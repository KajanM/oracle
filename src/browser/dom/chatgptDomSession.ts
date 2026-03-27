import type { BrowserLogger, ChromeClient } from "../types.js";
import { CHATGPT_MANIFEST } from "./chatgptManifest.js";
import { INJECTED_ORACLE_DOM_HELPERS } from "./injected.js";
import type { BootstrapHealth, LocatorKey, ResolvedLocator, Surface } from "./types.js";

const SURFACE_KEYS: Record<Surface, LocatorKey[]> = {
  composer: ["composer.root", "composer.input", "composer.sendButton"],
  attachments: [
    "attachments.plusButton",
    "attachments.fileInput",
    "attachments.removeButton",
  ],
  modelPicker: ["model.trigger", "model.menu"],
  assistant: ["assistant.latestTurn", "assistant.copyButton"],
};

export class ChatgptDomSession {
  private installed = false;

  constructor(
    private readonly runtime: ChromeClient["Runtime"],
    private readonly input: ChromeClient["Input"] | undefined,
    private readonly logger: BrowserLogger,
  ) {}

  async install(): Promise<void> {
    if (this.installed) {
      return;
    }

    await this.eval<void>(INJECTED_ORACLE_DOM_HELPERS);
    await this.eval<void>(
      `(() => {
        window.__oracleManifest = ${JSON.stringify(CHATGPT_MANIFEST)};
      })()`,
    );
    this.installed = true;
  }

  async bootstrap(keys: LocatorKey[]): Promise<BootstrapHealth> {
    await this.install();
    return this.eval<BootstrapHealth>(
      `window.__oracle.bootstrap(${JSON.stringify(keys)})`,
    );
  }

  async resolve(
    key: LocatorKey,
    opts: { refresh?: boolean } = {},
  ): Promise<ResolvedLocator> {
    await this.install();
    return this.eval<ResolvedLocator>(
      `window.__oracle.resolve(${JSON.stringify(key)}, ${JSON.stringify(opts)})`,
    );
  }

  async repair(surface: Surface): Promise<BootstrapHealth> {
    await this.install();
    this.logger(`[browser] [dom] repairing surface=${surface}`);
    await this.eval<boolean>(`window.__oracle.invalidateSurface(${JSON.stringify(surface)})`);
    return this.bootstrap(SURFACE_KEYS[surface]);
  }

  async withRepair<T>(surface: Surface, op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger(`[browser] [dom] surface=${surface} failed, retrying after repair: ${message}`);
      await this.repair(surface);
      return op();
    }
  }

  getRuntime(): ChromeClient["Runtime"] {
    return this.runtime;
  }

  getInput(): ChromeClient["Input"] | undefined {
    return this.input;
  }

  private async eval<T>(expression: string): Promise<T> {
    const evaluation = await this.runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    if (evaluation.exceptionDetails) {
      throw new Error(evaluation.exceptionDetails.text || "Runtime evaluation failed");
    }

    return (evaluation.result?.value ?? undefined) as T;
  }
}
