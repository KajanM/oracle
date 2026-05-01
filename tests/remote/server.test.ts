import { describe, expect, test } from "vitest";
import http from "node:http";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { createRemoteServer } from "../../src/remote/server.js";
import { createRemoteBrowserExecutor } from "../../src/remote/client.js";
import type { BrowserRunResult } from "../../src/browserMode.js";

const CAN_LISTEN_LOCALHOST =
  spawnSync(
    process.execPath,
    [
      "-e",
      `
      const net = require('net');
      const s = net.createServer();
      s.on('error', () => process.exit(1));
      s.listen(0, '127.0.0.1', () => s.close(() => process.exit(0)));
    `,
    ],
    { stdio: "ignore" },
  ).status === 0;

describe("remote browser service", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "streams logs and returns results via client executor",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-test-"));
      const attachmentPath = path.join(tmpDir, "note.txt");
      await writeFile(attachmentPath, "hello world", "utf8");

      const runLog: string[] = [];
      const browserConfigs: Array<Record<string, unknown>> = [];
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          runBrowser: async (options) => {
            runLog.push(options.prompt);
            browserConfigs.push(options.config as Record<string, unknown>);
            expect(options.attachments).toHaveLength(1);
            const attachment = options.attachments?.[0];
            if (!attachment) {
              throw new Error("missing attachment");
            }
            const stored = await readFile(attachment.path, "utf8");
            expect(stored).toBe("hello world");
            options.log?.("uploading attachment");
            const result: BrowserRunResult = {
              answerText: "hi",
              answerMarkdown: "hi",
              tookMs: 1000,
              answerTokens: 42,
              answerChars: 2,
            };
            return result;
          },
        },
      );

      const executor = createRemoteBrowserExecutor({
        host: `127.0.0.1:${server.port}`,
        token: "secret",
      });
      const clientLogs: string[] = [];
      const result = await executor({
        prompt: "remote",
        attachments: [{ path: attachmentPath, displayPath: "note.txt", sizeBytes: 11 }],
        config: {},
        log: (message?: string) => {
          if (message) clientLogs.push(message);
        },
      });

      expect(clientLogs.some((entry) => entry.includes("uploading attachment"))).toBe(true);
      expect(result.answerText).toBe("hi");
      expect(runLog).toEqual(["remote"]);
      expect(browserConfigs[0]).toMatchObject({
        desiredModel: "Use latest model",
        modelStrategy: "select",
        thinkingTime: "extended",
        manualLogin: false,
        manualLoginProfileDir: null,
        manualLoginCookieSync: false,
      });

      const healthUnauthorized = await httpGetJson({
        hostname: "127.0.0.1",
        port: server.port,
        path: "/health",
      });
      expect(healthUnauthorized.statusCode).toBe(401);

      const healthOk = await httpGetJson({
        hostname: "127.0.0.1",
        port: server.port,
        path: "/health",
        token: "secret",
      });
      expect(healthOk.statusCode).toBe(200);
      expect(healthOk.json?.ok).toBe(true);
      expect(typeof healthOk.json?.version).toBe("string");

      await server.close();
      await rm(tmpDir, { recursive: true, force: true });
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)("rejects runs over the concurrency cap", async () => {
    const previousCap = process.env.ORACLE_SERVE_MAX_CONCURRENT;
    process.env.ORACLE_SERVE_MAX_CONCURRENT = "1";

    let releaseRun: (() => void) | undefined;
    const server = await createRemoteServer(
      { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
      {
        runBrowser: async () => {
          await new Promise<void>((resolve) => {
            releaseRun = resolve;
          });
          return {
            answerText: "done",
            answerMarkdown: "done",
            tookMs: 1000,
            answerTokens: 1,
            answerChars: 4,
          };
        },
      },
    );

    const first = postRun({ port: server.port, token: "secret", prompt: "first" });
    await waitForActiveRun(server.port);

    const second = await postRun({ port: server.port, token: "secret", prompt: "second" });
    expect(second.statusCode).toBe(409);
    expect(second.json?.error).toBe("busy");
    expect(second.json?.activeRuns).toBe(1);
    expect(second.json?.maxConcurrentRuns).toBe(1);

    releaseRun?.();
    const completed = await first;
    expect(completed.statusCode).toBe(200);

    await server.close();
    if (previousCap === undefined) {
      delete process.env.ORACLE_SERVE_MAX_CONCURRENT;
    } else {
      process.env.ORACLE_SERVE_MAX_CONCURRENT = previousCap;
    }
  });
});

async function waitForActiveRun(port: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 2000) {
    const health = await httpGetJson({
      hostname: "127.0.0.1",
      port,
      path: "/health",
      token: "secret",
    });
    if (health.json?.activeRuns === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("remote run did not become active");
}

async function postRun({
  port,
  token,
  prompt,
}: {
  port: number;
  token: string;
  prompt: string;
}): Promise<{ statusCode: number; json: Record<string, unknown> | null }> {
  return await new Promise((resolve, reject) => {
    const body = JSON.stringify({
      prompt,
      attachments: [],
      browserConfig: {},
      options: {},
    });
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/runs",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.setEncoding("utf8");
        let text = "";
        let settled = false;
        const settle = () => {
          if (settled) return;
          const statusCode = res.statusCode ?? 0;
          let json: Record<string, unknown> | null = null;
          const resultLine = text
            .trim()
            .split("\n")
            .findLast((line) => line.trim().length > 0);
          try {
            const parsed = resultLine ? JSON.parse(resultLine) : null;
            json =
              parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
          } catch {
            json = null;
          }
          if (statusCode !== 200 || json?.type === "result" || json?.type === "error") {
            settled = true;
            resolve({ statusCode, json });
            res.destroy();
          }
        };
        res.on("data", (chunk: string) => {
          text += chunk;
          settle();
        });
        res.on("end", () => {
          if (!settled) settle();
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function httpGetJson({
  hostname,
  port,
  path,
  token,
}: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
}): Promise<{ statusCode: number; json: Record<string, unknown> | null }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname,
        port,
        path,
        method: "GET",
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
      },
      (res) => {
        res.setEncoding("utf8");
        let body = "";
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          const statusCode = res.statusCode ?? 0;
          let json: Record<string, unknown> | null = null;
          try {
            const parsed = body.length ? JSON.parse(body) : null;
            json =
              parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
          } catch {
            json = null;
          }
          resolve({ statusCode, json });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
