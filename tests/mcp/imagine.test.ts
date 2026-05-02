import { describe, expect, test } from "vitest";
import { buildImagineBrowserConfig } from "../../src/mcp/tools/imagine.js";

describe("buildImagineBrowserConfig", () => {
  test("uses Thinking model and enables image capture without manual login", () => {
    const config = buildImagineBrowserConfig({
      userConfig: {
        browser: {
          chatgptUrl: "https://chatgpt.com/g/g-p-foo/project",
          keepBrowser: false,
          manualLogin: true,
          manualLoginProfileDir: "/tmp/profile",
          thinkingTime: "extended",
        },
      },
      browserKeepBrowser: true,
    });

    expect(config).toMatchObject({
      chatgptUrl: "https://chatgpt.com/g/g-p-foo/project",
      url: "https://chatgpt.com/g/g-p-foo/project",
      keepBrowser: true,
      desiredModel: "GPT-5.5 Thinking",
      modelStrategy: "select",
      createImageMode: true,
      captureGeneratedImages: true,
      manualLogin: false,
      manualLoginProfileDir: null,
      manualLoginCookieSync: false,
      cookieSync: true,
    });
    expect(config.thinkingTime).toBeUndefined();
  });
});
