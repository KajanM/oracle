import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { BrowserRunOptions } from "../browserMode.js";
import type { BrowserRunResult } from "../browserMode.js";
import type { BrowserAttachment } from "../browser/types.js";
import type { BrowserRemoteRunMetadata } from "../sessionStore.js";
import type { RemoteRunPayload, RemoteRunEvent, RemoteAttachmentPayload } from "./types.js";
import { parseHostPort } from "../bridge/connection.js";

interface RemoteExecutorOptions {
  host: string;
  token?: string;
}

const TCP_KEEPALIVE_INITIAL_MS = 15_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const SOCKET_IDLE_TIMEOUT_MULTIPLIER = 5;
const MIN_SOCKET_IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BACKOFF_BASE_MS = 1_000;
const RECONNECT_BACKOFF_MAX_MS = 15_000;
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
const TRANSIENT_ERROR_MESSAGES = [
  "socket hang up",
  "Stream closed before result was received",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "socket idle timeout",
];

function isTransientError(error: unknown): boolean {
  if (!error) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_ERROR_CODES.has(code)) {
    return true;
  }
  const message = formatRemoteErrorMessage(error);
  return TRANSIENT_ERROR_MESSAGES.some((needle) => message.includes(needle));
}

export function formatRemoteErrorMessage(error: unknown): string {
  if (!error) return "Unknown remote transport error.";
  if (error instanceof AggregateError) {
    const parts = error.errors
      .map((entry) => formatRemoteErrorMessage(entry))
      .filter((entry) => entry.trim().length > 0);
    const message = error.message.trim();
    if (parts.length > 0) {
      return message ? `${message}: ${parts.join("; ")}` : parts.join("; ");
    }
    return message || "Unknown aggregate remote transport error.";
  }
  if (error instanceof Error) {
    const details = formatErrorDetails(error);
    const message = error.message.trim();
    if (message && details) return `${message} (${details})`;
    if (message) return message;
    if (details) return details;
    return error.name || "Unknown remote transport error.";
  }
  return String(error);
}

function formatErrorDetails(error: Error): string {
  const fields: string[] = [];
  const coded = error as {
    code?: unknown;
    syscall?: unknown;
    address?: unknown;
    port?: unknown;
    cause?: unknown;
  };
  if (typeof coded.code === "string" && coded.code.length > 0) fields.push(coded.code);
  if (typeof coded.syscall === "string" && coded.syscall.length > 0) {
    fields.push(`syscall=${coded.syscall}`);
  }
  if (typeof coded.address === "string" && coded.address.length > 0) {
    fields.push(`address=${coded.address}`);
  }
  if (typeof coded.port === "number" || typeof coded.port === "string") {
    fields.push(`port=${coded.port}`);
  }
  if (coded.cause && coded.cause !== error) {
    fields.push(`cause=${formatRemoteErrorMessage(coded.cause)}`);
  }
  return fields.join(", ");
}

function backoffDelayMs(attempt: number): number {
  // attempt is 1-based; cap exponential growth and add jitter so multiple
  // clients reconnecting after a network blip don't synchronize.
  const base = Math.min(
    RECONNECT_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1),
    RECONNECT_BACKOFF_MAX_MS,
  );
  const jitter = Math.random() * 0.25 * base;
  return Math.round(base + jitter);
}

interface StreamState {
  runId: string | null;
  cursor: number;
  resolved: BrowserRunResult | null;
  remoteError: string | null;
  retentionMs?: number;
  startedAt?: string;
}

export function createRemoteBrowserExecutor({ host, token }: RemoteExecutorOptions) {
  // Return a drop-in replacement for runBrowserMode so the browser session runner can stay unchanged.
  return async function remoteBrowserExecutor(
    options: BrowserRunOptions,
  ): Promise<BrowserRunResult> {
    const payload: RemoteRunPayload = {
      prompt: options.prompt,
      attachments: await serializeAttachments(options.attachments ?? []),
      browserConfig: options.config ?? {},
      options: {
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        verbose: options.verbose,
      },
    };

    const body = Buffer.from(JSON.stringify(payload));
    const { hostname, port } = parseHost(host);
    const heartbeatMs = payload.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const idleTimeoutMs = Math.max(
      heartbeatMs * SOCKET_IDLE_TIMEOUT_MULTIPLIER,
      MIN_SOCKET_IDLE_TIMEOUT_MS,
    );

    const state: StreamState = {
      runId: null,
      cursor: -1,
      resolved: null,
      remoteError: null,
    };

    let attempt = 0;
    let lastError: unknown = null;
    while (attempt <= MAX_RECONNECT_ATTEMPTS) {
      try {
        if (attempt === 0) {
          await streamRun({
            mode: "start",
            hostname,
            port,
            token,
            body,
            options,
            state,
            idleTimeoutMs,
          });
        } else {
          if (!state.runId) {
            // No runId means the initial POST never landed an event — retry
            // the POST itself. Re-using the same body is safe because the
            // server treats every POST /runs as a fresh run.
            await streamRun({
              mode: "start",
              hostname,
              port,
              token,
              body,
              options,
              state,
              idleTimeoutMs,
            });
          } else {
            options.log?.(
              `[remote] reconnecting to runId=${state.runId} cursor=${state.cursor} (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS})`,
            );
            await streamRun({
              mode: "resume",
              hostname,
              port,
              token,
              options,
              state,
              idleTimeoutMs,
            });
          }
        }
        if (state.resolved) {
          return state.resolved;
        }
        if (state.remoteError) {
          throw new Error(state.remoteError);
        }
        // Stream ended without terminal event — treat as transient.
        throw new Error("Stream closed before result was received");
      } catch (error) {
        lastError = error;
        if (!isTransientError(error) || attempt >= MAX_RECONNECT_ATTEMPTS) {
          break;
        }
        attempt += 1;
        const delay = backoffDelayMs(attempt);
        options.log?.(
          `[remote] transient transport error: ${formatRemoteErrorMessage(error)} — retrying in ${delay}ms`,
        );
        await sleep(delay);
      }
    }

    if (state.resolved) {
      return state.resolved;
    }
    const finalMessage = formatRemoteErrorMessage(lastError);
    const prefix = state.runId
      ? `Remote browser run ${state.runId} failed`
      : `Unable to connect to remote oracle serve at ${host}`;
    throw new Error(`${prefix}: ${finalMessage}`);
  };
}

