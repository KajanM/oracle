import { describe, expect, it } from "vitest";
import { buildThinkingTimeExpressionForTest } from "../../src/browser/actions/thinkingTime.js";

describe("browser thinking-time selection expression", () => {
  it("uses centralized menu selectors and normalized matching", () => {
    const expression = buildThinkingTimeExpressionForTest();
    expect(expression).toContain("const MENU_CONTAINER_SELECTOR");
    expect(expression).toContain("const MENU_ITEM_SELECTOR");
    expect(expression).toContain('role=\\"menu\\"');
    expect(expression).toContain("data-radix-collection-root");
    expect(expression).toContain('role=\\"menuitem\\"');
    expect(expression).toContain('role=\\"menuitemradio\\"');
    expect(expression).toContain("normalize");
    expect(expression).toContain("extended");
    expect(expression).toContain("standard");
    expect(expression).toContain("instant");
    expect(expression).toContain("isVisible");
  });

  it("can open the current Instant composer mode pill", () => {
    const expression = buildThinkingTimeExpressionForTest("extended");
    expect(expression).toContain("modeTriggerLabels");
    expect(expression).toContain("instant");
    expect(expression).toContain("targetAliases");
    expect(expression).toContain("pro");
  });

  it("treats the visible Extended Pro composer pill as already selected", () => {
    const expression = buildThinkingTimeExpressionForTest("extended");
    expect(expression).toContain("chipMatchesTarget");
    expect(expression).toContain("already-selected");
    expect(expression).toContain("chip.textContent");
  });

  it("targets the requested thinking time level", () => {
    const levels = ["light", "standard", "extended", "heavy"] as const;
    for (const level of levels) {
      const expression = buildThinkingTimeExpressionForTest(level);
      expect(expression).toContain("const TARGET_LEVEL");
      expect(expression).toContain(`"${level}"`);
    }
  });
});
