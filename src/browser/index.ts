import CDP from "chrome-remote-interface";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { resolveBrowserConfig } from "./config.js";
import type {
  BrowserRunOptions,
  BrowserRunResult,
  BrowserLogger,
  ChromeClient,
  BrowserAttachment,
} from "./types.js";
import {
  launchChrome,
  registerTerminationHooks,
  hideChromeWindow,
  connectToRemoteChrome,
  closeRemoteChromeTarget,
  connectWithNewTab,
  closeTab,
} from "./chromeLifecycle.js";
import { syncCookies } from "./cookies.js";
import {
  navigateToChatGPT,
  navigateToPromptReadyWithFallback,
  assertCurrentConversationId,
  ensureNotBlocked,
  ensureLoggedIn,
  ensurePromptReady,
  installJavaScriptDialogAutoDismissal,
  ensureModelSelection,
  forceDismissOpenModelPicker,
  closeOpenModelMenuBestEffort,
  clearPromptComposer,
  waitForAssistantResponse,
  captureAssistantMarkdown,
  clearComposerAttachments,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
  waitForUserTurnAttachments,
  readAssistantSnapshot,
  pollAssistantCompletion,
} from "./pageActions.js";
import { INPUT_SELECTORS } from "./constants.js";
import { uploadAttachmentViaDataTransfer } from "./actions/remoteFileTransfer.js";
import { ensureThinkingTime } from "./actions/thinkingTime.js";
import { ensureCreateImageMode } from "./actions/createImageMode.js";
import {
  collectGeneratedImages,
  countGeneratedImages,
  waitForNewGeneratedImage,
} from "./actions/generatedImages.js";
import { estimateTokenCount, withRetries, delay } from "./utils.js";
import { formatElapsed } from "../oracle/format.js";
import { CHATGPT_URL, CONVERSATION_TURN_SELECTOR, DEFAULT_MODEL_STRATEGY } from "./constants.js";
import type { LaunchedChrome } from "chrome-launcher";
import { BrowserAutomationError } from "../oracle/errors.js";
import { getBuildTag } from "../version.js";
import { alignPromptEchoPair, buildPromptEchoMatcher } from "./reattachHelpers.js";
import type { ProfileRunLock } from "./profileState.js";
import {
  cleanupStaleProfileState,
  acquireProfileRunLock,
  readChromePid,
  readDevToolsPort,
  shouldCleanupManualLoginProfileState,
  verifyDevToolsReachable,
  writeChromePid,
  writeDevToolsActivePort,
} from "./profileState.js";
import { runProviderSubmissionFlow } from "./providerDomFlow.js";
import { chatgptDomProvider } from "./providers/index.js";

export type { BrowserAutomationConfig, BrowserRunOptions, BrowserRunResult } from "./types.js";
export { CHATGPT_URL, DEFAULT_MODEL_STRATEGY, DEFAULT_MODEL_TARGET } from "./constants.js";
export { parseDuration, delay, normalizeChatgptUrl, isTemporaryChatUrl } from "./utils.js";

function isCloudflareChallengeError(error: unknown): error is BrowserAutomationError {
  if (!(error instanceof BrowserAutomationError)) return false;
  return (error.details as { stage?: string } | undefined)?.stage === "cloudflare-challenge";
}

function shouldPreserveBrowserOnError(error: unknown, headless: boolean): boolean {
  return !headless && isCloudflareChallengeError(error);
}

export function shouldPreserveBrowserOnErrorForTest(error: unknown, headless: boolean): boolean {
  return shouldPreserveBrowserOnError(error, headless);
}

