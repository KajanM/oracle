import {
  COPY_BUTTON_SELECTOR,
  MODEL_BUTTON_SELECTOR,
  PROMPT_PRIMARY_SELECTOR,
  SEND_BUTTON_SELECTOR,
} from "../constants.js";
import type {
  LocatorKey,
  Pattern,
  Predicate,
  SemanticLocator,
  Strategy,
} from "./types.js";

const substring = (value: string): Pattern => ({ kind: "substring", value });
const visible = (): Predicate => ({ kind: "visible" });
const enabled = (): Predicate => ({ kind: "enabled" });
const editable = (): Predicate => ({ kind: "editable" });
const inside = (locatorKey: LocatorKey): Predicate => ({ kind: "inside", locatorKey });

const css = (selector: string, weight: number, scope?: LocatorKey): Strategy => ({
  kind: "css",
  selector,
  weight,
  scope,
});

const probe = (probeName: string, weight: number, scope?: LocatorKey): Strategy => ({
  kind: "probe",
  probe: probeName,
  weight,
  scope,
});

export const CHATGPT_MANIFEST: Record<LocatorKey, SemanticLocator> = {
  "composer.root": {
    key: "composer.root",
    surface: "composer",
    required: true,
    cachePolicy: "navigation",
    strategies: [
      probe("findComposerRoot", 120),
      css("form", 80),
      css('[data-testid*="composer"] div', 60),
    ],
    predicates: [visible()],
  },
  "composer.input": {
    key: "composer.input",
    surface: "composer",
    required: true,
    cachePolicy: "fingerprint",
    strategies: [
      css(PROMPT_PRIMARY_SELECTOR, 110, "composer.root"),
      css('.ProseMirror[contenteditable="true"]', 105, "composer.root"),
      css('[role="textbox"][contenteditable="true"]', 85, "composer.root"),
      probe("findEditableTextbox", 95, "composer.root"),
    ],
    predicates: [visible(), editable(), inside("composer.root")],
  },
  "composer.sendButton": {
    key: "composer.sendButton",
    surface: "composer",
    required: true,
    cachePolicy: "fingerprint",
    strategies: [
      css(SEND_BUTTON_SELECTOR, 110, "composer.root"),
      css('button[aria-label*="Send"]', 90, "composer.root"),
      css("button.composer-submit-btn", 80, "composer.root"),
    ],
    predicates: [visible(), inside("composer.root")],
  },
  "attachments.plusButton": {
    key: "attachments.plusButton",
    surface: "attachments",
    required: false,
    cachePolicy: "fingerprint",
    strategies: [css('button[data-testid="composer-plus-btn"]', 110, "composer.root")],
    predicates: [visible(), enabled(), inside("composer.root")],
  },
  "attachments.fileInput": {
    key: "attachments.fileInput",
    surface: "attachments",
    required: false,
    cachePolicy: "none",
    strategies: [
      probe("pickBestFileInput", 140, "composer.root"),
      css('input[type="file"][multiple]', 70, "composer.root"),
      css('input[type="file"]', 50, "composer.root"),
    ],
    predicates: [inside("composer.root")],
  },
  "attachments.removeButton": {
    key: "attachments.removeButton",
    surface: "attachments",
    required: false,
    cachePolicy: "none",
    strategies: [css('[aria-label*="Remove file"]', 120, "composer.root")],
    predicates: [visible(), inside("composer.root")],
  },
  "model.trigger": {
    key: "model.trigger",
    surface: "modelPicker",
    required: false,
    cachePolicy: "fingerprint",
    strategies: [css(MODEL_BUTTON_SELECTOR, 120), probe("findModelTrigger", 90)],
    predicates: [visible(), enabled()],
  },
  "model.menu": {
    key: "model.menu",
    surface: "modelPicker",
    required: false,
    cachePolicy: "none",
    strategies: [
      css('[role="menu"]', 100),
      css("[data-radix-menu-content]", 80),
    ],
    predicates: [visible()],
  },
  "assistant.latestTurn": {
    key: "assistant.latestTurn",
    surface: "assistant",
    required: false,
    cachePolicy: "none",
    strategies: [
      probe("findLatestAssistantTurn", 150),
      css('[data-message-author-role="assistant"]', 100),
      css('[data-turn="assistant"]', 90),
    ],
    predicates: [visible()],
  },
  "assistant.copyButton": {
    key: "assistant.copyButton",
    surface: "assistant",
    required: false,
    cachePolicy: "none",
    strategies: [css(COPY_BUTTON_SELECTOR, 110, "assistant.latestTurn")],
    predicates: [visible(), inside("assistant.latestTurn")],
  },
};

export const CHATGPT_MANIFEST_PATTERNS = {
  modelMenuDataTestId: substring("model-switcher"),
};
