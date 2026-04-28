import type { BrowserSessionConfig } from "../sessionStore.js";
import type { BrowserRunResult } from "../browserMode.js";
import type { BrowserAttachment } from "../browser/types.js";

export interface RemoteAttachmentPayload {
  fileName: string;
  displayPath: string;
  sizeBytes?: number;
  contentBase64: string;
}

export interface RemoteRunPayload {
  prompt: string;
  attachments: RemoteAttachmentPayload[];
  browserConfig: BrowserSessionConfig;
  options: {
    heartbeatIntervalMs?: number;
    verbose?: boolean;
  };
}

// Each NDJSON event carries a monotonic `seq` so resuming clients can request
// only events strictly after the last one they observed. `runId` identifies
// the server-side run and is required to resume after a transport drop.
export type RemoteRunEvent =
  | { type: "runId"; seq: number; runId: string }
  | { type: "log"; seq: number; message: string }
  | { type: "result"; seq: number; result: BrowserRunResult }
  | { type: "error"; seq: number; message: string };

export interface SerializedAttachment extends BrowserAttachment {
  fileName: string;
  contentBase64: string;
}

export interface RemoteRunSummary {
  runId: string;
  status: "running" | "completed" | "errored";
  startedAt: string;
  endedAt?: string;
  promptChars: number;
  attachmentCount: number;
  eventCount: number;
  attachedClients: number;
  totalDisconnects: number;
  lastDisconnectAt?: string;
  durationMs?: number;
}

export interface RemoteRunsListing {
  ok: boolean;
  active: RemoteRunSummary[];
  recent: RemoteRunSummary[];
  retentionMs: number;
}
