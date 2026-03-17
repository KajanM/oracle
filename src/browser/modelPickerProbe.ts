import type { ChromeClient, BrowserLogger } from "./types.js";
import { MENU_CONTAINER_SELECTOR, MODEL_BUTTON_SELECTOR } from "./constants.js";

/** Log full model-picker DOM state (run in the ChatGPT tab). */
export function buildModelPickerProbeExpression(): string {
  const btnSel = JSON.stringify(MODEL_BUTTON_SELECTOR);
  const surfaces = [
    '[role="menu"]',
    '[data-radix-collection-root]',
    '[data-radix-dropdown-menu-content]',
    '[data-radix-menu-content]',
    '[data-radix-select-content]',
    '[data-radix-popper-content-wrapper]',
    MENU_CONTAINER_SELECTOR,
  ] as const;
  const surfacesJson = JSON.stringify([...surfaces]);
  return `(() => {
    const BTN = ${btnSel};
    const SURFACES = ${surfacesJson};
    const btn = document.querySelector(BTN);
    const uniqSurfaces = Array.from(new Set(SURFACES));
    const surfaceCounts = {};
    for (const sel of uniqSurfaces) {
      try {
        surfaceCounts[sel] = document.querySelectorAll(sel).length;
      } catch {
        surfaceCounts[sel] = -1;
      }
    }
    const modelTestIds = Array.from(
      document.querySelectorAll('[data-testid*="model"], [data-testid*="switcher"]'),
    )
      .map((el) => el.getAttribute('data-testid'))
      .filter(Boolean);
    const uniqueTestIds = [...new Set(modelTestIds)].slice(0, 30);
    const openMenu = document.querySelector(
      '[role="menu"], [data-radix-dropdown-menu-content], [data-radix-menu-content]',
    );
    let openMenuPreview = null;
    if (openMenu instanceof HTMLElement) {
      const buttons = Array.from(openMenu.querySelectorAll('button, [role="menuitem"], [role="menuitemradio"]')).slice(
        0,
        12,
      );
      openMenuPreview = {
        tag: openMenu.tagName,
        role: openMenu.getAttribute('role'),
        dataState: openMenu.getAttribute('data-state'),
        dataTestId: openMenu.getAttribute('data-testid'),
        items: buttons.map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60)),
      };
    }
    return {
      href: (() => {
        try {
          return location.href.split('?')[0];
        } catch {
          return '';
        }
      })(),
      modelSwitcherButton: btn
        ? {
            found: true,
            tag: btn.tagName,
            ariaExpanded: btn.getAttribute('aria-expanded'),
            ariaControls: btn.getAttribute('aria-controls'),
            ariaHaspopup: btn.getAttribute('aria-haspopup'),
            dataState: btn.getAttribute('data-state'),
            text: (btn.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
          }
        : { found: false },
      surfaceCounts,
      modelRelatedTestIds: uniqueTestIds,
      openMenuPreview,
    };
  })()`;
}

export function shouldLogModelPickerDomProbe(logger: BrowserLogger): boolean {
  return Boolean(logger.verbose) || process.env.ORACLE_BROWSER_MODEL_DEBUG === "1";
}

const COMPACT_PROBE = `(() => {
  const b = document.querySelector(${JSON.stringify(MODEL_BUTTON_SELECTOR)});
  return {
    modelSwitcherButton: Boolean(b),
    ariaExpanded: b ? b.getAttribute('aria-expanded') : null,
    ariaControls: b ? (b.getAttribute('aria-controls') || '').slice(0, 80) : null,
    dataState: b ? b.getAttribute('data-state') : null,
    roleMenuCount: document.querySelectorAll('[role="menu"]').length,
    radixDropdownContent: document.querySelectorAll('[data-radix-dropdown-menu-content]').length,
    radixPopper: document.querySelectorAll('[data-radix-popper-content-wrapper]').length,
  };
})()`;

export async function logModelPickerCompactProbe(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<void> {
  try {
    const { result } = await Runtime.evaluate({ expression: COMPACT_PROBE, returnByValue: true });
    logger(
      `[browser] [model] dom-compact: ${JSON.stringify(result?.value)} — full probe: ORACLE_BROWSER_MODEL_DEBUG=1 or oracle -v`,
    );
  } catch {
    /* ignore */
  }
}

export async function logModelPickerDomProbe(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  phase: "before-model-select" | "after-model-select" | "model-select-failed",
): Promise<void> {
  if (!shouldLogModelPickerDomProbe(logger)) {
    return;
  }
  try {
    const { result } = await Runtime.evaluate({
      expression: buildModelPickerProbeExpression(),
      returnByValue: true,
    });
    const payload = result?.value;
    const line = `[browser] [model] dom-probe (${phase}): ${JSON.stringify(payload, null, 0)}`;
    logger(line);
    if (logger.sessionLog && logger.sessionLog !== logger) {
      logger.sessionLog(line);
    }
  } catch (e) {
    logger(
      `[browser] [model] dom-probe (${phase}) failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
