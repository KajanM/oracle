import { describe, expect, test } from "vitest";
import { buildBrowserConfig, resolveBrowserModelLabel } from "../../src/cli/browserConfig.js";

describe("buildBrowserConfig", () => {
  test("uses defaults when optional flags omitted", async () => {
    const config = await buildBrowserConfig({ model: "gpt-5.4-pro" });
    expect(config).toMatchObject({
      chromeProfile: "Default",
      chromePath: null,
      chromeCookiePath: null,
      url: undefined,
      timeoutMs: undefined,
      inputTimeoutMs: undefined,
      cookieSync: undefined,
      headless: undefined,
      keepBrowser: undefined,
      hideWindow: undefined,
      desiredModel: "Use latest model",
      thinkingTime: "extended",
      debug: undefined,
      allowCookieErrors: true,
    });
  });

  test("maps gpt browser runs to latest Pro", async () => {
    const config = await buildBrowserConfig({ model: "gpt-5.4" });
    expect(config.desiredModel).toBe("Use latest model");
    expect(config.thinkingTime).toBe("extended");
  });

  test("forces model selection and extended thinking for GPT browser runs", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.2-pro",
      browserModelStrategy: "current",
    });
    expect(config.modelStrategy).toBe("select");
    expect(config.desiredModel).toBe("Use latest model");
    expect(config.thinkingTime).toBe("extended");
  });

  test("forces extended thinking for Pro even when caller asks for another thinking time", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.2-pro",
      browserThinkingTime: "standard",
    });
    expect(config.desiredModel).toBe("Use latest model");
    expect(config.thinkingTime).toBe("extended");
  });

  test("honors overrides and converts durations + booleans", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.1",
      browserChromeProfile: "Profile 2",
      browserChromePath: "/Applications/Chrome.app",
      browserCookiePath: "/tmp/cookies.db",
      browserUrl: "https://chat.example.com",
      browserTimeout: "120s",
      browserInputTimeout: "5s",
      browserProfileLockTimeout: "2m",
      browserCookieWait: "4s",
      browserNoCookieSync: true,
      browserHeadless: true,
      browserHideWindow: true,
      browserKeepBrowser: true,
      browserAllowCookieErrors: true,
      verbose: true,
    });
    expect(config).toMatchObject({
      chromeProfile: "Profile 2",
      chromePath: "/Applications/Chrome.app",
      chromeCookiePath: "/tmp/cookies.db",
      url: "https://chat.example.com/",
      timeoutMs: 120_000,
      inputTimeoutMs: 5_000,
      profileLockTimeoutMs: 120_000,
      cookieSyncWaitMs: 4_000,
      cookieSync: false,
      headless: undefined,
      hideWindow: true,
      keepBrowser: true,
      desiredModel: "Use latest model",
      thinkingTime: "extended",
      debug: true,
      allowCookieErrors: true,
    });
  });

  test("prefers explicit browser model label when provided", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.2-pro",
      browserModelLabel: "Instant",
    });
    expect(config.desiredModel).toBe("Use latest model");
  });

  test("falls back to canonical label when override matches base model", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.1",
      browserModelLabel: "gpt-5.1",
    });
    expect(config.desiredModel).toBe("Use latest model");
  });

  test("maps thinking Gemini model to thinking label", async () => {
    const config = await buildBrowserConfig({
      model: "gemini-3-pro",
    });
    expect(config.desiredModel).toBe("Gemini 3 Pro");
  });

  test("maps deep-think Gemini model to deep-think label", async () => {
    const config = await buildBrowserConfig({
      model: "gemini-3-pro-deep-think",
    });
    expect(config.desiredModel).toBe("gemini-3-deep-think");
  });

  test("trims whitespace around override labels", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.1",
      browserModelLabel: "  ChatGPT 5.1 Instant  ",
    });
    expect(config.desiredModel).toBe("Use latest model");
  });

  test("parses remoteChrome host targets", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.2-pro",
      remoteChrome: "remote-host:9333",
    });
    expect(config.remoteChrome).toEqual({ host: "remote-host", port: 9_333 });
  });

  test("normalizes chatgpt-url alias and adds https when missing", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.1",
      chatgptUrl: "chatgpt.example.com/workspace",
    });
    expect(config.url).toBe("https://chatgpt.example.com/workspace");
  });

  test("rejects invalid chatgpt URL protocols", async () => {
    await expect(
      buildBrowserConfig({
        model: "gpt-5.1",
        chatgptUrl: "ftp://chatgpt.example.com",
      }),
    ).rejects.toThrow(/http/i);
  });

  test("rejects temporary chat URLs when targeting Pro", async () => {
    await expect(
      buildBrowserConfig({
        model: "gpt-5.2-pro",
        chatgptUrl: "https://chatgpt.com/?temporary-chat=true",
      }),
    ).rejects.toThrow(/Temporary Chat/i);
  });

  test("rejects temporary chat URLs for all GPT browser runs", async () => {
    await expect(
      buildBrowserConfig({
        model: "gpt-5.2",
        chatgptUrl: "https://chatgpt.com/?temporary-chat=true",
      }),
    ).rejects.toThrow(/Temporary Chat/i);
  });

  test("accepts IPv6 remoteChrome targets wrapped in brackets", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.2-pro",
      remoteChrome: "[2001:db8::1]:9222",
    });
    expect(config.remoteChrome).toEqual({ host: "2001:db8::1", port: 9_222 });
  });

  test("rejects malformed remoteChrome targets", async () => {
    await expect(
      buildBrowserConfig({
        model: "gpt-5.2-pro",
        remoteChrome: "just-a-host",
      }),
    ).rejects.toThrow(/host:port/i);
  });

  test("rejects remoteChrome IPv6 without brackets", async () => {
    await expect(
      buildBrowserConfig({
        model: "gpt-5.2-pro",
        remoteChrome: "2001:db8::1:9222",
      }),
    ).rejects.toThrow(/Wrap IPv6 addresses/i);
  });

  test("rejects out-of-range remoteChrome ports", async () => {
    await expect(
      buildBrowserConfig({
        model: "gpt-5.2-pro",
        remoteChrome: "server:70000",
      }),
    ).rejects.toThrow(/between 1 and 65535/i);
  });
});

