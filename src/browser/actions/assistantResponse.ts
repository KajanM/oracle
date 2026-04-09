import type { ChromeClient, BrowserLogger } from "../types.js";
import {
  ANSWER_SELECTORS,
  ASSISTANT_ROLE_SELECTOR,
  COMPOSER_SUBMIT_BUTTON_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  COPY_BUTTON_SELECTOR,
  FINISHED_ACTIONS_SELECTOR,
  STOP_BUTTON_SELECTOR,
} from "../constants.js";
import { delay } from "../utils.js";
import {
  logDomFailure,
  logConversationSnapshot,
  buildConversationDebugExpression,
} from "../domDebug.js";
import { AssistantSurface, getChatgptDomSession } from "../dom/index.js";
import { buildClickDispatcher } from "./domEvents.js";

const ASSISTANT_POLL_TIMEOUT_ERROR = "assistant-response-watchdog-timeout";
const ASSISTANT_POLL_INITIAL_DELAY_MS = 200;
const ASSISTANT_POLL_MAX_DELAY_MS = 1_000;
const ASSISTANT_PARTIAL_CAPTURE_INTERVAL_MS = 15_000;
const CONSECUTIVE_EVAL_FAILURE_LIMIT = 20;
const TEXT_STABILITY_THRESHOLD = 15;
const MIN_PARTIAL_CHARS = 200;
// Second poller runs when the evaluation returns but the stop button is still
// visible (ChatGPT Extended Pro thinking). Cap at 45 minutes — even extended
// thinking models finish within this window. Prevents indefinite waiting when
// the stop button gets stuck in the DOM or Chrome becomes unresponsive.
const SECOND_POLLER_MAX_TIMEOUT_MS = 45 * 60 * 1_000;

interface AssistantDomContext {
  session: ReturnType<typeof getChatgptDomSession>;
  surface: AssistantSurface;
}

