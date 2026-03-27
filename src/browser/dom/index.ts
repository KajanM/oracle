import type { BrowserLogger, ChromeClient } from "../types.js";
import { ChatgptDomSession } from "./chatgptDomSession.js";

export * from "./chatgptDomSession.js";
export * from "./chatgptManifest.js";
export * from "./surfaces/index.js";
export * from "./types.js";

export function getChatgptDomSession(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  logger: BrowserLogger,
): ChatgptDomSession {
  return new ChatgptDomSession(runtime, input, logger);
}
