#!/usr/bin/env tsx
/**
 * metrics-backfill.ts — Compute chain-level success rates from session history.
 *
 * Reads ~/.oracle/sessions/, groups sessions by heuristic base slug,
 * and outputs three rates:
 *   1. Preflight pass rate   (sessions that got past validation)
 *   2. Execution success rate (sessions that completed once running)
 *   3. Work-item chain success rate (at least one attempt in chain succeeded)
 *
 * Usage:  npx tsx scripts/metrics-backfill.ts [--hours N] [--pretty]
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface SessionMeta {
  id: string;
  createdAt: string;
  status: "pending" | "running" | "completed" | "error" | "cancelled";
  mode?: "api" | "browser";
  errorMessage?: string;
  error?: { category?: string; message?: string };
  elapsedMs?: number;
  startedAt?: string;
  completedAt?: string;
}

interface ChainSummary {
  baseSlug: string;
  sessions: {
    id: string;
    status: string;
    errorCategory: string | null;
    preflightFailed: boolean;
    createdAt: string;
  }[];
  totalAttempts: number;
  preflightFailures: number;
  executionFailures: number;
  successes: number;
  chainSucceeded: boolean;
}

/* ------------------------------------------------------------------ */
/*  Preflight error categories — these fail before Chrome even starts  */
/* ------------------------------------------------------------------ */

const PREFLIGHT_CATEGORIES = new Set([
  "prompt-validation",
  "file-validation",
  "token-validation",
]);