interface StreamArgs {
  mode: "start" | "resume";
  hostname: string;
  port: number;
  token?: string;
  body?: Buffer;
  options: BrowserRunOptions;
  state: StreamState;
  idleTimeoutMs: number;
}

function streamRun(args: StreamArgs): Promise<void> {
  const { mode, hostname, port, token, body, options, state, idleTimeoutMs } = args;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let activeResponse: http.IncomingMessage | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      activeResponse?.destroy();
      resolve();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const requestPath =
      mode === "start"
        ? "/runs"
        : `/runs/${encodeURIComponent(state.runId!)}/events?cursor=${state.cursor}`;
    const method = mode === "start" ? "POST" : "GET";
    const headers: Record<string, string | number> = {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
    if (mode === "start" && body) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = body.length;
    }

    const req = http.request(
      {
        hostname,
        port,
        path: requestPath,
        method,
        headers,
      },
      (res) => {
        if (res.statusCode === 410) {
          // Server has GC'd this run; cannot resume — surface as terminal.
          collectError(res)
            .then((message) =>
              fail(
                new Error(
                  message ||
                    `Remote run ${state.runId} no longer available (server GC'd before reconnect).`,
                ),
              ),
            )
            .catch(fail);
          return;
        }
        if (res.statusCode === 404 && mode === "resume") {
          collectError(res)
            .then((message) =>
              fail(new Error(message || `Remote run ${state.runId} not found on host.`)),
            )
            .catch(fail);
          return;
        }
        if (res.statusCode !== 200) {
          collectError(res)
            .then((message) => fail(new Error(message)))
            .catch(fail);
          return;
        }
        activeResponse = res;

        // Apply TCP keepalive + nodelay on the underlying socket so dead peers
        // surface within seconds instead of after macOS' default 2-hour idle.
        const socket = res.socket;
        if (socket) {
          try {
            socket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_MS);
            socket.setNoDelay(true);
            socket.setTimeout(idleTimeoutMs);
          } catch {
            // ignore — best-effort socket tuning
          }
        }

        res.setEncoding("utf8");
        let buffer = "";

        const onSocketTimeout = () => {
          // No bytes for idleTimeoutMs — treat as dead and tear down so the
          // outer retry loop can reconnect.
          const err: NodeJS.ErrnoException = new Error(
            `socket idle timeout after ${idleTimeoutMs}ms (no events from remote)`,
          );
          err.code = "ETIMEDOUT";
          req.destroy(err);
        };
        socket?.on("timeout", onSocketTimeout);

        res.on("data", (chunk: string) => {
          buffer += chunk;
          let newlineIndex = buffer.indexOf("\n");
          while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (line.length > 0) {
              try {
                handleEvent(line, options, state, `${hostname}:${port}`);
                if (state.resolved || state.remoteError) {
                  finish();
                  return;
                }
              } catch (error) {
                req.destroy(error instanceof Error ? error : new Error(String(error)));
                return;
              }
            }
            newlineIndex = buffer.indexOf("\n");
          }
        });

        res.on("end", () => {
          socket?.off("timeout", onSocketTimeout);
          finish();
        });

        res.on("error", (err) => {
          socket?.off("timeout", onSocketTimeout);
          if (settled && (state.resolved || state.remoteError)) return;
          fail(err);
        });
      },
    );

    req.on("socket", (socket) => {
      try {
        socket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_MS);
        socket.setNoDelay(true);
      } catch {
        // ignore — best-effort
      }
    });
    req.on("error", (error) => {
      if (settled && (state.resolved || state.remoteError)) return;
      fail(error);
    });
    req.setTimeout(idleTimeoutMs, () => {
      const err: NodeJS.ErrnoException = new Error(`request idle timeout after ${idleTimeoutMs}ms`);
      err.code = "ETIMEDOUT";
      req.destroy(err);
    });

    if (mode === "start" && body) {
      req.write(body);
    }
    req.end();
  });
}

