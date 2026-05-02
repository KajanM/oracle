import type { ChromeClient, BrowserLogger, BrowserModelStrategy } from "../types.js";
import {
  MENU_CONTAINER_SELECTOR,
  MENU_ITEM_SELECTOR,
  MODEL_BUTTON_SELECTOR,
} from "../constants.js";
import { logDomFailure } from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";
import {
  logModelPickerCompactProbe,
  logModelPickerDomProbe,
  shouldLogModelPickerDomProbe,
} from "../modelPickerProbe.js";
import { getChatgptDomSession, ModelPickerSurface } from "../dom/index.js";

interface ModelDomContext {
  session: ReturnType<typeof getChatgptDomSession>;
  surface: ModelPickerSurface;
}

async function createModelDomContext(
  Runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  logger: BrowserLogger,
): Promise<ModelDomContext | null> {
  try {
    const session = getChatgptDomSession(Runtime, input, logger);
    const health = await session.bootstrap(["model.trigger", "model.menu"]);
    if (!health?.ok) {
      throw new Error("bootstrap returned unhealthy result");
    }
    return {
      session,
      surface: new ModelPickerSurface(session, Runtime, input, logger),
    };
  } catch (error) {
    logger(
      `[browser] [dom] model bootstrap failed, falling back to inline selectors: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/** If the model dropdown stays open it covers the composer; dismiss aggressively. */
export function buildForceDismissModelPickerExpression(): string {
  const sel = JSON.stringify(MODEL_BUTTON_SELECTOR);
  return `(() => {
    ${buildClickDispatcher("dispatchClickSequence")}
    const btn = document.querySelector(${sel});
    ${buildPickModelPickerMenuJs()}
    const menuOpen = () =>
      Boolean(btn?.getAttribute("aria-expanded") === "true" || pickModelPickerMenu());
    if (!btn) {
      return { dismissed: true, reason: "no-button" };
    }
    if (!menuOpen()) {
      return { dismissed: true };
    }
    const esc = (t) => {
      try {
        t?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            keyCode: 27,
            bubbles: true,
            cancelable: true,
          }),
        );
      } catch {}
    };
    for (let round = 0; round < 8 && menuOpen(); round++) {
      esc(pickModelPickerMenu());
      esc(document.activeElement);
      esc(document.body);
      if (menuOpen()) {
        try {
          btn.click();
        } catch {}
        try {
          dispatchClickSequence(btn);
        } catch {}
      }
    }
    return {
      dismissed: !menuOpen(),
      ariaExpanded: btn.getAttribute("aria-expanded"),
      rounds: 8,
    };
  })()`;
}

export async function forceDismissOpenModelPicker(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<void> {
  try {
    const { result } = await Runtime.evaluate({
      expression: buildForceDismissModelPickerExpression(),
      returnByValue: true,
    });
    const v = result?.value as { dismissed?: boolean; ariaExpanded?: string | null } | undefined;
    if (v && !v.dismissed && shouldLogModelPickerDomProbe(logger)) {
      logger(
        `[browser] [model] warn: model picker may still be open (aria-expanded=${v.ariaExpanded ?? "?"})`,
      );
    }
  } catch (e) {
    logger(
      `[browser] [model] warn: force-dismiss model picker failed: ${e instanceof Error ? e.message : e}`,
    );
  }
}

const CDP_ESCAPE_KEYS = {
  windowsVirtualKeyCode: 27,
  nativeVirtualKeyCode: 27,
  code: "Escape",
  key: "Escape",
} as const;

/**
 * Root cause: document.querySelector('[role="menu"]') is often the WRONG menu (sidebar / hidden
 * portal). Pick the visible menu under the model trigger that contains model-switcher-* nodes.
 */
export function buildPickModelPickerMenuJs(): string {
  return `
    const pickModelPickerMenu = () => {
      const trigger = document.querySelector('[data-testid="model-switcher-dropdown-button"]');
      const tr = trigger?.getBoundingClientRect();
      if (!tr) return null;
      const visible = [...document.querySelectorAll('[role="menu"]')].filter((m) => {
        const r = m.getBoundingClientRect();
        return r.width > 36 && r.height > 36;
      });
      if (visible.length === 0) return null;
      let best = visible[0];
      let bestScore = -1;
      for (const m of visible) {
        const r = m.getBoundingClientRect();
        let s = 0;
        if (m.querySelector('[data-testid^="model-switcher"]')) s += 1000000;
        if (m.querySelector('[data-testid*="model-switcher"][data-testid*="pro"]')) s += 200000;
        if (r.top >= tr.top - 50) s += 10000;
        if (Math.abs(r.left - tr.left) < 420) s += 5000;
        s += (r.width * r.height) / 400;
        if (s > bestScore) {
          bestScore = s;
          best = m;
        }
      }
      return best;
    };
  `;
}

/** In-page: click Pro row in the *model* menu only; returns whether menu is gone. */
export function buildClickProRowToCloseMenuExpression(): string {
  return `(() => {
    ${buildPickModelPickerMenuJs()}
    const isOpen = () =>
      document.querySelector('[data-testid="model-switcher-dropdown-button"]')?.getAttribute('aria-expanded') === 'true' ||
      !!pickModelPickerMenu();
    if (!isOpen()) return { closed: true };

    let menu = pickModelPickerMenu();
    if (!menu) {
      menu =
        [...document.querySelectorAll('[role="menu"]')].find((m) => {
          const r = m.getBoundingClientRect();
          return r.width > 28 && r.height > 28;
        }) ?? null;
    }
    if (!menu) return { closed: true, err: 'no-menu' };

    const tap = (el) => {
      try {
        if (el instanceof HTMLElement) el.click();
      } catch {}
    };

    const selectors = [
      '[data-testid="model-switcher-gpt-5-4-pro"]',
      '[data-testid="model-switcher-gpt-5-2-pro"]',
      '[data-testid*="model-switcher-gpt"][data-testid*="-pro"]',
      '[data-testid*="model-switcher"][data-testid*="pro"]',
    ];
    for (const sel of selectors) {
      const el = menu.querySelector(sel);
      if (el) {
        tap(el);
        if (!isOpen()) return { closed: true, via: sel };
      }
    }

    for (const el of menu.querySelectorAll('[role="menuitem"]')) {
      const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
      if (/^Pro(\\s|$)/i.test(text) || /Research-grade/i.test(text)) {
        tap(el);
        if (!isOpen()) return { closed: true, via: 'menuitem-pro' };
      }
    }

    return { closed: !isOpen(), err: 'pro-click-no-close' };
  })()`;
}

async function cdpClickAt(input: ChromeClient["Input"], x: number, y: number): Promise<void> {
  await input.dispatchMouseEvent({ type: "mouseMoved", x, y });
  await input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

/**
 * Proven stuck: menu open over composer. Try Pro row click, then trusted outside-click + Escape.
 */
export async function logModelMenuDiagnostics(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  phase: string,
): Promise<void> {
  try {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const t = document.querySelector('[data-testid="model-switcher-dropdown-button"]');
        ${buildPickModelPickerMenuJs().replace(/\n/g, " ")}
        const pm = pickModelPickerMenu();
        const pr = pm?.getBoundingClientRect();
        const all = [...document.querySelectorAll('[role="menu"]')].map((m) => {
          const r = m.getBoundingClientRect();
          return {
            area: Math.round(r.width * r.height),
            switcher: !!m.querySelector('[data-testid^="model-switcher"]'),
          };
        });
        return {
          phase: ${JSON.stringify(phase)},
          ariaExpanded: t?.getAttribute("aria-expanded") ?? null,
          roleMenuCount: all.length,
          pickedMenuArea: pr ? Math.round(pr.width * pr.height) : 0,
          pickedHasSwitcher: pm ? !!pm.querySelector('[data-testid^="model-switcher"]') : false,
          menus: all,
        };
      })()`,
      returnByValue: true,
    });
    logger(`[browser] [model] diagnostic ${JSON.stringify(result?.value)}`);
  } catch {
    /* ignore */
  }
}