async function createAssistantDomContext(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<AssistantDomContext | null> {
  try {
    const session = getChatgptDomSession(Runtime, undefined, logger);
    const health = await session.bootstrap(["assistant.latestTurn", "assistant.copyButton"]);
    if (!health?.ok) {
      throw new Error("bootstrap returned unhealthy result");
    }
    return {
      session,
      surface: new AssistantSurface(session, Runtime, undefined, logger),
    };
  } catch (error) {
    logger(
      `[browser] [dom] assistant bootstrap failed, falling back to inline selectors: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function isAnswerNowPlaceholderText(normalized: string): boolean {
  const text = normalized.trim();
  if (!text) return false;
  // Learned: "Pro thinking" shows a placeholder turn that contains "Answer now".
  // That is not the final answer and must be ignored in browser automation.
  if (text === "chatgpt said:" || text === "chatgpt said") return true;
  if (
    text.includes("file upload request") &&
    (text.includes("pro thinking") || text.includes("chatgpt said"))
  ) {
    return true;
  }
  return (
    text.includes("answer now") && (text.includes("pro thinking") || text.includes("chatgpt said"))
  );
}

export async function waitForAssistantResponse(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
}> {
  const start = Date.now();
  logger("Waiting for ChatGPT response");
  const domContext = await createAssistantDomContext(Runtime, logger);
  // Learned: two paths are needed:
  // 1) DOM observer (fast when mutations fire),
  // 2) snapshot poller (fallback when observers miss or JS stalls).
  const expression = buildResponseObserverExpression(timeoutMs, minTurnIndex);
  const evaluationPromise = Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const raceReadyEvaluation = evaluationPromise.then(
    (value) => ({ kind: "evaluation" as const, value }),
    (error) => {
      throw { source: "evaluation" as const, error };
    },
  );
  // Use AbortController to stop the poller when the evaluation wins the race,
  // preventing abandoned polling loops from consuming resources.
  const pollerAbort = new AbortController();
  const pollerPromise = pollAssistantCompletion(
    Runtime,
    timeoutMs,
    minTurnIndex,
    pollerAbort.signal,
    logger,
    domContext,
  ).then(
    (value) => ({ kind: "poll" as const, value }),
    (error) => {
      throw { source: "poll" as const, error };
    },
  );

  let evaluation: Awaited<ReturnType<ChromeClient["Runtime"]["evaluate"]>> | null = null;
  try {
    const winner = await Promise.race([raceReadyEvaluation, pollerPromise]);
    if (winner.kind === "poll") {
      if (!winner.value) {
        throw { source: "poll" as const, error: new Error(ASSISTANT_POLL_TIMEOUT_ERROR) };
      }
      logger(`[browser] [response] poller won race — ${winner.value.text.length} chars captured`);
      evaluationPromise.catch(() => undefined);
      await terminateRuntimeExecution(Runtime);
      return winner.value;
    }
    // Evaluation won - abort the poller to prevent it from running until timeout
    pollerAbort.abort();
    logger("[browser] [response] evaluation won race — aborting poller");
    evaluation = winner.value;
  } catch (wrappedError) {
    if (
      wrappedError &&
      typeof wrappedError === "object" &&
      "source" in wrappedError &&
      "error" in wrappedError
    ) {
      const { source, error } = wrappedError as { source: string; error: unknown };
      if (
        source === "poll" &&
        error instanceof Error &&
        error.message === ASSISTANT_POLL_TIMEOUT_ERROR
      ) {
        evaluation = await evaluationPromise;
      } else if (source === "poll") {
        throw error;
      } else if (source === "evaluation") {
        const recovered = await recoverAssistantResponse(
          Runtime,
          timeoutMs,
          logger,
          minTurnIndex,
          domContext,
        );
        if (recovered) {
          return recovered;
        }
        await logDomFailure(Runtime, logger, "assistant-response");
        throw error ?? new Error("Failed to capture assistant response");
      }
    } else {
      throw wrappedError;
    }
  }

  if (!evaluation) {
    await logDomFailure(Runtime, logger, "assistant-response");
    throw new Error("Failed to capture assistant response");
  }

  const parsed = await parseAssistantEvaluationResult(Runtime, evaluation, logger);
  if (!parsed) {
    logger("[browser] [response] evaluation result unparseable — attempting recovery");
    let remainingMs = Math.max(0, timeoutMs - (Date.now() - start));
    if (remainingMs > 0) {
      const recovered = await recoverAssistantResponse(
        Runtime,
        remainingMs,
        logger,
        minTurnIndex,
        domContext,
      );
      if (recovered) {
        return recovered;
      }
      remainingMs = Math.max(0, timeoutMs - (Date.now() - start));
      if (remainingMs > 0) {
        const polled = await Promise.race([
          pollerPromise.catch(() => null),
          delay(remainingMs).then(() => null),
        ]);
        if (polled && polled.kind === "poll" && polled.value) {
          return polled.value;
        }
      }
    }
    await logDomFailure(Runtime, logger, "assistant-response");
    throw new Error("Unable to capture assistant response");
  }

  logger(`[browser] [response] evaluation parsed — ${parsed.text.length} chars, messageId=${parsed.meta.messageId ?? "none"}`);
  const refreshed = await refreshAssistantSnapshot(
    Runtime,
    parsed,
    logger,
    minTurnIndex,
    domContext,
  );
  const candidate = refreshed ?? parsed;
  if (refreshed) {
    logger(`[browser] [response] snapshot refreshed — ${parsed.text.length}→${refreshed.text.length} chars`);
  }
  // The evaluation path can race ahead of completion. If ChatGPT is still streaming, wait for the watchdog poller.
  const elapsedMs = Date.now() - start;
  const remainingMs = Math.max(0, timeoutMs - elapsedMs);
  if (remainingMs > 0) {
    const generationState = await readAssistantGenerationUiState(Runtime, domContext);
    const dbg = generationState.debug;
    logger(`[browser] [response] post-eval state — stop=${generationState.stopVisible} completion=${generationState.completionVisible} turns=${dbg?.turnCount ?? "?"} copyGlobal=${dbg?.copyButtonGlobal ?? "?"} copyInTurn=${dbg?.copyButtonInTurn ?? "?"} composerReady=${dbg?.composerReady ?? "?"}`);
    if (generationState.stopVisible) {
      const secondPollerTimeout = Math.min(remainingMs, SECOND_POLLER_MAX_TIMEOUT_MS);
      logger(`[browser] [response] entering second poller — candidate=${candidate.text.length} chars, timeout=${secondPollerTimeout}ms`);
      try {
        const completed = await pollAssistantCompletion(
          Runtime,
          secondPollerTimeout,
          minTurnIndex,
          undefined,
          logger,
          domContext,
        );
        if (completed) {
          logger(`[browser] [response] second poller completed — ${completed.text.length} chars`);
          return completed;
        }
        logger(`[browser] [response] second poller returned null — attempting final snapshot`);
      } catch (pollerError) {
        logger(`[browser] [response] second poller failed (CDP disconnect?) — attempting final snapshot`);
      }
      // The second poller timed out or Chrome disconnected. Attempt one last
      // snapshot capture — Chrome may still be responsive enough for a single
      // evaluation even if the polling loop failed. Pick the longest text
      // between the initial candidate and the final snapshot.
      try {
        const finalSnapshot = await readAssistantSnapshot(Runtime, minTurnIndex, domContext);
        const finalResult = normalizeAssistantSnapshot(finalSnapshot);
        if (finalResult && finalResult.text.length > candidate.text.length) {
          logger(`[browser] [response] final snapshot captured ${finalResult.text.length} chars (was ${candidate.text.length}) — using snapshot`);
          return finalResult;
        }
      } catch {
        // Chrome is truly gone — fall through to candidate
      }
      logger(`[browser] [response] returning candidate (${candidate.text.length} chars)`);
    }
  }

  return candidate;
}

export async function readAssistantSnapshot(
  Runtime: ChromeClient["Runtime"],
  minTurnIndex?: number,
  domContextArg?: AssistantDomContext | null,
): Promise<AssistantSnapshot | null> {
  const domContext = domContextArg ?? (await createAssistantDomContext(Runtime, () => {}));
  if (domContext) {
    try {
      const turn = await domContext.session.withRepair("assistant", () =>
        domContext.session.resolve("assistant.latestTurn", { refresh: true }),
      );
      if (turn.ok && turn.oracleId) {
        const snapshot = await domContext.surface.readSnapshot();
        const { result: metaResult } = await Runtime.evaluate({
          expression: `(() => {
            const node = document.querySelector('[data-oracle-id="${turn.oracleId}"]');
            const container =
              node?.closest?.(${JSON.stringify(CONVERSATION_TURN_SELECTOR)}) ?? node ?? null;
            return {
              messageId:
                container?.getAttribute?.('data-message-id') ??
                node?.getAttribute?.('data-message-id') ??
                null,
              turnId:
                node?.getAttribute?.('data-oracle-id') ??
                container?.getAttribute?.('data-testid') ??
                null,
            };
          })()`,
          returnByValue: true,
        });
        const meta = (metaResult?.value ?? {}) as {
          messageId?: string | null;
          turnId?: string | null;
        };
        const normalized: AssistantSnapshot = {
          text: snapshot.text,
          html: snapshot.html,
          turnIndex: snapshot.turnIndex,
          turnId: meta.turnId ?? snapshot.oracleId ?? null,
          messageId: meta.messageId ?? null,
        };
        if (typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex)) {
          const turnIndex =
            typeof normalized.turnIndex === "number" ? normalized.turnIndex : null;
          if (turnIndex !== null && turnIndex < minTurnIndex) {
            return null;
          }
        }
        if (normalized.text?.trim()) {
          return normalized;
        }
      }
    } catch {
      // Fall back to the legacy snapshot expression.
    }
  }
  const { result } = await Runtime.evaluate({
    expression: buildAssistantSnapshotExpression(minTurnIndex),
    returnByValue: true,
  });
  const value = result?.value;
  if (value && typeof value === "object") {
    const snapshot = value as AssistantSnapshot;
    if (typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex)) {
      const turnIndex = typeof snapshot.turnIndex === "number" ? snapshot.turnIndex : null;
      if (turnIndex === null) {
        return snapshot;
      }
      if (turnIndex < minTurnIndex) {
        return null;
      }
    }
    return snapshot;
  }
  return null;
}

export async function captureAssistantMarkdown(
  Runtime: ChromeClient["Runtime"],
  meta: { messageId?: string | null; turnId?: string | null },
  logger: BrowserLogger,
  domContextArg?: AssistantDomContext | null,
): Promise<string | null> {
  const domContext = domContextArg ?? (await createAssistantDomContext(Runtime, logger));
  if (domContext) {
    try {
      const snapshot = await domContext.surface.readSnapshot();
      if (snapshot.text?.trim()) {
        const markdown = await domContext.surface.copyMarkdown();
        if (typeof markdown === "string" && markdown.trim()) {
          return markdown;
        }
      }
    } catch {
      // Fall back to the legacy clipboard expression.
    }
  }
  const { result } = await Runtime.evaluate({
    expression: buildCopyExpression(meta),
    returnByValue: true,
    awaitPromise: true,
  });
  if (result?.value?.success && typeof result.value.markdown === "string") {
    return result.value.markdown;
  }
  const status = result?.value?.status;
  if (status && status !== "missing-button") {
    logger(`Copy button fallback status: ${status}`);
    await logDomFailure(Runtime, logger, "copy-markdown");
  }
  if (!status) {
    await logDomFailure(Runtime, logger, "copy-markdown");
  }
  return null;
}

export function buildAssistantExtractorForTest(name: string): string {
  return buildAssistantExtractor(name);
}

export function buildConversationDebugExpressionForTest(): string {
  return buildConversationDebugExpression();
}

export function buildMarkdownFallbackExtractorForTest(minTurnLiteral = "0"): string {
  return buildMarkdownFallbackExtractor(minTurnLiteral);
}

export function buildCopyExpressionForTest(
  meta: { messageId?: string | null; turnId?: string | null } = {},
): string {
  return buildCopyExpression(meta);
}

async function recoverAssistantResponse(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
  domContext?: AssistantDomContext | null,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null> {
  const recoveryTimeoutMs = Math.max(0, timeoutMs);
  if (recoveryTimeoutMs === 0) {
    return null;
  }
  const recovered = await waitForCondition(
    async () => {
      const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex, domContext);
      return normalizeAssistantSnapshot(snapshot);
    },
    recoveryTimeoutMs,
    400,
  );
  if (recovered) {
    logger("Recovered assistant response via polling fallback");
    return recovered;
  }
  await logConversationSnapshot(Runtime, logger).catch(() => undefined);
  return null;
}

async function parseAssistantEvaluationResult(
  _Runtime: ChromeClient["Runtime"],
  evaluation: Awaited<ReturnType<ChromeClient["Runtime"]["evaluate"]>>,
  _logger: BrowserLogger,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null> {
  const { result } = evaluation;
  if (
    result.type === "object" &&
    result.value &&
    typeof result.value === "object" &&
    "text" in result.value
  ) {
    const html =
      typeof (result.value as { html?: unknown }).html === "string"
        ? ((result.value as { html?: string }).html ?? undefined)
        : undefined;
    const turnId =
      typeof (result.value as { turnId?: unknown }).turnId === "string"
        ? ((result.value as { turnId?: string }).turnId ?? undefined)
        : undefined;
    const messageId =
      typeof (result.value as { messageId?: unknown }).messageId === "string"
        ? ((result.value as { messageId?: string }).messageId ?? undefined)
        : undefined;
    const text = cleanAssistantText(String((result.value as { text: unknown }).text ?? ""));
    const normalized = text.toLowerCase();
    if (isAnswerNowPlaceholderText(normalized)) {
      return null;
    }
    return { text, html, meta: { turnId, messageId } };
  }
  const fallbackText =
    typeof result.value === "string" ? cleanAssistantText(result.value as string) : "";
  if (!fallbackText) {
    return null;
  }
  if (isAnswerNowPlaceholderText(fallbackText.toLowerCase())) {
    return null;
  }
  return { text: fallbackText, html: undefined, meta: {} };
}

async function refreshAssistantSnapshot(
  Runtime: ChromeClient["Runtime"],
  current: {
    text: string;
    html?: string;
    meta: { turnId?: string | null; messageId?: string | null };
  },
  logger: BrowserLogger,
  minTurnIndex?: number,
  domContext?: AssistantDomContext | null,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null> {
  const deadline = Date.now() + 5_000;
  let best: {
    text: string;
    html?: string;
    meta: { turnId?: string | null; messageId?: string | null };
  } | null = null;
  let stableCycles = 0;
  const stableTarget = 3;
  while (Date.now() < deadline) {
    // Learned: short/fast answers can race; poll a few extra cycles to pick up messageId + full text.
    const latestSnapshot = await readAssistantSnapshot(Runtime, minTurnIndex, domContext).catch(
      () => null,
    );
    const latest = normalizeAssistantSnapshot(latestSnapshot);
    if (latest) {
      if (
        !best ||
        latest.text.length > best.text.length ||
        (!best.meta.messageId && latest.meta.messageId)
      ) {
        best = latest;
        stableCycles = 0;
      } else if (latest.text.trim() === best.text.trim()) {
        stableCycles += 1;
      }
    }
    if (best && stableCycles >= stableTarget) {
      break;
    }
    await delay(300);
  }
  if (!best) {
    return null;
  }
  const currentLength = cleanAssistantText(current.text).trim().length;
  const latestLength = best.text.length;
  const hasBetterId = !current.meta?.messageId && Boolean(best.meta.messageId);
  const isLonger = latestLength > currentLength;
  const hasDifferentText = best.text.trim() !== current.text.trim();
  if (isLonger || hasBetterId || hasDifferentText) {
    logger("Refreshed assistant response via latest snapshot");
    return best;
  }
  return null;
}

async function terminateRuntimeExecution(Runtime: ChromeClient["Runtime"]): Promise<void> {
  if (typeof Runtime.terminateExecution !== "function") {
    return;
  }
  try {
    await Runtime.terminateExecution();
  } catch {
    // terminateExecution is best-effort; not all Runtime implementations support it
  }
}

export async function pollAssistantCompletion(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  minTurnIndex?: number,
  abortSignal?: AbortSignal,
  logger?: BrowserLogger,
  domContext?: AssistantDomContext | null,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null> {
  const watchdogDeadline = Date.now() + timeoutMs;
  const pollStartMs = Date.now();
  let pollDelayMs = ASSISTANT_POLL_INITIAL_DELAY_MS;
  let nextPartialCaptureAt = Date.now() + ASSISTANT_PARTIAL_CAPTURE_INTERVAL_MS;
  let nextStatusLogAt = Date.now() + 30_000;
  let lastPartialText = "";
  let done = false;
  let pollCycles = 0;
  let lastStopVisible = false;
  let lastCompletionVisible = false;
  let noStopStableCycles = 0;
  let consecutiveEvalFailures = 0;
  // Track how many times completionVisible has been true while stop is also true.
  // This catches multi-turn thinking patterns where copy buttons flicker on/off
  // as ChatGPT transitions between turns during extended thinking.
  let completionFlickerCount = 0;
  const COMPLETION_FLICKER_THRESHOLD = 3;
  // After flicker threshold is met, require text stability (no growth for N cycles)
  // before declaring completion. Prevents cutting off extended thinking runs that
  // emit interim turns and keep going.
  const FLICKER_STABILITY_CYCLES = 5;
  let lastPartialLength = 0;
  let textStableCycles = 0;
  if (logger) {
    logger(`[browser] [poll] start — timeout=${timeoutMs}ms minTurn=${minTurnIndex ?? "none"}`);
  }
  while (Date.now() < watchdogDeadline) {
    if (abortSignal?.aborted) {
      if (logger) {
        logger(`[browser] [poll] aborted after ${pollCycles} cycles`);
      }
      return null;
    }
    if (Date.now() >= nextPartialCaptureAt) {
      try {
        lastPartialText = await capturePartialAssistantProgress(
          Runtime,
          logger ?? (() => {}),
          minTurnIndex,
          lastPartialText,
          domContext,
        );
        consecutiveEvalFailures = 0;
      } catch (err) {
        consecutiveEvalFailures += 1;
        if (logger && consecutiveEvalFailures <= 3) {
          logger(`[browser] [warn] partial capture failed (consecutive=${consecutiveEvalFailures}): ${err instanceof Error ? err.message : err}`);
        }
      } finally {
        nextPartialCaptureAt = Date.now() + ASSISTANT_PARTIAL_CAPTURE_INTERVAL_MS;
      }
    }
    let generationState: {
      stopVisible: boolean;
      completionVisible: boolean;
      debug?: { turnCount: number; lastAssistantFound: boolean; copyButtonGlobal: boolean; copyButtonInTurn: boolean; composerReady?: boolean };
    };
    try {
      generationState = await readAssistantGenerationUiState(Runtime, domContext);
      consecutiveEvalFailures = 0;
    } catch (evalError) {
      consecutiveEvalFailures += 1;
      if (logger) {
        const msg = evalError instanceof Error ? evalError.message : String(evalError);
        logger(`[browser] [poll] Runtime.evaluate FAILED cycle=${pollCycles} consecutive=${consecutiveEvalFailures} error=${msg.slice(0, 200)}`);
      }
      // Keep the LAST KNOWN state instead of defaulting to { stopVisible: false }.
      // Defaulting to false would bias the state machine toward "stop disappeared",
      // falsely triggering the no-stop fallback during transient eval failures.
      generationState = { stopVisible: lastStopVisible, completionVisible: lastCompletionVisible };
    }
    pollCycles += 1;

    // When stop button disappears, immediately capture text for fallback detection
    if (!generationState.stopVisible && lastStopVisible) {
      try {
        lastPartialText = await capturePartialAssistantProgress(
          Runtime,
          logger ?? (() => {}),
          minTurnIndex,
          lastPartialText,
          domContext,
        );
      } catch (captureErr) {
        if (logger) {
          logger(`[browser] [poll] stop-transition partial capture failed: ${captureErr instanceof Error ? captureErr.message : captureErr}`);
        }
      }
    }

    if (!generationState.stopVisible) {
      noStopStableCycles += 1;
    } else {
      noStopStableCycles = 0;
    }

    // When the counter is accumulating but we have no text yet,
    // trigger an early partial capture to populate lastPartialText
    // so the fallback threshold can be evaluated.
    if (noStopStableCycles >= 5 && lastPartialText.length === 0) {
      try {
        lastPartialText = await capturePartialAssistantProgress(
          Runtime,
          logger ?? (() => {}),
          minTurnIndex,
          lastPartialText,
          domContext,
        );
        if (logger && lastPartialText.length > 0) {
          logger(`[browser] [poll] early partial capture succeeded: ${lastPartialText.length} chars`);
        }
      } catch (captureErr) {
        if (logger) {
          logger(`[browser] [poll] early partial capture failed (noStopStable=${noStopStableCycles}): ${captureErr instanceof Error ? captureErr.message : captureErr}`);
        }
      }
    }

    // If Runtime.evaluate has failed many times in a row, Chrome is likely
    // under severe resource pressure or disconnected. Attempt one final
    // snapshot capture and treat it as complete if we get any text.
    if (consecutiveEvalFailures >= CONSECUTIVE_EVAL_FAILURE_LIMIT) {
      if (logger) {
        logger(`[browser] [poll] ${consecutiveEvalFailures} consecutive eval failures — attempting final snapshot capture`);
      }
      try {
        const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex, domContext);
        const result = normalizeAssistantSnapshot(snapshot);
        if (result && result.text.length >= MIN_PARTIAL_CHARS) {
          if (logger) {
            logger(`[browser] [poll] recovered ${result.text.length} chars after eval failure streak — treating as complete`);
          }
          return result;
        }
      } catch {
        // final attempt failed too
      }
      consecutiveEvalFailures = 0;
    }

    // Track completion flicker BEFORE updating lastCompletionVisible.
    // completionVisible goes true while stop is also true during multi-turn
    // thinking when copy buttons appear briefly before a new turn starts.
    // Seeing this pattern multiple times is a strong signal of substantial output.
    if (generationState.stopVisible && generationState.completionVisible && !lastCompletionVisible) {
      completionFlickerCount += 1;
    }

    if (
      generationState.stopVisible !== lastStopVisible ||
      generationState.completionVisible !== lastCompletionVisible
    ) {
      if (logger) {
        const elapsedSec = Math.round((Date.now() - pollStartMs) / 1000);
        const dbg = generationState.debug;
        const debugStr = dbg
          ? ` turns=${dbg.turnCount} lastAsst=${dbg.lastAssistantFound} copyGlobal=${dbg.copyButtonGlobal} copyInTurn=${dbg.copyButtonInTurn} composerReady=${dbg.composerReady ?? false}`
          : "";
        logger(
          `[browser] [poll] state change at ${elapsedSec}s cycle=${pollCycles} stop=${generationState.stopVisible} completion=${generationState.completionVisible}${debugStr}`,
        );
      }
      lastStopVisible = generationState.stopVisible;
      lastCompletionVisible = generationState.completionVisible;
    }
    if (logger && Date.now() >= nextStatusLogAt) {
      const elapsedSec = Math.round((Date.now() - pollStartMs) / 1000);
      const remainSec = Math.round((watchdogDeadline - Date.now()) / 1000);
      const dbg = generationState.debug;
      const debugStr = dbg
        ? ` turns=${dbg.turnCount} lastAsst=${dbg.lastAssistantFound} copyGlobal=${dbg.copyButtonGlobal} copyInTurn=${dbg.copyButtonInTurn} composerReady=${dbg.composerReady ?? false}`
        : "";
      logger(
        `[browser] [poll] heartbeat at ${elapsedSec}s cycle=${pollCycles} stop=${generationState.stopVisible} completion=${generationState.completionVisible}${debugStr} stableNoStop=${noStopStableCycles} flickers=${completionFlickerCount} remaining=${remainSec}s`,
      );
      nextStatusLogAt = Date.now() + 60_000;
    }
    if (!generationState.stopVisible && generationState.completionVisible) {
      if (logger) {
        const elapsedSec = Math.round((Date.now() - pollStartMs) / 1000);
        logger(
          `[browser] [poll] completion detected at ${elapsedSec}s cycle=${pollCycles} — reading snapshot`,
        );
      }
      done = true;
      break;
    }
    // Fallback: if stop button is gone for enough cycles, treat as complete.
    // Primary: 15+ cycles with partial text (copy button selector may have changed).
    // Extended: 60+ cycles without any partial text — partial capture can silently
    // fail when DOM selectors don't match, but 60s of no stop button is definitive.
    if (
      !generationState.stopVisible &&
      noStopStableCycles >= TEXT_STABILITY_THRESHOLD &&
      (lastPartialText.length >= MIN_PARTIAL_CHARS || noStopStableCycles >= 60)
    ) {
      if (logger) {
        const elapsedSec = Math.round((Date.now() - pollStartMs) / 1000);
        logger(
          `[browser] [poll] fallback completion at ${elapsedSec}s cycle=${pollCycles} — stop gone for ${noStopStableCycles} cycles, partial=${lastPartialText.length} chars`,
        );
      }
      done = true;
      break;
    }
    // Track text stability for the flicker heuristic.
    // When partial text length changes, reset the stability counter.
    if (lastPartialText.length !== lastPartialLength) {
      lastPartialLength = lastPartialText.length;
      textStableCycles = 0;
    } else {
      textStableCycles += 1;
    }
    // Completion flicker heuristic: if completionVisible has flickered on/off
    // multiple times while stop stays true, the model is producing multi-turn
    // output. Requires BOTH partial text AND text stability — prevents cutting
    // off extended thinking runs that emit interim turns and keep going.
    if (
      generationState.stopVisible &&
      !generationState.completionVisible &&
      completionFlickerCount >= COMPLETION_FLICKER_THRESHOLD &&
      lastPartialText.length >= MIN_PARTIAL_CHARS &&
      textStableCycles >= FLICKER_STABILITY_CYCLES
    ) {
      if (logger) {
        const elapsedSec = Math.round((Date.now() - pollStartMs) / 1000);
        logger(
          `[browser] [poll] flicker-based completion at ${elapsedSec}s cycle=${pollCycles} — ${completionFlickerCount} flickers, partial=${lastPartialText.length} chars, stable=${textStableCycles} cycles`,
        );
      }
      done = true;
      break;
    }
    await delay(pollDelayMs);
    pollDelayMs = Math.min(pollDelayMs * 2, ASSISTANT_POLL_MAX_DELAY_MS);
  }
  if (!done || abortSignal?.aborted) {
    if (logger) {
      const elapsedSec = Math.round((Date.now() - pollStartMs) / 1000);
      logger(
        `[browser] [poll] ${abortSignal?.aborted ? "aborted" : "TIMED OUT"} at ${elapsedSec}s cycle=${pollCycles} stop=${lastStopVisible} completion=${lastCompletionVisible} flickers=${completionFlickerCount}`,
      );
    }
    return null;
  }
  const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex);
  const snapshotFromDom = domContext ? await readAssistantSnapshot(Runtime, minTurnIndex, domContext) : snapshot;
  const result = normalizeAssistantSnapshot(snapshotFromDom);
  if (logger) {
    logger(
      `[browser] [poll] snapshot captured — ${result?.text.length ?? 0} chars`,
    );
  }
  return result;
}

async function capturePartialAssistantProgress(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  minTurnIndex: number | undefined,
  lastPartialText: string,
  domContext?: AssistantDomContext | null,
): Promise<string> {
  const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex, domContext).catch(() => null);
  const normalized = normalizeAssistantSnapshot(snapshot);
  if (!normalized?.text) {
    return lastPartialText;
  }
  const text = normalized.text.trim();
  if (!text || text === lastPartialText) {
    return lastPartialText;
  }
  logger(`[browser] [partial-capture] ${text.length} chars captured — preview: ${text.slice(0, 120).replace(/\n/g, " ")}`);
  return text;
}

async function readAssistantGenerationUiState(
  Runtime: ChromeClient["Runtime"],
  domContext?: AssistantDomContext | null,
): Promise<{
  stopVisible: boolean;
  completionVisible: boolean;
  debug?: { turnCount: number; lastAssistantFound: boolean; copyButtonGlobal: boolean; copyButtonInTurn: boolean; composerReady?: boolean };
}> {
  try {
    let latestTurnOracleId: string | null = null;
    if (domContext) {
      try {
        const latestTurn = await domContext.session.withRepair("assistant", () =>
          domContext.session.resolve("assistant.latestTurn", { refresh: true }),
        );
        latestTurnOracleId = latestTurn.ok ? latestTurn.oracleId ?? null : null;
      } catch {
        latestTurnOracleId = null;
      }
    }
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        // Check if the stop button element exists in the DOM
        let stopVisible = Boolean(document.querySelector(${JSON.stringify(STOP_BUTTON_SELECTOR)}));

        // Composer-ready override: the composer submit button transitions between
        // "Stop streaming" (during generation) and "Start Voice"/"Send" (when ready).
        // If the button exists but is NOT in the stop state, generation is complete
        // even if a stale stop-button element lingers in the DOM.
        let composerReady = false;
        if (stopVisible) {
          const composerBtn = document.querySelector(${JSON.stringify(COMPOSER_SUBMIT_BUTTON_SELECTOR)});
          if (composerBtn) {
            const label = (composerBtn.getAttribute('aria-label') || '').toLowerCase();
            if (!label.includes('stop')) {
              stopVisible = false;
              composerReady = true;
            }
          }
        }

        const latestTurnOracleId = ${JSON.stringify(latestTurnOracleId)};

        const CONV_SEL = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
        const ASST_SEL = ${JSON.stringify(ASSISTANT_ROLE_SELECTOR)};
        const FINISH_SEL = ${JSON.stringify(FINISHED_ACTIONS_SELECTOR)};

        const isAssistantTurn = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const turn = (node.getAttribute('data-turn') || '').toLowerCase();
          if (turn === 'assistant') return true;
          const role = (node.getAttribute('data-message-author-role') || '').toLowerCase();
          if (role === 'assistant') return true;
          const tid = (node.getAttribute('data-testid') || '').toLowerCase();
          if (tid.includes('assistant')) return true;
          return Boolean(node.querySelector(ASST_SEL));
        };

        const copyButtonGlobal = Boolean(document.querySelector(FINISH_SEL));

        const resolveLatestAssistantTurn = () => {
          if (latestTurnOracleId) {
            const node = document.querySelector('[data-oracle-id="' + latestTurnOracleId + '"]');
            if (node instanceof HTMLElement) {
              return node;
            }
          }
          const oracle = window.__oracle;
          if (oracle && typeof oracle.resolve === 'function') {
            const resolved = oracle.resolve('assistant.latestTurn', { refresh: true });
            if (resolved?.ok && resolved?.oracleId) {
              const node = document.querySelector('[data-oracle-id="' + resolved.oracleId + '"]');
              if (node instanceof HTMLElement) {
                return node;
              }
            }
          }
          return null;
        };

        let completionVisible = false;
        let lastAssistantFound = false;
        let copyButtonInTurn = false;
        const turns = document.querySelectorAll(CONV_SEL);
        const latestAssistantTurn = resolveLatestAssistantTurn();
        if (latestAssistantTurn) {
          lastAssistantFound = true;
          copyButtonInTurn = Boolean(latestAssistantTurn.querySelector(FINISH_SEL));
          completionVisible = copyButtonInTurn;
        } else {
          for (let i = turns.length - 1; i >= 0; i--) {
            if (isAssistantTurn(turns[i])) {
              lastAssistantFound = true;
              copyButtonInTurn = Boolean(turns[i].querySelector(FINISH_SEL));
              completionVisible = copyButtonInTurn;
              break;
            }
          }
        }

        if (!completionVisible && copyButtonGlobal && !stopVisible) {
          const articles = document.querySelectorAll('article');
          for (let i = articles.length - 1; i >= 0; i--) {
            if (articles[i].querySelector(FINISH_SEL)) {
              completionVisible = true;
              break;
            }
          }
        }

        return {
          stopVisible,
          completionVisible,
          debug: {
            turnCount: turns.length,
            lastAssistantFound,
            copyButtonGlobal,
            copyButtonInTurn,
            composerReady,
          },
        };
      })()`,
      returnByValue: true,
    });
    const value = result?.value as
      | {
          stopVisible?: unknown;
          completionVisible?: unknown;
          debug?: { turnCount: number; lastAssistantFound: boolean; copyButtonGlobal: boolean; copyButtonInTurn: boolean; composerReady?: boolean };
        }
      | undefined;
    return {
      stopVisible: Boolean(value?.stopVisible),
      completionVisible: Boolean(value?.completionVisible),
      debug: value?.debug,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg && !msg.includes("Cannot find context")) {
      // Log unexpected failures but suppress routine context-destroyed errors during navigation
    }
    return { stopVisible: false, completionVisible: false };
  }
}

