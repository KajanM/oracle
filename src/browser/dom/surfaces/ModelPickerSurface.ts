import { buildClickDispatcher } from "../../actions/domEvents.js";
import type { BrowserLogger, ChromeClient } from "../../types.js";
import { ChatgptDomSession } from "../chatgptDomSession.js";

function oracleSelector(oracleId: string): string {
  return `'[data-oracle-id=' + ${JSON.stringify(oracleId)} + ']'`;
}

export interface ModelPickerOption {
  oracleId: string;
  text: string;
  selected: boolean;
}

export class ModelPickerSurface {
  constructor(
    private readonly session: ChatgptDomSession,
    private readonly runtime: ChromeClient["Runtime"],
    private readonly input: ChromeClient["Input"] | undefined,
    private readonly logger: BrowserLogger,
  ) {}

  async open(): Promise<boolean> {
    return this.session.withRepair("modelPicker", async () => {
      const trigger = await this.session.resolve("model.trigger", { refresh: true });
      if (!trigger.ok || !trigger.oracleId) {
        return false;
      }

      const result = await this.runtime.evaluate({
        expression: `(() => {
          ${buildClickDispatcher("dispatchOracleModelClick")}
          const node = document.querySelector(${oracleSelector(trigger.oracleId)});
          if (!(node instanceof HTMLElement)) {
            return false;
          }
          dispatchOracleModelClick(node);
          node.click();
          return true;
        })()`,
        returnByValue: true,
        awaitPromise: true,
      });

      return Boolean(result.result?.value);
    });
  }

  async listOptions(): Promise<ModelPickerOption[]> {
    return this.session.withRepair("modelPicker", async () => {
      let menu = await this.session.resolve("model.menu", { refresh: true });
      if (!menu.ok || !menu.oracleId) {
        await this.open();
        menu = await this.session.resolve("model.menu", { refresh: true });
      }
      if (!menu.ok || !menu.oracleId) {
        return [];
      }

      const result = await this.runtime.evaluate({
        expression: `(() => {
          const anchor = document.querySelector(${oracleSelector(menu.oracleId)});
          const menu = anchor?.closest('[role="menu"], [data-radix-menu-content]') || anchor;
          if (!(menu instanceof HTMLElement)) {
            return [];
          }
          const options = Array.from(menu.querySelectorAll('button, [role="menuitem"], [role="menuitemradio"]'));
          return options.map((node) => {
            if (!(node instanceof HTMLElement)) {
              return null;
            }
            const oracleId = node.getAttribute('data-oracle-id') || window.__oracle.mark(node, 'model.menu');
            return {
              oracleId,
              text: (node.textContent || '').replace(/\\s+/g, ' ').trim(),
              selected: node.getAttribute('aria-checked') === 'true' || node.getAttribute('data-state') === 'checked',
            };
          }).filter(Boolean);
        })()`,
        returnByValue: true,
        awaitPromise: true,
      });

      return (result.result?.value ?? []) as ModelPickerOption[];
    });
  }

  async clickOption(option: string): Promise<boolean> {
    return this.session.withRepair("modelPicker", async () => {
      const options = await this.listOptions();
      const lower = option.toLowerCase();
      const target =
        options.find((entry) => entry.text.toLowerCase() === lower) ??
        options.find((entry) => entry.text.toLowerCase().includes(lower));
      if (!target?.oracleId) {
        this.logger(`[browser] [dom] model option not found: ${option}`);
        return false;
      }

      const result = await this.runtime.evaluate({
        expression: `(() => {
          ${buildClickDispatcher("dispatchOracleModelOptionClick")}
          const node = document.querySelector(${oracleSelector(target.oracleId)});
          if (!(node instanceof HTMLElement)) {
            return false;
          }
          dispatchOracleModelOptionClick(node);
          node.click();
          return true;
        })()`,
        returnByValue: true,
        awaitPromise: true,
      });

      return Boolean(result.result?.value);
    });
  }

  async confirmSelected(model: string): Promise<boolean> {
    const trigger = await this.session.resolve("model.trigger", { refresh: true });
    if (!trigger.ok || !trigger.oracleId) {
      return false;
    }

    const result = await this.runtime.evaluate({
      expression: `(() => {
        const node = document.querySelector(${oracleSelector(trigger.oracleId)});
        if (!(node instanceof HTMLElement)) {
          return false;
        }
        const text = ((node.textContent || '') + ' ' + (node.getAttribute('aria-label') || ''))
          .replace(/\\s+/g, ' ')
          .trim()
          .toLowerCase();
        return text.includes(${JSON.stringify(model.toLowerCase())});
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });

    return Boolean(result.result?.value);
  }
}