export async function closeOpenModelMenuBestEffort(
  Runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  logger: BrowserLogger,
): Promise<void> {
  await logModelMenuDiagnostics(Runtime, logger, "before-close-menu");
  for (let wave = 0; wave < 4; wave++) {
    try {
      const { result } = await Runtime.evaluate({
        expression: buildClickProRowToCloseMenuExpression(),
        returnByValue: true,
      });
      if ((result?.value as { closed?: boolean })?.closed) {
        return;
      }
    } catch {
      /* ignore */
    }

    if (input && typeof input.dispatchMouseEvent === "function") {
      try {
        const { result: ptRes } = await Runtime.evaluate({
          expression: `(() => {
            ${buildPickModelPickerMenuJs().replace(/\n/g, " ")}
            const m = pickModelPickerMenu();
            const w = window.innerWidth;
            const h = window.innerHeight;
            if (!m) return [];
            const r = m.getBoundingClientRect();
            const right = Math.min(w - 16, Math.max(r.right + 40, w * 0.52));
            const midY = Math.min(h - 100, Math.max(80, r.top + r.height * 0.35));
            return [
              { x: Math.round(right), y: Math.round(midY) },
              { x: Math.round(w * 0.5), y: Math.round(h - 72) },
            ];
          })()`,
          returnByValue: true,
        });
        const pts = ptRes?.value as Array<{ x: number; y: number }> | undefined;
        if (Array.isArray(pts)) {
          for (const p of pts) {
            if (typeof p?.x === "number" && typeof p?.y === "number") {
              await cdpClickAt(input, p.x, p.y);
            }
          }
        }
      } catch (e) {
        logger(`[browser] [model] menu CDP click: ${e instanceof Error ? e.message : e}`);
      }

      try {
        await input.dispatchKeyEvent({ type: "keyDown", ...CDP_ESCAPE_KEYS });
        await input.dispatchKeyEvent({ type: "keyUp", ...CDP_ESCAPE_KEYS });
      } catch {
        /* ignore */
      }
    }

    await new Promise((r) => setTimeout(r, 90));
  }
  await logModelMenuDiagnostics(Runtime, logger, "after-close-menu");
}

