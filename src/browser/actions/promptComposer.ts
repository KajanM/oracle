import type { ChromeClient, BrowserLogger } from "../types.js";
import {
  INPUT_SELECTORS,
  PROMPT_PRIMARY_SELECTOR,
  PROMPT_FALLBACK_SELECTOR,
  SEND_BUTTON_SELECTORS,
  CONVERSATION_TURN_SELECTOR,
  STOP_BUTTON_SELECTOR,
  ASSISTANT_ROLE_SELECTOR,
} from "../constants.js";
import { delay } from "../utils.js";
import { logDomFailure } from "../domDebug.js";
import {
  AttachmentSurface,
  ComposerSurface,
  getChatgptDomSession,
} from "../dom/index.js";
import { buildClickDispatcher } from "./domEvents.js";
import { BrowserAutomationError } from "../../oracle/errors.js";

const ENTER_KEY_EVENT = {
  key: "Enter",
  code: "Enter",
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13,
} as const;
const ENTER_KEY_TEXT = "\r";

interface PromptDomContext {
  session: ReturnType<typeof getChatgptDomSession>;
  composer: ComposerSurface;
  attachments: AttachmentSurface;
}

export async function submitPrompt(
  deps: {
    runtime: ChromeClient["Runtime"];
    input: ChromeClient["Input"];
    attachmentNames?: string[];
    baselineTurns?: number | null;
    inputTimeoutMs?: number | null;
  },
  prompt: string,
  logger: BrowserLogger,
): Promise<number | null> {
  const { runtime, input } = deps;

  await waitForDomReady(runtime, logger, deps.inputTimeoutMs ?? undefined);
  const domContext = await createPromptDomContext(runtime, input, logger);
  const encodedPrompt = JSON.stringify(prompt);
  const focusResult = await focusComposerInput(runtime, domContext);
  if (!focusResult) {
    await logDomFailure(runtime, logger, "focus-textarea");
    throw new Error("Failed to focus prompt textarea");
  }

  await input.insertText({ text: prompt });

  // Some pages (notably ChatGPT when subscriptions/widgets load) need a brief settle
  // before the send button becomes enabled; give it a short breather to avoid races.
  await delay(500);

  const composerInputOracleId = await resolvePromptOracleId(domContext, "composer.input");
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const verification = await runtime.evaluate({
    expression: buildComposerValueProbeExpression(composerInputOracleId),
    returnByValue: true,
  });

  const editorTextRaw = verification.result?.value?.editorText ?? "";
  const fallbackValueRaw = verification.result?.value?.fallbackValue ?? "";
  const activeValueRaw = verification.result?.value?.activeValue ?? "";
  const editorTextTrimmed = editorTextRaw?.trim?.() ?? "";
  const fallbackValueTrimmed = fallbackValueRaw?.trim?.() ?? "";
  const activeValueTrimmed = activeValueRaw?.trim?.() ?? "";
  if (!editorTextTrimmed && !fallbackValueTrimmed && !activeValueTrimmed) {
    // Learned: occasionally Input.insertText doesn't land in the editor; force textContent/value + input events.
    await runtime.evaluate({
      expression: buildComposerTextWriteExpression(encodedPrompt, composerInputOracleId),
    });
  }

  const promptLength = prompt.length;
  const postVerification = await runtime.evaluate({
    expression: buildComposerValueProbeExpression(composerInputOracleId),
    returnByValue: true,
  });
  const observedEditor = postVerification.result?.value?.editorText ?? "";
  const observedFallback = postVerification.result?.value?.fallbackValue ?? "";
  const observedActive = postVerification.result?.value?.activeValue ?? "";
  const observedLength = Math.max(
    observedEditor.length,
    observedFallback.length,
    observedActive.length,
  );
  if (promptLength >= 50_000 && observedLength > 0 && observedLength < promptLength - 2_000) {
    // Learned: very large prompts can truncate silently; fail fast so we can fall back to file uploads.
    await logDomFailure(runtime, logger, "prompt-too-large");
    throw new BrowserAutomationError(
      "Prompt appears truncated in the composer (likely too large).",
      {
        stage: "submit-prompt",
        code: "prompt-too-large",
        promptLength,
        observedLength,
      },
    );
  }

  const hasExpectedAttachments = Array.isArray(deps?.attachmentNames) && deps.attachmentNames.length > 0;
  const clicked = await attemptSendButton(runtime, logger, deps?.attachmentNames, domContext);
  logger(`[browser] [submit] promptLength=${promptLength}, method=${clicked ? "button" : "enter"}`);
  if (!clicked) {
    // Before falling back to Enter key, verify attachments are present if expected.
    // Learned: with ChatGPT UI lag, attachments may not be ready when attemptSendButton times out;
    // submitting via Enter without the attachment wastes the oracle turn.
    if (hasExpectedAttachments) {
      const attachmentsReady = await areAttachmentsReady(runtime, domContext, deps.attachmentNames!);
      if (!attachmentsReady) {
        logger(`[browser] [submit] attachments not ready, aborting submit to avoid sending without attachment`);
        throw new BrowserAutomationError(
          "Attachments not present in composer before submit — aborting to avoid sending prompt without attachment.",
          {
            stage: "submit-prompt",
            code: "attachments-not-ready",
            expectedAttachments: deps.attachmentNames,
          },
        );
      }
      logger(`[browser] [submit] attachments verified present before Enter key fallback`);
    }
    await input.dispatchKeyEvent({
      type: "keyDown",
      ...ENTER_KEY_EVENT,
      text: ENTER_KEY_TEXT,
      unmodifiedText: ENTER_KEY_TEXT,
    });
    await input.dispatchKeyEvent({
      type: "keyUp",
      ...ENTER_KEY_EVENT,
    });
    logger("Submitted prompt via Enter key");
  } else {
    logger("Clicked send button");
  }

  const commitTimeoutMs = Math.max(60_000, deps.inputTimeoutMs ?? 0);
  // Learned: the send button can succeed but the turn doesn't appear immediately; verify commit via turns/stop button.
  const verifyResult = await verifyPromptCommitted(
    runtime,
    prompt,
    commitTimeoutMs,
    logger,
    deps.baselineTurns ?? undefined,
  );
  logger(`[browser] [submit] verifyPromptCommitted succeeded`);
  return verifyResult;
}

