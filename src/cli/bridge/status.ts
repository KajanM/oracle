import http from "node:http";
import chalk from "chalk";
import { configPath as defaultConfigPath } from "../../config.js";
import { readUserConfigFile } from "../../bridge/userConfigFile.js";
import { parseHostPort } from "../../bridge/connection.js";
import { checkRemoteHealth } from "../../remote/health.js";
import type { RemoteRunsListing, RemoteRunSummary } from "../../remote/types.js";

export interface BridgeStatusOptions {
  host?: string;
  token?: string;
  config?: string;
  json?: boolean;
  timeout?: number;
}

export async function runBridgeStatus(options: BridgeStatusOptions): Promise<void> {
  const resolved = await resolveHostToken(options);
  const host = resolved.host;
  const token = resolved.token;
  if (!host) {
    throw new Error(
      "Missing remote host. Pass --host <host:port> or configure ~/.oracle/config.json (browser.remoteHost).",
    );
  }

  const timeoutMs = options.timeout ?? 5000;
  const health = await checkRemoteHealth({ host, token, timeoutMs });
  const listing = health.ok ? await fetchRunsListing({ host, token, timeoutMs }) : null;

  if (options.json) {
    const payload = {
      host,
      health,
      runs: listing,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  printHumanStatus(host, health, listing);
}

async function resolveHostToken(
  options: BridgeStatusOptions,
): Promise<{ host: string; token: string | undefined }> {
  if (options.host) {
    return { host: options.host, token: options.token };
  }
  if (process.env.ORACLE_REMOTE_HOST) {
    return {
      host: process.env.ORACLE_REMOTE_HOST,
      token: options.token ?? process.env.ORACLE_REMOTE_TOKEN,
    };
  }
  const configFilePath = options.config?.trim() || defaultConfigPath();
  try {
    const { config } = await readUserConfigFile(configFilePath);
    const browser = config.browser;
    return {
      host: browser?.remoteHost ?? "",
      token: options.token ?? browser?.remoteToken ?? undefined,
    };
  } catch {
    return { host: "", token: options.token };
  }
}

async function fetchRunsListing({
  host,
  token,
  timeoutMs,
}: {
  host: string;
  token?: string;
  timeoutMs: number;
}): Promise<RemoteRunsListing | { ok: false; error: string }> {
  const { hostname, port } = parseHostPort(host);
  return await new Promise((resolve) => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request(
      { hostname, port, path: "/runs", method: "GET", headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            const json = body.length ? JSON.parse(body) : null;
            if (res.statusCode === 200 && json && typeof json === "object") {
              resolve(json as RemoteRunsListing);
              return;
            }
            if (res.statusCode === 404) {
              resolve({
                ok: false,
                error: "remote host does not expose /runs (upgrade oracle on the host)",
              });
              return;
            }
            resolve({
              ok: false,
              error:
                (json && typeof json === "object" && "error" in (json as object)
                  ? String((json as { error: unknown }).error)
                  : "") || `HTTP ${res.statusCode}`,
            });
          } catch (error) {
            resolve({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err.message });
    });
    req.end();
  });
}

function printHumanStatus(
  host: string,
  health: Awaited<ReturnType<typeof checkRemoteHealth>>,
  listing: RemoteRunsListing | { ok: false; error: string } | null,
) {
  const heading = chalk.bold(`Remote: ${host}`);
  process.stdout.write(`${heading}\n`);
  if (!health.ok) {
    const suffix = health.statusCode ? ` (HTTP ${health.statusCode})` : "";
    process.stdout.write(
      chalk.red(`  health: FAIL — ${health.error ?? "unknown"}${suffix}\n`),
    );
    return;
  }
  process.stdout.write(
    chalk.green(
      `  health: OK — oracle ${health.version ?? "?"} up ${formatUptime(health.uptimeSeconds)}\n`,
    ),
  );

  if (!listing) {
    return;
  }
  if (!("active" in listing)) {
    process.stdout.write(chalk.yellow(`  runs: unavailable — ${listing.error}\n`));
    return;
  }

  const active = listing.active;
  const recent = listing.recent;
  process.stdout.write(`  active runs: ${active.length}\n`);
  for (const run of active) {
    process.stdout.write(`    ${formatActiveRun(run)}\n`);
  }
  if (recent.length === 0) {
    process.stdout.write("  recent runs: none\n");
    return;
  }
  process.stdout.write(`  recent runs (retained ${formatMs(listing.retentionMs)}):\n`);
  for (const run of recent.slice(0, 10)) {
    process.stdout.write(`    ${formatRecentRun(run)}\n`);
  }
}

function formatActiveRun(run: RemoteRunSummary): string {
  const elapsedMs = Date.now() - new Date(run.startedAt).getTime();
  const disconnects = run.totalDisconnects > 0 ? chalk.yellow(` ⚠ ${run.totalDisconnects} disconnect(s)`) : "";
  return `${chalk.cyan(run.runId.slice(0, 8))} elapsed=${formatMs(elapsedMs)} clients=${run.attachedClients} events=${run.eventCount}${disconnects}`;
}

function formatRecentRun(run: RemoteRunSummary): string {
  const status =
    run.status === "completed"
      ? chalk.green(run.status)
      : run.status === "errored"
        ? chalk.red(run.status)
        : chalk.yellow(run.status);
  const dur = run.durationMs !== undefined ? formatMs(run.durationMs) : "?";
  const disconnects =
    run.totalDisconnects > 0 ? chalk.yellow(` disconnects=${run.totalDisconnects}`) : "";
  return `${chalk.cyan(run.runId.slice(0, 8))} ${status} dur=${dur} events=${run.eventCount}${disconnects}`;
}

function formatUptime(seconds?: number): string {
  if (!seconds || seconds < 0) return "?";
  return formatMs(seconds * 1000);
}

function formatMs(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 90) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min}m`;
  const hr = (min / 60).toFixed(1);
  return `${hr}h`;
}