function normalizeAssistantSnapshot(snapshot: AssistantSnapshot | null): {
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null {
  const text = snapshot?.text ? cleanAssistantText(snapshot.text) : "";
  if (!text.trim()) {
    return null;
  }
  const normalized = text.toLowerCase();
  // "Pro thinking" often renders a placeholder turn containing an "Answer now" gate.
  // Treat it as incomplete so browser mode keeps waiting for the real assistant text.
  if (isAnswerNowPlaceholderText(normalized)) {
    return null;
  }
  // Ignore user echo turns that can show up in project view fallbacks.
  if (normalized.startsWith("you said")) {
    return null;
  }
  return {
    text,
    html: snapshot?.html ?? undefined,
    meta: { turnId: snapshot?.turnId ?? undefined, messageId: snapshot?.messageId ?? undefined },
  };
}

async function waitForCondition<T>(
  getter: () => Promise<T | null>,
  timeoutMs: number,
  pollIntervalMs = 400,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await getter();
    if (value) {
      return value;
    }
    await delay(pollIntervalMs);
  }
  return null;
}

function buildAssistantSnapshotExpression(minTurnIndex?: number): string {
  const minTurnLiteral =
    typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  return `(() => {
    const MIN_TURN_INDEX = ${minTurnLiteral};
    // Learned: the default turn DOM misses project view; keep a fallback extractor.
    ${buildAssistantExtractor("extractAssistantTurn")}
    const extracted = extractAssistantTurn();
    const isPlaceholder = (snapshot) => {
      const normalized = String(snapshot?.text ?? '').toLowerCase().trim();
      if (normalized === 'chatgpt said:' || normalized === 'chatgpt said') return true;
      if (normalized.includes('file upload request') && (normalized.includes('pro thinking') || normalized.includes('chatgpt said'))) {
        return true;
      }
      return normalized.includes('answer now') && (normalized.includes('pro thinking') || normalized.includes('chatgpt said'));
    };
    if (extracted && extracted.text && !isPlaceholder(extracted)) {
      return extracted;
    }
    // Fallback for ChatGPT project view: answers can live outside conversation turns.
    const fallback = ${buildMarkdownFallbackExtractor("MIN_TURN_INDEX")};
    return fallback ?? extracted;
  })()`;
}

