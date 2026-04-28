import http from "node:http";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import chalk from "chalk";
import type { BrowserAttachment, BrowserLogger, CookieParam } from "../browser/types.js";
import { runBrowserMode } from "../browserMode.js";
import type { BrowserRunResult } from "../browserMode.js";
import type {
  RemoteRunPayload,
  RemoteRunEvent,
  RemoteRunSummary,
  RemoteRunsListing,
} from "./types.js";
import { getCookies, type Cookie } from "@steipete/sweet-cookie";
import { CHATGPT_URL } from "../browser/constants.js";
import { getCliVersion } from "../version.js";
import {
  cleanupStaleProfileState,
  readDevToolsPort,
  verifyDevToolsReachable,
  writeChromePid,
  writeDevToolsActivePort,
} from "../browser/profileState.js";
import { normalizeChatgptUrl } from "../browser/utils.js";

export interface RemoteServerOptions {
  host?: string;
  port?: number;
  token?: string;
  logger?: (message: string) => void;
  manualLoginDefault?: boolean;
  manualLoginProfileDir?: string;
  // Tier 2 knobs — defaults are reasonable for a single-user remote.
  completedRunRetentionMs?: number;
  recentRunsLimit?: number;
}

interface RemoteServerDeps {
  runBrowser?: typeof runBrowserMode;
}

interface RemoteServerInstance {
  port: number;
  token: string;
  close(): Promise<void>;
}

const DEFAULT_COMPLETED_RUN_RETENTION_MS = 10 * 60_000;
const DEFAULT_RECENT_RUNS_LIMIT = 25;
const TCP_KEEPALIVE_INITIAL_MS = 15_000;

interface RunRecord {
  id: string;
  status: "running" | "completed" | "errored";
  startedAt: number;
  endedAt?: number;
  promptChars: number;
  attachmentCount: number;
  events: RemoteRunEvent[];
  // Number of clients currently streaming this run.
  attachedClients: Set<http.ServerResponse>;
  totalDisconnects: number;
  lastDisconnectAt?: number;
  // Resolves when the underlying runBrowser promise settles. Used by the server
  // shutdown path to wait for in-flight runs.
  completion: Promise<void>;
  // GC timer scheduled after the run terminates, holding the buffer for late
  // clients. Cleared if a client reattaches.
  gcTimer?: NodeJS.Timeout;
  // Sequence counter — assigned at emit time, monotonic per run.
  nextSeq: number;
}

async function findAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", (err) => reject(err));
    srv.listen(0, () => {
      const address = srv.address();
      if (typeof address === "object" && address?.port) {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Unable to allocate port")));
      }
    });
  });
}