function handleEvent(line: string, options: BrowserRunOptions, state: StreamState, host?: string) {
  let event: RemoteRunEvent;
  try {
    event = JSON.parse(line) as RemoteRunEvent;
  } catch (error) {
    throw new Error(
      `Failed to parse remote event: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    typeof event !== "object" ||
    event === null ||
    typeof (event as { type?: unknown }).type !== "string"
  ) {
    return;
  }
  if (typeof (event as { seq?: unknown }).seq === "number") {
    state.cursor = Math.max(state.cursor, (event as { seq: number }).seq);
  }
  if (event.type === "runId") {
    state.runId = event.runId;
    state.retentionMs = event.retentionMs;
    state.startedAt = event.startedAt;
    emitRemoteHint(options, state, host, { status: "running" });
    return;
  }
  if (event.type === "log") {
    options.log?.(event.message);
    return;
  }
  if (event.type === "error") {
    state.remoteError = event.message;
    emitRemoteHint(options, state, host, {
      status: "errored",
      completedAt: new Date().toISOString(),
      unavailableReason: event.message,
    });
    return;
  }
  if (event.type === "result") {
    state.resolved = event.result;
    emitRemoteHint(options, state, host, {
      status: "completed",
      completedAt: new Date().toISOString(),
      conversationUrl: event.result.tabUrl,
    });
  }
}

function emitRemoteHint(
  options: BrowserRunOptions,
  state: StreamState,
  host: string | undefined,
  updates: Partial<BrowserRemoteRunMetadata>,
): void {
  if (!options.remoteHintCb || !host || !state.runId) return;
  void options.remoteHintCb({
    host,
    runId: state.runId,
    cursor: state.cursor,
    retentionMs: state.retentionMs,
    startedAt: state.startedAt,
    updatedAt: new Date().toISOString(),
    ...updates,
  });
}

export type RemoteBrowserRecoveryResult =
  | { status: "completed"; result: BrowserRunResult; remote: BrowserRemoteRunMetadata }
  | { status: "errored"; message: string; remote: BrowserRemoteRunMetadata }
  | { status: "running"; remote: BrowserRemoteRunMetadata }
  | { status: "unavailable"; message: string; remote: BrowserRemoteRunMetadata };

export async function recoverRemoteBrowserRun({
  host,
  token,
  runId,
  cursor = -1,
}: {
  host: string;
  token?: string;
  runId: string;
  cursor?: number;
}): Promise<RemoteBrowserRecoveryResult> {
  const { hostname, port } = parseHost(host);
  const state: StreamState = { runId, cursor, resolved: null, remoteError: null };
  try {
    await streamRun({
      mode: "resume",
      hostname,
      port,
      token,
      options: { prompt: "" },
      state,
      idleTimeoutMs: MIN_SOCKET_IDLE_TIMEOUT_MS,
    });
  } catch (error) {
    const message = formatRemoteErrorMessage(error);
    return {
      status: "unavailable",
      message,
      remote: {
        host,
        runId,
        cursor: state.cursor,
        status: "unavailable",
        updatedAt: new Date().toISOString(),
        unavailableReason: message,
      },
    };
  }
  const baseRemote: BrowserRemoteRunMetadata = {
    host,
    runId,
    cursor: state.cursor,
    retentionMs: state.retentionMs,
    startedAt: state.startedAt,
    updatedAt: new Date().toISOString(),
  };
  if (state.resolved) {
    return {
      status: "completed",
      result: state.resolved,
      remote: {
        ...baseRemote,
        status: "completed",
        completedAt: new Date().toISOString(),
        conversationUrl: state.resolved.tabUrl,
      },
    };
  }
  if (state.remoteError) {
    return {
      status: "errored",
      message: state.remoteError,
      remote: {
        ...baseRemote,
        status: "errored",
        completedAt: new Date().toISOString(),
        unavailableReason: state.remoteError,
      },
    };
  }
  return { status: "running", remote: { ...baseRemote, status: "running" } };
}

async function serializeAttachments(
  attachments: BrowserAttachment[],
): Promise<RemoteAttachmentPayload[]> {
  const serialized: RemoteAttachmentPayload[] = [];
  for (const attachment of attachments) {
    // Read the local file upfront so the remote host never touches the caller's filesystem.
    const content = await readFile(attachment.path);
    serialized.push({
      fileName: path.basename(attachment.path),
      displayPath: attachment.displayPath,
      sizeBytes: attachment.sizeBytes,
      contentBase64: content.toString("base64"),
    });
  }
  return serialized;
}

function parseHost(input: string): { hostname: string; port: number } {
  try {
    return parseHostPort(input);
  } catch (error) {
    throw new Error(
      `Invalid remote host: ${input} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function collectError(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    res.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed.error ?? `Remote host responded with status ${res.statusCode}`);
      } catch {
        resolve(raw || `Remote host responded with status ${res.statusCode}`);
      }
    });
    res.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