function buildResponseObserverExpression(timeoutMs: number, minTurnIndex?: number): string {
  const selectorsLiteral = JSON.stringify(ANSWER_SELECTORS);
  const conversationLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  const minTurnLiteral =
    typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  return `(() => {
    ${buildClickDispatcher()}
    const SELECTORS = ${selectorsLiteral};
    const STOP_SELECTOR = '${STOP_BUTTON_SELECTOR}';
    const COMPOSER_BTN_SELECTOR = '${COMPOSER_SUBMIT_BUTTON_SELECTOR}';
    const FINISHED_SELECTOR = '${FINISHED_ACTIONS_SELECTOR}';
    const CONVERSATION_SELECTOR = ${conversationLiteral};
    const ASSISTANT_SELECTOR = ${assistantLiteral};
    // Learned: settling avoids capturing mid-stream HTML; keep short.
    const settleDelayMs = 800;
    const isAnswerNowPlaceholder = (snapshot) => {
      const normalized = String(snapshot?.text ?? '').toLowerCase().trim();
      if (normalized === 'chatgpt said:' || normalized === 'chatgpt said') return true;
      if (normalized.includes('file upload request') && (normalized.includes('pro thinking') || normalized.includes('chatgpt said'))) {
        return true;
      }
      return normalized.includes('answer now') && (normalized.includes('pro thinking') || normalized.includes('chatgpt said'));
    };

    // Helper to detect assistant turns - must match buildAssistantExtractor logic for consistency.
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (turnAttr === 'assistant') return true;
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') return true;
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) return true;
      return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
    };

    const resolveLatestAssistantTurn = () => {
      const oracle = window.__oracle;
      if (oracle && typeof oracle.resolve === 'function') {
        const resolved = oracle.resolve('assistant.latestTurn', { refresh: true });
        if (resolved?.ok && resolved?.oracleId) {
          const node = document.querySelector('[data-oracle-id="' + resolved.oracleId + '"]');
          if (node instanceof HTMLElement) {
            return node;
          }
        }
      }
      const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        if (isAssistantTurn(turns[i])) {
          return turns[i];
        }
      }
      return null;
    };

    const MIN_TURN_INDEX = ${minTurnLiteral};
    ${buildAssistantExtractor("extractFromTurns")}
    // Learned: some layouts (project view) render markdown without assistant turn wrappers.
    const extractFromMarkdownFallback = ${buildMarkdownFallbackExtractor("MIN_TURN_INDEX")};

    const acceptSnapshot = (snapshot) => {
      if (!snapshot) return null;
      const index = typeof snapshot.turnIndex === 'number' ? snapshot.turnIndex : -1;
      if (MIN_TURN_INDEX >= 0) {
        if (index < 0 || index < MIN_TURN_INDEX) {
          return null;
        }
      }
      return snapshot;
    };

    const captureViaObserver = () =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + ${timeoutMs};
        let stopInterval = null;
        let timeoutId = null;
        let cleanedUp = false;
        let observer = null;

        // Centralized cleanup to prevent resource leaks
        const cleanup = () => {
          if (cleanedUp) return;
          cleanedUp = true;
          if (stopInterval) {
            clearInterval(stopInterval);
            stopInterval = null;
          }
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          if (observer) {
            try {
              observer.disconnect();
            } catch {
              // ignore disconnect errors
            }
            observer = null;
          }
        };

        const observerCallback = () => {
          if (cleanedUp) return;
          try {
            const extractedRaw = extractFromTurns();
            const extractedCandidate =
              extractedRaw && !isAnswerNowPlaceholder(extractedRaw) ? extractedRaw : null;
            let extracted = acceptSnapshot(extractedCandidate);
            if (!extracted) {
              const fallbackRaw = extractFromMarkdownFallback();
              const fallbackCandidate =
                fallbackRaw && !isAnswerNowPlaceholder(fallbackRaw) ? fallbackRaw : null;
              extracted = acceptSnapshot(fallbackCandidate);
            }
            if (extracted) {
              cleanup();
              resolve(extracted);
            } else if (Date.now() > deadline) {
              cleanup();
              reject(new Error('Response timeout'));
            }
          } catch (error) {
            cleanup();
            reject(error);
          }
        };

        observer = new MutationObserver(observerCallback);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });

        stopInterval = setInterval(() => {
          if (cleanedUp) return;
          const stop = document.querySelector(STOP_SELECTOR);
          if (!stop) {
            return;
          }
          const isStopButton =
            stop.getAttribute('data-testid') === 'stop-button' || stop.getAttribute('aria-label')?.toLowerCase()?.includes('stop');
          if (isStopButton) {
            return;
          }
          dispatchClickSequence(stop);
        }, 500);

        timeoutId = setTimeout(() => {
          cleanup();
          reject(new Error('Response timeout'));
        }, ${timeoutMs});
      });

    // Check if the last assistant turn has finished (scoped to avoid detecting old turns).
    const isLastAssistantTurnFinished = () => {
      const lastAssistantTurn = resolveLatestAssistantTurn();
      if (!lastAssistantTurn) return false;
      // Check for action buttons in this specific turn
      if (lastAssistantTurn.querySelector(FINISHED_SELECTOR)) return true;
      // Check for "Done" text in this turn's markdown
      const markdowns = lastAssistantTurn.querySelectorAll('.markdown');
      return Array.from(markdowns).some((n) => (n.textContent || '').trim() === 'Done');
    };

    const waitForSettle = async (snapshot) => {
      // Learned: short answers can be 1-2 tokens; enforce longer settle windows to avoid truncation.
      // Learned: long streaming responses (esp. thinking models) can pause mid-stream;
      // use progressively longer windows to avoid truncation (#71).
      const initialLength = snapshot?.text?.length ?? 0;
      const shortAnswer = initialLength > 0 && initialLength < 16;
      const mediumAnswer = initialLength >= 16 && initialLength < 40;
      const longAnswer = initialLength >= 40 && initialLength < 500;
      const settleWindowMs = shortAnswer ? 12_000 : mediumAnswer ? 5_000 : longAnswer ? 8_000 : 10_000;
      const settleIntervalMs = 400;
      const deadline = Date.now() + settleWindowMs;
      let latest = snapshot;
      let lastLength = snapshot?.text?.length ?? 0;
      let stableCycles = 0;
      const stableTarget = shortAnswer ? 6 : mediumAnswer ? 3 : longAnswer ? 5 : 6;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, settleIntervalMs));
        const refreshedRaw = extractFromTurns();
        const refreshedCandidate =
          refreshedRaw && !isAnswerNowPlaceholder(refreshedRaw) ? refreshedRaw : null;
        let refreshed = acceptSnapshot(refreshedCandidate);
        if (!refreshed) {
          const fallbackRaw = extractFromMarkdownFallback();
          const fallbackCandidate =
            fallbackRaw && !isAnswerNowPlaceholder(fallbackRaw) ? fallbackRaw : null;
          refreshed = acceptSnapshot(fallbackCandidate);
        }
        const nextLength = refreshed?.text?.length ?? lastLength;
        if (refreshed && nextLength >= lastLength) {
          latest = refreshed;
        }
        if (nextLength > lastLength) {
          lastLength = nextLength;
          stableCycles = 0;
        } else {
          stableCycles += 1;
        }
        let stopVisible = Boolean(document.querySelector(STOP_SELECTOR));
        // Composer-ready override: if the composer button has transitioned away
        // from "Stop streaming", generation is done even if the stop-button
        // element lingers in the DOM.
        if (stopVisible) {
          const composerBtn = document.querySelector(COMPOSER_BTN_SELECTOR);
          if (composerBtn) {
            const label = (composerBtn.getAttribute('aria-label') || '').toLowerCase();
            if (!label.includes('stop')) {
              stopVisible = false;
            }
          }
        }
        const finishedVisible = isLastAssistantTurnFinished();

        if (finishedVisible || (!stopVisible && stableCycles >= stableTarget)) {
          break;
        }
      }
      return latest ?? snapshot;
    };

    const extractedRaw = extractFromTurns();
    const extractedCandidate = extractedRaw && !isAnswerNowPlaceholder(extractedRaw) ? extractedRaw : null;
    let extracted = acceptSnapshot(extractedCandidate);
    if (!extracted) {
      const fallbackRaw = extractFromMarkdownFallback();
      const fallbackCandidate = fallbackRaw && !isAnswerNowPlaceholder(fallbackRaw) ? fallbackRaw : null;
      extracted = acceptSnapshot(fallbackCandidate);
    }
    if (extracted) {
      return waitForSettle(extracted);
    }
    return captureViaObserver().then((payload) => waitForSettle(payload));
  })()`;
}