export async function runBrowserMode(options: BrowserRunOptions): Promise<BrowserRunResult> {
  const promptText = options.prompt?.trim();
  if (!promptText) {
    throw new Error("Prompt text is required when using browser mode.");
  }

  const attachments: BrowserAttachment[] = options.attachments ?? [];
  const fallbackSubmission = options.fallbackSubmission;

  let config = resolveBrowserConfig(options.config);
  const logger: BrowserLogger = options.log ?? ((_message: string) => {});
  if (logger.verbose === undefined) {
    logger.verbose = Boolean(config.debug);
  }
  if (logger.sessionLog === undefined && options.log?.sessionLog) {
    logger.sessionLog = options.log.sessionLog;
  }
  const runtimeHintCb = options.runtimeHintCb;
  let lastTargetId: string | undefined;
  let lastUrl: string | undefined;
  const emitRuntimeHint = async (): Promise<void> => {
    if (!runtimeHintCb || !chrome?.port) {
      return;
    }
    const conversationId = lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined;
    const hint = {
      chromePid: chrome.pid,
      chromePort: chrome.port,
      chromeHost,
      chromeTargetId: lastTargetId,
      tabUrl: lastUrl,
      conversationId,
      userDataDir,
      controllerPid: process.pid,
    };
    try {
      await runtimeHintCb(hint);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to persist runtime hint: ${message}`);
    }
  };
  if (config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") {
    logger(
      `[browser-mode] config: ${JSON.stringify({
        ...config,
        promptLength: promptText.length,
      })}`,
    );
  }
  config = {
    ...config,
    manualLogin: false,
    manualLoginProfileDir: null,
    manualLoginCookieSync: false,
  };

  if (!config.remoteChrome && !config.manualLogin) {
    const preferredPort = config.debugPort ?? DEFAULT_DEBUG_PORT;
    const availablePort = await pickAvailableDebugPort(preferredPort, logger);
    if (availablePort !== preferredPort) {
      logger(
        `DevTools port ${preferredPort} busy; using ${availablePort} to avoid attaching to stray Chrome.`,
      );
    }
    config = { ...config, debugPort: availablePort };
  }

  // Remote Chrome mode - connect to existing browser
  if (config.remoteChrome) {
    // Warn about ignored local-only options
    if (config.headless || config.hideWindow || config.keepBrowser || config.chromePath) {
      logger(
        "Note: --remote-chrome ignores local Chrome flags " +
          "(--browser-headless, --browser-hide-window, --browser-keep-browser, --browser-chrome-path).",
      );
    }

    return runRemoteBrowserMode(promptText, attachments, config, logger, options);
  }

  const manualLogin = false;
  const userDataDir = await mkdtemp(path.join(await resolveUserDataBaseDir(), "oracle-browser-"));
  logger(`Created temporary Chrome profile at ${userDataDir}`);

  const effectiveKeepBrowser = Boolean(config.keepBrowser);
  const chromeStartMs = Date.now();
  const reusedChrome = manualLogin
    ? await maybeReuseRunningChrome(userDataDir, logger, {
        waitForPortMs: config.reuseChromeWaitMs,
      })
    : null;
  const chrome =
    reusedChrome ??
    (await launchChrome(
      {
        ...config,
        remoteChrome: config.remoteChrome,
      },
      userDataDir,
      logger,
    ));
  const chromeHost = (chrome as unknown as { host?: string }).host ?? "127.0.0.1";
  logger(
    `[browser] [phase] chrome-launch — ${Date.now() - chromeStartMs}ms pid=${chrome.pid} port=${chrome.port} reused=${Boolean(reusedChrome)}`,
  );
  // Persist profile state so future manual-login runs can reuse this Chrome.
  if (manualLogin && chrome.port) {
    await writeDevToolsActivePort(userDataDir, chrome.port);
    if (!reusedChrome && chrome.pid) {
      await writeChromePid(userDataDir, chrome.pid);
    }
  }
  let removeTerminationHooks: (() => void) | null = null;
  try {
    removeTerminationHooks = registerTerminationHooks(
      chrome,
      userDataDir,
      effectiveKeepBrowser,
      logger,
      {
        isInFlight: () => runStatus !== "complete",
        emitRuntimeHint,
        preserveUserDataDir: manualLogin,
      },
    );
  } catch (err) {
    logger(
      `[browser] [warn] registerTerminationHooks failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  let client: ChromeClient | null = null;
  let isolatedTargetId: string | null = null;
  const startedAt = Date.now();
  let answerText = "";
  let answerMarkdown = "";
  let answerHtml = "";
  let runStatus: "attempted" | "complete" = "attempted";
  let connectionClosedUnexpectedly = false;
  let stopThinkingMonitor: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let appliedCookies = 0;
  let preserveBrowserOnError = false;

  try {
    const cdpStartMs = Date.now();
    try {
      const strictTabIsolation = Boolean(manualLogin && reusedChrome);
      const connection = await connectWithNewTab(chrome.port, logger, undefined, chromeHost, {
        fallbackToDefault: !strictTabIsolation,
        retries: strictTabIsolation ? 3 : 0,
        retryDelayMs: 500,
      });
      client = connection.client;
      isolatedTargetId = connection.targetId ?? null;
    } catch (error) {
      const hint = describeDevtoolsFirewallHint(chromeHost, chrome.port);
      if (hint) {
        logger(hint);
      }
      throw error;
    }
    logger(
      `[browser] [phase] cdp-connect — ${Date.now() - cdpStartMs}ms targetId=${isolatedTargetId ?? "default"}`,
    );
    logger(
      `[browser] [build] oracle build=${getBuildTag()} pid=${process.pid} chrome_pid=${chrome.pid} port=${chrome.port}`,
    );
    const disconnectPromise = new Promise<never>((_, reject) => {
      client?.on("disconnect", () => {
        connectionClosedUnexpectedly = true;
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        logger(
          `[browser] [lifecycle] CDP disconnected after ${elapsedSec}s — chrome_pid=${chrome.pid} port=${chrome.port}`,
        );
        reject(
          new Error(
            "Chrome window closed before oracle finished. Please keep it open until completion.",
          ),
        );
      });
    });
    const raceWithDisconnect = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, disconnectPromise]);
    const { Network, Page, Runtime, Input, DOM } = client;
    const bringPageToFront = async () => {
      if (Page && typeof Page.bringToFront === "function") {
        try {
          await Page.bringToFront();
        } catch (err) {
          logger(
            `[browser] [warn] bringToFront failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    };

    if (!config.headless && config.hideWindow) {
      await hideChromeWindow(chrome, logger);
    }

    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === "function") {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    removeDialogHandler = installJavaScriptDialogAutoDismissal(Page, logger);
    if (!manualLogin) {
      await Network.clearBrowserCookies();
    }

    const cookieStartMs = Date.now();
    let cookieSyncError: string | null = null;
    const manualLoginCookieSync = manualLogin && Boolean(config.manualLoginCookieSync);
    const cookieSyncEnabled = config.cookieSync && (!manualLogin || manualLoginCookieSync);
    if (cookieSyncEnabled) {
      if (manualLoginCookieSync) {
        logger(
          "Manual login mode: seeding persistent profile with cookies from your Chrome profile.",
        );
      }
      if (!config.inlineCookies) {
        logger(
          "Heads-up: macOS may prompt for your Keychain password to read Chrome cookies; use --copy or --render for manual flow.",
        );
      } else {
        logger("Applying inline cookies (skipping Chrome profile read and Keychain prompt)");
      }
      // Learned: always sync cookies before the first navigation so /backend-api/me succeeds.
      const cookieCount = await syncCookies(Network, config.url, config.chromeProfile, logger, {
        allowErrors: config.allowCookieErrors ?? false,
        filterNames: config.cookieNames ?? undefined,
        inlineCookies: config.inlineCookies ?? undefined,
        cookiePath: config.chromeCookiePath ?? undefined,
        waitMs: config.cookieSyncWaitMs ?? 0,
        onError: (message) => {
          cookieSyncError = message;
        },
      });
      appliedCookies = cookieCount;
      if (config.inlineCookies && cookieCount === 0) {
        throw new Error("No inline cookies were applied; aborting before navigation.");
      }
      logger(
        cookieCount > 0
          ? config.inlineCookies
            ? `Applied ${cookieCount} inline cookies`
            : `Copied ${cookieCount} cookies from Chrome profile ${config.chromeProfile ?? "Default"}`
          : config.inlineCookies
            ? "No inline cookies applied; continuing without session reuse"
            : "No Chrome cookies found; continuing without session reuse",
      );
    } else {
      logger(
        manualLogin
          ? "Skipping Chrome cookie sync (--browser-manual-login enabled); reuse the opened profile after signing in."
          : "Skipping Chrome cookie sync (--browser-no-cookie-sync)",
      );
    }

    if (cookieSyncEnabled && !manualLogin && (appliedCookies ?? 0) === 0 && !config.inlineCookies) {
      // Learned: if the profile has no ChatGPT cookies, browser mode will just bounce to login.
      // Fail early so the user knows to sign in.
      const cookieSyncMessage = cookieSyncError
        ? `${cookieSyncError} No ChatGPT cookies were applied from your Chrome profile; cannot proceed in browser mode.`
        : "No ChatGPT cookies were applied from your Chrome profile; cannot proceed in browser mode. " +
          "Make sure ChatGPT is signed in in the selected profile, use inline cookies, " +
          "or retry with --browser-cookie-wait 5s if Keychain prompts are slow.";
      throw new BrowserAutomationError(cookieSyncMessage, {
        stage: "execute-browser",
        details: {
          profile: config.chromeProfile ?? "Default",
          cookiePath: config.chromeCookiePath ?? null,
          hint: "If macOS Keychain prompts or denies access, run oracle from a GUI session or use --copy/--render for the manual flow.",
        },
      });
    }

    logger(
      `[browser] [phase] cookie-sync — ${Date.now() - cookieStartMs}ms count=${appliedCookies}`,
    );
    const navStartMs = Date.now();
    const baseUrl = CHATGPT_URL;
    // First load the base ChatGPT homepage to satisfy potential interstitials,
    // then hop to the requested URL if it differs.
    await raceWithDisconnect(navigateToChatGPT(Page, Runtime, baseUrl, logger));
    await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
    logger(`[browser] [phase] navigate — ${Date.now() - navStartMs}ms url=${baseUrl}`);
    const loginStartMs = Date.now();
    // Learned: login checks must happen on the base domain before jumping into project URLs.
    await raceWithDisconnect(
      waitForLogin({
        runtime: Runtime,
        logger,
        appliedCookies,
        manualLogin,
        timeoutMs: config.timeoutMs,
      }),
    );
    logger(`[browser] [phase] login — ${Date.now() - loginStartMs}ms`);

    if (config.url !== baseUrl) {
      await raceWithDisconnect(
        navigateToPromptReadyWithFallback(Page, Runtime, {
          url: config.url,
          fallbackUrl: baseUrl,
          timeoutMs: config.inputTimeoutMs,
          headless: config.headless,
          logger,
        }),
      );
    } else {
      await bringPageToFront();
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
    }
    logger(
      `Prompt textarea ready (initial focus, ${promptText.length.toLocaleString()} chars queued)`,
    );
    const captureRuntimeSnapshot = async () => {
      try {
        if (client?.Target?.getTargetInfo) {
          const info = await client.Target.getTargetInfo({});
          lastTargetId = info?.targetInfo?.targetId ?? lastTargetId;
          lastUrl = info?.targetInfo?.url ?? lastUrl;
        }
      } catch (err) {
        logger(
          `[browser] [warn] getTargetInfo failed: ${err instanceof Error ? err.message : err}`,
        );
      }
      try {
        const { result } = await Runtime.evaluate({
          expression: "location.href",
          returnByValue: true,
        });
        if (typeof result?.value === "string") {
          lastUrl = result.value;
        }
      } catch (err) {
        logger(
          `[browser] [warn] location.href eval failed: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (lastUrl) {
        logger(`[browser] url = ${lastUrl}`);
      }
      if (chrome?.port) {
        const suffix = lastTargetId ? ` target=${lastTargetId}` : "";
        if (lastUrl) {
          logger(
            `[reattach] chrome port=${chrome.port} host=${chromeHost} url=${lastUrl}${suffix}`,
          );
        } else {
          logger(`[reattach] chrome port=${chrome.port} host=${chromeHost}${suffix}`);
        }
        await emitRuntimeHint();
      }
    };
    let conversationHintInFlight: Promise<boolean> | null = null;
    const updateConversationHint = async (label: string, timeoutMs = 10_000): Promise<boolean> => {
      if (!chrome?.port) {
        return false;
      }
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          const { result } = await Runtime.evaluate({
            expression: "location.href",
            returnByValue: true,
          });
          if (typeof result?.value === "string" && result.value.includes("/c/")) {
            lastUrl = result.value;
            logger(`[browser] conversation url (${label}) = ${lastUrl}`);
            await emitRuntimeHint();
            return true;
          }
        } catch (err) {
          logger(
            `[browser] [warn] conversation hint poll failed: ${err instanceof Error ? err.message : err}`,
          );
        }
        await delay(250);
      }
      return false;
    };
    const scheduleConversationHint = (label: string, timeoutMs?: number): void => {
      if (conversationHintInFlight) {
        return;
      }
      // Learned: the /c/ URL can update after the answer; emit hints in the background.
      // Run in the background so prompt submission/streaming isn't blocked by slow URL updates.
      conversationHintInFlight = updateConversationHint(label, timeoutMs)
        .catch(() => false)
        .finally(() => {
          conversationHintInFlight = null;
        });
    };
    await captureRuntimeSnapshot();
    const modelStartMs = Date.now();
    const modelStrategy = config.createImageMode
      ? "current"
      : (config.modelStrategy ?? DEFAULT_MODEL_STRATEGY);
    if (config.desiredModel && modelStrategy === "select") {
      await bringPageToFront();
      await raceWithDisconnect(
        withRetries(
          () =>
            ensureModelSelection(
              Runtime,
              config.desiredModel as string,
              logger,
              modelStrategy,
              Input,
            ),
          {
            retries: 2,
            delayMs: 300,
            onRetry: (attempt, error) => {
              if (options.verbose) {
                logger(
                  `[retry] Model picker attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                );
              }
            },
          },
        ),
      ).catch((error) => {
        const base = error instanceof Error ? error.message : String(error);
        const hint =
          appliedCookies === 0
            ? " No cookies were applied; log in to ChatGPT in Chrome or provide inline cookies (--browser-inline-cookies[(-file)] or ORACLE_BROWSER_COOKIES_JSON)."
            : "";
        throw new Error(`${base}${hint}`);
      });
      await raceWithDisconnect(closeOpenModelMenuBestEffort(Runtime, Input, logger));
      await raceWithDisconnect(forceDismissOpenModelPicker(Runtime, logger));
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
      logger(
        `Prompt textarea ready (after model switch, ${promptText.length.toLocaleString()} chars queued)`,
      );
    } else if (modelStrategy === "ignore" || modelStrategy === "current") {
      logger(`[browser] [phase] model-select — skipped (strategy=${modelStrategy})`);
    }
    logger(
      `[browser] [phase] model-select — ${Date.now() - modelStartMs}ms model=${config.desiredModel ?? "default"} strategy=${modelStrategy}`,
    );
    // Handle thinking time selection if specified
    const thinkingTime = config.thinkingTime;
    if (thinkingTime) {
      const thinkStartMs = Date.now();
      await raceWithDisconnect(
        withRetries(() => ensureThinkingTime(Runtime, thinkingTime, logger), {
          retries: 2,
          delayMs: 300,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(
                `[retry] Thinking time (${thinkingTime}) attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
              );
            }
          },
        }),
      );
      logger(
        `[browser] [phase] thinking-time — ${Date.now() - thinkStartMs}ms level=${thinkingTime}`,
      );
    }
    if (config.createImageMode) {
      const imageModeStartMs = Date.now();
      await raceWithDisconnect(ensureCreateImageMode(Runtime, Input, logger));
      logger(`[browser] [phase] create-image-mode — ${Date.now() - imageModeStartMs}ms`);
    }
    const profileLockTimeoutMs = manualLogin ? (config.profileLockTimeoutMs ?? 0) : 0;
    let profileLock: ProfileRunLock | null = null;
    const acquireProfileLockIfNeeded = async () => {
      if (profileLockTimeoutMs <= 0) return;
      profileLock = await acquireProfileRunLock(userDataDir, {
        timeoutMs: profileLockTimeoutMs,
        logger,
      });
    };
    const releaseProfileLockIfHeld = async () => {
      if (!profileLock) return;
      const handle = profileLock;
      profileLock = null;
      await handle.release().catch(() => undefined);
    };
    const submitOnce = async (prompt: string, submissionAttachments: BrowserAttachment[]) => {
      const submitStartMs = Date.now();
      logger(
        `[browser] [phase] submit-flow — started chars=${prompt.length} attachments=${submissionAttachments.length}`,
      );
      const baselineSnapshot = await readAssistantSnapshot(Runtime).catch(() => null);
      const baselineAssistantText =
        typeof baselineSnapshot?.text === "string" ? baselineSnapshot.text.trim() : "";
      const attachmentNames = submissionAttachments.map((a) => path.basename(a.path));
      let attachmentWaitTimedOut = false;
      let inputOnlyAttachments = false;
      if (submissionAttachments.length > 0) {
        if (!DOM) {
          throw new Error("Chrome DOM domain unavailable while uploading attachments.");
        }
        await clearComposerAttachments(Runtime, 5_000, logger);
        for (
          let attachmentIndex = 0;
          attachmentIndex < submissionAttachments.length;
          attachmentIndex += 1
        ) {
          const attachment = submissionAttachments[attachmentIndex];
          logger(`Uploading attachment: ${attachment.displayPath}`);
          const uiConfirmed = await uploadAttachmentFile(
            { runtime: Runtime, dom: DOM, input: Input },
            attachment,
            logger,
            { expectedCount: attachmentIndex + 1 },
          );
          if (!uiConfirmed) {
            inputOnlyAttachments = true;
          }
          await delay(500);
        }
        // Scale timeout based on number of files: base 45s + 20s per additional file.
        const baseTimeout = config.inputTimeoutMs ?? 30_000;
        const perFileTimeout = 20_000;
        const waitBudget =
          Math.max(baseTimeout, 45_000) + (submissionAttachments.length - 1) * perFileTimeout;
        try {
          await waitForAttachmentCompletion(Runtime, waitBudget, attachmentNames, logger);
          logger("All attachments uploaded");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/Attachments did not finish uploading before timeout/i.test(message)) {
            attachmentWaitTimedOut = true;
            logger(
              `[browser] Attachment upload timed out after ${Math.round(waitBudget / 1000)}s; continuing without confirmation.`,
            );
          } else {
            throw error;
          }
        }
      }
      let baselineTurns = await readConversationTurnCount(Runtime, logger);
      // Learned: return baselineTurns so assistant polling can ignore earlier content.
      const sendAttachmentNames = attachmentWaitTimedOut ? [] : attachmentNames;
      const providerState: Record<string, unknown> = {
        runtime: Runtime,
        input: Input,
        logger,
        timeoutMs: config.timeoutMs,
        inputTimeoutMs: config.inputTimeoutMs ?? undefined,
        baselineTurns: baselineTurns ?? undefined,
        attachmentNames: sendAttachmentNames,
      };
      await runProviderSubmissionFlow(chatgptDomProvider, {
        prompt,
        evaluate: async () => undefined,
        delay,
        log: logger,
        state: providerState,
      });
      const providerBaselineTurns = providerState.baselineTurns;
      if (typeof providerBaselineTurns === "number" && Number.isFinite(providerBaselineTurns)) {
        baselineTurns = providerBaselineTurns;
      }
      if (attachmentNames.length > 0) {
        if (attachmentWaitTimedOut) {
          logger("Attachment confirmation timed out; skipping user-turn attachment verification.");
        } else if (inputOnlyAttachments) {
          logger(
            "Attachment UI did not render before send; skipping user-turn attachment verification.",
          );
        } else {
          const verified = await waitForUserTurnAttachments(
            Runtime,
            attachmentNames,
            20_000,
            logger,
          );
          if (!verified) {
            // Prompt was already submitted and committed — downgrade to warning instead of
            // aborting the session. ChatGPT's post-submit attachment rendering changes frequently.
            logger(
              "[browser] [warn] Could not verify attachment UI on sent user message — proceeding anyway since prompt was committed.",
            );
          } else {
            logger("Verified attachments present on sent user message");
          }
        }
      }
      // Reattach needs a /c/ URL; ChatGPT can update it late, so poll in the background.
      scheduleConversationHint("post-submit", config.timeoutMs ?? 120_000);
      logger(
        `[browser] [phase] submit-flow — ${Date.now() - submitStartMs}ms baseline_turns=${baselineTurns ?? "none"}`,
      );
      return { baselineTurns, baselineAssistantText };
    };

    let baselineTurns: number | null = null;
    let baselineAssistantText: string | null = null;
    const baselineGeneratedImageCount = config.captureGeneratedImages
      ? await countGeneratedImages(Runtime).catch(() => 0)
      : 0;
    await acquireProfileLockIfNeeded();
    try {
      try {
        const submission = await raceWithDisconnect(submitOnce(promptText, attachments));
        baselineTurns = submission.baselineTurns;
        baselineAssistantText = submission.baselineAssistantText;
      } catch (error) {
        const isPromptTooLarge =
          error instanceof BrowserAutomationError &&
          (error.details as { code?: string } | undefined)?.code === "prompt-too-large";
        if (fallbackSubmission && isPromptTooLarge) {
          // Learned: when prompts truncate, retry with file uploads so the UI receives the full content.
          logger("[browser] Inline prompt too large; retrying with file uploads.");
          await raceWithDisconnect(clearPromptComposer(Runtime, logger));
          await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
          const submission = await raceWithDisconnect(
            submitOnce(fallbackSubmission.prompt, fallbackSubmission.attachments),
          );
          baselineTurns = submission.baselineTurns;
          baselineAssistantText = submission.baselineAssistantText;
        } else {
          throw error;
        }
      }
    } finally {
      await releaseProfileLockIfHeld();
    }
    stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, options.verbose ?? false);
    // Helper to normalize text for echo detection (collapse whitespace, lowercase)
    const normalizeForComparison = (text: string): string =>
      text.toLowerCase().replace(/\s+/g, " ").trim();
    const waitForFreshAssistantResponse = async (baselineNormalized: string, timeoutMs: number) => {
      const baselinePrefix =
        baselineNormalized.length >= 80
          ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
          : "";
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await readAssistantSnapshot(Runtime, baselineTurns ?? undefined).catch(
          () => null,
        );
        const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
        if (text) {
          const normalized = normalizeForComparison(text);
          const isBaseline =
            normalized === baselineNormalized ||
            (baselinePrefix.length > 0 && normalized.startsWith(baselinePrefix));
          if (!isBaseline) {
            return {
              text,
              html: snapshot?.html ?? undefined,
              meta: {
                turnId: snapshot?.turnId ?? undefined,
                messageId: snapshot?.messageId ?? undefined,
              },
            };
          }
        }
        await delay(350);
      }
      return null;
    };
    let answer: {
      text: string;
      html?: string;
      meta: { turnId?: string | null; messageId?: string | null };
    };
    const recheckDelayMs = Math.max(0, config.assistantRecheckDelayMs ?? 0);
    const recheckTimeoutMs = Math.max(0, config.assistantRecheckTimeoutMs ?? 0);
    const attemptAssistantRecheck = async () => {
      if (!recheckDelayMs) return null;
      logger(
        `[browser] Assistant response timed out; waiting ${formatElapsed(recheckDelayMs)} before rechecking conversation.`,
      );
      await raceWithDisconnect(delay(recheckDelayMs));
      await updateConversationHint("assistant-recheck", 15_000).catch(() => false);
      await captureRuntimeSnapshot().catch(() => undefined);
      const conversationUrl = await readConversationUrl(Runtime);
      if (conversationUrl && isConversationUrl(conversationUrl)) {
        logger(`[browser] Rechecking assistant response at ${conversationUrl}`);
        await raceWithDisconnect(Page.navigate({ url: conversationUrl }));
        await raceWithDisconnect(delay(1000));
      }
      // Validate session before attempting recheck - sessions can expire during the delay
      const sessionValid = await validateChatGPTSession(Runtime, logger);
      if (!sessionValid.valid) {
        logger(`[browser] Session validation failed: ${sessionValid.reason}`);
        // Update session metadata to indicate login is needed
        await emitRuntimeHint();
        throw new BrowserAutomationError(
          `ChatGPT session expired during recheck: ${sessionValid.reason}. ` +
            `Conversation URL: ${conversationUrl || lastUrl || "unknown"}. ` +
            `Please sign in and retry.`,
          {
            stage: "assistant-recheck",
            details: {
              conversationUrl: conversationUrl || lastUrl || null,
              sessionStatus: "needs_login",
              validationReason: sessionValid.reason,
            },
            runtime: {
              chromePid: chrome.pid,
              chromePort: chrome.port,
              chromeHost,
              userDataDir,
              chromeTargetId: lastTargetId,
              tabUrl: lastUrl,
              conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
              controllerPid: process.pid,
            },
          },
        );
      }
      const timeoutMs = recheckTimeoutMs > 0 ? recheckTimeoutMs : config.timeoutMs;
      const rechecked = await raceWithDisconnect(
        waitForAssistantResponseWithReload(
          Runtime,
          Page,
          timeoutMs,
          logger,
          baselineTurns ?? undefined,
        ),
      );
      logger("Recovered assistant response after delayed recheck");
      return rechecked;
    };
    const waitStartMs = Date.now();
    logger(
      `[browser] [lifecycle] waiting for assistant response — timeout=${config.timeoutMs}ms baseline_turns=${baselineTurns ?? "none"}`,
    );
    try {
      if (config.captureGeneratedImages && config.createImageMode) {
        await raceWithDisconnect(
          waitForNewGeneratedImage(Runtime, baselineGeneratedImageCount, config.timeoutMs, logger),
        );
        answer = {
          text: "",
          html: undefined,
          meta: {},
        };
      } else {
        answer = await raceWithDisconnect(
          waitForAssistantResponseWithReload(
            Runtime,
            Page,
            config.timeoutMs,
            logger,
            baselineTurns ?? undefined,
          ),
        );
      }
      const waitElapsed = Math.round((Date.now() - waitStartMs) / 1000);
      logger(
        `[browser] [lifecycle] assistant response captured after ${waitElapsed}s — ${answer.text.length} chars`,
      );
    } catch (error) {
      if (isAssistantResponseTimeoutError(error)) {
        const rechecked = await attemptAssistantRecheck().catch(() => null);
        if (rechecked) {
          answer = rechecked;
        } else {
          await updateConversationHint("assistant-timeout", 15_000).catch(() => false);
          await captureRuntimeSnapshot().catch(() => undefined);
          const runtime = {
            chromePid: chrome.pid,
            chromePort: chrome.port,
            chromeHost,
            userDataDir,
            chromeTargetId: lastTargetId,
            tabUrl: lastUrl,
            conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
            controllerPid: process.pid,
          };
          throw new BrowserAutomationError(
            "Assistant response timed out before completion; reattach later to capture the answer.",
            { stage: "assistant-timeout", runtime },
            error,
          );
        }
      } else if (connectionClosedUnexpectedly) {
        // CDP WebSocket disconnected but Chrome may still be alive.
        // Attempt to reconnect and capture the assistant response.
        // On success, return IMMEDIATELY — the old Runtime/Page/Input handles
        // are dead, so post-processing (markdown capture, sanity checks) would fail.
        logger(
          `[browser] [recovery] CDP disconnected during assistant response — attempting reconnection to port=${chrome.port}`,
        );
        const recoveryRemainingMs = Math.max(0, config.timeoutMs - (Date.now() - waitStartMs));
        const recovered = await recoverAssistantResponseViaCdpReconnect(
          chrome.port,
          chromeHost,
          isolatedTargetId,
          lastUrl ?? null,
          baselineTurns ?? undefined,
          logger,
          recoveryRemainingMs,
        ).catch((reconnectError) => {
          logger(
            `[browser] [recovery] reconnection failed: ${reconnectError instanceof Error ? reconnectError.message : reconnectError}`,
          );
          return null;
        });
        if (recovered) {
          logger(
            `[browser] [recovery] recovered ${recovered.text.length} chars via CDP reconnection — returning immediately`,
          );
          stopThinkingMonitor?.();
          runStatus = "complete";
          const durationMs = Date.now() - startedAt;
          return {
            answerText: recovered.text,
            answerMarkdown: recovered.text,
            answerHtml: recovered.html ?? undefined,
            tookMs: durationMs,
            answerTokens: estimateTokenCount(recovered.text),
            answerChars: recovered.text.length,
            chromePid: chrome.pid,
            chromePort: chrome.port,
            chromeHost,
            userDataDir,
            chromeTargetId: lastTargetId,
            tabUrl: lastUrl,
            controllerPid: process.pid,
          };
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
    // Ensure we store the final conversation URL even if the UI updated late.
    await updateConversationHint("post-response", 15_000);
    answerText = answer.text;
    answerHtml = answer.html ?? "";
    if (config.captureGeneratedImages && config.createImageMode) {
      answerMarkdown = answerText;
    } else {
      const baselineNormalized = baselineAssistantText
        ? normalizeForComparison(baselineAssistantText)
        : "";
      if (baselineNormalized) {
        const normalizedAnswer = normalizeForComparison(answer.text ?? "");
        const baselinePrefix =
          baselineNormalized.length >= 80
            ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
            : "";
        const isBaseline =
          normalizedAnswer === baselineNormalized ||
          (baselinePrefix.length > 0 && normalizedAnswer.startsWith(baselinePrefix));
        if (isBaseline) {
          logger("Detected stale assistant response; waiting for new response...");
          const refreshed = await waitForFreshAssistantResponse(baselineNormalized, 15_000);
          if (refreshed) {
            answer = refreshed;
          }
        }
      }
      answerText = answer.text;
      answerHtml = answer.html ?? "";
      const copiedMarkdown = await raceWithDisconnect(
        withRetries(
          async () => {
            const attempt = await captureAssistantMarkdown(Runtime, answer.meta, logger);
            if (!attempt) {
              throw new Error("copy-missing");
            }
            return attempt;
          },
          {
            retries: 2,
            delayMs: 350,
            onRetry: (attempt, error) => {
              if (options.verbose) {
                logger(
                  `[retry] Markdown capture attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                );
              }
            },
          },
        ),
      ).catch(() => null);
      answerMarkdown = copiedMarkdown ?? answerText;

      const promptEchoMatcher = buildPromptEchoMatcher(promptText);
      ({ answerText, answerMarkdown } = await maybeRecoverLongAssistantResponse({
        runtime: Runtime,
        baselineTurns,
        answerText,
        answerMarkdown,
        logger,
        allowMarkdownUpdate: !copiedMarkdown,
      }));

      // Final sanity check: ensure we didn't accidentally capture the user prompt instead of the assistant turn.
      const finalSnapshot = await readAssistantSnapshot(Runtime, baselineTurns ?? undefined).catch(
        () => null,
      );
      const finalText = typeof finalSnapshot?.text === "string" ? finalSnapshot.text.trim() : "";
      if (finalText && finalText !== promptText.trim()) {
        const trimmedMarkdown = answerMarkdown.trim();
        const finalIsEcho = promptEchoMatcher ? promptEchoMatcher.isEcho(finalText) : false;
        const lengthDelta = finalText.length - trimmedMarkdown.length;
        const missingCopy = !copiedMarkdown && lengthDelta >= 0;
        const likelyTruncatedCopy =
          copiedMarkdown &&
          trimmedMarkdown.length > 0 &&
          lengthDelta >= Math.max(12, Math.floor(trimmedMarkdown.length * 0.75));
        if ((missingCopy || likelyTruncatedCopy) && !finalIsEcho && finalText !== trimmedMarkdown) {
          logger("Refreshed assistant response via final DOM snapshot");
          answerText = finalText;
          answerMarkdown = finalText;
        }
      }

      // Detect prompt echo using normalized comparison (whitespace-insensitive).
      const alignedEcho = alignPromptEchoPair(
        answerText,
        answerMarkdown,
        promptEchoMatcher,
        copiedMarkdown ? logger : undefined,
        {
          text: "Aligned assistant response text to copied markdown after prompt echo",
          markdown: "Aligned assistant markdown to response text after prompt echo",
        },
      );
      answerText = alignedEcho.answerText;
      answerMarkdown = alignedEcho.answerMarkdown;
      const isPromptEcho = alignedEcho.isEcho;
      if (isPromptEcho) {
        logger("Detected prompt echo in response; waiting for actual assistant response...");
        const deadline = Date.now() + 15_000;
        let bestText: string | null = null;
        let stableCount = 0;
        while (Date.now() < deadline) {
          const snapshot = await readAssistantSnapshot(Runtime, baselineTurns ?? undefined).catch(
            () => null,
          );
          const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
          const isStillEcho = !text || Boolean(promptEchoMatcher?.isEcho(text));
          if (!isStillEcho) {
            if (!bestText || text.length > bestText.length) {
              bestText = text;
              stableCount = 0;
            } else if (text === bestText) {
              stableCount += 1;
            }
            if (stableCount >= 2) {
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        if (bestText) {
          logger("Recovered assistant response after detecting prompt echo");
          answerText = bestText;
          answerMarkdown = bestText;
        }
      }
      const minAnswerChars = 16;
      if (answerText.trim().length > 0 && answerText.trim().length < minAnswerChars) {
        const deadline = Date.now() + 12_000;
        let bestText = answerText.trim();
        let stableCycles = 0;
        while (Date.now() < deadline) {
          const snapshot = await readAssistantSnapshot(Runtime, baselineTurns ?? undefined).catch(
            () => null,
          );
          const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
          if (text && text.length > bestText.length) {
            bestText = text;
            stableCycles = 0;
          } else {
            stableCycles += 1;
          }
          if (stableCycles >= 3 && bestText.length >= minAnswerChars) {
            break;
          }
          await delay(400);
        }
        if (bestText.length > answerText.trim().length) {
          logger("Refreshed short assistant response from latest DOM snapshot");
          answerText = bestText;
          answerMarkdown = bestText;
        }
      }
    }
    if (connectionClosedUnexpectedly) {
      // Bail out on mid-run disconnects so the session stays reattachable.
      throw new Error("Chrome disconnected before completion");
    }
    stopThinkingMonitor?.();
    runStatus = "complete";
    const durationMs = Date.now() - startedAt;
    const answerChars = answerText.length;
    const answerTokens = estimateTokenCount(answerMarkdown);
    const generatedImages = config.captureGeneratedImages
      ? await collectGeneratedImages(Runtime, logger).catch((error) => {
          logger(
            `[browser] [image] generated image capture failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return [];
        })
      : [];
    return {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
      tookMs: durationMs,
      answerTokens,
      answerChars,
      chromePid: chrome.pid,
      chromePort: chrome.port,
      chromeHost,
      userDataDir,
      chromeTargetId: lastTargetId,
      tabUrl: lastUrl,
      controllerPid: process.pid,
      generatedImages,
    };
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    stopThinkingMonitor?.();
    const socketClosed = connectionClosedUnexpectedly || isWebSocketClosureError(normalizedError);
    connectionClosedUnexpectedly = connectionClosedUnexpectedly || socketClosed;
    if (shouldPreserveBrowserOnError(normalizedError, config.headless)) {
      preserveBrowserOnError = true;
      const runtime = {
        chromePid: chrome.pid,
        chromePort: chrome.port,
        chromeHost,
        userDataDir,
        chromeTargetId: lastTargetId,
        tabUrl: lastUrl,
        controllerPid: process.pid,
      };
      await emitRuntimeHint();
      logger("Cloudflare challenge detected; leaving browser open so you can complete the check.");
      throw new BrowserAutomationError(
        "Cloudflare challenge detected. Complete the “Just a moment…” check in the open browser, then rerun.",
        {
          stage: "cloudflare-challenge",
          runtime,
        },
        normalizedError,
      );
    }
    if (!socketClosed) {
      logger(`Failed to complete ChatGPT run: ${normalizedError.message}`);
      if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
        logger(normalizedError.stack);
      }
      throw normalizedError;
    }
    if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
      logger(`Chrome window closed before completion: ${normalizedError.message}`);
      logger(normalizedError.stack);
    }
    await emitRuntimeHint();
    throw new BrowserAutomationError(
      "Chrome window closed before oracle finished. Please keep it open until completion.",
      {
        stage: "connection-lost",
        runtime: {
          chromePid: chrome.pid,
          chromePort: chrome.port,
          chromeHost,
          userDataDir,
          chromeTargetId: lastTargetId,
          tabUrl: lastUrl,
          controllerPid: process.pid,
        },
      },
      normalizedError,
    );
  } finally {
    const cleanupStartMs = Date.now();
    try {
      if (!connectionClosedUnexpectedly) {
        await client?.close();
      }
    } catch (err) {
      logger(`[browser] [warn] client.close() failed: ${err instanceof Error ? err.message : err}`);
    }
    // Close the isolated tab once the response has been fully captured to prevent
    // tab accumulation across repeated runs. Keep the tab open on incomplete runs
    // so reattach can recover the response.
    if (runStatus === "complete" && isolatedTargetId && chrome?.port) {
      await closeTab(chrome.port, isolatedTargetId, logger, chromeHost).catch(() => undefined);
    }
    removeDialogHandler?.();
    removeTerminationHooks?.();
    const keepBrowserOpen = effectiveKeepBrowser || preserveBrowserOnError;
    // Kill Chrome unless the user asked to keep it open. When the CDP connection
    // dropped unexpectedly but recovery succeeded (runStatus === "complete"),
    // Chrome is still alive (recovery proved it) and must be cleaned up —
    // otherwise an empty about:blank Chrome window is left on screen.
    const recoveredSuccessfully = connectionClosedUnexpectedly && runStatus === "complete";
    const shouldKillChrome = !connectionClosedUnexpectedly || recoveredSuccessfully;
    if (!keepBrowserOpen) {
      if (shouldKillChrome) {
        try {
          await chrome.kill();
        } catch (err) {
          logger(
            `[browser] [warn] chrome.kill() failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      if (manualLogin) {
        const shouldCleanup = await shouldCleanupManualLoginProfileState(
          userDataDir,
          logger.verbose ? logger : undefined,
          {
            connectionClosedUnexpectedly,
            host: chromeHost,
          },
        );
        if (shouldCleanup) {
          // Preserve the persistent manual-login profile, but clear stale reattach hints.
          await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
            () => undefined,
          );
        }
      } else {
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (shouldKillChrome) {
        const totalSeconds = (Date.now() - startedAt) / 1000;
        logger(`[browser] [phase] cleanup — ${Date.now() - cleanupStartMs}ms`);
        logger(
          `[browser] [phase] total — ${Math.round(totalSeconds * 1000)}ms status=${runStatus}`,
        );
      }
    } else if (!connectionClosedUnexpectedly) {
      detachKeptBrowserProcess(chrome, logger);
      logger(`Chrome left running on port ${chrome.port} with profile ${userDataDir}`);
    }
  }
}

export function detachKeptBrowserProcess(chrome: LaunchedChrome, logger: BrowserLogger): void {
  const child = (chrome as { process?: { unref?: () => void } }).process;
  try {
    child?.unref?.();
  } catch (error) {
    logger(
      `[browser] [warn] chrome process unref failed: ${error instanceof Error ? error.message : error}`,
    );
  }
}

const DEFAULT_DEBUG_PORT = 9222;

async function pickAvailableDebugPort(
  preferredPort: number,
  logger: BrowserLogger,
): Promise<number> {
  const start =
    Number.isFinite(preferredPort) && preferredPort > 0 ? preferredPort : DEFAULT_DEBUG_PORT;
  for (let offset = 0; offset < 10; offset++) {
    const candidate = start + offset;
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }
  const fallback = await findEphemeralPort();
  logger(`DevTools ports ${start}-${start + 9} are occupied; falling back to ${fallback}.`);
  return fallback;
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      server.close();
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to acquire ephemeral port")));
      }
    });
  });
}

async function waitForLogin({
  runtime,
  logger,
  appliedCookies,
  manualLogin,
  timeoutMs,
}: {
  runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  appliedCookies: number;
  manualLogin: boolean;
  timeoutMs: number;
}): Promise<void> {
  if (!manualLogin) {
    await ensureLoggedIn(runtime, logger, { appliedCookies });
    return;
  }
  const deadline = Date.now() + Math.min(timeoutMs ?? 1_200_000, 20 * 60_000);
  let lastNotice = 0;
  while (Date.now() < deadline) {
    try {
      await ensureLoggedIn(runtime, logger, { appliedCookies });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const loginDetected = message?.toLowerCase().includes("login button");
      const sessionMissing = message?.toLowerCase().includes("session not detected");
      if (!loginDetected && !sessionMissing) {
        throw error;
      }
      const now = Date.now();
      if (now - lastNotice > 5000) {
        logger(
          "Manual login mode: please sign into chatgpt.com in the opened Chrome window; waiting for session to appear...",
        );
        lastNotice = now;
      }
      await delay(1000);
    }
  }
  throw new Error(
    "Manual login mode timed out waiting for ChatGPT session; please sign in and retry.",
  );
}

async function maybeRecoverLongAssistantResponse({
  runtime,
  baselineTurns,
  answerText,
  answerMarkdown,
  logger,
  allowMarkdownUpdate,
}: {
  runtime: ChromeClient["Runtime"];
  baselineTurns: number | null;
  answerText: string;
  answerMarkdown: string;
  logger: BrowserLogger;
  allowMarkdownUpdate: boolean;
}): Promise<{ answerText: string; answerMarkdown: string }> {
  // Learned: long streaming responses can still be rendering after initial capture.
  // Add a brief delay and re-poll to catch any additional content (#71).
  const capturedLength = answerText.trim().length;
  if (capturedLength <= 500) {
    return { answerText, answerMarkdown };
  }

  await delay(1500);
  let bestLength = capturedLength;
  let bestText = answerText;
  for (let i = 0; i < 5; i++) {
    const laterSnapshot = await readAssistantSnapshot(runtime, baselineTurns ?? undefined).catch(
      () => null,
    );
    const laterText = typeof laterSnapshot?.text === "string" ? laterSnapshot.text.trim() : "";
    if (laterText.length > bestLength) {
      bestLength = laterText.length;
      bestText = laterText;
      await delay(800); // More content appeared, keep waiting
    } else {
      break; // Stable, stop polling
    }
  }
  if (bestLength > capturedLength) {
    logger(`Recovered ${bestLength - capturedLength} additional chars via delayed re-read`);
    return {
      answerText: bestText,
      answerMarkdown: allowMarkdownUpdate ? bestText : answerMarkdown,
    };
  }
  return { answerText, answerMarkdown };
}

async function _assertNavigatedToHttp(
  runtime: ChromeClient["Runtime"],
  _logger: BrowserLogger,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = "";
  while (Date.now() < deadline) {
    const { result } = await runtime.evaluate({
      expression: 'typeof location === "object" && location.href ? location.href : ""',
      returnByValue: true,
    });
    const url = typeof result?.value === "string" ? result.value : "";
    lastUrl = url;
    if (/^https?:\/\//i.test(url)) {
      return url;
    }
    await delay(250);
  }
  throw new BrowserAutomationError("ChatGPT session not detected; page never left new tab.", {
    stage: "execute-browser",
    details: { url: lastUrl || "(empty)" },
  });
}

async function maybeReuseRunningChrome(
  userDataDir: string,
  logger: BrowserLogger,
  options: { waitForPortMs?: number; probe?: typeof verifyDevToolsReachable } = {},
): Promise<LaunchedChrome | null> {
  const waitForPortMs = Math.max(0, options.waitForPortMs ?? 0);
  let port = await readDevToolsPort(userDataDir);
  if (!port && waitForPortMs > 0) {
    const deadline = Date.now() + waitForPortMs;
    logger(`Waiting up to ${formatElapsed(waitForPortMs)} for shared Chrome to appear...`);
    while (!port && Date.now() < deadline) {
      await delay(250);
      port = await readDevToolsPort(userDataDir);
    }
  }
  if (!port) return null;

  const probe = await (options.probe ?? verifyDevToolsReachable)({ port });
  if (!probe.ok) {
    logger(
      `DevToolsActivePort found for ${userDataDir} but unreachable (${probe.error}); launching new Chrome.`,
    );
    // Safe cleanup: remove stale DevToolsActivePort; only remove lock files if this was an Oracle-owned pid that died.
    await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "if_oracle_pid_dead" });
    return null;
  }

  const pid = await readChromePid(userDataDir);
  logger(
    `Found running Chrome for ${userDataDir}; reusing (DevTools port ${port}${pid ? `, pid ${pid}` : ""})`,
  );
  return {
    port,
    pid: pid ?? undefined,
    kill: async () => {},
    process: undefined,
  } as unknown as LaunchedChrome;
}

async function runRemoteBrowserMode(
  promptText: string,
  attachments: BrowserAttachment[],
  config: ReturnType<typeof resolveBrowserConfig>,
  logger: BrowserLogger,
  options: BrowserRunOptions,
): Promise<BrowserRunResult> {
  const remoteChromeConfig = config.remoteChrome;
  if (!remoteChromeConfig) {
    throw new Error(
      "Remote Chrome configuration missing. Pass --remote-chrome <host:port> to use this mode.",
    );
  }
  const { host, port } = remoteChromeConfig;
  logger(`Connecting to remote Chrome at ${host}:${port}`);

  let client: ChromeClient | null = null;
  let remoteTargetId: string | null = null;
  let lastUrl: string | undefined;
  const runtimeHintCb = options.runtimeHintCb;
  const emitRuntimeHint = async () => {
    if (!runtimeHintCb) return;
    try {
      await runtimeHintCb({
        chromePort: port,
        chromeHost: host,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: lastUrl,
        controllerPid: process.pid,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to persist runtime hint: ${message}`);
    }
  };
  const startedAt = Date.now();
  let answerText = "";
  let answerMarkdown = "";
  let answerHtml = "";
  let connectionClosedUnexpectedly = false;
  let stopThinkingMonitor: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;

  try {
    const connection = await connectToRemoteChrome(host, port, logger, config.url);
    client = connection.client;
    remoteTargetId = connection.targetId ?? null;
    await emitRuntimeHint();
    const markConnectionLost = () => {
      connectionClosedUnexpectedly = true;
    };
    client.on("disconnect", markConnectionLost);
    const { Network, Page, Runtime, Input, DOM } = client;
    const bringPageToFront = async () => {
      if (Page && typeof Page.bringToFront === "function") {
        try {
          await Page.bringToFront();
        } catch (err) {
          logger(
            `[browser] [warn] remote bringToFront failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    };

    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === "function") {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    removeDialogHandler = installJavaScriptDialogAutoDismissal(Page, logger);

    // Skip cookie sync for remote Chrome - it already has cookies
    logger("Skipping cookie sync for remote Chrome (using existing session)");

    await navigateToChatGPT(Page, Runtime, config.url, logger);
    await ensureNotBlocked(Runtime, config.headless, logger);
    await ensureLoggedIn(Runtime, logger, { remoteSession: true });
    await bringPageToFront();
    await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
    {
      const expectedConversationId = extractConversationIdFromUrl(config.url);
      if (expectedConversationId) {
        await assertCurrentConversationId(Runtime, expectedConversationId, logger);
      }
    }
    logger(
      `Prompt textarea ready (initial focus, ${promptText.length.toLocaleString()} chars queued)`,
    );
    try {
      const { result } = await Runtime.evaluate({
        expression: "location.href",
        returnByValue: true,
      });
      if (typeof result?.value === "string") {
        lastUrl = result.value;
      }
      await emitRuntimeHint();
    } catch (err) {
      logger(
        `[browser] [warn] remote snapshot failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    const modelStrategy = config.createImageMode
      ? "current"
      : (config.modelStrategy ?? DEFAULT_MODEL_STRATEGY);
    if (config.desiredModel && modelStrategy === "select") {
      await bringPageToFront();
      await withRetries(
        () =>
          ensureModelSelection(
            Runtime,
            config.desiredModel as string,
            logger,
            modelStrategy,
            Input,
          ),
        {
          retries: 2,
          delayMs: 300,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(
                `[retry] Model picker attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
              );
            }
          },
        },
      );
      await closeOpenModelMenuBestEffort(Runtime, Input, logger);
      await forceDismissOpenModelPicker(Runtime, logger);
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
      logger(
        `Prompt textarea ready (after model switch, ${promptText.length.toLocaleString()} chars queued)`,
      );
    } else if (modelStrategy === "ignore" || modelStrategy === "current") {
      logger(`Model picker: skipped (strategy=${modelStrategy})`);
    }
    // Handle thinking time selection if specified
    const thinkingTime = config.thinkingTime;
    if (thinkingTime) {
      await withRetries(() => ensureThinkingTime(Runtime, thinkingTime, logger), {
        retries: 2,
        delayMs: 300,
        onRetry: (attempt, error) => {
          if (options.verbose) {
            logger(
              `[retry] Thinking time (${thinkingTime}) attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
            );
          }
        },
      });
    }
    if (config.createImageMode) {
      await ensureCreateImageMode(Runtime, Input, logger);
      logger("Create image mode enabled");
    }

    const submitOnce = async (prompt: string, submissionAttachments: BrowserAttachment[]) => {
      const baselineSnapshot = await readAssistantSnapshot(Runtime).catch(() => null);
      const baselineAssistantText =
        typeof baselineSnapshot?.text === "string" ? baselineSnapshot.text.trim() : "";
      const attachmentNames = submissionAttachments.map((a) => path.basename(a.path));
      if (submissionAttachments.length > 0) {
        if (!DOM) {
          throw new Error("Chrome DOM domain unavailable while uploading attachments.");
        }
        await clearComposerAttachments(Runtime, 5_000, logger);
        // Use remote file transfer for remote Chrome (reads local files and injects via CDP)
        for (const attachment of submissionAttachments) {
          logger(`Uploading attachment: ${attachment.displayPath}`);
          await uploadAttachmentViaDataTransfer({ runtime: Runtime, dom: DOM }, attachment, logger);
          await delay(500);
        }
        // Scale timeout based on number of files: base 30s + 15s per additional file
        const baseTimeout = config.inputTimeoutMs ?? 30_000;
        const perFileTimeout = 15_000;
        const waitBudget =
          Math.max(baseTimeout, 30_000) + (submissionAttachments.length - 1) * perFileTimeout;
        await waitForAttachmentCompletion(Runtime, waitBudget, attachmentNames, logger);
        logger("All attachments uploaded");
      }
      let baselineTurns = await readConversationTurnCount(Runtime, logger);
      const providerState: Record<string, unknown> = {
        runtime: Runtime,
        input: Input,
        logger,
        timeoutMs: config.timeoutMs,
        inputTimeoutMs: config.inputTimeoutMs ?? undefined,
        baselineTurns: baselineTurns ?? undefined,
        attachmentNames,
      };
      await runProviderSubmissionFlow(chatgptDomProvider, {
        prompt,
        evaluate: async () => undefined,
        delay,
        log: logger,
        state: providerState,
      });
      const providerBaselineTurns = providerState.baselineTurns;
      if (typeof providerBaselineTurns === "number" && Number.isFinite(providerBaselineTurns)) {
        baselineTurns = providerBaselineTurns;
      }
      return { baselineTurns, baselineAssistantText };
    };

    let baselineTurns: number | null = null;
    let baselineAssistantText: string | null = null;
    const baselineGeneratedImageCount = config.captureGeneratedImages
      ? await countGeneratedImages(Runtime).catch(() => 0)
      : 0;
    try {
      const submission = await submitOnce(promptText, attachments);
      baselineTurns = submission.baselineTurns;
      baselineAssistantText = submission.baselineAssistantText;
    } catch (error) {
      const isPromptTooLarge =
        error instanceof BrowserAutomationError &&
        (error.details as { code?: string } | undefined)?.code === "prompt-too-large";
      if (options.fallbackSubmission && isPromptTooLarge) {
        logger("[browser] Inline prompt too large; retrying with file uploads.");
        await clearPromptComposer(Runtime, logger);
        await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
        const submission = await submitOnce(
          options.fallbackSubmission.prompt,
          options.fallbackSubmission.attachments,
        );
        baselineTurns = submission.baselineTurns;
        baselineAssistantText = submission.baselineAssistantText;
      } else {
        throw error;
      }
    }
    stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, options.verbose ?? false);
    // Helper to normalize text for echo detection (collapse whitespace, lowercase)
    const normalizeForComparison = (text: string): string =>
      text.toLowerCase().replace(/\s+/g, " ").trim();
    const waitForFreshAssistantResponse = async (baselineNormalized: string, timeoutMs: number) => {
      const baselinePrefix =
        baselineNormalized.length >= 80
          ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
          : "";
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await readAssistantSnapshot(Runtime, baselineTurns ?? undefined).catch(
          () => null,
        );
        const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
        if (text) {
          const normalized = normalizeForComparison(text);
          const isBaseline =
            normalized === baselineNormalized ||
            (baselinePrefix.length > 0 && normalized.startsWith(baselinePrefix));
          if (!isBaseline) {
            return {
              text,
              html: snapshot?.html ?? undefined,
              meta: {
                turnId: snapshot?.turnId ?? undefined,
                messageId: snapshot?.messageId ?? undefined,
              },
            };
          }
        }
        await delay(350);
      }
      return null;
    };
    let answer: {
      text: string;
      html?: string;
      meta: { turnId?: string | null; messageId?: string | null };
    };
    const recheckDelayMs = Math.max(0, config.assistantRecheckDelayMs ?? 0);
    const recheckTimeoutMs = Math.max(0, config.assistantRecheckTimeoutMs ?? 0);
    const attemptAssistantRecheck = async () => {
      if (!recheckDelayMs) return null;
      logger(
        `[browser] Assistant response timed out; waiting ${formatElapsed(recheckDelayMs)} before rechecking conversation.`,
      );
      await delay(recheckDelayMs);
      const conversationUrl = await readConversationUrl(Runtime);
      if (conversationUrl && isConversationUrl(conversationUrl)) {
        lastUrl = conversationUrl;
        logger(`[browser] Rechecking assistant response at ${conversationUrl}`);
        await Page.navigate({ url: conversationUrl });
        await delay(1000);
      }
      // Validate session before attempting recheck - sessions can expire during the delay
      const sessionValid = await validateChatGPTSession(Runtime, logger);
      if (!sessionValid.valid) {
        logger(`[browser] Session validation failed: ${sessionValid.reason}`);
        // Update session metadata to indicate login is needed
        await emitRuntimeHint();
        throw new BrowserAutomationError(
          `ChatGPT session expired during recheck: ${sessionValid.reason}. ` +
            `Conversation URL: ${conversationUrl || lastUrl || "unknown"}. ` +
            `Please sign in and retry.`,
          {
            stage: "assistant-recheck",
            details: {
              conversationUrl: conversationUrl || lastUrl || null,
              sessionStatus: "needs_login",
              validationReason: sessionValid.reason,
            },
            runtime: {
              chromeHost: host,
              chromePort: port,
              chromeTargetId: remoteTargetId ?? undefined,
              tabUrl: lastUrl,
              conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
              controllerPid: process.pid,
            },
          },
        );
      }
      await emitRuntimeHint();
      const timeoutMs = recheckTimeoutMs > 0 ? recheckTimeoutMs : config.timeoutMs;
      const rechecked = await waitForAssistantResponseWithReload(
        Runtime,
        Page,
        timeoutMs,
        logger,
        baselineTurns ?? undefined,
      );
      logger("Recovered assistant response after delayed recheck");
      return rechecked;
    };
    try {
      if (config.captureGeneratedImages && config.createImageMode) {
        await waitForNewGeneratedImage(
          Runtime,
          baselineGeneratedImageCount,
          config.timeoutMs,
          logger,
        );
        answer = {
          text: "",
          html: undefined,
          meta: {},
        };
      } else {
        answer = await waitForAssistantResponseWithReload(
          Runtime,
          Page,
          config.timeoutMs,
          logger,
          baselineTurns ?? undefined,
        );
      }
    } catch (error) {
      if (isAssistantResponseTimeoutError(error)) {
        const rechecked = await attemptAssistantRecheck().catch(() => null);
        if (rechecked) {
          answer = rechecked;
        } else {
          try {
            const conversationUrl = await readConversationUrl(Runtime);
            if (conversationUrl) {
              lastUrl = conversationUrl;
            }
          } catch (err) {
            logger(
              `[browser] [warn] readConversationUrl failed: ${err instanceof Error ? err.message : err}`,
            );
          }
          await emitRuntimeHint();
          const runtime = {
            chromePort: port,
            chromeHost: host,
            chromeTargetId: remoteTargetId ?? undefined,
            tabUrl: lastUrl,
            conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
            controllerPid: process.pid,
          };
          throw new BrowserAutomationError(
            "Assistant response timed out before completion; reattach later to capture the answer.",
            { stage: "assistant-timeout", runtime },
            error,
          );
        }
      } else {
        throw error;
      }
    }
    answerText = answer.text;
    answerHtml = answer.html ?? "";
    if (config.captureGeneratedImages && config.createImageMode) {
      answerMarkdown = answerText;
    } else {
      const baselineNormalized = baselineAssistantText
        ? normalizeForComparison(baselineAssistantText)
        : "";
      if (baselineNormalized) {
        const normalizedAnswer = normalizeForComparison(answer.text ?? "");
        const baselinePrefix =
          baselineNormalized.length >= 80
            ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
            : "";
        const isBaseline =
          normalizedAnswer === baselineNormalized ||
          (baselinePrefix.length > 0 && normalizedAnswer.startsWith(baselinePrefix));
        if (isBaseline) {
          logger("Detected stale assistant response; waiting for new response...");
          const refreshed = await waitForFreshAssistantResponse(baselineNormalized, 15_000);
          if (refreshed) {
            answer = refreshed;
          }
        }
      }
      answerText = answer.text;
      answerHtml = answer.html ?? "";

      const copiedMarkdown = await withRetries(
        async () => {
          const attempt = await captureAssistantMarkdown(Runtime, answer.meta, logger);
          if (!attempt) {
            throw new Error("copy-missing");
          }
          return attempt;
        },
        {
          retries: 2,
          delayMs: 350,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(
                `[retry] Markdown capture attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
              );
            }
          },
        },
      ).catch(() => null);

      answerMarkdown = copiedMarkdown ?? answerText;
      ({ answerText, answerMarkdown } = await maybeRecoverLongAssistantResponse({
        runtime: Runtime,
        baselineTurns,
        answerText,
        answerMarkdown,
        logger,
        allowMarkdownUpdate: !copiedMarkdown,
      }));

      // Final sanity check: ensure we didn't accidentally capture the user prompt instead of the assistant turn.
      const finalSnapshot = await readAssistantSnapshot(Runtime, baselineTurns ?? undefined).catch(
        () => null,
      );
      const finalText = typeof finalSnapshot?.text === "string" ? finalSnapshot.text.trim() : "";
      if (
        finalText &&
        finalText !== answerMarkdown.trim() &&
        finalText !== promptText.trim() &&
        finalText.length >= answerMarkdown.trim().length
      ) {
        logger("Refreshed assistant response via final DOM snapshot");
        answerText = finalText;
        answerMarkdown = finalText;
      }

      // Detect prompt echo using normalized comparison (whitespace-insensitive).
      const promptEchoMatcher = buildPromptEchoMatcher(promptText);
      const alignedEcho = alignPromptEchoPair(
        answerText,
        answerMarkdown,
        promptEchoMatcher,
        copiedMarkdown ? logger : undefined,
        {
          text: "Aligned assistant response text to copied markdown after prompt echo",
          markdown: "Aligned assistant markdown to response text after prompt echo",
        },
      );
      answerText = alignedEcho.answerText;
      answerMarkdown = alignedEcho.answerMarkdown;
      const isPromptEcho = alignedEcho.isEcho;
      if (isPromptEcho) {
        logger("Detected prompt echo in response; waiting for actual assistant response...");
        const deadline = Date.now() + 15_000;
        let bestText: string | null = null;
        let stableCount = 0;
        while (Date.now() < deadline) {
          const snapshot = await readAssistantSnapshot(Runtime, baselineTurns ?? undefined).catch(
            () => null,
          );
          const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
          const isStillEcho = !text || Boolean(promptEchoMatcher?.isEcho(text));
          if (!isStillEcho) {
            if (!bestText || text.length > bestText.length) {
              bestText = text;
              stableCount = 0;
            } else if (text === bestText) {
              stableCount += 1;
            }
            if (stableCount >= 2) {
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        if (bestText) {
          logger("Recovered assistant response after detecting prompt echo");
          answerText = bestText;
          answerMarkdown = bestText;
        }
      }
    }
    stopThinkingMonitor?.();

    const durationMs = Date.now() - startedAt;
    const answerChars = answerText.length;
    const answerTokens = estimateTokenCount(answerMarkdown);
    const generatedImages = config.captureGeneratedImages
      ? await collectGeneratedImages(Runtime, logger).catch((error) => {
          logger(
            `[browser] [image] generated image capture failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return [];
        })
      : [];

    return {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
      tookMs: durationMs,
      answerTokens,
      answerChars,
      chromePid: undefined,
      chromePort: port,
      chromeHost: host,
      userDataDir: undefined,
      chromeTargetId: remoteTargetId ?? undefined,
      tabUrl: lastUrl,
      controllerPid: process.pid,
      generatedImages,
    };
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    stopThinkingMonitor?.();
    const socketClosed = connectionClosedUnexpectedly || isWebSocketClosureError(normalizedError);
    connectionClosedUnexpectedly = connectionClosedUnexpectedly || socketClosed;

    if (!socketClosed) {
      logger(`Failed to complete ChatGPT run: ${normalizedError.message}`);
      if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
        logger(normalizedError.stack);
      }
      throw normalizedError;
    }

    throw new BrowserAutomationError("Remote Chrome connection lost before Oracle finished.", {
      stage: "connection-lost",
      runtime: {
        chromeHost: host,
        chromePort: port,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: lastUrl,
        controllerPid: process.pid,
      },
    });
  } finally {
    try {
      if (!connectionClosedUnexpectedly && client) {
        await client.close();
      }
    } catch (err) {
      logger(
        `[browser] [warn] remote client.close() failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    removeDialogHandler?.();
    await closeRemoteChromeTarget(host, port, remoteTargetId ?? undefined, logger);
    // Don't kill remote Chrome - it's not ours to manage
    const totalSeconds = (Date.now() - startedAt) / 1000;
    logger(`Remote session complete • ${totalSeconds.toFixed(1)}s total`);
  }
}

export { estimateTokenCount } from "./utils.js";
export { resolveBrowserConfig, DEFAULT_BROWSER_CONFIG } from "./config.js";
export { syncCookies } from "./cookies.js";
export {
  navigateToChatGPT,
  ensureNotBlocked,
  ensurePromptReady,
  ensureModelSelection,
  submitPrompt,
  waitForAssistantResponse,
  captureAssistantMarkdown,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
} from "./pageActions.js";

export async function maybeReuseRunningChromeForTest(
  userDataDir: string,
  logger: BrowserLogger,
  options: { waitForPortMs?: number; probe?: typeof verifyDevToolsReachable } = {},
): Promise<LaunchedChrome | null> {
  return maybeReuseRunningChrome(userDataDir, logger, options);
}

export function isWebSocketClosureError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("websocket connection closed") ||
    message.includes("websocket is closed") ||
    message.includes("websocket error") ||
    message.includes("inspected target navigated or closed") ||
    message.includes("target closed")
  );
}

export function formatThinkingLog(
  startedAt: number,
  now: number,
  message: string,
  locatorSuffix: string,
): string {
  const elapsedMs = now - startedAt;
  const elapsedText = formatElapsed(elapsedMs);
  const progress = Math.min(1, elapsedMs / 600_000); // soft target: 10 minutes
  const pct = Math.round(progress * 100)
    .toString()
    .padStart(3, " ");
  const statusLabel = message ? ` — ${message}` : "";
  return `${pct}% [${elapsedText} / ~10m]${statusLabel}${locatorSuffix}`;
}

async function waitForAssistantResponseWithReload(
  Runtime: ChromeClient["Runtime"],
  Page: ChromeClient["Page"],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
) {
  try {
    return await waitForAssistantResponse(Runtime, timeoutMs, logger, minTurnIndex);
  } catch (error) {
    if (!shouldReloadAfterAssistantError(error)) {
      throw error;
    }
    const conversationUrl = await readConversationUrl(Runtime);
    if (!conversationUrl || !isConversationUrl(conversationUrl)) {
      throw error;
    }
    logger("Assistant response stalled; reloading conversation and retrying once");
    await Page.navigate({ url: conversationUrl });
    await delay(1000);
    return await waitForAssistantResponse(Runtime, timeoutMs, logger, minTurnIndex);
  }
}

function shouldReloadAfterAssistantError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("assistant-response") ||
    message.includes("watchdog") ||
    message.includes("timeout") ||
    message.includes("capture assistant response")
  );
}

function isAssistantResponseTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (!message) return false;
  return (
    message.includes("assistant-response") ||
    message.includes("assistant response") ||
    message.includes("watchdog") ||
    message.includes("capture assistant response")
  );
}

async function readConversationUrl(
  Runtime: ChromeClient["Runtime"],
  logger?: BrowserLogger,
): Promise<string | null> {
  try {
    const currentUrl = await Runtime.evaluate({ expression: "location.href", returnByValue: true });
    return typeof currentUrl.result?.value === "string" ? currentUrl.result.value : null;
  } catch (err) {
    logger?.(
      `[browser] [warn] readConversationUrl eval failed: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

interface SessionValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates that the ChatGPT session is still active by checking for login CTAs
 * and textarea availability. Sessions can expire during long delays (e.g., recheck).
 *
 * @param Runtime - Chrome Runtime client
 * @param logger - Browser logger for diagnostics
 * @returns SessionValidationResult indicating if session is valid and reason if not
 */
async function validateChatGPTSession(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<SessionValidationResult> {
  try {
    const outcome = await Runtime.evaluate({
      expression: buildSessionValidationExpression(),
      awaitPromise: true,
      returnByValue: true,
    });

    const result = outcome.result?.value as
      | {
          valid: boolean;
          hasLoginCta: boolean;
          hasTextarea: boolean;
          onAuthPage: boolean;
          pageUrl: string | null;
        }
      | undefined;

    if (!result) {
      return { valid: false, reason: "Failed to evaluate session state" };
    }

    if (result.onAuthPage) {
      return { valid: false, reason: "Redirected to auth page" };
    }

    if (result.hasLoginCta) {
      return { valid: false, reason: "Login button detected on page" };
    }

    if (!result.hasTextarea) {
      return { valid: false, reason: "Prompt textarea not available" };
    }

    return { valid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Session validation error: ${message}`);
    return { valid: false, reason: `Validation error: ${message}` };
  }
}

function buildSessionValidationExpression(): string {
  const selectorLiteral = JSON.stringify(INPUT_SELECTORS);
  return `(async () => {
    const pageUrl = typeof location === 'object' && location?.href ? location.href : null;
    const onAuthPage =
      typeof location === 'object' &&
      typeof location.pathname === 'string' &&
      /^\\/(auth|login|signin)/i.test(location.pathname);

    // Check for login CTAs (similar to ensureLoggedIn logic)
    const hasLoginCta = (() => {
      const candidates = Array.from(
        document.querySelectorAll(
          [
            'a[href*="/auth/login"]',
            'a[href*="/auth/signin"]',
            'button[type="submit"]',
            'button[data-testid*="login"]',
            'button[data-testid*="log-in"]',
            'button[data-testid*="sign-in"]',
            'button[data-testid*="signin"]',
            'button',
            'a',
          ].join(','),
        ),
      );
      const textMatches = (text) => {
        if (!text) return false;
        const normalized = text.toLowerCase().trim();
        return ['log in', 'login', 'sign in', 'signin', 'continue with'].some((needle) =>
          normalized.startsWith(needle),
        );
      };
      for (const node of candidates) {
        if (!(node instanceof HTMLElement)) continue;
        const label =
          node.textContent?.trim() ||
          node.getAttribute('aria-label') ||
          node.getAttribute('title') ||
          '';
        if (textMatches(label)) {
          return true;
        }
      }
      return false;
    })();

    // Check for textarea availability
    const hasTextarea = (() => {
      const selectors = ${selectorLiteral};
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (node) {
          return true;
        }
      }
      return false;
    })();

    return {
      valid: !onAuthPage && !hasLoginCta && hasTextarea,
      hasLoginCta,
      hasTextarea,
      onAuthPage,
      pageUrl,
    };
  })()`;
}

async function readConversationTurnCount(
  Runtime: ChromeClient["Runtime"],
  logger?: BrowserLogger,
): Promise<number | null> {
  const selectorLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const attempts = 4;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const { result } = await Runtime.evaluate({
        expression: `document.querySelectorAll(${selectorLiteral}).length`,
        returnByValue: true,
      });
      const raw = typeof result?.value === "number" ? result.value : Number(result?.value);
      if (!Number.isFinite(raw)) {
        throw new Error("Turn count not numeric");
      }
      return Math.max(0, Math.floor(raw));
    } catch (error) {
      if (attempt < attempts - 1) {
        await delay(150);
        continue;
      }
      if (logger?.verbose) {
        logger(
          `Failed to read conversation turn count: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    }
  }
  return null;
}

function isConversationUrl(url: string): boolean {
  return /\/c\/[a-z0-9-]+/i.test(url);
}

function startThinkingStatusMonitor(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  includeDiagnostics = false,
): () => void {
  let stopped = false;
  let pending = false;
  let lastMessage: string | null = null;
  const startedAt = Date.now();
  const interval = setInterval(async () => {
    // stop flag flips asynchronously
    if (stopped || pending) {
      return;
    }
    pending = true;
    try {
      const nextMessage = await readThinkingStatus(Runtime);
      if (nextMessage && nextMessage !== lastMessage) {
        lastMessage = nextMessage;
        let locatorSuffix = "";
        if (includeDiagnostics) {
          try {
            const snapshot = await readAssistantSnapshot(Runtime);
            locatorSuffix = ` | assistant-turn=${snapshot ? "present" : "missing"}`;
          } catch {
            locatorSuffix = " | assistant-turn=error";
          }
        }
        logger(formatThinkingLog(startedAt, Date.now(), nextMessage, locatorSuffix));
      }
    } catch (err) {
      logger(
        `[browser] [warn] thinking monitor poll failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      pending = false;
    }
  }, 1500);
  interval.unref?.();
  return () => {
    // multiple callers may race to stop
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(interval);
  };
}

async function readThinkingStatus(Runtime: ChromeClient["Runtime"]): Promise<string | null> {
  const expression = buildThinkingStatusExpression();
  try {
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    const value = typeof result.value === "string" ? result.value.trim() : "";
    const sanitized = sanitizeThinkingText(value);
    return sanitized || null;
  } catch {
    return null;
  }
}

function sanitizeThinkingText(raw: string): string {
  if (!raw) {
    return "";
  }
  const trimmed = raw.trim();
  const prefixPattern = /^(pro thinking)\s*[•:\-–—]*\s*/i;
  if (prefixPattern.test(trimmed)) {
    return trimmed.replace(prefixPattern, "").trim();
  }
  return trimmed;
}

function describeDevtoolsFirewallHint(host: string, port: number): string | null {
  if (!isWsl()) return null;
  return [
    `DevTools port ${host}:${port} is blocked from WSL.`,
    "",
    "PowerShell (admin):",
    `New-NetFirewallRule -DisplayName 'Chrome DevTools ${port}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port}`,
    "New-NetFirewallRule -DisplayName 'Chrome DevTools (chrome.exe)' -Direction Inbound -Action Allow -Program 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' -Protocol TCP",
    "",
    "Re-run the same oracle command after adding the rule.",
  ].join("\n");
}

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  return os.release().toLowerCase().includes("microsoft");
}

function extractConversationIdFromUrl(url: string): string | undefined {
  const match = url.match(/\/c\/([a-zA-Z0-9-]+)/);
  return match?.[1];
}

async function resolveUserDataBaseDir(): Promise<string> {
  // On WSL, Chrome launched via Windows can choke on UNC paths; prefer a Windows-backed temp folder.
  if (isWsl()) {
    const candidates = [
      "/mnt/c/Users/Public/AppData/Local/Temp",
      "/mnt/c/Temp",
      "/mnt/c/Windows/Temp",
    ];
    for (const candidate of candidates) {
      try {
        await mkdir(candidate, { recursive: true });
        return candidate;
      } catch {
        // try next
      }
    }
  }
  return os.tmpdir();
}

function buildThinkingStatusExpression(): string {
  const selectors = [
    "span.loading-shimmer",
    "span.flex.items-center.gap-1.truncate.text-start.align-middle.text-token-text-tertiary",
    '[data-testid*="thinking"]',
    '[data-testid*="reasoning"]',
    '[role="status"]',
    '[aria-live="polite"]',
  ];
  const keywords = [
    "pro thinking",
    "thinking",
    "reasoning",
    "clarifying",
    "planning",
    "drafting",
    "summarizing",
  ];
  const selectorLiteral = JSON.stringify(selectors);
  const keywordsLiteral = JSON.stringify(keywords);
  return `(() => {
    const selectors = ${selectorLiteral};
    const keywords = ${keywordsLiteral};
    const nodes = new Set();
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((node) => nodes.add(node));
    }
    document.querySelectorAll('[data-testid]').forEach((node) => nodes.add(node));
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      const text = node.textContent?.trim();
      if (!text) {
        continue;
      }
      const classLabel = (node.className || '').toLowerCase();
      const dataLabel = ((node.getAttribute('data-testid') || '') + ' ' + (node.getAttribute('aria-label') || ''))
        .toLowerCase();
      const normalizedText = text.toLowerCase();
      const matches = keywords.some((keyword) =>
        normalizedText.includes(keyword) || classLabel.includes(keyword) || dataLabel.includes(keyword)
      );
      if (matches) {
        const shimmerChild = node.querySelector(
          'span.flex.items-center.gap-1.truncate.text-start.align-middle.text-token-text-tertiary',
        );
        if (shimmerChild?.textContent?.trim()) {
          return shimmerChild.textContent.trim();
        }
        return text.trim();
      }
    }
    return null;
  })()`;
}

/**
 * Reconnect to a Chrome tab after CDP disconnect and capture the assistant response.
 * Chrome may still be alive with a completed response even though the WebSocket dropped.
 * This tries: (1) reconnect to the specific tab target, (2) fall back to finding the
 * ChatGPT conversation tab, (3) read the assistant snapshot.
 */
async function recoverAssistantResponseViaCdpReconnect(
  port: number,
  chromeHost: string,
  isolatedTargetId: string | null,
  lastKnownUrl: string | null,
  minTurnIndex: number | undefined,
  logger: BrowserLogger,
  remainingTimeoutMs?: number,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null> {
  const effectiveHost = chromeHost || "127.0.0.1";

  // Step 1: Verify Chrome is still reachable
  logger(`[browser] [recovery] checking Chrome health at ${effectiveHost}:${port}`);
  let targets: Array<{ id: string; type: string; url: string }>;
  try {
    targets = (await CDP.List({ host: effectiveHost, port })) as Array<{
      id: string;
      type: string;
      url: string;
    }>;
    logger(`[browser] [recovery] Chrome alive — ${targets.length} targets found`);
  } catch (err) {
    logger(`[browser] [recovery] Chrome unreachable: ${err instanceof Error ? err.message : err}`);
    return null;
  }

  // Step 2: Find the right target to reconnect to.
  // Priority: (1) original target ID, (2) exact URL match, (3) conversation ID match.
  // Never fall back to "first chatgpt.com/c/ page" — that can pick the wrong tab
  // when multiple oracle sessions have concurrent Chrome instances.
  let targetId: string | undefined;
  if (isolatedTargetId) {
    const found = targets.find((t) => t.id === isolatedTargetId);
    if (found) {
      logger(
        `[browser] [recovery] found original isolated target ${isolatedTargetId} — url=${found.url.slice(0, 80)}`,
      );
      targetId = isolatedTargetId;
    } else {
      logger(
        `[browser] [recovery] original target ${isolatedTargetId} not found — trying URL match`,
      );
    }
  }
  if (!targetId && lastKnownUrl) {
    // Extract conversation ID for fuzzy matching (URL may have trailing params)
    const conversationId = extractConversationIdFromUrl(lastKnownUrl);
    // Try exact URL match first
    const exactMatch = targets.find((t) => t.type === "page" && t.url === lastKnownUrl);
    if (exactMatch) {
      logger(`[browser] [recovery] exact URL match: ${exactMatch.url.slice(0, 80)}`);
      targetId = exactMatch.id;
    } else if (conversationId) {
      // Fall back to conversation ID match
      const cidMatch = targets.find((t) => t.type === "page" && t.url.includes(conversationId));
      if (cidMatch) {
        logger(
          `[browser] [recovery] conversation ID match (${conversationId}): ${cidMatch.url.slice(0, 80)}`,
        );
        targetId = cidMatch.id;
      }
    }
  }
  if (!targetId) {
    logger(`[browser] [recovery] no matching target found — listing all targets for diagnostics`);
    for (const t of targets) {
      logger(`[browser] [recovery]   target ${t.id}: type=${t.type} url=${t.url.slice(0, 80)}`);
    }
    return null;
  }

  // Step 3: Reconnect CDP
  logger(`[browser] [recovery] reconnecting to target ${targetId}`);
  let reconnectedClient: ChromeClient;
  try {
    reconnectedClient = await CDP({ host: effectiveHost, port, target: targetId });
    logger(`[browser] [recovery] CDP reconnected successfully`);
  } catch (err) {
    logger(
      `[browser] [recovery] CDP reconnect failed: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }

  // Step 4: Enable Runtime and read the assistant snapshot
  try {
    await reconnectedClient.Runtime.enable();
    logger(
      `[browser] [recovery] Runtime enabled — reading assistant snapshot (minTurnIndex=${minTurnIndex ?? "none"})`,
    );

    // Wait briefly for any in-flight rendering to settle
    await delay(2000);

    // Diagnostic: check what the DOM actually contains before the snapshot filter
    let diagStopVisible = false;
    try {
      const diag = await reconnectedClient.Runtime.evaluate({
        expression: `(() => {
          const allTurns = document.querySelectorAll('section[data-testid^="conversation-turn"], article[data-testid^="conversation-turn"], div[data-testid^="conversation-turn"], section[data-message-author-role], article[data-message-author-role], div[data-message-author-role], section[data-turn], article[data-turn], div[data-turn]');
          const assistantTurns = document.querySelectorAll('[data-message-author-role="assistant"], [data-turn="assistant"]');
          const lastAssistant = assistantTurns[assistantTurns.length - 1];
          return {
            totalTurns: allTurns.length,
            assistantTurns: assistantTurns.length,
            lastAssistantText: lastAssistant ? (lastAssistant.textContent || '').slice(0, 200) : 'none',
            lastAssistantIndex: lastAssistant ? Array.from(allTurns).indexOf(lastAssistant.closest('section, article, div[data-testid^="conversation-turn"]') || lastAssistant) : -1,
            stopVisible: Boolean(document.querySelector('[data-testid="stop-button"]')),
          };
        })()`,
        returnByValue: true,
      });
      const d = diag.result?.value as Record<string, unknown> | undefined;
      diagStopVisible = Boolean(d?.stopVisible);
      logger(
        `[browser] [recovery] DOM diagnostic — totalTurns=${d?.totalTurns} assistantTurns=${d?.assistantTurns} lastAssistantIndex=${d?.lastAssistantIndex} stop=${d?.stopVisible} textPreview="${String(d?.lastAssistantText ?? "").slice(0, 100)}"`,
      );
    } catch (diagErr) {
      logger(
        `[browser] [recovery] DOM diagnostic failed: ${diagErr instanceof Error ? diagErr.message : diagErr}`,
      );
    }

    // If the stop button is still visible, ChatGPT is still thinking.
    // Poll for completion instead of capturing an interim thinking snippet.
    if (diagStopVisible && remainingTimeoutMs && remainingTimeoutMs > 0) {
      logger(
        `[browser] [recovery] stop button still visible — entering poll loop (timeout=${Math.round(remainingTimeoutMs / 1000)}s)`,
      );
      try {
        const pollResult = await pollAssistantCompletion(
          reconnectedClient.Runtime,
          remainingTimeoutMs,
          minTurnIndex,
          undefined,
          logger,
          null,
        );
        if (pollResult) {
          logger(`[browser] [recovery] poll completed — ${pollResult.text.length} chars`);
          return pollResult;
        }
        logger(`[browser] [recovery] poll returned null — falling through to one-shot snapshot`);
      } catch (pollErr) {
        logger(
          `[browser] [recovery] poll failed: ${pollErr instanceof Error ? pollErr.message : pollErr} — falling through to one-shot snapshot`,
        );
      }
    }

    // One-shot snapshot: either stop was already gone, or polling failed/timed out.
    let snapshot = await readAssistantSnapshot(reconnectedClient.Runtime, minTurnIndex);

    // If filtered snapshot is empty, try again without the filter
    if (!snapshot?.text?.trim() && typeof minTurnIndex === "number") {
      logger(`[browser] [recovery] filtered snapshot empty — retrying without minTurnIndex filter`);
      snapshot = await readAssistantSnapshot(reconnectedClient.Runtime, undefined);
    }

    if (!snapshot || !snapshot.text?.trim()) {
      logger(`[browser] [recovery] snapshot empty or no text found`);
      return null;
    }

    const text = snapshot.text.trim();
    logger(
      `[browser] [recovery] captured ${text.length} chars — preview: ${text.slice(0, 120).replace(/\n/g, " ")}`,
    );

    return {
      text,
      html: snapshot.html ?? undefined,
      meta: {
        turnId: snapshot.turnId ?? undefined,
        messageId: snapshot.messageId ?? undefined,
      },
    };
  } catch (err) {
    logger(
      `[browser] [recovery] snapshot capture failed: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  } finally {
    try {
      await reconnectedClient.close();
      logger(`[browser] [recovery] cleanup — reconnected client closed`);
    } catch {
      // best-effort cleanup
    }
  }
}