describe("resolveBrowserModelLabel", () => {
  test("returns canonical ChatGPT label when CLI value matches API model", () => {
    expect(resolveBrowserModelLabel("gpt-5.4-pro", "gpt-5.4-pro")).toBe("Use latest model");
    expect(resolveBrowserModelLabel("gpt-5.5-pro", "gpt-5.5-pro")).toBe("Use latest model");
    expect(resolveBrowserModelLabel("gpt-5.5", "gpt-5.5")).toBe("Use latest model");
    expect(resolveBrowserModelLabel("gpt-5.4", "gpt-5.4")).toBe("Use latest model");
    expect(resolveBrowserModelLabel("gpt-5-pro", "gpt-5-pro")).toBe("Use latest model");
    expect(resolveBrowserModelLabel("gpt-5.2-pro", "gpt-5.2-pro")).toBe("Use latest model");
    expect(resolveBrowserModelLabel("gpt-5.1-pro", "gpt-5.1-pro")).toBe("Use latest model");
    expect(resolveBrowserModelLabel("GPT-5.1", "gpt-5.1")).toBe("Use latest model");
  });

  test("falls back to canonical label when input is empty", () => {
    expect(resolveBrowserModelLabel("", "gpt-5.1")).toBe("Use latest model");
  });

  test("ignores descriptive GPT labels and targets latest Pro", () => {
    expect(resolveBrowserModelLabel("ChatGPT 5.1 Instant", "gpt-5.1")).toBe("Use latest model");
  });

  test("supports undefined or whitespace-only input", () => {
    expect(resolveBrowserModelLabel(undefined, "gpt-5.2-pro")).toBe("Use latest model");
    expect(resolveBrowserModelLabel("   ", "gpt-5.1")).toBe("Use latest model");
  });

  test("preserves descriptive non-GPT labels", () => {
    expect(resolveBrowserModelLabel("  Gemini 3 Pro ", "gemini-3-pro")).toBe("Gemini 3 Pro");
  });
});