async function openModelPickerTrusted(
  Runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  domContext?: ModelDomContext | null,
): Promise<boolean> {
  if (domContext) {
    try {
      return await domContext.surface.open();
    } catch {
      // Fall back to the legacy trusted open path.
    }
  }
  if (!input || typeof input.dispatchMouseEvent !== "function") {
    return false;
  }
  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const btn = document.querySelector('${MODEL_BUTTON_SELECTOR}');
      if (!(btn instanceof HTMLElement)) return { ok: false };
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      const hasMenu = Boolean(document.querySelector('[role="menu"] [data-testid^="model-switcher-"]'));
      if (expanded || hasMenu) {
        return { ok: false, skip: true };
      }
      const rect = btn.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return { ok: false };
      return {
        ok: true,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    })()`,
    returnByValue: true,
  });
  const point = result?.value as
    | { ok?: boolean; x?: number; y?: number; skip?: boolean }
    | undefined;
  if (!point?.ok || typeof point.x !== "number" || typeof point.y !== "number") {
    return Boolean(point?.skip);
  }
  await input.dispatchMouseEvent({ type: "mouseMoved", x: point.x, y: point.y });
  await input.dispatchMouseEvent({
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await input.dispatchMouseEvent({
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  const isMenuOpen = async () => {
    const probe = await Runtime.evaluate({
      expression: `(() => {
        const btn = document.querySelector('${MODEL_BUTTON_SELECTOR}');
        return Boolean(
          btn?.getAttribute('aria-expanded') === 'true' ||
            document.querySelector('[role="menu"] [data-testid^="model-switcher-"]'),
        );
      })()`,
      returnByValue: true,
    });
    return probe?.result?.value === true;
  };

  // Wait for CDP click to take effect
  const deadline = Date.now() + 750;
  while (Date.now() < deadline) {
    if (await isMenuOpen()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }

  // Fallback: Radix UI may require PointerEvents that CDP mouse events don't trigger.
  // Dispatch a full pointer event sequence directly on the button via DOM.
  await Runtime.evaluate({
    expression: `(() => {
      const btn = document.querySelector('${MODEL_BUTTON_SELECTOR}');
      if (!(btn instanceof HTMLElement)) return;
      const common = { bubbles: true, cancelable: true, view: window };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const event = type.startsWith('pointer') && 'PointerEvent' in window
          ? new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse' })
          : new MouseEvent(type, common);
        btn.dispatchEvent(event);
      }
    })()`,
  });
  const fallbackDeadline = Date.now() + 750;
  while (Date.now() < fallbackDeadline) {
    if (await isMenuOpen()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function buildModelStateProbeExpression(targetModel: string): string {
  const targetLiteral = JSON.stringify(targetModel);
  return `(() => {
    const resolveModelTrigger = () => {
      const oracle = window.__oracle;
      if (!oracle || typeof oracle.resolve !== 'function') {
        return document.querySelector('${MODEL_BUTTON_SELECTOR}');
      }
      const resolved = oracle.resolve('model.trigger', { refresh: true });
      if (resolved?.ok && resolved?.oracleId) {
        return document.querySelector('[data-oracle-id="' + resolved.oracleId + '"]');
      }
      return document.querySelector('${MODEL_BUTTON_SELECTOR}');
    };
    const normalizeText = (value) => {
      if (!value) return '';
      return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\\s+/g, ' ').trim();
    };
    const target = normalizeText(${targetLiteral});
    const trigger = resolveModelTrigger();
    const header = (trigger?.textContent ?? '').trim();
    const footer = (document.querySelector('.__composer-pill-composite') || document.querySelector('[data-testid=\"composer-footer-actions\"]'))?.textContent?.trim() ?? '';
    const normalizedHeader = normalizeText(header);
    const normalizedFooter = normalizeText(footer);
    const wantsPro = target === 'pro';
    const wantsLatestModel = target === 'use latest model';
    const alreadySelected = wantsLatestModel
      ? true
      : wantsPro
        ? normalizedFooter.includes('extended pro') || normalizedFooter === 'pro'
        : Boolean(target && normalizedHeader.includes(target));
    return { target, header, footer, alreadySelected };
  })()`;
}

function buildTrustedModelProbeExpression(targetModel: string): string {
  const matchers = buildModelMatchersLiteral(targetModel);
  const labelLiteral = JSON.stringify(matchers.labelTokens);
  const idLiteral = JSON.stringify(matchers.testIdTokens);
  const primaryLabelLiteral = JSON.stringify(targetModel);
  return `(() => {
    ${buildPickModelPickerMenuJs()}
    const LABEL_TOKENS = ${labelLiteral};
    const TEST_IDS = ${idLiteral};
    const PRIMARY_LABEL = ${primaryLabelLiteral};
    const normalizeText = (value) => {
      if (!value) return '';
      return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\\s+/g, ' ').trim();
    };
    const menu = pickModelPickerMenu();
    const button = document.querySelector('${MODEL_BUTTON_SELECTOR}');
    const buttonLabel = (button?.textContent ?? '').trim();
    const menuOpen = Boolean(menu);
    if (!menu) {
      return { menuOpen, buttonLabel, availableOptions: [] };
    }
    const normalizedTarget = normalizeText(PRIMARY_LABEL);
    const simpleTarget = ['pro', 'thinking', 'auto', 'instant', 'use latest model'].includes(
      normalizedTarget,
    )
      ? normalizedTarget
      : null;
    const normalizedTokens = Array.from(new Set([normalizedTarget, ...LABEL_TOKENS]))
      .map((token) => normalizeText(token))
      .filter(Boolean);
    const score = (node) => {
      const text = normalizeText(node?.textContent ?? '');
      const testid = (node?.getAttribute?.('data-testid') ?? '').toLowerCase();
      let total = 0;
      if (simpleTarget) {
        if (text === simpleTarget) total += 2000;
        else if (text.startsWith(simpleTarget + ' ')) total += 1800;
        else if (text.includes(simpleTarget)) total += 900;
        // "Use latest model" should match the Pro option in the picker
        else if (simpleTarget === 'use latest model' && (text.startsWith('pro') || text.includes('research grade'))) total += 1800;
      }
      const exactMatch = TEST_IDS.find((id) => id && testid === id);
      if (exactMatch) total += 1500;
      else {
        const hits = TEST_IDS.filter((id) => id && testid.includes(id));
        if (hits.length > 0) total += 500;
      }
      if (normalizedTarget && text.includes(normalizedTarget)) total += 500;
      for (const token of normalizedTokens) {
        if (token && text.includes(token)) total += Math.min(120, Math.max(10, token.length * 4));
      }
      if (text.includes('configure')) total -= 1000;
      return Math.max(total, 0);
    };
    let match = null;
    const options = Array.from(
      menu.querySelectorAll('button, [role="menuitem"], [role="menuitemradio"], [data-testid*="model-switcher-"]'),
    );
    const availableOptions = options
      .map((node) => (node?.textContent ?? '').trim())
      .filter(Boolean)
      .filter((label, index, arr) => arr.indexOf(label) === index)
      .slice(0, 12);
    for (const option of options) {
      const optionScore = score(option);
      if (optionScore <= 0 || !(option instanceof HTMLElement)) continue;
      const rect = option.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;
      const selected =
        option.getAttribute('aria-checked') === 'true' ||
        option.getAttribute('aria-selected') === 'true' ||
        option.getAttribute('aria-current') === 'true' ||
        option.getAttribute('data-selected') === 'true' ||
        Boolean(option.querySelector('[data-testid*="check"], [role="img"][data-icon="check"], svg[data-icon="check"]'));
      if (!match || optionScore > match.score) {
        match = {
          score: optionScore,
          label: (option.textContent ?? '').trim(),
          selected,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      }
    }
    if (!match && simpleTarget) {
      for (const node of menu.querySelectorAll('*')) {
        if (!(node instanceof HTMLElement)) continue;
        const text = normalizeText(node.textContent ?? '');
        if (!text) continue;
        const textLooksRight =
          text === simpleTarget ||
          text.startsWith(simpleTarget + ' ') ||
          text.includes(simpleTarget) ||
          ((simpleTarget === 'pro' || simpleTarget === 'use latest model') &&
            text.includes('research grade'));
        if (!textLooksRight) continue;
        const clickable =
          node.closest('[role="menuitem"], [role="menuitemradio"], button, [data-testid*="model-switcher"]') ??
          node;
        if (!(clickable instanceof HTMLElement)) continue;
        const rect = clickable.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) continue;
        const selected =
          clickable.getAttribute('aria-checked') === 'true' ||
          clickable.getAttribute('aria-selected') === 'true' ||
          clickable.getAttribute('aria-current') === 'true' ||
          clickable.getAttribute('data-selected') === 'true' ||
          Boolean(clickable.querySelector('[data-testid*="check"], [role="img"][data-icon="check"], svg[data-icon="check"]'));
        match = {
          score: 2500,
          label: (clickable.textContent ?? '').trim(),
          selected,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
        break;
      }
    }
    return { menuOpen, buttonLabel, availableOptions, match };
  })()`;
}

function buildButtonMatchProbeExpression(targetModel: string): string {
  const primaryLabelLiteral = JSON.stringify(targetModel);
  return `(() => {
    const normalizeText = (value) => {
      if (!value) return '';
      return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\\s+/g, ' ').trim();
    };
    const target = normalizeText(${primaryLabelLiteral});
    const label = (document.querySelector('${MODEL_BUTTON_SELECTOR}')?.textContent ?? '').trim();
    const normalized = normalizeText(label);
    const footer = (document.querySelector('.__composer-pill-composite') || document.querySelector('[data-testid="composer-footer-actions"]'))?.textContent?.trim() ?? '';
    const normalizedFooter = normalizeText(footer);
    const wantsPro = target === 'pro';
    const wantsLatestModel = target === 'use latest model';
    return {
      label,
      footer,
      matches: wantsPro || wantsLatestModel
        ? normalizedFooter.includes('extended pro') || normalizedFooter === 'pro' ||
          (wantsLatestModel && (normalized === 'chatgpt' || normalizedFooter.includes('pro')))
        : Boolean(target && normalized && normalized.includes(target)),
      menuOpen: Boolean(document.querySelector('[role="menu"] [data-testid^="model-switcher-"]')),
    };
  })()`;
}

async function selectModelViaTrustedClicks(
  Runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"],
  desiredModel: string,
  domContext?: ModelDomContext | null,
): Promise<
  | {
      status: "already-selected";
      label?: string | null;
      modelPickerInstrumentation?: { reopenTriggerClicks: number };
    }
  | {
      status: "switched";
      label?: string | null;
      modelPickerInstrumentation?: { reopenTriggerClicks: number };
    }
  | {
      status: "switched-best-effort";
      label?: string | null;
      modelPickerInstrumentation?: { reopenTriggerClicks: number };
    }
  | {
      status: "option-not-found";
      hint?: { temporaryChat?: boolean; availableOptions?: string[] };
      modelPickerInstrumentation?: { reopenTriggerClicks: number };
    }
  | { status: "menu-not-open"; modelPickerInstrumentation?: { reopenTriggerClicks: number } }
> {
  const opened = await openModelPickerTrusted(Runtime, input, domContext);
  if (!opened) {
    return { status: "menu-not-open", modelPickerInstrumentation: { reopenTriggerClicks: 0 } };
  }

  if (domContext) {
    try {
      return await domContext.session.withRepair("modelPicker", async () => {
        const options = await domContext.surface.listOptions();
        const availableOptions = options
          .map((option) => option.text)
          .filter(Boolean)
          .filter((label, index, arr) => arr.indexOf(label) === index)
          .slice(0, 12);
        const matchers = buildModelMatchersLiteral(desiredModel);
        const normalizeText = (value: string) =>
          value
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        const normalizedTarget = normalizeText(desiredModel);
        const simpleTarget = ["pro", "thinking", "auto", "instant", "use latest model"].includes(
          normalizedTarget,
        )
          ? normalizedTarget
          : null;
        const normalizedTokens = Array.from(new Set([normalizedTarget, ...matchers.labelTokens]))
          .map((token) => normalizeText(token))
          .filter(Boolean);
        const scoreOption = (option: { text: string; oracleId: string; selected: boolean }) => {
          const text = normalizeText(option.text);
          const testid = option.oracleId.toLowerCase();
          let total = 0;
          if (simpleTarget) {
            if (text === simpleTarget) total += 2000;
            else if (text.startsWith(simpleTarget + " ")) total += 1800;
            else if (text.includes(simpleTarget)) total += 900;
            else if (
              simpleTarget === "use latest model" &&
              (text.startsWith("pro") || text.includes("research grade"))
            ) {
              total += 1800;
            }
          }
          const exactMatch = matchers.testIdTokens.find((id) => id && testid === id);
          if (exactMatch) total += 1500;
          else {
            const hits = matchers.testIdTokens.filter((id) => id && testid.includes(id));
            if (hits.length > 0) total += 500;
          }
          if (normalizedTarget && text.includes(normalizedTarget)) total += 500;
          for (const token of normalizedTokens) {
            if (token && text.includes(token)) {
              total += Math.min(120, Math.max(10, token.length * 4));
            }
          }
          if (text.includes("configure")) total -= 1000;
          return Math.max(total, 0);
        };
        const match = options
          .map((option) => ({ option, score: scoreOption(option) }))
          .filter((entry) => entry.score > 0)
          .sort((left, right) => right.score - left.score)[0];
        if (!match) {
          return {
            status: "option-not-found" as const,
            hint: { availableOptions },
            modelPickerInstrumentation: { reopenTriggerClicks: 0 },
          };
        }
        if (match.option.selected) {
          return {
            status: "already-selected" as const,
            label: match.option.text,
            modelPickerInstrumentation: { reopenTriggerClicks: 0 },
          };
        }
        const clicked = await domContext.surface.clickOption(match.option.text);
        if (!clicked) {
          return {
            status: "option-not-found" as const,
            hint: { availableOptions },
            modelPickerInstrumentation: { reopenTriggerClicks: 0 },
          };
        }
        return {
          status: "switched" as const,
          label: match.option.text,
          modelPickerInstrumentation: { reopenTriggerClicks: 0 },
        };
      });
    } catch {
      // Fall through to the legacy trusted click strategy.
    }
  }

  let lastAvailable: string[] = [];
  const deadline = Date.now() + 900;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: buildTrustedModelProbeExpression(desiredModel),
      returnByValue: true,
    });
    const probe = result?.value as
      | {
          menuOpen?: boolean;
          buttonLabel?: string;
          availableOptions?: string[];
          match?: { label?: string; selected?: boolean; x?: number; y?: number };
        }
      | undefined;
    lastAvailable = probe?.availableOptions ?? lastAvailable;
    const match = probe?.match;
    if (match && typeof match.x === "number" && typeof match.y === "number") {
      await cdpClickAt(input, match.x, match.y);
      if (match.selected) {
        return {
          status: "already-selected",
          label: match.label,
          modelPickerInstrumentation: { reopenTriggerClicks: 0 },
        };
      }
      const labelDeadline = Date.now() + 1200;
      while (Date.now() < labelDeadline) {
        const { result: buttonResult } = await Runtime.evaluate({
          expression: buildButtonMatchProbeExpression(desiredModel),
          returnByValue: true,
        });
        const buttonProbe = buttonResult?.value as
          | { label?: string; matches?: boolean; menuOpen?: boolean }
          | undefined;
        if (buttonProbe?.matches) {
          return {
            status: "switched",
            label: buttonProbe.label,
            modelPickerInstrumentation: { reopenTriggerClicks: 0 },
          };
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return {
        status: "switched-best-effort",
        label: match.label,
        modelPickerInstrumentation: { reopenTriggerClicks: 0 },
      };
    }
    if (probe && probe.menuOpen === false) {
      return {
        status: "menu-not-open",
        modelPickerInstrumentation: { reopenTriggerClicks: 0 },
      };
    }
    await new Promise((r) => setTimeout(r, 45));
  }

  return {
    status: "option-not-found",
    hint: { availableOptions: lastAvailable },
    modelPickerInstrumentation: { reopenTriggerClicks: 0 },
  };
}

export async function ensureModelSelection(
  Runtime: ChromeClient["Runtime"],
  desiredModel: string,
  logger: BrowserLogger,
  strategy: BrowserModelStrategy = "select",
  input?: ChromeClient["Input"],
) {
  logger(`[browser] [model] opening model picker`);
  await logModelPickerDomProbe(Runtime, logger, "before-model-select");
  const domContext = await createModelDomContext(Runtime, input, logger);
  const { result: stateResult } = await Runtime.evaluate({
    expression: buildModelStateProbeExpression(desiredModel),
    returnByValue: true,
  });
  const stateProbe = stateResult?.value as
    | { header?: string; footer?: string; alreadySelected?: boolean }
    | undefined;
  if (stateProbe?.alreadySelected) {
    const label = stateProbe.footer || stateProbe.header || desiredModel;
    logger(`[browser] [model] selected: ${label}`);
    logger(`[browser] [model] selection complete`);
    return;
  }
  const canTrustedOpen = Boolean(input && typeof input.dispatchMouseEvent === "function");
  const trustedResult =
    canTrustedOpen && strategy === "select" && input
      ? await selectModelViaTrustedClicks(Runtime, input, desiredModel, domContext)
      : null;
  const result = trustedResult
    ? trustedResult
    : ((
        await Runtime.evaluate({
          expression: buildModelSelectionExpression(desiredModel, strategy, false),
          awaitPromise: true,
          returnByValue: true,
        })
      ).result?.value as
        | {
            status: "already-selected";
            label?: string | null;
            modelPickerInstrumentation?: { reopenTriggerClicks: number };
          }
        | {
            status: "switched";
            label?: string | null;
            modelPickerInstrumentation?: { reopenTriggerClicks: number };
          }
        | {
            status: "switched-best-effort";
            label?: string | null;
            modelPickerInstrumentation?: { reopenTriggerClicks: number };
          }
        | {
            status: "option-not-found";
            hint?: { temporaryChat?: boolean; availableOptions?: string[] };
            modelPickerInstrumentation?: { reopenTriggerClicks: number };
          }
        | { status: "menu-not-open"; modelPickerInstrumentation?: { reopenTriggerClicks: number } }
        | { status: "button-missing"; modelPickerInstrumentation?: { reopenTriggerClicks: number } }
        | undefined);

  const reopen = result?.modelPickerInstrumentation?.reopenTriggerClicks ?? 0;
  if (reopen > 0) {
    logger(
      `[browser] [model] warning: model trigger re-clicked ${reopen} time(s) while selecting (site may not expose open menu state; menu can flicker). Use ORACLE_BROWSER_MODEL_DEBUG=1 or --verbose for dom-probe.`,
    );
  }

  switch (result?.status) {
    case "already-selected":
    case "switched":
    case "switched-best-effort": {
      const label = result.label ?? desiredModel;
      logger(`[browser] [model] selected: ${label}`);
      logger(`[browser] [model] selection complete`);
      await forceDismissOpenModelPicker(Runtime, logger);
      await logModelPickerDomProbe(Runtime, logger, "after-model-select");
      return;
    }
    case "option-not-found": {
      logger(`[browser] [model] selection complete (option-not-found)`);
      await forceDismissOpenModelPicker(Runtime, logger);
      await logModelPickerCompactProbe(Runtime, logger);
      await logModelPickerDomProbe(Runtime, logger, "model-select-failed");
      await logDomFailure(Runtime, logger, "model-switcher-option");
      const isTemporary = result.hint?.temporaryChat ?? false;
      const available = (result.hint?.availableOptions ?? []).filter(Boolean);
      const availableHint = available.length > 0 ? ` Available: ${available.join(", ")}.` : "";
      const tempHint =
        isTemporary && /\bpro\b/i.test(desiredModel)
          ? ' You are in Temporary Chat mode; Pro models are not available there. Remove "temporary-chat=true" from --chatgpt-url or use a non-Pro model (e.g. gpt-5.2).'
          : "";
      throw new Error(
        `Unable to find model option matching "${desiredModel}" in the model switcher.${availableHint}${tempHint}`,
      );
    }
    case "menu-not-open": {
      logger(`[browser] [model] selection complete (menu-not-open)`);
      await logModelPickerCompactProbe(Runtime, logger);
      await logModelPickerDomProbe(Runtime, logger, "model-select-failed");
      throw new Error("ChatGPT model picker closed before options could be read.");
    }
    default: {
      logger(`[browser] [model] selection complete (button-missing)`);
      await forceDismissOpenModelPicker(Runtime, logger);
      await logModelPickerCompactProbe(Runtime, logger);
      await logModelPickerDomProbe(Runtime, logger, "model-select-failed");
      await logDomFailure(Runtime, logger, "model-switcher-button");
      throw new Error("Unable to locate the ChatGPT model selector button.");
    }
  }
}

/**
 * Builds the DOM expression that runs inside the ChatGPT tab to select a model.
 * The string is evaluated inside Chrome, so keep it self-contained and well-commented.
 */
function buildModelSelectionExpression(
  targetModel: string,
  strategy: BrowserModelStrategy,
  trustedOpenStarted = false,
): string {
  const matchers = buildModelMatchersLiteral(targetModel);
  const labelLiteral = JSON.stringify(matchers.labelTokens);
  const idLiteral = JSON.stringify(matchers.testIdTokens);
  const primaryLabelLiteral = JSON.stringify(targetModel);
  const strategyLiteral = JSON.stringify(strategy);
  const trustedOpenLiteral = JSON.stringify(trustedOpenStarted);
  const menuContainerLiteral = JSON.stringify(MENU_CONTAINER_SELECTOR);
  const menuItemLiteral = JSON.stringify(MENU_ITEM_SELECTOR);
  return `(() => {
    ${buildClickDispatcher()}
    // Radix model rows are DIV[role=menuitem]; synthetic events alone often leave the menu open.
    // Native .click() on the model-switcher-* node reliably closes it (verified via browser CDP).
    const clickPickerRow = (node) => {
      if (!(node instanceof HTMLElement)) return;
      let t = node;
      const tid = node.getAttribute('data-testid') || '';
      if (!tid.startsWith('model-switcher-')) {
        const inner = node.querySelector('[data-testid^="model-switcher-"]');
        if (inner instanceof HTMLElement) t = inner;
      }
      try {
        dispatchClickSequence(t);
      } catch {}
      try {
        t.click();
      } catch {}
    };
    // Capture the selectors and matcher literals up front so the browser expression stays pure.
    const BUTTON_SELECTOR = '${MODEL_BUTTON_SELECTOR}';
    const LABEL_TOKENS = ${labelLiteral};
    const TEST_IDS = ${idLiteral};
    const PRIMARY_LABEL = ${primaryLabelLiteral};
    const MODEL_STRATEGY = ${strategyLiteral};
    const TRUSTED_OPEN_STARTED = ${trustedOpenLiteral};
    // Current ChatGPT behavior: the picker can auto-dismiss quickly. Scan almost immediately after a
    // trusted open instead of waiting a full second and missing the real menu.
    const MENU_SETTLE_MS = 220;
    const INITIAL_WAIT_MS = 35;
    const RETRY_WHEN_NO_MATCH_MS = 45;
    const MAX_WAIT_MS = 20000;
    const normalizeText = (value) => {
      if (!value) {
        return '';
      }
      return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\\s+/g, ' ')
        .trim();
    };
    // Normalize every candidate token to keep fuzzy matching deterministic.
    const normalizedTarget = normalizeText(PRIMARY_LABEL);
    const normalizedTokens = Array.from(new Set([normalizedTarget, ...LABEL_TOKENS]))
      .map((token) => normalizeText(token))
      .filter(Boolean);
    const targetWords = normalizedTarget.split(' ').filter(Boolean);
    const desiredVersion = normalizedTarget.includes('5 5')
      ? '5-5'
      : normalizedTarget.includes('5 4')
        ? '5-4'
        : normalizedTarget.includes('5 2')
          ? '5-2'
          : normalizedTarget.includes('5 1')
            ? '5-1'
            : normalizedTarget.includes('5 0')
              ? '5-0'
              : null;
    const wantsPro = normalizedTarget.includes(' pro') || normalizedTarget.endsWith(' pro') || normalizedTokens.includes('pro');
    const wantsInstant = normalizedTarget.includes('instant');
    const wantsThinking = normalizedTarget.includes('thinking');

    const button = document.querySelector(BUTTON_SELECTOR);
    if (!button) {
      return { status: 'button-missing' };
    }
    ${buildPickModelPickerMenuJs()}

    const getButtonLabel = () => (button.textContent ?? '').trim();
    if (MODEL_STRATEGY === 'current') {
      return { status: 'already-selected', label: getButtonLabel() };
    }
    const buttonMatchesTarget = () => {
      const normalizedLabel = normalizeText(getButtonLabel());
      if (!normalizedLabel) return false;
      if (desiredVersion) {
        if (desiredVersion === '5-5' && !normalizedLabel.includes('5 5')) return false;
        if (desiredVersion === '5-4' && !normalizedLabel.includes('5 4')) return false;
        if (desiredVersion === '5-2' && !normalizedLabel.includes('5 2')) return false;
        if (desiredVersion === '5-1' && !normalizedLabel.includes('5 1')) return false;
        if (desiredVersion === '5-0' && !normalizedLabel.includes('5 0')) return false;
      }
      if (wantsPro && !normalizedLabel.includes(' pro')) return false;
      if (wantsInstant && !normalizedLabel.includes('instant')) return false;
      if (wantsThinking && !normalizedLabel.includes('thinking')) return false;
      // Also reject if button has variants we DON'T want
      if (!wantsPro && normalizedLabel.includes(' pro')) return false;
      if (!wantsInstant && normalizedLabel.includes('instant')) return false;
      if (!wantsThinking && normalizedLabel.includes('thinking')) return false;
      return true;
    };

    if (buttonMatchesTarget()) {
      return { status: 'already-selected', label: getButtonLabel() };
    }

    const getOptionLabel = (node) => node?.textContent?.trim() ?? '';
    const optionIsSelected = (node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      const ariaChecked = node.getAttribute('aria-checked');
      const ariaSelected = node.getAttribute('aria-selected');
      const ariaCurrent = node.getAttribute('aria-current');
      const dataSelected = node.getAttribute('data-selected');
      const dataState = (node.getAttribute('data-state') ?? '').toLowerCase();
      const selectedStates = ['checked', 'selected', 'on', 'true'];
      if (ariaChecked === 'true' || ariaSelected === 'true' || ariaCurrent === 'true') {
        return true;
      }
      if (dataSelected === 'true' || selectedStates.includes(dataState)) {
        return true;
      }
      if (node.querySelector('[data-testid*="check"], [role="img"][data-icon="check"], svg[data-icon="check"]')) {
        return true;
      }
      return false;
    };

    const scoreOption = (normalizedText, testid) => {
      // Assign a score to every node so we can pick the most likely match without brittle equality checks.
      if (!normalizedText && !testid) {
        return 0;
      }
      let score = 0;
      const normalizedTestId = (testid ?? '').toLowerCase();
      if (normalizedTestId) {
        if (desiredVersion) {
          // data-testid strings have been observed with both dotted and dashed versions (e.g. gpt-5.2-pro vs gpt-5-2-pro).
          const has55 =
            normalizedTestId.includes('5-5') ||
            normalizedTestId.includes('5.5') ||
            normalizedTestId.includes('gpt-5-5') ||
            normalizedTestId.includes('gpt-5.5') ||
            normalizedTestId.includes('gpt55');
          const has52 =
            normalizedTestId.includes('5-2') ||
            normalizedTestId.includes('5.2') ||
            normalizedTestId.includes('gpt-5-2') ||
            normalizedTestId.includes('gpt-5.2') ||
            normalizedTestId.includes('gpt52');
          const has54 =
            normalizedTestId.includes('5-4') ||
            normalizedTestId.includes('5.4') ||
            normalizedTestId.includes('gpt-5-4') ||
            normalizedTestId.includes('gpt-5.4') ||
            normalizedTestId.includes('gpt54');
          const has51 =
            normalizedTestId.includes('5-1') ||
            normalizedTestId.includes('5.1') ||
            normalizedTestId.includes('gpt-5-1') ||
            normalizedTestId.includes('gpt-5.1') ||
            normalizedTestId.includes('gpt51');
          const has50 =
            normalizedTestId.includes('5-0') ||
            normalizedTestId.includes('5.0') ||
            normalizedTestId.includes('gpt-5-0') ||
            normalizedTestId.includes('gpt-5.0') ||
            normalizedTestId.includes('gpt50');
          const candidateVersion = has55 ? '5-5' : has54 ? '5-4' : has52 ? '5-2' : has51 ? '5-1' : has50 ? '5-0' : null;
          // If a candidate advertises a different version, ignore it entirely.
          if (candidateVersion && candidateVersion !== desiredVersion) {
            return 0;
          }
          // When targeting an explicit version, avoid selecting submenu wrappers that can contain legacy models.
          if (normalizedTestId.includes('submenu') && candidateVersion === null) {
            return 0;
          }
        }
        // Exact testid matches take priority over substring matches
        const exactMatch = TEST_IDS.find((id) => id && normalizedTestId === id);
        if (exactMatch) {
          score += 1500;
          if (exactMatch.startsWith('model-switcher-')) score += 200;
        } else {
          const matches = TEST_IDS.filter((id) => id && normalizedTestId.includes(id));
          if (matches.length > 0) {
            // Prefer the most specific match (longest token) instead of treating any hit as equal.
            // This prevents generic tokens (e.g. "pro") from outweighing version-specific targets.
            const best = matches.reduce((acc, token) => (token.length > acc.length ? token : acc), '');
            score += 200 + Math.min(900, best.length * 25);
            if (best.startsWith('model-switcher-')) score += 120;
            if (best.includes('gpt-')) score += 60;
          }
        }
      }
      if (normalizedText && normalizedTarget) {
        if (normalizedText === normalizedTarget) {
          score += 500;
        } else if (normalizedText.startsWith(normalizedTarget)) {
          score += 420;
        } else if (normalizedText.includes(normalizedTarget)) {
          score += 380;
        }
      }
      for (const token of normalizedTokens) {
        // Reward partial matches to the expanded label/token set.
        if (token && normalizedText.includes(token)) {
          const tokenWeight = Math.min(120, Math.max(10, token.length * 4));
          score += tokenWeight;
        }
      }
      if (targetWords.length > 1) {
        let missing = 0;
        for (const word of targetWords) {
          if (!normalizedText.includes(word)) {
            missing += 1;
          }
        }
        score -= missing * 12;
      }
      // If the caller didn't explicitly ask for Pro, prefer non-Pro options when both exist.
      if (wantsPro) {
        if (!normalizedText.includes(' pro')) {
          score -= 80;
        }
      } else if (normalizedText.includes(' pro')) {
        score -= 40;
      }
      // Similarly for Thinking variant
      if (wantsThinking) {
        if (!normalizedText.includes('thinking') && !normalizedTestId.includes('thinking')) {
          score -= 80;
        }
      } else if (normalizedText.includes('thinking') || normalizedTestId.includes('thinking')) {
        score -= 40;
      }
      // Similarly for Instant variant
      if (wantsInstant) {
        if (!normalizedText.includes('instant') && !normalizedTestId.includes('instant')) {
          score -= 80;
        }
      } else if (normalizedText.includes('instant') || normalizedTestId.includes('instant')) {
        score -= 40;
      }
      return Math.max(score, 0);
    };

    const getModelPickerRoots = () => {
      const preferred = pickModelPickerMenu();
      let menus = Array.from(document.querySelectorAll(${menuContainerLiteral}));
      if (preferred) {
        menus = [preferred, ...menus.filter((m) => m !== preferred)];
      }
      const controlsId = button.getAttribute('aria-controls');
      if (controlsId) {
        try {
          const panel = document.getElementById(controlsId);
          if (panel instanceof HTMLElement && !menus.includes(panel)) {
            menus.unshift(panel);
          }
        } catch {}
      }
      return menus.filter((menu) => {
        const mr = menu.getBoundingClientRect();
        if (mr.width < 20 || mr.height < 20) return false;
        return Boolean(menu.querySelector('[data-testid^="model-switcher-"]'));
      });
    };

    const findBestOption = () => {
      let bestMatch = null;
      const menus = getModelPickerRoots();
      for (const menu of menus) {
        const buttons = Array.from(menu.querySelectorAll(${menuItemLiteral}));
        for (const option of buttons) {
          const text = option.textContent ?? '';
          const normalizedText = normalizeText(text);
          const testid =
            option.getAttribute('data-testid') ??
            option.querySelector('[data-testid^="model-switcher-"]')?.getAttribute('data-testid') ??
            '';
          const score = scoreOption(normalizedText, testid);
          if (score <= 0) {
            continue;
          }
          const label = getOptionLabel(option);
          if (!bestMatch || score > bestMatch.score) {
            bestMatch = { node: option, label, score, testid, normalizedText };
          }
        }
      }
      return bestMatch;
    };

    return new Promise((resolve) => {
      const start = performance.now();
      let reopenTriggerClicks = 0;
      const detectTemporaryChat = () => {
        try {
          const url = new URL(window.location.href);
          const flag = (url.searchParams.get('temporary-chat') ?? '').toLowerCase();
          if (flag === 'true' || flag === '1' || flag === 'yes') return true;
        } catch {}
        const title = (document.title || '').toLowerCase();
        if (title.includes('temporary chat')) return true;
        const body = (document.body?.innerText || '').toLowerCase();
        return body.includes('temporary chat');
      };
      const collectAvailableOptions = () => {
        const menuRoots = getModelPickerRoots();
        const nodes = menuRoots.flatMap((root) => Array.from(root.querySelectorAll(${menuItemLiteral})));
        const labels = nodes
          .map((node) => (node?.textContent ?? '').trim())
          .filter(Boolean)
          .filter((label, index, arr) => arr.indexOf(label) === index);
        return labels.slice(0, 12);
      };
      const hasModelPickerMenu = () => getModelPickerRoots().length > 0;

      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const kickoff = async () => {
        const waitForModelPickerMenu = async () => {
          const deadline = performance.now() + MENU_SETTLE_MS;
          while (performance.now() < deadline) {
            if (hasModelPickerMenu()) {
              return true;
            }
            await sleep(RETRY_WHEN_NO_MATCH_MS);
          }
          return hasModelPickerMenu();
        };
        if (!(await waitForModelPickerMenu())) {
          resolve({
            status: 'menu-not-open',
            modelPickerInstrumentation: { reopenTriggerClicks },
          });
          return;
        }
        await sleep(INITIAL_WAIT_MS);

        const attempt = async () => {
        const directTestId = TEST_IDS.find((id) => id && id.startsWith('model-switcher-'));
        if (directTestId) {
          const direct = document.querySelector('[data-testid="' + directTestId.replace(/"/g, '\\"') + '"]');
          if (direct instanceof Element) {
            const directTarget =
              direct instanceof HTMLElement
                ? direct
                : direct.closest('[role="menuitem"], [role="menuitemradio"], button, [data-testid*="model-switcher"]');
            if (!(directTarget instanceof HTMLElement)) {
              return;
            }
            clickPickerRow(directTarget);
            setTimeout(() => {
              resolve({
                status: 'switched-best-effort',
                label: directTarget.textContent?.trim() || PRIMARY_LABEL,
                modelPickerInstrumentation: { reopenTriggerClicks },
              });
            }, 150);
            return;
          }
        }
        const match = findBestOption();
        if (match) {
          if (optionIsSelected(match.node)) {
            // Click the active row (e.g. Pro) to dismiss; never click the header here — it reopens
            // the dropdown right after the menu already closed from the row click.
            clickPickerRow(match.node);
            setTimeout(() => {
              resolve({
                status: 'already-selected',
                label: getButtonLabel() || match.label,
                modelPickerInstrumentation: { reopenTriggerClicks },
              });
            }, 150);
            return;
          }
          clickPickerRow(match.node);
          // Submenus (e.g. "Legacy models") need a second pass to pick the actual model option.
          // Keep scanning once the submenu opens instead of treating the submenu click as a final switch.
          const isSubmenu = (match.testid ?? '').toLowerCase().includes('submenu');
          if (isSubmenu) {
            setTimeout(attempt, RETRY_WHEN_NO_MATCH_MS);
            return;
          }
          const clickedModelSwitcher = (match.testid ?? '').toLowerCase().startsWith('model-switcher-');
          // Wait for the top bar label to reflect the requested model; otherwise keep scanning.
          setTimeout(() => {
            if (buttonMatchesTarget()) {
              // Menu already closed by the option click; do not click the header (that reopens it).
              resolve({
                status: 'switched',
                label: getButtonLabel() || match.label,
                modelPickerInstrumentation: { reopenTriggerClicks },
              });
              return;
            }
            if (clickedModelSwitcher) {
              resolve({
                status: 'switched-best-effort',
                label: match.label,
                modelPickerInstrumentation: { reopenTriggerClicks },
              });
              return;
            }
            attempt();
          }, Math.max(100, INITIAL_WAIT_MS));
          return;
        }
        if (TRUSTED_OPEN_STARTED && !hasModelPickerMenu()) {
          resolve({
            status: 'menu-not-open',
            modelPickerInstrumentation: { reopenTriggerClicks },
          });
          return;
        }
        if (performance.now() - start > MAX_WAIT_MS) {
          resolve({
            status: 'option-not-found',
            hint: { temporaryChat: detectTemporaryChat(), availableOptions: collectAvailableOptions() },
            modelPickerInstrumentation: { reopenTriggerClicks },
          });
          return;
        }
        setTimeout(attempt, RETRY_WHEN_NO_MATCH_MS);
      };
        await attempt();
      };
      kickoff();
    });
  })()`;
}

export function buildModelMatchersLiteralForTest(targetModel: string) {
  return buildModelMatchersLiteral(targetModel);
}

function buildModelMatchersLiteral(targetModel: string): {
  labelTokens: string[];
  testIdTokens: string[];
} {
  const base = targetModel.trim().toLowerCase();
  const labelTokens = new Set<string>();
  const testIdTokens = new Set<string>();

  const push = (value: string | null | undefined, set: Set<string>) => {
    const normalized = value?.trim();
    if (normalized) {
      set.add(normalized);
    }
  };

  push(base, labelTokens);
  push(base.replace(/\s+/g, " "), labelTokens);
  const collapsed = base.replace(/\s+/g, "");
  push(collapsed, labelTokens);
  const dotless = base.replace(/[.]/g, "");
  push(dotless, labelTokens);
  push(`chatgpt ${base}`, labelTokens);
  push(`chatgpt ${dotless}`, labelTokens);
  push(`gpt ${base}`, labelTokens);
  push(`gpt ${dotless}`, labelTokens);
  // Numeric variations (5.3 ↔ 53 ↔ gpt-5-3)
  if (base.includes("5.3") || base.includes("5-3") || base.includes("53")) {
    push("5.3", labelTokens);
    push("gpt-5.3", labelTokens);
    push("gpt5.3", labelTokens);
    push("gpt-5-3", labelTokens);
    push("gpt5-3", labelTokens);
    push("gpt53", labelTokens);
    push("chatgpt 5.3", labelTokens);
    push("instant", labelTokens);
    testIdTokens.add("model-switcher-gpt-5-3");
    testIdTokens.add("gpt-5-3");
    testIdTokens.add("gpt5-3");
    testIdTokens.add("gpt53");
  }
  // Numeric variations (5.4 ↔ 54 ↔ gpt-5-4)
  if (base.includes("5.4") || base.includes("5-4") || base.includes("54")) {
    push("5.4", labelTokens);
    push("gpt-5.4", labelTokens);
    push("gpt5.4", labelTokens);
    push("gpt-5-4", labelTokens);
    push("gpt5-4", labelTokens);
    push("gpt54", labelTokens);
    push("chatgpt 5.4", labelTokens);
    // Thinking variant: explicit testid for "Thinking" picker option
    if (base.includes("thinking")) {
      push("thinking", labelTokens);
      testIdTokens.add("model-switcher-gpt-5-4-thinking");
      testIdTokens.add("gpt-5-4-thinking");
      testIdTokens.add("gpt-5.4-thinking");
    }
    if (!base.includes("pro") && !base.includes("thinking")) {
      testIdTokens.add("model-switcher-gpt-5-4");
    }
    testIdTokens.add("gpt-5-4");
    testIdTokens.add("gpt5-4");
    testIdTokens.add("gpt54");
  }
  // Numeric variations (5.5 ↔ 55 ↔ gpt-5-5)
  if (base.includes("5.5") || base.includes("5-5") || base.includes("55")) {
    push("5.5", labelTokens);
    push("gpt-5.5", labelTokens);
    push("gpt5.5", labelTokens);
    push("gpt-5-5", labelTokens);
    push("gpt5-5", labelTokens);
    push("gpt55", labelTokens);
    push("chatgpt 5.5", labelTokens);
    if (base.includes("thinking")) {
      push("thinking", labelTokens);
      testIdTokens.add("model-switcher-gpt-5-5-thinking");
      testIdTokens.add("gpt-5-5-thinking");
      testIdTokens.add("gpt-5.5-thinking");
    }
    if (!base.includes("pro") && !base.includes("thinking")) {
      testIdTokens.add("model-switcher-gpt-5-5");
    }
    testIdTokens.add("gpt-5-5");
    testIdTokens.add("gpt5-5");
    testIdTokens.add("gpt55");
  }
  // Numeric variations (5.1 ↔ 51 ↔ gpt-5-1)
  if (base.includes("5.1") || base.includes("5-1") || base.includes("51")) {
    push("5.1", labelTokens);
    push("gpt-5.1", labelTokens);
    push("gpt5.1", labelTokens);
    push("gpt-5-1", labelTokens);
    push("gpt5-1", labelTokens);
    push("gpt51", labelTokens);
    push("chatgpt 5.1", labelTokens);
    testIdTokens.add("gpt-5-1");
    testIdTokens.add("gpt5-1");
    testIdTokens.add("gpt51");
  }
  // Numeric variations (5.0 ↔ 50 ↔ gpt-5-0)
  if (base.includes("5.0") || base.includes("5-0") || base.includes("50")) {
    push("5.0", labelTokens);
    push("gpt-5.0", labelTokens);
    push("gpt5.0", labelTokens);
    push("gpt-5-0", labelTokens);
    push("gpt5-0", labelTokens);
    push("gpt50", labelTokens);
    push("chatgpt 5.0", labelTokens);
    testIdTokens.add("gpt-5-0");
    testIdTokens.add("gpt5-0");
    testIdTokens.add("gpt50");
  }
  // Numeric variations (5.2 ↔ 52 ↔ gpt-5-2)
  if (base.includes("5.2") || base.includes("5-2") || base.includes("52")) {
    push("5.2", labelTokens);
    push("gpt-5.2", labelTokens);
    push("gpt5.2", labelTokens);
    push("gpt-5-2", labelTokens);
    push("gpt5-2", labelTokens);
    push("gpt52", labelTokens);
    push("chatgpt 5.2", labelTokens);
    // Thinking variant: explicit testid for "Thinking" picker option
    if (base.includes("thinking")) {
      push("thinking", labelTokens);
      testIdTokens.add("model-switcher-gpt-5-2-thinking");
      testIdTokens.add("gpt-5-2-thinking");
      testIdTokens.add("gpt-5.2-thinking");
    }
    // Instant variant: explicit testid for "Instant" picker option
    if (base.includes("instant")) {
      push("instant", labelTokens);
      testIdTokens.add("model-switcher-gpt-5-2-instant");
      testIdTokens.add("gpt-5-2-instant");
      testIdTokens.add("gpt-5.2-instant");
    }
    // Base 5.2 testids (for "Auto" mode when no suffix specified)
    if (!base.includes("thinking") && !base.includes("instant") && !base.includes("pro")) {
      testIdTokens.add("model-switcher-gpt-5-2");
    }
    testIdTokens.add("gpt-5-2");
    testIdTokens.add("gpt5-2");
    testIdTokens.add("gpt52");
  }
  // Pro / research variants
  if (base.includes("pro")) {
    push("proresearch", labelTokens);
    push("research grade", labelTokens);
    push("advanced reasoning", labelTokens);
    if (base.includes("5.4") || base.includes("5-4") || base.includes("54")) {
      testIdTokens.add("gpt-5.4-pro");
      testIdTokens.add("gpt-5-4-pro");
      testIdTokens.add("gpt54pro");
    }
    if (base.includes("5.1") || base.includes("5-1") || base.includes("51")) {
      testIdTokens.add("gpt-5.1-pro");
      testIdTokens.add("gpt-5-1-pro");
      testIdTokens.add("gpt51pro");
    }
    if (base.includes("5.0") || base.includes("5-0") || base.includes("50")) {
      testIdTokens.add("gpt-5.0-pro");
      testIdTokens.add("gpt-5-0-pro");
      testIdTokens.add("gpt50pro");
    }
    if (base.includes("5.2") || base.includes("5-2") || base.includes("52")) {
      testIdTokens.add("gpt-5.2-pro");
      testIdTokens.add("gpt-5-2-pro");
      testIdTokens.add("gpt52pro");
    }
    testIdTokens.add("pro");
    testIdTokens.add("proresearch");
  }
  base
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .forEach((token) => {
      push(token, labelTokens);
    });

  const hyphenated = base.replace(/\s+/g, "-");
  push(hyphenated, testIdTokens);
  push(collapsed, testIdTokens);
  push(dotless, testIdTokens);
  // data-testid values observed in the ChatGPT picker (e.g., model-switcher-gpt-5.1-pro)
  push(`model-switcher-${hyphenated}`, testIdTokens);
  push(`model-switcher-${collapsed}`, testIdTokens);
  push(`model-switcher-${dotless}`, testIdTokens);

  if (!labelTokens.size) {
    labelTokens.add(base);
  }
  if (!testIdTokens.size) {
    testIdTokens.add(base.replace(/\s+/g, "-"));
  }

  return {
    labelTokens: Array.from(labelTokens).filter(Boolean),
    testIdTokens: Array.from(testIdTokens).filter(Boolean),
  };
}

export function buildModelSelectionExpressionForTest(targetModel: string): string {
  return buildModelSelectionExpression(targetModel, "select");
}