function buildAssistantExtractor(functionName: string): string {
  const conversationLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  return `const ${functionName} = () => {
    ${buildClickDispatcher()}
    const CONVERSATION_SELECTOR = ${conversationLiteral};
    const ASSISTANT_SELECTOR = ${assistantLiteral};
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (turnAttr === 'assistant') {
        return true;
      }
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') {
        return true;
      }
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) {
        return true;
      }
      return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
    };

    const oracle = window.__oracle;

    const expandCollapsibles = (root) => {
      const buttons = Array.from(root.querySelectorAll('button'));
      for (const button of buttons) {
        const label = (button.textContent || '').toLowerCase();
        const testid = (button.getAttribute('data-testid') || '').toLowerCase();
        if (
          label.includes('more') ||
          label.includes('expand') ||
          label.includes('show') ||
          testid.includes('markdown') ||
          testid.includes('toggle')
        ) {
          dispatchClickSequence(button);
        }
      }
    };

    const buildSnapshot = (turn, indexHint = null) => {
      if (!(turn instanceof HTMLElement)) {
        return null;
      }
      const messageRoot = turn.querySelector(ASSISTANT_SELECTOR) ?? turn;
      expandCollapsibles(messageRoot);
      const preferred =
        (messageRoot.matches?.('.markdown') || messageRoot.matches?.('[data-message-content]') ? messageRoot : null) ||
        messageRoot.querySelector('.markdown') ||
        messageRoot.querySelector('[data-message-content]') ||
        messageRoot.querySelector('[data-testid*="message"]') ||
        messageRoot.querySelector('[data-testid*="assistant"]') ||
        messageRoot.querySelector('.prose') ||
        messageRoot.querySelector('[class*="markdown"]');
      const contentRoot = preferred ?? messageRoot;
      if (!contentRoot) {
        return null;
      }
      const innerText = contentRoot?.innerText ?? '';
      const textContent = contentRoot?.textContent ?? '';
      const text = innerText.trim().length > 0 ? innerText : textContent;
      const html = contentRoot?.innerHTML ?? '';
      const messageId =
        messageRoot.getAttribute('data-message-id') ||
        turn.getAttribute('data-message-id') ||
        null;
      const oracleId =
        oracle && typeof oracle.mark === 'function' ? oracle.mark(turn, 'assistant.latestTurn') : null;
      const turnId = oracleId || messageRoot.getAttribute('data-testid') || turn.getAttribute('data-testid') || null;
      if (text.trim()) {
        return { text, html, messageId, turnId, turnIndex: indexHint };
      }
      return null;
    };

    if (oracle && typeof oracle.resolve === 'function') {
      const resolved = oracle.resolve('assistant.latestTurn', { refresh: true });
      if (resolved?.ok && resolved?.oracleId) {
        const node = document.querySelector('[data-oracle-id="' + resolved.oracleId + '"]');
        if (node instanceof HTMLElement) {
          const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
          const turnNode = node.closest(CONVERSATION_SELECTOR) || node;
          const turnIndex = turns.indexOf(turnNode);
          const snapshot = buildSnapshot(turnNode, turnIndex >= 0 ? turnIndex : null);
          if (snapshot) {
            return snapshot;
          }
        }
      }
    }

    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (!isAssistantTurn(turn)) {
        continue;
      }
      const snapshot = buildSnapshot(turn, index);
      if (snapshot) {
        return snapshot;
      }
    }
    return null;
  };`;
}

