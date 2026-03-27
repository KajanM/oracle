import { COPY_BUTTON_SELECTOR, STOP_BUTTON_SELECTOR } from "../../constants.js";
import { buildClickDispatcher } from "../../actions/domEvents.js";
import type { BrowserLogger, ChromeClient } from "../../types.js";
import { ChatgptDomSession } from "../chatgptDomSession.js";

function oracleSelector(oracleId: string): string {
  return `'[data-oracle-id=' + ${JSON.stringify(oracleId)} + ']'`;
}

export interface AssistantTurn {
  oracleId: string;
  text: string;
  html: string;
  turnIndex: number;
}

export interface AssistantSnapshot {
  oracleId?: string;
  text: string;
  html?: string;
  turnIndex?: number;
  complete: boolean;
  hasCopyButton: boolean;
}

export class AssistantSurface {
  constructor(
    private readonly session: ChatgptDomSession,
    private readonly runtime: ChromeClient["Runtime"],
    private readonly input: ChromeClient["Input"] | undefined,
    private readonly logger: BrowserLogger,
  ) {}

  async findLatestTurn(minIndex?: number): Promise<AssistantTurn | null> {
    return this.session.withRepair("assistant", async () => {
      await this.session.resolve("assistant.latestTurn", { refresh: true });
      const result = await this.runtime.evaluate({
        expression: `(() => {
          const turns = Array.from(document.querySelectorAll('[data-message-author-role="assistant"], [data-turn="assistant"]'))
            .filter((node, index, list) => list.indexOf(node) === index);
          if (turns.length === 0) {
            return null;
          }
          const startIndex = ${JSON.stringify(minIndex ?? null)};
          const indexed = turns.map((node, index) => ({ node, index }));
          const filtered = startIndex === null
            ? indexed
            : indexed.filter((entry) => entry.index >= startIndex);
          const selected = filtered[filtered.length - 1] || indexed[indexed.length - 1];
          if (!selected || !(selected.node instanceof HTMLElement)) {
            return null;
          }
          const oracleId = selected.node.getAttribute('data-oracle-id') || window.__oracle.mark(selected.node, 'assistant.latestTurn');
          return {
            oracleId,
            text: (selected.node.textContent || '').replace(/\\s+/g, ' ').trim(),
            html: selected.node.innerHTML,
            turnIndex: selected.index,
          };
        })()`,
        returnByValue: true,
        awaitPromise: true,
      });

      return (result.result?.value ?? null) as AssistantTurn | null;
    });
  }

  async readSnapshot(): Promise<AssistantSnapshot> {
    const turn = await this.findLatestTurn();
    if (!turn) {
      return { text: "", complete: false, hasCopyButton: false };
    }

    const result = await this.runtime.evaluate({
      expression: `(() => {
        const node = document.querySelector(${oracleSelector(turn.oracleId)});
        if (!(node instanceof HTMLElement)) {
          return null;
        }
        const hasCopyButton = Boolean(node.querySelector(${JSON.stringify(COPY_BUTTON_SELECTOR)}));
        const stopVisible = Boolean(document.querySelector(${JSON.stringify(STOP_BUTTON_SELECTOR)}));
        return {
          oracleId: node.getAttribute('data-oracle-id') || undefined,
          text: (node.textContent || '').replace(/\\s+/g, ' ').trim(),
          html: node.innerHTML,
          turnIndex: ${JSON.stringify(turn.turnIndex)},
          complete: hasCopyButton && !stopVisible,
          hasCopyButton,
        };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });

    return (result.result?.value ?? {
      oracleId: turn.oracleId,
      text: turn.text,
      html: turn.html,
      turnIndex: turn.turnIndex,
      complete: false,
      hasCopyButton: false,
    }) as AssistantSnapshot;
  }

  async isComplete(): Promise<boolean> {
    const snapshot = await this.readSnapshot();
    return snapshot.complete;
  }

  async copyMarkdown(): Promise<string | null> {
    return this.session.withRepair("assistant", async () => {
      const copyButton = await this.session.resolve("assistant.copyButton", { refresh: true });
      const snapshot = await this.readSnapshot();
      if (!copyButton.ok || !copyButton.oracleId) {
        return snapshot.text || null;
      }

      const result = await this.runtime.evaluate({
        expression: `(async () => {
          ${buildClickDispatcher("dispatchOracleCopyClick")}
          const button = document.querySelector(${oracleSelector(copyButton.oracleId)});
          if (!(button instanceof HTMLElement)) {
            return null;
          }
          dispatchOracleCopyClick(button);
          button.click();
          if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
            await new Promise((resolve) => setTimeout(resolve, 150));
            try {
              const text = await navigator.clipboard.readText();
              return text || null;
            } catch {
              return null;
            }
          }
          return null;
        })()`,
        returnByValue: true,
        awaitPromise: true,
      });

      return (result.result?.value as string | null | undefined) ?? snapshot.text ?? null;
    });
  }
}
