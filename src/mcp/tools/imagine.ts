import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LoggingMessageNotificationParamsSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { getCliVersion } from "../../version.js";
import { CHATGPT_URL } from "../../browser/constants.js";
import type { BrowserSessionConfig } from "../../sessionStore.js";
import { sessionStore } from "../../sessionStore.js";
import { loadUserConfig, type UserConfig } from "../../config.js";
import { ensureBrowserAvailable } from "../utils.js";
import { resolveRemoteServiceConfig } from "../../remote/remoteServiceConfig.js";
import { createRemoteBrowserExecutor } from "../../remote/client.js";
import type { BrowserSessionRunnerDeps } from "../../browser/sessionRunner.js";
import { performSessionRun } from "../../cli/sessionRunner.js";
import { resolveNotificationSettings } from "../../cli/notifier.js";
import type { RunOracleOptions } from "../../oracle.js";

const imagineInputShape = {
  prompt: z.string().min(1, "Prompt is required.").describe("Image prompt to send to ChatGPT."),
  files: z.array(z.string()).default([]).describe("Optional reference image/file paths to upload."),
  slug: z
    .string()
    .optional()
    .describe("Optional human-friendly session id (used to locate downloaded images)."),
  browserKeepBrowser: z
    .boolean()
    .optional()
    .describe("Keep Chrome open after completion for debugging."),
  browserConversationUrl: z
    .string()
    .url()
    .optional()
    .describe("Existing ChatGPT conversation URL to continue."),
} satisfies z.ZodRawShape;

export function buildImagineBrowserConfig({
  userConfig,
  browserKeepBrowser,
  browserConversationUrl,
}: {
  userConfig: UserConfig;
  browserKeepBrowser?: boolean;
  browserConversationUrl?: string;
}): BrowserSessionConfig {
  const configuredBrowser = userConfig.browser ?? {};
  const requestedConversationUrl = browserConversationUrl?.trim();
  const configuredUrl =
    requestedConversationUrl && requestedConversationUrl.length > 0
      ? requestedConversationUrl
      : (configuredBrowser.chatgptUrl ?? configuredBrowser.url ?? CHATGPT_URL);
  return {
    ...configuredBrowser,
    url: configuredUrl,
    chatgptUrl: configuredUrl,
    cookieSync: true,
    headless: configuredBrowser.headless ?? false,
    hideWindow: configuredBrowser.hideWindow ?? false,
    keepBrowser: browserKeepBrowser ?? configuredBrowser.keepBrowser ?? false,
    manualLogin: false,
    manualLoginProfileDir: null,
    manualLoginCookieSync: false,
    desiredModel: "GPT-5.5 Thinking",
    modelStrategy: "select",
    thinkingTime: undefined,
    createImageMode: true,
    captureGeneratedImages: true,
  };
}

async function readSessionLogTail(sessionId: string, maxBytes: number): Promise<string | null> {
  try {
    const log = await sessionStore.readLog(sessionId);
    if (log.length <= maxBytes) return log;
    return log.slice(-maxBytes);
  } catch {
    return null;
  }
}

async function listGeneratedImagePaths(sessionId: string): Promise<string[]> {
  try {
    const paths = await sessionStore.getPaths(sessionId);
    const imageDir = path.join(paths.dir, "images");
    const entries = await fs.readdir(imageDir);
    return entries
      .filter((entry) => /\.(png|jpe?g|webp|gif)$/i.test(entry))
      .sort()
      .map((entry) => path.join(imageDir, entry));
  } catch {
    return [];
  }
}