function buildMarkdownFallbackExtractor(minTurnLiteral?: string): string {
  const turnIndexValue = minTurnLiteral
    ? `(${minTurnLiteral} >= 0 ? ${minTurnLiteral} : null)`
    : "null";
  return `(() => {
    const __minTurn = ${turnIndexValue};
    const roots = [
      document.querySelector('section[data-testid="screen-threadFlyOut"]'),
      document.querySelector('[data-testid="chat-thread"]'),
      document.querySelector('main'),
      document.querySelector('[role="main"]'),
    ].filter(Boolean);
    if (roots.length === 0) return null;
    const markdownSelector = '.markdown,[data-message-content],[data-testid*="message"],.prose,[class*="markdown"]';
    const isExcluded = (node) =>
      Boolean(
        node?.closest?.(
          'nav, aside, [data-testid*="sidebar"], [data-testid*="chat-history"], [data-testid*="composer"], form',
        ),
      );
    const scoreRoot = (node) => {
      const actions = node.querySelectorAll('${FINISHED_ACTIONS_SELECTOR}').length;
      const assistants = node.querySelectorAll('[data-message-author-role="assistant"], [data-turn="assistant"]').length;
      const markdowns = node.querySelectorAll(markdownSelector).length;
      return actions * 10 + assistants * 5 + markdowns;
    };
    let root = roots[0];
    let bestScore = scoreRoot(root);
    for (let i = 1; i < roots.length; i += 1) {
      const candidate = roots[i];
      const score = scoreRoot(candidate);
      if (score > bestScore) {
        bestScore = score;
        root = candidate;
      }
    }
    if (!root) return null;
    const CONVERSATION_SELECTOR = '${CONVERSATION_TURN_SELECTOR}';
    const turnNodes = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    const hasTurns = turnNodes.length > 0;
    const resolveTurnIndex = (node) => {
      const turn = node?.closest?.(CONVERSATION_SELECTOR);
      if (!turn) return null;
      const idx = turnNodes.indexOf(turn);
      return idx >= 0 ? idx : null;
    };
    const isAfterMinTurn = (node) => {
      if (__minTurn === null) return true;
      if (!hasTurns) return true;
      const idx = resolveTurnIndex(node);
      return idx !== null && idx >= __minTurn;
    };
    const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const collectUserText = (scope) => {
      if (!scope?.querySelectorAll) return '';
      const userTurns = Array.from(scope.querySelectorAll('[data-message-author-role="user"], [data-turn="user"]'));
      const lastUser = userTurns[userTurns.length - 1];
      return lastUser ? normalize(lastUser.innerText || lastUser.textContent || '') : '';
    };
    const userText = collectUserText(root) || collectUserText(document);
    const isUserEcho = (text) => {
      if (!userText) return false;
      const normalized = normalize(text);
      if (!normalized) return false;
      return normalized === userText || normalized.startsWith(userText);
    };
    const markdowns = Array.from(root.querySelectorAll(markdownSelector))
      .filter((node) => !isExcluded(node))
      .filter((node) => {
        const container = node.closest('[data-message-author-role], [data-turn]');
        if (!container) return true;
        const role =
          (container.getAttribute('data-message-author-role') || container.getAttribute('data-turn') || '').toLowerCase();
        return role !== 'user';
      });
    if (markdowns.length === 0) return null;
    const actionButtons = Array.from(root.querySelectorAll('${FINISHED_ACTIONS_SELECTOR}'));
    const actionMarkdowns = [];
    for (const button of actionButtons) {
      const container =
        button.closest('${CONVERSATION_TURN_SELECTOR}') ||
        button.closest('[data-message-author-role="assistant"], [data-turn="assistant"]') ||
        button.closest('[data-message-author-role], [data-turn]') ||
        button.closest('[data-testid*="assistant"]');
      if (!container || container === root || container === document.body) continue;
      const scoped = Array.from(container.querySelectorAll(markdownSelector))
        .filter((node) => !isExcluded(node))
        .filter((node) => {
          const roleNode = node.closest('[data-message-author-role], [data-turn]');
          if (!roleNode) return true;
          const role =
            (roleNode.getAttribute('data-message-author-role') || roleNode.getAttribute('data-turn') || '').toLowerCase();
          return role !== 'user';
        });
      if (scoped.length === 0) continue;
      for (const node of scoped) {
        actionMarkdowns.push(node);
      }
    }
    const assistantMarkdowns = markdowns.filter((node) => {
      const container = node.closest('[data-message-author-role], [data-turn], [data-testid*="assistant"]');
      if (!container) return false;
      const role =
        (container.getAttribute('data-message-author-role') || container.getAttribute('data-turn') || '').toLowerCase();
      if (role === 'assistant') return true;
      const testId = (container.getAttribute('data-testid') || '').toLowerCase();
      return testId.includes('assistant');
    });
    const hasAssistantIndicators = Boolean(
      root.querySelector('${FINISHED_ACTIONS_SELECTOR}') ||
        root.querySelector('[data-message-author-role="assistant"], [data-turn="assistant"], [data-testid*="assistant"]'),
    );
    const allowMarkdownFallback = hasAssistantIndicators || hasTurns || Boolean(userText);
    const candidates =
      actionMarkdowns.length > 0
        ? actionMarkdowns
        : assistantMarkdowns.length > 0
          ? assistantMarkdowns
          : allowMarkdownFallback
            ? markdowns
            : [];
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const node = candidates[i];
      if (!node) continue;
      if (!isAfterMinTurn(node)) continue;
      const text = (node.innerText || node.textContent || '').trim();
      if (!text) continue;
      if (isUserEcho(text)) continue;
      const html = node.innerHTML ?? '';
      const turnIndex = resolveTurnIndex(node);
      return { text, html, messageId: null, turnId: null, turnIndex };
    }
    return null;
  })`;
}