async function createPromptDomContext(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"],
  logger: BrowserLogger,
): Promise<PromptDomContext | null> {
  try {
    const session = getChatgptDomSession(runtime, input, logger);
    const health = await session.bootstrap([
      "composer.root",
      "composer.input",
      "composer.sendButton",
      "attachments.fileInput",
      "attachments.removeButton",
    ]);
    if (!health || typeof health !== "object" || health.ok !== true) {
      throw new Error("bootstrap returned unhealthy result");
    }
    return {
      session,
      composer: new ComposerSurface(session, runtime, input, logger),
      attachments: new AttachmentSurface(session, runtime, input, logger),
    };
  } catch (error) {
    logger(
      `[browser] [dom] prompt bootstrap failed, falling back to inline selectors: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

async function focusComposerInput(
  runtime: ChromeClient["Runtime"],
  domContext: PromptDomContext | null,
): Promise<boolean> {
  if (domContext) {
    try {
      const resolved = await domContext.composer.focusInput();
      if (resolved?.oracleId) {
        return true;
      }
    } catch {
      // Fall back to the legacy selector path below.
    }
  }
  const focusResult = await runtime.evaluate({
    expression: `(() => {
      ${buildClickDispatcher()}
      const SELECTORS = ${JSON.stringify(INPUT_SELECTORS)};
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const focusNode = (node) => {
        if (!node) {
          return false;
        }
        // Learned: React/ProseMirror require a real click + focus + selection for inserts to stick.
        dispatchClickSequence(node);
        if (typeof node.focus === 'function') {
          node.focus();
        }
        const doc = node.ownerDocument;
        const selection = doc?.getSelection?.();
        if (selection) {
          const range = doc.createRange();
          range.selectNodeContents(node);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return true;
      };

      const candidates = [];
      for (const selector of SELECTORS) {
        const node = document.querySelector(selector);
        if (node) {
          candidates.push(node);
        }
      }
      const preferred = candidates.find((node) => isVisible(node)) || candidates[0];
      if (preferred && focusNode(preferred)) {
        return { focused: true };
      }
      return { focused: false };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  return Boolean(focusResult.result?.value?.focused);
}

async function resolvePromptOracleId(
  domContext: PromptDomContext | null,
  key: "composer.input" | "composer.sendButton",
): Promise<string | undefined> {
  if (!domContext) {
    return undefined;
  }
  try {
    const resolved = await domContext.session.resolve(key);
    return resolved.ok ? resolved.oracleId : undefined;
  } catch {
    return undefined;
  }
}

function buildComposerValueProbeExpression(composerInputOracleId?: string): string {
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  return `(() => {
    const oracleId = ${JSON.stringify(composerInputOracleId ?? null)};
    const editor = document.querySelector(${primarySelectorLiteral});
    const fallback = document.querySelector(${fallbackSelectorLiteral});
    const oracleNode = oracleId
      ? document.querySelector('[data-oracle-id="' + oracleId + '"]')
      : null;
    const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
    const readValue = (node) => {
      if (!node) return '';
      if (node instanceof HTMLTextAreaElement) return node.value ?? '';
      return node.innerText ?? '';
    };
    const isVisible = (node) => {
      if (!node || typeof node.getBoundingClientRect !== 'function') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const candidates = inputSelectors
      .map((selector) => document.querySelector(selector))
      .filter((node) => Boolean(node));
    const active =
      (oracleNode && isVisible(oracleNode) ? oracleNode : null) ||
      candidates.find((node) => isVisible(node)) ||
      oracleNode ||
      candidates[0] ||
      null;
    return {
      editorText: editor?.innerText ?? '',
      fallbackValue: fallback?.value ?? '',
      activeValue: active ? readValue(active) : '',
    };
  })()`;
}

function buildComposerTextWriteExpression(
  encodedPrompt: string,
  composerInputOracleId?: string,
): string {
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  return `(() => {
    const oracleId = ${JSON.stringify(composerInputOracleId ?? null)};
    const fallback = document.querySelector(${fallbackSelectorLiteral});
    const editor = document.querySelector(${primarySelectorLiteral});
    const oracleNode = oracleId
      ? document.querySelector('[data-oracle-id="' + oracleId + '"]')
      : null;
    const updateNode = (node) => {
      if (!node) return false;
      if (node instanceof HTMLTextAreaElement) {
        node.value = ${encodedPrompt};
        node.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      if (node instanceof HTMLElement) {
        node.textContent = ${encodedPrompt};
        node.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));
        return true;
      }
      return false;
    };
    updateNode(fallback);
    if (!updateNode(oracleNode)) {
      updateNode(editor);
    }
  })()`;
}

async function areAttachmentsReady(
  runtime: ChromeClient["Runtime"],
  domContext: PromptDomContext | null,
  attachmentNames: string[],
): Promise<boolean> {
  if (domContext) {
    try {
      const checks = await Promise.all(
        attachmentNames.map(async (name) => {
          const signals = await domContext.attachments.readSignals(name);
          const lower = name.toLowerCase();
          return (
            signals.ready &&
            (signals.removeButtons >= attachmentNames.length ||
              signals.matchingNames.some((value) => value.toLowerCase().includes(lower)) ||
              signals.names.some((value) => value.toLowerCase().includes(lower)))
          );
        }),
      );
      if (checks.every(Boolean)) {
        return true;
      }
    } catch {
      // Fall back to the legacy selector probe below.
    }
  }
  const attachmentsReady = await runtime.evaluate({
    expression: buildAttachmentReadyExpression(attachmentNames),
    returnByValue: true,
  });
  return attachmentsReady?.result?.value === true;
}

export async function clearPromptComposer(Runtime: ChromeClient["Runtime"], logger: BrowserLogger) {
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const result = await Runtime.evaluate({
    expression: `(() => {
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const editor = document.querySelector(${primarySelectorLiteral});
      const inputSelectors = ${inputSelectorsLiteral};
      let cleared = false;
      if (fallback) {
        fallback.value = '';
        fallback.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
        fallback.dispatchEvent(new Event('change', { bubbles: true }));
        cleared = true;
      }
      if (editor) {
        editor.textContent = '';
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
        cleared = true;
      }
      const nodes = inputSelectors
        .map((selector) => document.querySelector(selector))
        .filter((node) => Boolean(node));
      for (const node of nodes) {
        if (!node) continue;
        if (node instanceof HTMLTextAreaElement) {
          node.value = '';
          node.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
          cleared = true;
          continue;
        }
        if (node.isContentEditable || node.getAttribute('contenteditable') === 'true') {
          node.textContent = '';
          node.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
          cleared = true;
        }
      }
      return { cleared };
    })()`,
    returnByValue: true,
  });
  if (!result.result?.value?.cleared) {
    await logDomFailure(Runtime, logger, "clear-composer");
    throw new Error("Failed to clear prompt composer");
  }
  await delay(250);
}

async function waitForDomReady(
  Runtime: ChromeClient["Runtime"],
  logger?: BrowserLogger,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const ready = document.readyState === 'complete';
        const composer = document.querySelector('[data-testid*="composer"]') || document.querySelector('form');
        const fileInput = document.querySelector('input[type="file"]');
        return { ready, composer: Boolean(composer), fileInput: Boolean(fileInput) };
      })()`,
      returnByValue: true,
    });
    const value = result?.value as
      | { ready?: boolean; composer?: boolean; fileInput?: boolean }
      | undefined;
    if (value?.ready && value.composer) {
      return;
    }
    await delay(150);
  }
  logger?.(`Page did not reach ready/composer state within ${timeoutMs}ms; continuing cautiously.`);
}

function buildAttachmentReadyExpression(attachmentNames: string[]): string {
  const namesLiteral = JSON.stringify(attachmentNames.map((name) => name.toLowerCase()));
  return `(() => {
    const oracle = window.__oracle;
    const names = ${namesLiteral};
    const composerResolved =
      oracle && typeof oracle.resolve === 'function'
        ? oracle.resolve('composer.root', {})
        : null;
    const composer =
      (composerResolved?.ok && composerResolved?.oracleId
        ? document.querySelector('[data-oracle-id="' + composerResolved.oracleId + '"]')
        : null) ||
      document.querySelector('form') ||
      document.querySelector('div[data-testid*="composer"]') ||
      document.body ||
      document;
    // Check textContent, aria-label, and title for the filename.
    // ChatGPT now puts filenames in aria-label (e.g. "Remove file 1: filename.txt").
    const match = (node, name) => {
      const text = (node?.textContent || '').toLowerCase();
      const aria = (node?.getAttribute?.('aria-label') || '').toLowerCase();
      const title = (node?.getAttribute?.('title') || '').toLowerCase();
      return text.includes(name) || aria.includes(name) || title.includes(name);
    };

    const collectSurfaceSignals = (name) => {
      if (!oracle || typeof oracle.resolve !== 'function') return null;
      const remove = oracle.resolve('attachments.removeButton', { refresh: true });
      const input = oracle.resolve('attachments.fileInput', { refresh: true });
      const removeNode =
        remove?.ok && remove?.oracleId
          ? document.querySelector('[data-oracle-id="' + remove.oracleId + '"]')
          : null;
      const inputNode =
        input?.ok && input?.oracleId
          ? document.querySelector('[data-oracle-id="' + input.oracleId + '"]')
          : null;
      const names = [];
      if (removeNode) {
        const text = removeNode.textContent || '';
        const aria = removeNode.getAttribute?.('aria-label') || '';
        const title = removeNode.getAttribute?.('title') || '';
        if ([text, aria, title].some((value) => match({ textContent: value, getAttribute: () => value }, name))) {
          names.push(text || aria || title);
        }
      }
      let inputReady = false;
      if (inputNode instanceof HTMLInputElement) {
        inputReady = Array.from(inputNode.files || []).some((file) =>
          file?.name?.toLowerCase?.().includes(name),
        );
      }
      return {
        removeCount: removeNode ? 1 : 0,
        inputReady,
        names,
      };
    };

    const attachmentSelectors = [
      '[aria-label*="Remove file"]',
      'button[aria-label*="Remove file"]',
      '[data-testid*="chip"]',
      '[data-testid*="attachment"]',
      '[data-testid*="upload"]',
    ];

    const chipNodes = Array.from(composer.querySelectorAll(attachmentSelectors.join(',')));
    const chipsReady = names.every((name) =>
      chipNodes.some((node) => match(node, name)),
    );
    const inputsReady = names.every((name) =>
      Array.from(composer.querySelectorAll('input[type="file"]')).some((el) =>
        Array.from((el instanceof HTMLInputElement ? el.files : []) || []).some((file) =>
          file?.name?.toLowerCase?.().includes(name),
        ),
      ),
    );

    // Fallback: if we can't match filenames but "Remove file" buttons exist in the composer,
    // the attachments are present.
    const removeFileButtons = composer.querySelectorAll('[aria-label*="Remove file"]');
    const removeCountReady = removeFileButtons.length >= names.length;
    const surfaceReady = names.every((name) => {
      const surfaceSignals = collectSurfaceSignals(name);
      if (!surfaceSignals) return false;
      return (
        surfaceSignals.inputReady ||
        surfaceSignals.names.length > 0 ||
        surfaceSignals.removeCount >= names.length
      );
    });

    return surfaceReady || chipsReady || inputsReady || removeCountReady;
  })()`;
}

export function buildAttachmentReadyExpressionForTest(attachmentNames: string[]) {
  return buildAttachmentReadyExpression(attachmentNames);
}

async function attemptSendButton(
  Runtime: ChromeClient["Runtime"],
  logger?: BrowserLogger,
  attachmentNames?: string[],
  domContext?: PromptDomContext | null,
): Promise<boolean> {
  const sendOracleId = await resolvePromptOracleId(domContext ?? null, "composer.sendButton");
  const script = `(() => {
    ${buildClickDispatcher()}
    const oracleId = ${JSON.stringify(sendOracleId ?? null)};
    const selectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
    let button =
      oracleId ? document.querySelector('[data-oracle-id="' + oracleId + '"]') : null;
    if (!button) {
      for (const selector of selectors) {
        button = document.querySelector(selector);
        if (button) break;
      }
    }
    if (!button) return 'missing';
    const ariaDisabled = button.getAttribute('aria-disabled');
    const dataDisabled = button.getAttribute('data-disabled');
    const style = window.getComputedStyle(button);
    const disabled =
      button.hasAttribute('disabled') ||
      ariaDisabled === 'true' ||
      dataDisabled === 'true' ||
      style.pointerEvents === 'none' ||
      style.display === 'none';
    // Learned: some send buttons render but are inert; only click when truly enabled.
    if (disabled) return 'disabled';
    // Use unified pointer/mouse sequence to satisfy React handlers.
    dispatchClickSequence(button);
    return 'clicked';
  })()`;

  const needAttachment = Array.isArray(attachmentNames) && attachmentNames.length > 0;
  // Learned: ChatGPT UI lag can delay attachment rendering well beyond 8s; use a longer budget when attachments are expected.
  const deadline = Date.now() + (needAttachment ? 30_000 : 8_000);
  let lastAttachmentLog = 0;
  while (Date.now() < deadline) {
    if (needAttachment) {
      const ready = await areAttachmentsReady(Runtime, domContext ?? null, attachmentNames);
      if (!ready) {
        const now = Date.now();
        if (now - lastAttachmentLog > 5_000) {
          lastAttachmentLog = now;
          logger?.(`[browser] [submit] waiting for attachments to appear in composer...`);
        }
        await delay(250);
        continue;
      }
    }
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    if (result.value === "clicked") {
      return true;
    }
    if (result.value === "missing") {
      break;
    }
    await delay(100);
  }
  return false;
}

async function verifyPromptCommitted(
  Runtime: ChromeClient["Runtime"],
  prompt: string,
  timeoutMs: number,
  logger?: BrowserLogger,
  baselineTurns?: number,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  const encodedPrompt = JSON.stringify(prompt.trim());
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const stopSelectorLiteral = JSON.stringify(STOP_BUTTON_SELECTOR);
  const assistantSelectorLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  const turnSelectorLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  let baseline: number | null =
    typeof baselineTurns === "number" && Number.isFinite(baselineTurns) && baselineTurns >= 0
      ? Math.floor(baselineTurns)
      : null;
  if (baseline === null) {
    try {
      const { result } = await Runtime.evaluate({
        expression: `document.querySelectorAll(${turnSelectorLiteral}).length`,
        returnByValue: true,
      });
      const raw = typeof result?.value === "number" ? result.value : Number(result?.value);
      if (Number.isFinite(raw)) {
        baseline = Math.max(0, Math.floor(raw));
      }
    } catch (err) {
      logger?.(`[browser] [warn] verifyPromptCommitted baseline discovery: ${err instanceof Error ? err.message : err}`);
    }
  }
  const baselineLiteral = baseline ?? -1;
  // Learned: ChatGPT can echo/format text; normalize markdown and use prefix matches to detect the sent prompt.
  const script = `(() => {
		    const editor = document.querySelector(${primarySelectorLiteral});
		    const fallback = document.querySelector(${fallbackSelectorLiteral});
		    const inputSelectors = ${inputSelectorsLiteral};
	    const normalize = (value) => {
	      let text = value?.toLowerCase?.() ?? '';
	      // Strip markdown *markers* but keep content (ChatGPT renders fence markers differently).
	      text = text.replace(/\`\`\`[^\\n]*\\n([\\s\\S]*?)\`\`\`/g, ' $1 ');
	      text = text.replace(/\`\`\`/g, ' ');
	      text = text.replace(/\`([^\`]*)\`/g, '$1');
	      return text.replace(/\\s+/g, ' ').trim();
	    };
	    const normalizedPrompt = normalize(${encodedPrompt});
	    const normalizedPromptPrefix = normalizedPrompt.slice(0, 120);
	    const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
	    const articles = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
	    const normalizedTurns = articles.map((node) => normalize(node?.innerText));
	    const readValue = (node) => {
	      if (!node) return '';
	      if (node instanceof HTMLTextAreaElement) return node.value ?? '';
	      return node.innerText ?? '';
	    };
	    const isVisible = (node) => {
	      if (!node || typeof node.getBoundingClientRect !== 'function') return false;
	      const rect = node.getBoundingClientRect();
	      return rect.width > 0 && rect.height > 0;
	    };
	    const inputs = inputSelectors
	      .map((selector) => document.querySelector(selector))
	      .filter((node) => Boolean(node));
	    const visibleInputs = inputs.filter((node) => isVisible(node));
	    const activeInputs = visibleInputs.length > 0 ? visibleInputs : inputs;
	    const userMatched =
	      normalizedPrompt.length > 0 && normalizedTurns.some((text) => text.includes(normalizedPrompt));
	    const prefixMatched =
	      normalizedPromptPrefix.length > 30 &&
	      normalizedTurns.some((text) => text.includes(normalizedPromptPrefix));
		    const lastTurn = normalizedTurns[normalizedTurns.length - 1] ?? '';
		    const lastMatched =
		      normalizedPrompt.length > 0 &&
		      (lastTurn.includes(normalizedPrompt) ||
		        (normalizedPromptPrefix.length > 30 && lastTurn.includes(normalizedPromptPrefix)));
		    const baseline = ${baselineLiteral};
		    const hasNewTurn = baseline < 0 ? false : normalizedTurns.length > baseline;
		    const stopVisible = Boolean(document.querySelector(${stopSelectorLiteral}));
		    const assistantVisible = Boolean(
		      document.querySelector(${assistantSelectorLiteral}) ||
		      document.querySelector('[data-testid*="assistant"]'),
		    );
	    // Learned: composer clearing + stop button or assistant presence is a reliable fallback signal.
      const editorValue = editor?.innerText ?? '';
      const fallbackValue = fallback?.value ?? '';
      const activeEmpty =
        activeInputs.length === 0 ? null : activeInputs.every((node) => !String(readValue(node)).trim());
      const composerCleared = activeEmpty ?? !(String(editorValue).trim() || String(fallbackValue).trim());
      const href = typeof location === 'object' && location.href ? location.href : '';
      const inConversation = /\\/c\\//.test(href);
		    return {
        baseline,
	      userMatched,
	      prefixMatched,
	      lastMatched,
	      hasNewTurn,
	      stopVisible,
      assistantVisible,
      composerCleared,
      inConversation,
      href,
      fallbackValue,
      editorValue,
      lastTurn,
      turnsCount: normalizedTurns.length,
    };
  })()`;

  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    const info = result.value as {
      baseline?: number;
      userMatched?: boolean;
      prefixMatched?: boolean;
      lastMatched?: boolean;
      hasNewTurn?: boolean;
      stopVisible?: boolean;
      assistantVisible?: boolean;
      composerCleared?: boolean;
      inConversation?: boolean;
      turnsCount?: number;
    };
    const turnsCount = (result.value as { turnsCount?: number } | undefined)?.turnsCount;
    const matchesPrompt = Boolean(info?.lastMatched || info?.userMatched || info?.prefixMatched);
    const baselineUnknown =
      typeof info?.baseline === "number" ? info.baseline < 0 : baselineLiteral < 0;
    if (matchesPrompt && (baselineUnknown || info?.hasNewTurn)) {
      return typeof turnsCount === "number" && Number.isFinite(turnsCount) ? turnsCount : null;
    }
    const fallbackCommit =
      info?.composerCleared &&
      Boolean(info?.hasNewTurn) &&
      ((info?.stopVisible ?? false) || info?.assistantVisible || info?.inConversation);
    if (fallbackCommit) {
      return typeof turnsCount === "number" && Number.isFinite(turnsCount) ? turnsCount : null;
    }
    await delay(100);
  }
  logger?.(`[browser] [submit] verifyPromptCommitted failed`);
  if (logger) {
    logger(
      `Prompt commit check failed; latest state: ${await Runtime.evaluate({
        expression: script,
        returnByValue: true,
      })
        .then((res) => JSON.stringify(res?.result?.value))
        .catch(() => "unavailable")}`,
    );
    await logDomFailure(Runtime, logger, "prompt-commit");
  }
  if (prompt.trim().length >= 50_000) {
    throw new BrowserAutomationError(
      "Prompt did not appear in conversation before timeout (likely too large).",
      {
        stage: "submit-prompt",
        code: "prompt-too-large",
        promptLength: prompt.trim().length,
        timeoutMs,
      },
    );
  }
  throw new Error("Prompt did not appear in conversation before timeout (send may have failed)");
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  verifyPromptCommitted,
};
