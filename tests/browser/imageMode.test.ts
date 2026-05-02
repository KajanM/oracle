import { describe, expect, test } from "vitest";
import { buildCreateImageModeExpressionForTest } from "../../src/browser/actions/createImageMode.js";
import { buildGeneratedImagesExpressionForTest } from "../../src/browser/actions/generatedImages.js";

describe("ChatGPT image mode helpers", () => {
  test("targets the composer plus button and Create image radio item", () => {
    const expression = buildCreateImageModeExpressionForTest();
    expect(expression).toContain("Create image".toLowerCase());
    expect(expression).toContain("menuitemradio");
    expect(expression).toContain("aria-checked");
  });

  test("collects generated image elements and fetches their content", () => {
    const expression = buildGeneratedImagesExpressionForTest();
    expect(expression).toContain('img[alt="Generated image"]');
    expect(expression).toContain("fetch(img.src");
    expect(expression).toContain("dataBase64");
  });
});