function buildCopyExpression(meta: { messageId?: string | null; turnId?: string | null }): string {
  return `(() => {
    ${buildClickDispatcher()}
    const BUTTON_SELECTOR = '${COPY_BUTTON_SELECTOR}';
    const TIMEOUT_MS = 10000;

    const locateButton = () => {
      const hint = ${JSON.stringify(meta ?? {})};
      const oracle = window.__oracle;
      if (oracle && typeof oracle.resolve === 'function') {
        const resolved = oracle.resolve('assistant.copyButton', { refresh: true });
        if (resolved?.ok && resolved?.oracleId) {
          const node = document.querySelector('[data-oracle-id="' + resolved.oracleId + '"]');
          if (node) {
            return node;
          }
        }
      }
      if (hint?.messageId) {
        const node = document.querySelector('[data-message-id="' + hint.messageId + '"]');
        const buttons = node ? Array.from(node.querySelectorAll('${COPY_BUTTON_SELECTOR}')) : [];
        const button = buttons.at(-1) ?? null;
        if (button) {
          return button;
        }
      }
      if (hint?.turnId) {
        const node =
          document.querySelector('[data-oracle-id="' + hint.turnId + '"]') ||
          document.querySelector('[data-testid="' + hint.turnId + '"]');
        const buttons = node ? Array.from(node.querySelectorAll('${COPY_BUTTON_SELECTOR}')) : [];
        const button = buttons.at(-1) ?? null;
        if (button) {
          return button;
        }
      }
      const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
      const ASSISTANT_SELECTOR = '${ASSISTANT_ROLE_SELECTOR}';
      const isAssistantTurn = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
        if (turnAttr === 'assistant') return true;
        const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
        if (role === 'assistant') return true;
        const testId = (node.getAttribute('data-testid') || '').toLowerCase();
        if (testId.includes('assistant')) return true;
        return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
      };
      const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        const turn = turns[i];
        if (!isAssistantTurn(turn)) continue;
        const button = turn.querySelector(BUTTON_SELECTOR);
        if (button) {
          return button;
        }
      }
      const all = Array.from(document.querySelectorAll(BUTTON_SELECTOR));
      for (let i = all.length - 1; i >= 0; i -= 1) {
        const button = all[i];
        const turn = button?.closest?.(CONVERSATION_SELECTOR);
        if (turn && isAssistantTurn(turn)) {
          return button;
        }
      }
      return null;
    };

    const interceptClipboard = () => {
      const clipboard = navigator.clipboard;
      const state = { text: '', updatedAt: 0 };
      if (!clipboard) {
        return { state, restore: () => {} };
      }
      const originalWriteText = clipboard.writeText;
      const originalWrite = clipboard.write;
      clipboard.writeText = (value) => {
        state.text = typeof value === 'string' ? value : '';
        state.updatedAt = Date.now();
        return Promise.resolve();
      };
      clipboard.write = async (items) => {
        try {
          const list = Array.isArray(items) ? items : items ? [items] : [];
          for (const item of list) {
            if (!item) continue;
            const types = Array.isArray(item.types) ? item.types : [];
            if (types.includes('text/plain') && typeof item.getType === 'function') {
              const blob = await item.getType('text/plain');
              const text = await blob.text();
              state.text = text ?? '';
              state.updatedAt = Date.now();
              break;
            }
          }
        } catch {
          state.text = '';
          state.updatedAt = Date.now();
        }
        return Promise.resolve();
      };
      return {
        state,
        restore: () => {
          clipboard.writeText = originalWriteText;
          clipboard.write = originalWrite;
        },
      };
    };

    return new Promise((resolve) => {
      const deadline = Date.now() + TIMEOUT_MS;
      const waitForButton = () => {
        const button = locateButton();
        if (button) {
          const interception = interceptClipboard();
          let settled = false;
          let pollId = null;
          let timeoutId = null;
          const finish = (payload) => {
            if (settled) {
              return;
            }
            settled = true;
            if (pollId) {
              clearInterval(pollId);
            }
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            button.removeEventListener('copy', handleCopy, true);
            interception.restore?.();
            resolve(payload);
          };

          const readIntercepted = () => {
            const markdown = interception.state.text ?? '';
            const updatedAt = interception.state.updatedAt ?? 0;
            return { success: Boolean(markdown.trim()), markdown, updatedAt };
          };

          let lastText = '';
          let stableTicks = 0;
          const requiredStableTicks = 3;
          const requiredStableMs = 250;
          const maybeFinish = () => {
            const payload = readIntercepted();
            if (!payload.success) return;
            if (payload.markdown !== lastText) {
              lastText = payload.markdown;
              stableTicks = 0;
              return;
            }
            stableTicks += 1;
            const ageMs = Date.now() - (payload.updatedAt || 0);
            if (stableTicks >= requiredStableTicks && ageMs >= requiredStableMs) {
              finish(payload);
            }
          };

          const handleCopy = () => {
            maybeFinish();
          };

          button.addEventListener('copy', handleCopy, true);
          button.scrollIntoView({ block: 'center', behavior: 'instant' });
          dispatchClickSequence(button);
          pollId = setInterval(maybeFinish, 120);
          timeoutId = setTimeout(() => {
            button.removeEventListener('copy', handleCopy, true);
            finish({ success: false, status: 'timeout' });
          }, TIMEOUT_MS);
          return;
        }
        if (Date.now() > deadline) {
          resolve({ success: false, status: 'missing-button' });
          return;
        }
        setTimeout(waitForButton, 120);
      };

      waitForButton();
    });
  })()`;
}

interface AssistantSnapshot {
  text?: string;
  html?: string;
  messageId?: string | null;
  turnId?: string | null;
  turnIndex?: number | null;
}

const LANGUAGE_TAGS = new Set(
  [
    "copy code",
    "markdown",
    "bash",
    "sh",
    "shell",
    "javascript",
    "typescript",
    "ts",
    "js",
    "yaml",
    "json",
    "python",
    "py",
    "go",
    "java",
    "c",
    "c++",
    "cpp",
    "c#",
    "php",
    "ruby",
    "rust",
    "swift",
    "kotlin",
    "html",
    "css",
    "sql",
    "text",
  ].map((token) => token.toLowerCase()),
);

function cleanAssistantText(text: string): string {
  const normalized = text.replace(/\u00a0/g, " ");
  const lines = normalized.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const trimmed = line.trim().toLowerCase();
    if (LANGUAGE_TAGS.has(trimmed)) return false;
    return true;
  });
  return filtered
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