export async function createRemoteServer(
  options: RemoteServerOptions = {},
  deps: RemoteServerDeps = {},
): Promise<RemoteServerInstance> {
  const runBrowser = deps.runBrowser ?? runBrowserMode;
  const server = http.createServer();
  const logger = options.logger ?? console.log;
  const authToken = options.token ?? randomBytes(16).toString("hex");
  const startedAt = Date.now();
  const verbose = process.argv.includes("--verbose") || process.env.ORACLE_SERVE_VERBOSE === "1";
  const color = process.stdout.isTTY
    ? (formatter: (msg: string) => string, msg: string) => formatter(msg)
    : (_formatter: (msg: string) => string, msg: string) => msg;

  const completedRetentionMs =
    options.completedRunRetentionMs ?? DEFAULT_COMPLETED_RUN_RETENTION_MS;
  const recentRunsLimit = options.recentRunsLimit ?? DEFAULT_RECENT_RUNS_LIMIT;

  // Active runs by id, plus a small ring of completed runs (capped) for the
  // /runs listing surface. Active runs are GC'd into completed-only state once
  // their gcTimer fires, then dropped from the recent ring when it overflows.
  const runs = new Map<string, RunRecord>();
  const recent: string[] = [];

  // Single-flight guard: remote Chrome can only host one run at a time, so we
  // queue/reject overlapping requests. Disconnect alone does NOT free the slot
  // — only run completion does. This is the key contract change vs. the old
  // boolean `busy` guard.
  let activeRunId: string | null = null;

  if (!process.listenerCount("unhandledRejection")) {
    process.on("unhandledRejection", (reason) => {
      logger(
        `Unhandled promise rejection in remote server: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    });
  }

  const tuneSocket = (sock: net.Socket | null | undefined) => {
    if (!sock) return;
    try {
      sock.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_MS);
      sock.setNoDelay(true);
    } catch {
      // best-effort
    }
  };

  server.on("connection", (socket) => {
    tuneSocket(socket);
  });

  server.on("request", async (req, res) => {
    tuneSocket(req.socket);

    if (req.method === "GET" && req.url === "/status") {
      logger("[serve] Health check /status");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      const authHeader = req.headers.authorization ?? "";
      if (authHeader !== `Bearer ${authToken}`) {
        if (verbose) {
          logger(
            `[serve] Unauthorized /health attempt from ${formatSocket(req)} (missing/invalid token)`,
          );
        }
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          version: getCliVersion(),
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          activeRunId,
          activeRuns: activeRunId ? 1 : 0,
          retainedRuns: runs.size,
        }),
      );
      return;
    }

    // GET /runs — listing of active + recent runs (auth-gated).
    if (req.method === "GET" && req.url === "/runs") {
      const authHeader = req.headers.authorization ?? "";
      if (authHeader !== `Bearer ${authToken}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const listing: RemoteRunsListing = {
        ok: true,
        active: [],
        recent: [],
        retentionMs: completedRetentionMs,
      };
      for (const record of runs.values()) {
        const summary = summarizeRun(record);
        if (record.status === "running") {
          listing.active.push(summary);
        } else {
          listing.recent.push(summary);
        }
      }
      listing.recent.sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(listing));
      return;
    }

    // GET /runs/:id/events?cursor=N — resume an in-flight or recently completed run.
    const resumeMatch =
      req.method === "GET" && req.url
        ? /^\/runs\/([^/?]+)\/events(?:\?(.*))?$/.exec(req.url)
        : null;
    if (resumeMatch) {
      const authHeader = req.headers.authorization ?? "";
      if (authHeader !== `Bearer ${authToken}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const runId = decodeURIComponent(resumeMatch[1] ?? "");
      const cursorParam = new URLSearchParams(resumeMatch[2] ?? "").get("cursor");
      const cursor = cursorParam ? Number.parseInt(cursorParam, 10) : -1;
      handleResume({
        runId,
        cursor: Number.isFinite(cursor) ? cursor : -1,
        runs,
        res,
        logger,
        verbose,
        completedRetentionMs,
        retireRun,
      });
      return;
    }

    // POST /runs/:id/cancel — explicit cancellation of an in-flight run.
    const cancelMatch =
      req.method === "POST" && req.url
        ? /^\/runs\/([^/?]+)\/cancel$/.exec(req.url)
        : null;
    if (cancelMatch) {
      const authHeader = req.headers.authorization ?? "";
      if (authHeader !== `Bearer ${authToken}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const runId = decodeURIComponent(cancelMatch[1] ?? "");
      const record = runs.get(runId);
      if (!record) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      if (record.status !== "running") {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_running", status: record.status }));
        return;
      }
      // Cancellation is best-effort — runBrowserMode doesn't expose a cancel
      // primitive, so we mark the run errored and let it complete in the
      // background. Active clients see the error event immediately.
      const cancelMessage = "run cancelled by client";
      emitEvent(record, { type: "error", seq: 0, message: cancelMessage }, logger);
      retireRun(record, "errored", logger);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, runId }));
      return;
    }

    if (req.method !== "POST" || req.url !== "/runs") {
      res.statusCode = 404;
      res.end();
      return;
    }

    const authHeader = req.headers.authorization ?? "";
    if (authHeader !== `Bearer ${authToken}`) {
      if (verbose) {
        logger(
          `[serve] Unauthorized /runs attempt from ${formatSocket(req)} (missing/invalid token)`,
        );
      }
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (activeRunId) {
      if (verbose) {
        logger(
          `[serve] Busy: rejecting new run from ${formatSocket(req)} while runId=${activeRunId} is active`,
        );
      }
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "busy", activeRunId }));
      return;
    }

    let payload: RemoteRunPayload | null = null;
    try {
      const body = await readRequestBody(req);
      payload = JSON.parse(body) as RemoteRunPayload;
      if (payload?.browserConfig) {
        payload.browserConfig.url = normalizeChatgptUrl(payload.browserConfig.url, CHATGPT_URL);
      }
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_request" }));
      return;
    }

    const runId = randomUUID();
    activeRunId = runId;
    const runStartedAt = Date.now();
    const promptChars = payload?.prompt?.length ?? 0;
    const attachmentCount = Array.isArray(payload.attachments) ? payload.attachments.length : 0;

    logger(
      `[serve] Accepted run ${runId} from ${formatSocket(req)} (prompt ${promptChars} chars, ${attachmentCount} attachments)`,
    );

    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    tuneSocket(res.socket as net.Socket | null);

    // Each run gets an isolated temp dir so attachments/logs don't collide.
    const runDir = await mkdtemp(path.join(os.tmpdir(), `oracle-serve-${runId}-`));
    const attachmentDir = path.join(runDir, "attachments");
    await mkdir(attachmentDir, { recursive: true });

    const record: RunRecord = {
      id: runId,
      status: "running",
      startedAt: runStartedAt,
      promptChars,
      attachmentCount,
      events: [],
      attachedClients: new Set<http.ServerResponse>(),
      totalDisconnects: 0,
      nextSeq: 0,
      completion: Promise.resolve(),
    };
    runs.set(runId, record);
    pruneRecent(record.id, runs, recent, recentRunsLimit);

    attachClient(record, res, -1, logger, () => {
      // Capture disconnect — does NOT terminate the run.
      record.totalDisconnects += 1;
      record.lastDisconnectAt = Date.now();
      logger(
        `[serve] runId=${runId} client disconnected (events=${record.events.length}, elapsed=${Date.now() - record.startedAt}ms) — run continues server-side`,
      );
    });

    // Emit the runId event first so resuming clients have something to address.
    emitEvent(record, { type: "runId", seq: 0, runId }, logger);

    record.completion = (async () => {
      const attachments: BrowserAttachment[] = [];
      try {
        const attachmentsPayload = Array.isArray(payload!.attachments) ? payload!.attachments : [];
        for (const [index, attachment] of attachmentsPayload.entries()) {
          const safeName = sanitizeName(attachment.fileName ?? `attachment-${index + 1}`);
          const filePath = path.join(attachmentDir, safeName);
          await writeFile(filePath, Buffer.from(attachment.contentBase64, "base64"));
          attachments.push({
            path: filePath,
            displayPath: attachment.displayPath,
            sizeBytes: attachment.sizeBytes,
          });
        }

        // Reuse the existing browser logger surface so clients see the same log stream.
        const automationLogger: BrowserLogger = ((message?: string) => {
          if (typeof message === "string") {
            emitEvent(record, { type: "log", seq: 0, message }, logger);
          }
        }) as BrowserLogger;
        automationLogger.verbose = Boolean(payload!.options.verbose);

        // Remote runs always rely on the host's own Chrome profile; ignore any inline cookie transfer.
        const activePayload = payload!;
        if (activePayload.browserConfig) {
          activePayload.browserConfig.inlineCookies = null;
          activePayload.browserConfig.inlineCookiesSource = null;
          activePayload.browserConfig.cookieSync = true;
        } else {
          activePayload.browserConfig = {} as typeof activePayload.browserConfig;
        }

        // Enforce manual-login profile when cookie sync is unavailable (e.g., Windows/WSL).
        if (options.manualLoginDefault) {
          payload!.browserConfig.manualLogin = true;
          payload!.browserConfig.manualLoginProfileDir = options.manualLoginProfileDir;
          payload!.browserConfig.keepBrowser = true;
          if (verbose) {
            logger(
              `[serve] Enforcing manual-login profile at ${options.manualLoginProfileDir ?? "default"} for remote run ${runId}`,
            );
          }
        }

        const result = await runBrowser({
          prompt: payload!.prompt,
          attachments,
          config: payload!.browserConfig,
          log: automationLogger,
          heartbeatIntervalMs: payload!.options.heartbeatIntervalMs,
          verbose: payload!.options.verbose,
        });

        emitEvent(record, { type: "result", seq: 0, result: sanitizeResult(result) }, logger);
        retireRun(record, "completed", logger);
        logger(
          `[serve] Run ${runId} completed in ${Date.now() - runStartedAt}ms (disconnects=${record.totalDisconnects}, events=${record.events.length})`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitEvent(record, { type: "error", seq: 0, message }, logger);
        retireRun(record, "errored", logger);
        logger(
          `[serve] Run ${runId} failed after ${Date.now() - runStartedAt}ms: ${message} (disconnects=${record.totalDisconnects})`,
        );
      } finally {
        if (activeRunId === runId) {
          activeRunId = null;
        }
        try {
          await rm(runDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, options.host ?? "0.0.0.0", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine server address.");
  }
  const reachable = formatReachableAddresses(address.address, address.port);
  const primary = reachable[0] ?? `${address.address}:${address.port}`;
  const extras = reachable.slice(1);
  const also = extras.length ? `, also [${extras.join(", ")}]` : "";
  logger(color(chalk.cyanBright.bold, `Listening at ${primary}${also}`));
  logger(color(chalk.yellowBright, `Access token: ${authToken}`));
  logger("Leave this terminal running; press Ctrl+C to stop oracle serve.");

  function retireRun(record: RunRecord, status: "completed" | "errored", log: (msg: string) => void) {
    if (record.status !== "running") return;
    record.status = status;
    record.endedAt = Date.now();
    if (record.gcTimer) {
      clearTimeout(record.gcTimer);
    }
    record.gcTimer = setTimeout(() => {
      // Drop the buffered events once retention elapses. Active clients are
      // sent res.end() and removed in the same path.
      for (const client of record.attachedClients) {
        try {
          client.end();
        } catch {
          // ignore
        }
      }
      record.attachedClients.clear();
      runs.delete(record.id);
      log(
        `[serve] runId=${record.id} GC'd from buffer (${status}, retained ${completedRetentionMs}ms)`,
      );
      const idx = recent.indexOf(record.id);
      if (idx >= 0) recent.splice(idx, 1);
    }, completedRetentionMs);
    record.gcTimer.unref?.();
  }

  return {
    port: address.port,
    token: authToken,
    async close() {
      // Drain in-flight runs gracefully — close the listener but allow active
      // runs to finish. Tests rely on close() returning quickly.
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function attachClient(
  record: RunRecord,
  res: http.ServerResponse,
  cursor: number,
  logger: (msg: string) => void,
  onDisconnect: () => void,
) {
  // Replay any events with seq > cursor that are already in the buffer, then
  // register the response so future events stream live. Replay must happen
  // before registration so we don't double-write a borderline event.
  const tail = record.events.filter((event) => (event.seq ?? -1) > cursor);
  for (const event of tail) {
    try {
      res.write(`${JSON.stringify(event)}\n`);
    } catch {
      // socket already gone — let the close handler clean up
    }
  }

  if (record.status !== "running") {
    // Run already terminated; ensure terminal event is in the tail (it always
    // is) and close the response so the client doesn't hang.
    try {
      res.end();
    } catch {
      // ignore
    }
    return;
  }

  record.attachedClients.add(res);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    record.attachedClients.delete(res);
    onDisconnect();
  };

  res.on("close", () => {
    if (!res.writableEnded) {
      cleanup();
    }
  });
  res.on("finish", () => {
    record.attachedClients.delete(res);
  });
  res.on("error", (err) => {
    if (record.attachedClients.has(res)) {
      logger(
        `[serve] runId=${record.id} client write error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    cleanup();
  });
}

function handleResume(args: {
  runId: string;
  cursor: number;
  runs: Map<string, RunRecord>;
  res: http.ServerResponse;
  logger: (msg: string) => void;
  verbose: boolean;
  completedRetentionMs: number;
  retireRun: (record: RunRecord, status: "completed" | "errored", log: (msg: string) => void) => void;
}) {
  const { runId, cursor, runs, res, logger, verbose, completedRetentionMs } = args;
  const record = runs.get(runId);
  if (!record) {
    res.writeHead(410, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: `runId=${runId} no longer available (server retains completed runs ${completedRetentionMs}ms)`,
      }),
    );
    return;
  }

  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  tuneServerResponseSocket(res);

  if (verbose) {
    logger(
      `[serve] runId=${runId} resume from cursor=${cursor} (status=${record.status}, buffered=${record.events.length})`,
    );
  } else {
    logger(`[serve] runId=${runId} resume cursor=${cursor} status=${record.status}`);
  }

  attachClient(record, res, cursor, logger, () => {
    record.totalDisconnects += 1;
    record.lastDisconnectAt = Date.now();
    logger(
      `[serve] runId=${runId} resumed client disconnected after ${Date.now() - record.startedAt}ms`,
    );
  });
}

function tuneServerResponseSocket(res: http.ServerResponse) {
  const sock = res.socket as net.Socket | null | undefined;
  if (!sock) return;
  try {
    sock.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_MS);
    sock.setNoDelay(true);
  } catch {
    // best-effort
  }
}

function emitEvent(record: RunRecord, event: RemoteRunEvent, _logger: (msg: string) => void) {
  const seq = record.nextSeq++;
  const stamped: RemoteRunEvent = { ...event, seq } as RemoteRunEvent;
  record.events.push(stamped);
  const line = `${JSON.stringify(stamped)}\n`;
  for (const client of record.attachedClients) {
    try {
      client.write(line);
    } catch {
      // client socket failures are surfaced via the close/error listeners in
      // attachClient; nothing else to do here.
    }
  }
}

function summarizeRun(record: RunRecord): RemoteRunSummary {
  return {
    runId: record.id,
    status: record.status,
    startedAt: new Date(record.startedAt).toISOString(),
    endedAt: record.endedAt ? new Date(record.endedAt).toISOString() : undefined,
    promptChars: record.promptChars,
    attachmentCount: record.attachmentCount,
    eventCount: record.events.length,
    attachedClients: record.attachedClients.size,
    totalDisconnects: record.totalDisconnects,
    lastDisconnectAt: record.lastDisconnectAt
      ? new Date(record.lastDisconnectAt).toISOString()
      : undefined,
    durationMs: record.endedAt ? record.endedAt - record.startedAt : undefined,
  };
}

function pruneRecent(
  newId: string,
  runs: Map<string, RunRecord>,
  recent: string[],
  limit: number,
) {
  recent.push(newId);
  while (recent.length > limit) {
    const evicted = recent.shift();
    if (!evicted) break;
    const record = runs.get(evicted);
    if (record && record.status !== "running") {
      if (record.gcTimer) clearTimeout(record.gcTimer);
      runs.delete(evicted);
    }
  }
}

export async function serveRemote(options: RemoteServerOptions = {}): Promise<void> {
  const manualProfileDir =
    options.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile");
  const preferManualLogin = options.manualLoginDefault || process.platform === "win32" || isWsl();
  let cookies: CookieParam[] | null = null;
  let opened = false;

  if (isWsl() && process.env.ORACLE_ALLOW_WSL_SERVE !== "1") {
    console.log(
      "WSL detected. For reliable browser automation, run `oracle serve` from Windows PowerShell/Command Prompt so we can use your Windows Chrome profile.",
    );
    console.log(
      "If you want to stay in WSL anyway, set ORACLE_ALLOW_WSL_SERVE=1 and ensure a Linux Chrome is installed, then rerun.",
    );
    console.log(
      "Alternatively, start Windows Chrome with --remote-debugging-port=9222 and use `--remote-chrome <windows-ip>:9222`.",
    );
    return;
  }

  if (!preferManualLogin) {
    // Warm-up: ensure this host has a ChatGPT login before accepting runs.
    const result = await loadLocalChatgptCookies(console.log, CHATGPT_URL);
    cookies = result.cookies;
    opened = result.opened;
  }

  if (!cookies || cookies.length === 0) {
    console.log("No ChatGPT cookies detected on this host.");
    if (preferManualLogin) {
      await mkdir(manualProfileDir, { recursive: true });
      console.log(
        `Cookie extraction is unavailable on this platform. Using manual-login Chrome profile at ${manualProfileDir}. Remote runs will reuse this profile; sign in once when the browser opens.`,
      );
      const existingPort = await readDevToolsPort(manualProfileDir);
      if (existingPort) {
        const reachable = await verifyDevToolsReachable({ port: existingPort });
        if (reachable.ok) {
          console.log(
            "Detected an existing automation Chrome session; will reuse it for manual login.",
          );
        } else {
          console.log(
            `Found stale DevToolsActivePort (port ${existingPort}, ${reachable.error}); launching a fresh manual-login Chrome.`,
          );
          await cleanupStaleProfileState(manualProfileDir, console.log, {
            lockRemovalMode: "never",
          });
          void launchManualLoginChrome(manualProfileDir, CHATGPT_URL, console.log);
        }
      } else {
        void launchManualLoginChrome(manualProfileDir, CHATGPT_URL, console.log);
      }
    } else if (opened) {
      console.log(
        "Opened chatgpt.com for login. Sign in, then restart `oracle serve` to continue.",
      );
      return;
    } else {
      console.log(
        "Please open https://chatgpt.com/ in this host's browser and sign in; then rerun.",
      );
      console.log(
        "Tip: install xdg-utils (xdg-open) to enable automatic browser opening on Linux/WSL.",
      );
      return;
    }
  } else {
    console.log(
      `Detected ${cookies.length} ChatGPT cookies on this host; runs will reuse this session.`,
    );
  }

  const server = await createRemoteServer({
    ...options,
    manualLoginDefault: preferManualLogin,
    manualLoginProfileDir: manualProfileDir,
  });
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.log("Shutting down remote service...");
      server
        .close()
        .catch((error) => console.error("Failed to close remote server:", error))
        .finally(() => resolve());
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sanitizeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function sanitizeResult(result: BrowserRunResult): BrowserRunResult {
  return {
    answerText: result.answerText,
    answerMarkdown: result.answerMarkdown,
    answerHtml: result.answerHtml,
    tookMs: result.tookMs,
    answerTokens: result.answerTokens,
    answerChars: result.answerChars,
    chromePid: undefined,
    chromePort: undefined,
    userDataDir: undefined,
  };
}

function formatSocket(req: http.IncomingMessage): string {
  const socket = req.socket;
  const host = socket.remoteAddress ?? "unknown";
  const port = socket.remotePort ?? "0";
  return `${host}:${port}`;
}

function formatReachableAddresses(bindAddress: string, port: number): string[] {
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  if (bindAddress && bindAddress !== "::" && bindAddress !== "0.0.0.0") {
    if (bindAddress.includes(":")) {
      ipv6.push(`[${bindAddress}]:${port}`);
    } else {
      ipv4.push(`${bindAddress}:${port}`);
    }
  }
  try {
    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
      if (!entries) continue;
      for (const entry of entries) {
        const iface = entry as
          | { family?: string | number; address: string; internal?: boolean }
          | undefined;
        if (!iface || iface.internal) continue;
        const family =
          typeof iface.family === "string"
            ? iface.family
            : iface.family === 4
              ? "IPv4"
              : iface.family === 6
                ? "IPv6"
                : "";
        if (family === "IPv4") {
          const addr = iface.address;
          if (addr.startsWith("127.")) continue;
          if (addr.startsWith("169.254.")) continue; // APIPA/link-local
          ipv4.push(`${addr}:${port}`);
        } else if (family === "IPv6") {
          const addr = iface.address.toLowerCase();
          if (addr === "::1" || addr.startsWith("fe80:")) continue; // loopback/link-local
          ipv6.push(`[${iface.address}]:${port}`);
        }
      }
    }
  } catch {
    // network interface probing can fail in locked-down environments; ignore
  }
  // de-dup
  return Array.from(new Set([...ipv4, ...ipv6]));
}

async function loadLocalChatgptCookies(
  logger: (message: string) => void,
  targetUrl: string,
): Promise<{ cookies: CookieParam[] | null; opened: boolean }> {
  try {
    logger("Loading ChatGPT cookies from this host's Chrome profile...");
    const { cookies: rawCookies, warnings } = await getCookies({
      url: targetUrl,
      browsers: ["chrome"],
      mode: "merge",
      chromeProfile: "Default",
      timeoutMs: 5_000,
    });
    if (warnings.length) {
      logger(`Cookie warnings:\n- ${warnings.join("\n- ")}`);
    }
    const cookies = rawCookies.map(toCdpCookie).filter((c): c is CookieParam => Boolean(c));
    if (!cookies || cookies.length === 0) {
      logger("No local ChatGPT cookies found on this host. Please log in once; opening ChatGPT...");
      const opened = triggerLocalLoginPrompt(logger, targetUrl);
      return { cookies: null, opened };
    }
    logger(`Loaded ${cookies.length} local ChatGPT cookies on this host.`);
    return { cookies, opened: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missingDbMatch = message.match(/Unable to locate Chrome cookie DB at (.+?)(?:\.|$)/);
    if (missingDbMatch) {
      const lookedPath = missingDbMatch[1];
      logger(
        `Chrome cookies not found at ${lookedPath}. Set --browser-cookie-path to your Chrome profile or log in manually.`,
      );
    } else {
      logger(`Unable to load local ChatGPT cookies on this host: ${message}`);
    }
    if (process.platform === "linux" && isWsl()) {
      logger(
        "WSL hint: Chrome lives under /mnt/c/Users/<you>/AppData/Local/Google/Chrome/User Data/Default; pass --browser-cookie-path to that directory if auto-detect fails.",
      );
    }
    const opened = triggerLocalLoginPrompt(logger, targetUrl);
    return { cookies: null, opened };
  }
}

function toCdpCookie(cookie: Cookie): CookieParam | null {
  if (!cookie?.name) return null;
  const out: CookieParam = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path ?? "/",
    secure: cookie.secure ?? true,
    httpOnly: cookie.httpOnly ?? false,
  };
  if (typeof cookie.expires === "number") out.expires = cookie.expires;
  if (cookie.sameSite === "Lax" || cookie.sameSite === "Strict" || cookie.sameSite === "None") {
    out.sameSite = cookie.sameSite;
  }
  return out;
}

function triggerLocalLoginPrompt(logger: (message: string) => void, url: string): boolean {
  const verbose = process.argv.includes("--verbose") || process.env.ORACLE_SERVE_VERBOSE === "1";
  const openers: Array<{ cmd: string; args?: string[] }> = [];

  if (process.platform === "darwin") {
    openers.push({ cmd: "open" });
  } else if (process.platform === "win32") {
    openers.push({ cmd: "start" });
  } else {
    if (isWsl()) {
      // Prefer wslview when available, then fall back to Windows start.exe to open in the host browser.
      openers.push({ cmd: "wslview" });
      openers.push({ cmd: "cmd.exe", args: ["/c", "start", "", url] });
    }
    openers.push({ cmd: "xdg-open" });
  }

  // Add a cross-platform, low-friction fallback when nothing above is available.
  openers.push({ cmd: "sensible-browser" });

  try {
    // Fire and forget; user completes login in the opened browser window.
    if (verbose) {
      logger(`[serve] Login opener candidates: ${openers.map((o) => o.cmd).join(", ")}`);
    }
    const candidate = openers.find((opener) => canSpawn(opener.cmd));
    if (candidate) {
      const child = spawn(candidate.cmd, candidate.args ?? [url], {
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      child.once("error", (error) => {
        if (verbose) {
          logger(
            `[serve] Opener ${candidate.cmd} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        logger(`Please open ${url} in this host's browser and sign in; then rerun.`);
      });
      logger(
        `Opened ${url} locally via ${candidate.cmd}. Please sign in; subsequent runs will reuse the session.`,
      );
      if (verbose && candidate.args) {
        logger(`[serve] Opener args: ${candidate.args.join(" ")}`);
      }
      return true;
    }
    if (verbose) {
      logger("[serve] No available opener found; prompting manual login.");
    }
    return false;
  } catch {
    return false;
  }
}

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  return Boolean(process.env.WSL_DISTRO_NAME || os.release().toLowerCase().includes("microsoft"));
}

function canSpawn(cmd: string): boolean {
  if (!cmd) return false;
  try {
    if (process.platform === "win32") {
      // `where` returns non-zero when the command is not found.
      const result = spawnSync("where", [cmd], { stdio: "ignore" });
      return result.status === 0;
    }
    // `command -v` is a shell builtin; run through sh. Fallback to `which`.
    const shResult = spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    if (shResult.status === 0) return true;
    const whichResult = spawnSync("which", [cmd], { stdio: "ignore" });
    return whichResult.status === 0;
  } catch {
    return false;
  }
}

async function launchManualLoginChrome(
  profileDir: string,
  url: string,
  logger: (msg: string) => void,
): Promise<void> {
  const timeoutMs = 7000;
  let finished = false;
  const timeout = setTimeout(() => {
    if (!finished) {
      logger(
        `Timed out launching Chrome for manual login. Launch Chrome manually with --user-data-dir=${profileDir} and log in to ${url}.`,
      );
    }
  }, timeoutMs);

  try {
    const chromeLauncher = await import("chrome-launcher");
    const { launch } = chromeLauncher;
    const debugPort = await findAvailablePort();
    logger(`Planned manual-login Chrome DevTools port: ${debugPort}`);
    const chrome = await launch({
      // Expose DevTools so later runs can attach instead of spawning a second Chrome.
      // Use a per-serve free port so the login window stays stable for all runs.
      port: debugPort,
      userDataDir: profileDir,
      startingUrl: url,
      chromeFlags: [
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profileDir}`,
        "--remote-allow-origins=*",
        `--remote-debugging-port=${debugPort}`, // ensure DevToolsActivePort is written even on Windows
      ],
    });

    const chosenPort = chrome?.port ?? debugPort ?? null;
    if (chosenPort) {
      // Persist DevToolsActivePort eagerly so future runs can attach/reuse this Chrome.
      await writeDevToolsActivePort(profileDir, chosenPort);
      if (chrome?.pid) {
        await writeChromePid(profileDir, chrome.pid);
      }
      logger(`Manual-login Chrome DevTools port: ${chosenPort}`);
      logger(`If needed, DevTools JSON at http://127.0.0.1:${chosenPort}/json/version`);
    } else {
      logger(
        "Warning: unable to determine manual-login Chrome DevTools port. Remote runs may fail to attach.",
      );
    }

    finished = true;
    clearTimeout(timeout);
    const portInfo = chosenPort ? ` (DevTools port ${chosenPort})` : "";
    logger(
      `Opened Chrome with manual-login profile at ${profileDir}${portInfo}. Complete login, then rerun remote sessions.`,
    );
  } catch (error) {
    finished = true;
    clearTimeout(timeout);
    const message = error instanceof Error ? error.message : String(error);
    logger(
      `Unable to open Chrome for manual login (${message}). Launch Chrome manually with --user-data-dir=${profileDir} and log in to ${url}.`,
    );
  }
}
