import type { ChromeClient, BrowserLogger } from "../types.js";
import { delay } from "../utils.js";

type LocatePoint = { ok?: boolean; x?: number; y?: number; checked?: boolean; reason?: string };

export function buildCreateImageModeExpressionForTest(): string {
  return buildCreateImageModeExpression();
}

export async function ensureCreateImageMode(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  logger: BrowserLogger,
): Promise<void> {
  const initial = await readCreateImageState(runtime);
  if (initial.checked) {
    logger("[browser] [image] Create image mode already enabled");
    return;
  }

  const plus = await locateComposerPlusButton(runtime);
  if (!plus.ok || typeof plus.x !== "number" || typeof plus.y !== "number") {
    throw new Error(`Unable to find ChatGPT composer plus button (${plus.reason ?? "missing"})`);
  }

  let clicked: LocatePoint = {
    ok: false,
    checked: false,
    reason: "create-image-menu-item-not-found",
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (input && typeof input.dispatchMouseEvent === "function") {
      await input.dispatchMouseEvent({ type: "mouseMoved", x: plus.x, y: plus.y });
      await input.dispatchMouseEvent({
        type: "mousePressed",
        x: plus.x,
        y: plus.y,
        button: "left",
        clickCount: 1,
      });
      await input.dispatchMouseEvent({
        type: "mouseReleased",
        x: plus.x,
        y: plus.y,
        button: "left",
        clickCount: 1,
      });
    } else {
      await clickComposerPlusButton(runtime);
    }

    clicked = await waitForCreateImageMenuItem(runtime, 1200);
    if (clicked.ok || clicked.checked) break;

    // Radix menus can ignore the first trusted click when focus has just moved back from the
    // model picker. Follow with an in-page pointer sequence before retrying.
    await clickComposerPlusButton(runtime);
    clicked = await waitForCreateImageMenuItem(runtime, 1200);
    if (clicked.ok || clicked.checked) break;
  }

  if (!clicked.ok && !clicked.checked) {
    throw new Error(`Unable to enable ChatGPT Create image mode (${clicked.reason ?? "missing"})`);
  }
  await delay(250);
  const finalState = await readCreateImageState(runtime);
  if (!finalState.checked && !clicked.checked) {
    logger("[browser] [image] Create image mode click completed; menu closed before state check");
  } else {
    logger("[browser] [image] Create image mode enabled");
  }
}

async function locateComposerPlusButton(runtime: ChromeClient["Runtime"]): Promise<LocatePoint> {
  const { result } = await runtime.evaluate({
    expression: `(() => {
      const selectors = [
        '#composer-plus-btn',
        'button[data-testid="composer-plus-btn"]',
        'button[aria-label="Add files and more"]',
        'button[aria-label*="Add files"]'
      ];
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (!(el instanceof HTMLElement)) continue;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        return {
          ok: true,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      }
      return { ok: false, reason: 'plus-button-not-found' };
    })()`,
    returnByValue: true,
  });
  return (result.value ?? {}) as LocatePoint;
}

async function readCreateImageState(runtime: ChromeClient["Runtime"]): Promise<LocatePoint> {
  const { result } = await runtime.evaluate({
    expression: buildCreateImageModeExpression("state"),
    returnByValue: true,
  });
  return (result.value ?? {}) as LocatePoint;
}

async function clickComposerPlusButton(runtime: ChromeClient["Runtime"]): Promise<void> {
  await runtime.evaluate({
    expression: `(() => {
      const el = document.querySelector('#composer-plus-btn, button[data-testid="composer-plus-btn"], button[aria-label="Add files and more"], button[aria-label*="Add files"]');
      if (!(el instanceof HTMLElement)) return false;
      const common = { bubbles: true, cancelable: true, view: window };
      try {
        el.dispatchEvent(new PointerEvent('pointerdown', { ...common, pointerId: 1, pointerType: 'mouse' }));
      } catch {}
      el.dispatchEvent(new MouseEvent('mousedown', common));
      try {
        el.click();
      } catch {}
      el.dispatchEvent(new MouseEvent('mouseup', common));
      try {
        el.dispatchEvent(new PointerEvent('pointerup', { ...common, pointerId: 1, pointerType: 'mouse' }));
      } catch {}
      return true;
    })()`,
    returnByValue: true,
  });
}

async function waitForCreateImageMenuItem(
  runtime: ChromeClient["Runtime"],
  timeoutMs: number,
): Promise<LocatePoint> {
  const deadline = Date.now() + timeoutMs;
  let last: LocatePoint = { ok: false, checked: false, reason: "create-image-menu-item-not-found" };
  while (Date.now() < deadline) {
    last = await clickCreateImageMenuItem(runtime);
    if (last.ok || last.checked) return last;
    await delay(100);
  }
  return last;
}

async function clickCreateImageMenuItem(runtime: ChromeClient["Runtime"]): Promise<LocatePoint> {
  const { result } = await runtime.evaluate({
    expression: buildCreateImageModeExpression("click"),
    returnByValue: true,
  });
  return (result.value ?? {}) as LocatePoint;
}

function buildCreateImageModeExpression(mode: "state" | "click" = "click"): string {
  return `(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    };
    const candidates = Array.from(document.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [data-radix-collection-item], button'));
    const available = candidates
      .filter((node) => node instanceof HTMLElement && isVisible(node))
      .map((node) => normalize(node.innerText || node.textContent))
      .filter(Boolean)
      .slice(0, 12);
    const item = candidates.find((node) => {
      if (!(node instanceof HTMLElement)) return false;
      if (!isVisible(node)) return false;
      const text = normalize(node.innerText || node.textContent);
      return text.includes('create image') || (text.includes('image') && text.includes('create'));
    });
    if (!item) {
      return {
        ok: false,
        checked: false,
        reason: available.length > 0
          ? 'create-image-menu-item-not-found; available=' + available.join(' | ')
          : 'create-image-menu-item-not-found',
      };
    }
    const checked =
      item.getAttribute('aria-checked') === 'true' ||
      item.getAttribute('data-state') === 'checked';
    if (checked || ${JSON.stringify(mode)} === 'state') {
      return { ok: true, checked };
    }
    item.scrollIntoView({ block: 'center', inline: 'center' });
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse' }));
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    item.click();
    item.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'mouse' }));
    return { ok: true, checked: true };
  })()`;
}
