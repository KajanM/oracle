import { describe, expect, test } from "vitest";
import { buildAttachmentReadyExpressionForTest } from "../../src/browser/actions/promptComposer.ts";

describe("prompt composer attachment expressions", () => {
  test("attachment ready check does not match prompt text", () => {
    const expression = buildAttachmentReadyExpressionForTest(["oracle-attach-verify.txt"]);
    expect(expression).toContain("document.querySelector('form')");
    expect(expression).toContain("document.querySelector('div[data-testid*=\"composer\"]')");
    expect(expression).toContain("const aria = (node?.getAttribute?.('aria-label') || '').toLowerCase();");
    expect(expression).toContain("const title = (node?.getAttribute?.('title') || '').toLowerCase();");
    expect(expression).toContain("'[aria-label*=\"Remove file\"]'");
    expect(expression).toContain("button[aria-label*=\"Remove file\"]");
    expect(expression).toContain("const removeFileButtons = composer.querySelectorAll('[aria-label*=\"Remove file\"]');");
    expect(expression).toContain("const removeCountReady = removeFileButtons.length >= names.length;");
    expect(expression).toContain('input[type="file"]');
    expect(expression).not.toContain("a,div,span");
    expect(expression).not.toContain(
      'document.querySelectorAll(\'[data-testid*="chip"],[data-testid*="attachment"],a,div,span\')',
    );
  });
});