function isPreflightError(meta: SessionMeta): boolean {
  const cat = meta.error?.category;
  if (cat && PREFLIGHT_CATEGORIES.has(cat)) return true;
  // Also catch browser-automation errors about limits/attachments that fire instantly
  const msg = meta.errorMessage ?? "";
  if (cat === "browser-automation") {
    if (
      msg.includes("System-wide Chrome limit") ||
      msg.includes("Too many attachments")
    )
      return true;
  }
  // Missing API key errors without category
  if (/^Missing \w+_API_KEY/.test(msg)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/*  Heuristic base slug extraction                                     */
/* ------------------------------------------------------------------ */

/**
 * Strip trailing -N suffix(es) to get the base slug for chain grouping.
 * e.g. "audit-builtin-command-consistenc-6" → "audit-builtin-command-consistenc"
 *      "audit-snapshots-tab-improvemen-15" → "audit-snapshots-tab-improvemen"
 *      "add-commit-phase-skill"            → "add-commit-phase-skill"
 */
function extractBaseSlug(id: string): string {
  return id.replace(/-\d+$/, "");
}

/* ------------------------------------------------------------------ */
/*  Load sessions                                                      */
/* ------------------------------------------------------------------ */

async function loadSessions(
  sessionsDir: string,
  hoursBack: number
): Promise<SessionMeta[]> {
  const cutoff = hoursBack > 0 ? Date.now() - hoursBack * 3600_000 : 0;
  const entries = await readdir(sessionsDir).catch(() => [] as string[]);
  const results: SessionMeta[] = [];

  for (const entry of entries) {
    const metaPath = join(sessionsDir, entry, "meta.json");
    try {
      const raw = await readFile(metaPath, "utf-8");
      const meta: SessionMeta = JSON.parse(raw);
      if (cutoff > 0 && new Date(meta.createdAt).getTime() < cutoff) continue;
      results.push(meta);
    } catch {
      // Missing or malformed meta.json — skip silently
    }
  }

  return results.sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

/* ------------------------------------------------------------------ */
/*  Group into chains                                                  */
/* ------------------------------------------------------------------ */

function groupIntoChains(sessions: SessionMeta[]): ChainSummary[] {
  const chainMap = new Map<string, SessionMeta[]>();

  for (const s of sessions) {
    const base = extractBaseSlug(s.id);
    let arr = chainMap.get(base);
    if (!arr) {
      arr = [];
      chainMap.set(base, arr);
    }
    arr.push(s);
  }

  const chains: ChainSummary[] = [];

  for (const [baseSlug, members] of chainMap) {
    const sessionSummaries = members.map((m) => ({
      id: m.id,
      status: m.status,
      errorCategory: m.error?.category ?? null,
      preflightFailed: m.status === "error" && isPreflightError(m),
      createdAt: m.createdAt,
    }));

    const preflightFailures = sessionSummaries.filter(
      (s) => s.preflightFailed
    ).length;
    const successes = sessionSummaries.filter(
      (s) => s.status === "completed"
    ).length;
    const executionFailures = sessionSummaries.filter(
      (s) => s.status === "error" && !s.preflightFailed
    ).length;

    chains.push({
      baseSlug,
      sessions: sessionSummaries,
      totalAttempts: members.length,
      preflightFailures,
      executionFailures,
      successes,
      chainSucceeded: successes > 0,
    });
  }

  return chains.sort((a, b) => (a.baseSlug < b.baseSlug ? -1 : 1));
}

/* ------------------------------------------------------------------ */
/*  Compute aggregate rates                                            */
/* ------------------------------------------------------------------ */

interface AggregateMetrics {
  totalSessions: number;
  totalChains: number;
  hoursBack: number | "all";

  preflightPassRate: string;
  preflightPassed: number;
  preflightFailed: number;

  executionSuccessRate: string;
  executionAttempted: number;
  executionSucceeded: number;
  executionFailed: number;

  chainSuccessRate: string;
  chainsSucceeded: number;
  chainsFailed: number;

  errorBreakdown: Record<string, number>;
  chains: ChainSummary[];
}

function computeMetrics(
  sessions: SessionMeta[],
  chains: ChainSummary[],
  hoursBack: number
): AggregateMetrics {
  const preflightFailed = sessions.filter(
    (s) => s.status === "error" && isPreflightError(s)
  ).length;
  const preflightPassed = sessions.length - preflightFailed;

  // Execution: only count sessions that passed preflight
  const executionPool = sessions.filter(
    (s) => !(s.status === "error" && isPreflightError(s))
  );
  const executionSucceeded = executionPool.filter(
    (s) => s.status === "completed"
  ).length;
  const executionFailed = executionPool.filter(
    (s) => s.status === "error"
  ).length;

  const chainsSucceeded = chains.filter((c) => c.chainSucceeded).length;
  const chainsFailed = chains.length - chainsSucceeded;

  // Error breakdown
  const errorBreakdown: Record<string, number> = {};
  for (const s of sessions) {
    if (s.status !== "error") continue;
    const cat = s.error?.category ?? "uncategorized";
    errorBreakdown[cat] = (errorBreakdown[cat] || 0) + 1;
  }

  const pct = (n: number, d: number) =>
    d === 0 ? "N/A" : `${((n / d) * 100).toFixed(1)}%`;

  return {
    totalSessions: sessions.length,
    totalChains: chains.length,
    hoursBack: hoursBack > 0 ? hoursBack : "all",

    preflightPassRate: pct(preflightPassed, sessions.length),
    preflightPassed,
    preflightFailed,

    executionSuccessRate: pct(executionSucceeded, executionPool.length),
    executionAttempted: executionPool.length,
    executionSucceeded,
    executionFailed,

    chainSuccessRate: pct(chainsSucceeded, chains.length),
    chainsSucceeded,
    chainsFailed,

    errorBreakdown,
    chains,
  };
}

/* ------------------------------------------------------------------ */
/*  CLI                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const args = process.argv.slice(2);
  const hoursIdx = args.indexOf("--hours");
  const hoursBack = hoursIdx >= 0 ? Number(args[hoursIdx + 1]) : 0; // 0 = all
  const pretty = args.includes("--pretty");

  const sessionsDir = join(homedir(), ".oracle", "sessions");
  const sessions = await loadSessions(sessionsDir, hoursBack);
  const chains = groupIntoChains(sessions);
  const metrics = computeMetrics(sessions, chains, hoursBack);

  const json = pretty
    ? JSON.stringify(metrics, null, 2)
    : JSON.stringify(metrics);
  process.stdout.write(json + "\n");
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
