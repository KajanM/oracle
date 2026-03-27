import { buildClickDispatcher } from "../../actions/domEvents.js";
import type { BrowserLogger, ChromeClient } from "../../types.js";
import { ChatgptDomSession } from "../chatgptDomSession.js";

function escapeAttribute(value: string): string {
  return JSON.stringify(value);
}

export class ComposerSurface {
  constructor(
    private readonly session: ChatgptDomSession,
    private readonly runtime: ChromeClient["Runtime"],
    private readonly input: ChromeClient["Input"] | undefined,
    private readonly logger: BrowserLogger,
  ) {}

  async focusInput() {
    return this.session.withRepair("composer", async () => {
      const resolved = await this.session.resolve("composer.input");
      if (!resolved.ok || !resolved.oracleId) {
        throw new Error("Composer input not found");
      }

      await this.runtime.evaluate({
        expression: `(() => {
          ${buildClickDispatcher("dispatchOracleComposerClick")}
          const node = document.querySelector('[data-oracle-id=' + ${escapeAttribute(
            resolved.oracleId,
          )} + ']');
          if (!(node instanceof HTMLElement)) {
            return false;
          }
          dispatchOracleComposerClick(node);
          node.focus();
          const doc = node.ownerDocument;
          const selection = doc?.getSelection?.();
          if (selection && node.isContentEditable) {
            const range = doc.createRange();
            range.selectNodeContents(node);
            range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
          }
          return true;
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });

      return resolved;
    });
  }

  async setText(text: string): Promise<void> {
    await this.session.withRepair("composer", async () => {
      const resolved = await this.focusInput();
      if (!resolved.oracleId) {
        throw new Error("Composer input not found");
      }

      const expression = `(() => {
        const node = document.querySelector('[data-oracle-id=' + ${escapeAttribute(
          resolved.oracleId,
        )} + ']');
        if (!(node instanceof HTMLElement)) {
          return false;
        }
        const value = ${JSON.stringify(text)};
        if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
          node.value = value;
          node.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        node.textContent = value;
        node.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
        return true;
      })()`;

      const result = await this.runtime.evaluate({
        expression,
        awaitPromise: true,
        returnByValue: true,
      });

      if (!result.result?.value && this.input) {
        await this.focusInput();
        await this.input.insertText({ text });
      }
    });
  }

  async submit(): Promise<boolean> {
    return this.session.withRepair("composer", async () => {
      const resolved = await this.session.resolve("composer.sendButton", { refresh: true });
      if (!resolved.ok || !resolved.oracleId) {
        throw new Error("Composer send button not found");
      }

      const result = await this.runtime.evaluate({
        expression: `(() => {
          ${buildClickDispatcher("dispatchOracleSubmitClick")}
          const node = document.querySelector('[data-oracle-id=' + ${escapeAttribute(
            resolved.oracleId,
          )} + ']');
          if (!(node instanceof HTMLElement)) {
            return false;
          }
          dispatchOracleSubmitClick(node);
          if (typeof node.click === 'function') {
            node.click();
          }
          return true;
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });

      return Boolean(result.result?.value);
    });
  }

  async isReady(): Promise<boolean> {
    const input = await this.session.resolve("composer.input");
    if (!input.ok || !input.oracleId) {
      return false;
    }

    const state = await this.runtime.evaluate({
      expression: `(() => {
        const node = document.querySelector('[data-oracle-id=' + ${escapeAttribute(
          input.oracleId,
        )} + ']');
        if (!(node instanceof HTMLElement)) {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (
          node.isContentEditable ||
          node instanceof HTMLTextAreaElement ||
          node instanceof HTMLInputElement
        );
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });

    return Boolean(state.result?.value);
  }
}
