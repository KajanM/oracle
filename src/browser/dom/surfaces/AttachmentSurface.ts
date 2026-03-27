import { UPLOAD_STATUS_SELECTORS } from "../../constants.js";
import { buildClickDispatcher } from "../../actions/domEvents.js";
import type { BrowserLogger, ChromeClient } from "../../types.js";
import { ChatgptDomSession } from "../chatgptDomSession.js";

function byOracleId(oracleId: string): string {
  return `'[data-oracle-id=' + ${JSON.stringify(oracleId)} + ']'`;
}

export interface AttachmentSignals {
  expectedName?: string;
  names: string[];
  matchingNames: string[];
  removeButtons: number;
  uploadSignals: string[];
  ready: boolean;
}

export class AttachmentSurface {
  constructor(
    private readonly session: ChatgptDomSession,
    private readonly runtime: ChromeClient["Runtime"],
    private readonly input: ChromeClient["Input"] | undefined,
    private readonly logger: BrowserLogger,
  ) {}

  async ensurePickerOpen(): Promise<boolean> {
    return this.session.withRepair("attachments", async () => {
      const plus = await this.session.resolve("attachments.plusButton");
      if (!plus.ok || !plus.oracleId) {
        return false;
      }

      await this.runtime.evaluate({
        expression: `(() => {
          ${buildClickDispatcher("dispatchOracleAttachmentClick")}
          const node = document.querySelector(${byOracleId(plus.oracleId)});
          if (!(node instanceof HTMLElement)) {
            return false;
          }
          dispatchOracleAttachmentClick(node);
          node.click();
          return true;
        })()`,
        returnByValue: true,
        awaitPromise: true,
      });

      return true;
    });
  }

  async pickBestInput(fileName: string, isImage: boolean) {
    return this.session.withRepair("attachments", async () => {
      await this.ensurePickerOpen();
      const input = await this.session.resolve("attachments.fileInput", { refresh: true });
      if (!input.ok || !input.oracleId) {
        throw new Error("Attachment file input not found");
      }

      const result = await this.runtime.evaluate({
        expression: `(() => {
          const node = document.querySelector(${byOracleId(input.oracleId)});
          if (!(node instanceof HTMLInputElement)) {
            return null;
          }
          return {
            oracleId: node.getAttribute('data-oracle-id'),
            name: ${JSON.stringify(fileName)},
            isImage: ${JSON.stringify(isImage)},
            accept: node.getAttribute('accept'),
            multiple: node.multiple,
            hidden: node.getBoundingClientRect().width === 0 && node.getBoundingClientRect().height === 0,
          };
        })()`,
        returnByValue: true,
        awaitPromise: true,
      });

      return result.result?.value ?? null;
    });
  }

  async readSignals(expectedName?: string): Promise<AttachmentSignals> {
    const uploadSelectors = JSON.stringify(UPLOAD_STATUS_SELECTORS);
    const result = await this.runtime.evaluate({
      expression: `(() => {
        const root = document.querySelector('form') || document.body;
        const text = (root.textContent || '').replace(/\\s+/g, ' ').trim();
        const uploadSelectors = ${uploadSelectors};
        const uploadSignals = uploadSelectors
          .flatMap((selector) => {
            try {
              return Array.from(root.querySelectorAll(selector)).map((node) => (node.textContent || '').trim());
            } catch {
              return [];
            }
          })
          .filter(Boolean);
        const nameMatches = ${JSON.stringify(expectedName ?? "")}
          ? text.includes(${JSON.stringify(expectedName ?? "")})
          : false;
        const removeButtons = root.querySelectorAll('[aria-label*="Remove file"]').length;
        const names = Array.from(root.querySelectorAll('[aria-label], [data-testid*="attachment"], [data-testid*="upload"]'))
          .map((node) => node.getAttribute('aria-label') || node.textContent || '')
          .map((value) => value.replace(/\\s+/g, ' ').trim())
          .filter(Boolean);
        const matchingNames = ${JSON.stringify(expectedName ?? "")}
          ? names.filter((value) => value.includes(${JSON.stringify(expectedName ?? "")})) 
          : [];
        const busy = uploadSignals.some((value) => /upload|loading|pending|progress/i.test(value));
        return {
          expectedName: ${JSON.stringify(expectedName ?? undefined)},
          names,
          matchingNames: nameMatches ? [${JSON.stringify(expectedName ?? "")}] : matchingNames,
          removeButtons,
          uploadSignals,
          ready: !busy && (!${JSON.stringify(Boolean(expectedName))} || nameMatches || removeButtons > 0),
        };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });

    return (result.result?.value ?? {
      expectedName,
      names: [],
      matchingNames: [],
      removeButtons: 0,
      uploadSignals: [],
      ready: false,
    }) as AttachmentSignals;
  }

  async waitReady(names: string[], timeout: number): Promise<AttachmentSignals> {
    const deadline = Date.now() + timeout;
    let last = await this.readSignals(names[0]);
    while (Date.now() < deadline) {
      const allReady = names.every((name) => {
        const textHit = last.names.some((value) => value.includes(name));
        const signalHit = last.matchingNames.some((value) => value.includes(name));
        return textHit || signalHit || last.removeButtons >= names.length;
      });
      if (last.ready && allReady) {
        return last;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      last = await this.readSignals(names[0]);
    }
    this.logger(`[browser] [dom] attachment readiness timed out for ${names.join(", ")}`);
    return last;
  }
}
