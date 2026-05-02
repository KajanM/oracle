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
    await runtime.evaluate({
      expression: `(() => {
        const el = document.querySelector('#composer-plus-btn, button[data-testid="composer-plus-btn"], button[aria-label="Add files and more"]');
        if (el instanceof HTMLElement) el.click();
      })()`,
    });
  }

  await delay(250);
  const clicked = await clickCreateImageMenuItem(runtime);
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
    const candidates = Array.from(document.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [data-radix-collection-item]'));
    const item = candidates.find((node) => {
      if (!(node instanceof HTMLElement)) return false;
      return normalize(node.innerText || node.textContent).includes('create image');
    });
    if (!item) return { ok: false, checked: false, reason: 'create-image-menu-item-not-found' };
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
