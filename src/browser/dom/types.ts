export type Surface = "composer" | "attachments" | "modelPicker" | "assistant";

export type LocatorKey =
  | "composer.root"
  | "composer.input"
  | "composer.sendButton"
  | "attachments.plusButton"
  | "attachments.fileInput"
  | "attachments.removeButton"
  | "model.trigger"
  | "model.menu"
  | "assistant.latestTurn"
  | "assistant.copyButton";

export type Pattern =
  | { kind: "substring"; value: string }
  | { kind: "regex"; source: string; flags?: string };

export type Predicate =
  | { kind: "visible" }
  | { kind: "enabled" }
  | { kind: "editable" }
  | { kind: "inside"; locatorKey: LocatorKey };

export interface StrategyBase {
  weight: number;
  scope?: LocatorKey;
}

export interface CssStrategy extends StrategyBase {
  kind: "css";
  selector: string;
}

export interface AttrStrategy extends StrategyBase {
  kind: "attr";
  attr: string;
  pattern: Pattern;
}

export interface TextStrategy extends StrategyBase {
  kind: "text";
  selector: string;
  pattern: Pattern;
}

export interface ProbeStrategy extends StrategyBase {
  kind: "probe";
  probe: string;
}

export type Strategy = CssStrategy | AttrStrategy | TextStrategy | ProbeStrategy;

export type CachePolicy = "navigation" | "fingerprint" | "none";

export interface SemanticLocator {
  key: LocatorKey;
  surface: Surface;
  required: boolean;
  cachePolicy: CachePolicy;
  strategies: Strategy[];
  predicates: Predicate[];
}

export interface LocatorTrace {
  id: string;
  matches: number;
  bestScore: number;
}

export interface ResolvedLocator {
  ok: boolean;
  key: LocatorKey;
  oracleId?: string;
  strategyId?: string;
  score?: number;
  fingerprint?: string;
  tried: LocatorTrace[];
}

export interface BootstrapHealth {
  ok: boolean;
  health: Record<string, ResolvedLocator>;
}