export function registerImagineTool(server: McpServer): void {
  const registeredTool = server.registerTool(
    "imagine",
    {
      description:
        "Generate images through ChatGPT browser automation. Uses Thinking mode, enables the composer Create image mode, and saves generated images under the Oracle session directory.",
      inputSchema: imagineInputShape,
    },
    async (input: unknown) => {
      const textContent = (text: string) => [{ type: "text" as const, text }];
      const { prompt, files, slug, browserKeepBrowser, browserConversationUrl } = z
        .object(imagineInputShape)
        .parse(input);
      const { config: userConfig } = await loadUserConfig();
      const cwd = process.cwd();
      const resolvedRemote = resolveRemoteServiceConfig({ userConfig, env: process.env });
      const browserGuard = ensureBrowserAvailable("browser", { remoteHost: resolvedRemote.host });
      if (browserGuard) {
        return { isError: true, content: textContent(browserGuard) };
      }

      let browserDeps: BrowserSessionRunnerDeps | undefined;
      if (resolvedRemote.host) {
        if (!resolvedRemote.token) {
          return {
            isError: true,
            content: textContent(
              `Remote host configured (${resolvedRemote.host}) but remote token is missing. Run \`oracle bridge client --connect <...>\` or set ORACLE_REMOTE_TOKEN.`,
            ),
          };
        }
        browserDeps = {
          executeBrowser: createRemoteBrowserExecutor({
            host: resolvedRemote.host,
            token: resolvedRemote.token,
          }),
        };
      }

      const browserConfig = buildImagineBrowserConfig({
        userConfig,
        browserKeepBrowser,
        browserConversationUrl,
      });
      const runOptions: RunOracleOptions = {
        prompt,
        file: files ?? [],
        model: "gpt-5.5",
        browserAttachments: "always",
        slug,
        search: false,
      };
      const notifications = resolveNotificationSettings({
        cliNotify: undefined,
        cliNotifySound: undefined,
        env: process.env,
        config: userConfig.notify,
      });
      const sessionMeta = await sessionStore.createSession(
        {
          ...runOptions,
          mode: "browser",
          slug,
          browserConfig,
          waitPreference: true,
        },
        cwd,
        notifications,
      );
      const logWriter = sessionStore.createLogWriter(sessionMeta.id);
      const sendLog = (text: string, level: "info" | "debug" = "info") =>
        server.server
          .sendLoggingMessage(
            LoggingMessageNotificationParamsSchema.parse({
              level,
              data: { text, bytes: Buffer.byteLength(text, "utf8") },
            }),
          )
          .catch(() => {});
      const log = (line?: string): void => {
        logWriter.logLine(line);
        if (line !== undefined) sendLog(line);
      };
      const write = (chunk: string): boolean => {
        logWriter.writeChunk(chunk);
        sendLog(chunk, "debug");
        return true;
      };

      try {
        await performSessionRun({
          sessionMeta,
          runOptions,
          mode: "browser",
          browserConfig,
          cwd,
          log,
          write,
          version: getCliVersion(),
          notifications,
          muteStdout: true,
          browserDeps,
        });
      } catch (error) {
        log(`Run failed: ${error instanceof Error ? error.message : String(error)}`);
        return {
          isError: true,
          content: textContent(
            `Session ${sessionMeta.id} failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        };
      } finally {
        logWriter.stream.end();
      }

      const finalMeta = (await sessionStore.readSession(sessionMeta.id)) ?? sessionMeta;
      const imagePaths = await listGeneratedImagePaths(sessionMeta.id);
      const logTail = await readSessionLogTail(sessionMeta.id, 4000);
      const summary = [
        `Session ${sessionMeta.id} (${finalMeta.status})`,
        imagePaths.length > 0
          ? `Saved images:\n${imagePaths.map((imagePath) => `- ${imagePath}`).join("\n")}`
          : "No generated images were captured.",
        logTail || "(log empty)",
      ]
        .join("\n")
        .trim();
      return {
        content: textContent(summary),
        structuredContent: {
          sessionId: sessionMeta.id,
          status: finalMeta.status,
          imagePaths,
          output: logTail ?? "",
        },
      };
    },
  );
  if (registeredTool) {
    (registeredTool as unknown as { execution?: unknown }).execution = undefined;
  }
}
