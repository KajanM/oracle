import { describe, expect, test, vi } from "vitest";
import {
  assertCurrentConversationId,
  navigateToPromptReadyWithFallback,
} from "../../src/browser/actions/navigation.ts";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.ts";
import { BrowserAutomationError } from "../../src/oracle/errors.ts";

type FakeRuntime = ChromeClient["Runtime"];
type FakePage = ChromeClient["Page"];

function makeRuntime(hrefByCall: string[]): FakeRuntime {
  const queue = [...hrefByCall];
  const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
    if (typeof expression === "string" && expression.includes("location.href")) {
      const value = queue.shift() ?? hrefByCall[hrefByCall.length - 1] ?? null;
      return { result: { value } };
    }
    return { result: { value: null } };
  });
  return { evaluate } as unknown as FakeRuntime;
}

function makePage(): FakePage {
  return { navigate: vi.fn(async () => {}) } as unknown as FakePage;
}

function makeLogger(): BrowserLogger {
  const logger = vi.fn() as BrowserLogger;
  logger.verbose = false;
  return logger;
}

describe("assertCurrentConversationId", () => {
  test("passes when current URL matches expected id", async () => {
    const runtime = makeRuntime(["https://chatgpt.com/c/abc-123"]);
    const logger = makeLogger();
    await expect(
      assertCurrentConversationId(runtime, "abc-123", logger),
    ).resolves.toBeUndefined();
  });

  test("throws BrowserAutomationError on id mismatch", async () => {
    const runtime = makeRuntime(["https://chatgpt.com/c/different-id"]);
    const logger = makeLogger();
    await expect(
      assertCurrentConversationId(runtime, "abc-123", logger),
    ).rejects.toBeInstanceOf(BrowserAutomationError);
  });

  test("throws when landed on base ChatGPT (no /c/ segment)", async () => {
    const runtime = makeRuntime(["https://chatgpt.com/"]);
    const logger = makeLogger();
    await expect(
      assertCurrentConversationId(runtime, "abc-123", logger),
    ).rejects.toBeInstanceOf(BrowserAutomationError);
  });
});

describe("navigateToPromptReadyWithFallback — conversation-id enforcement", () => {
  test("proceeds when requested /c/{id} loads and URL still matches", async () => {
    const expectedId = "abc-123";
    const requestedUrl = `https://chatgpt.com/c/${expectedId}`;
    const runtime = makeRuntime([requestedUrl]);
    const page = makePage();
    const logger = makeLogger();
    const navigateToChatGPT = vi.fn(async () => {});
    const ensureNotBlocked = vi.fn(async () => {});
    const ensurePromptReady = vi.fn(async () => {});

    const result = await navigateToPromptReadyWithFallback(
      page,
      runtime,
      {
        url: requestedUrl,
        fallbackUrl: "https://chatgpt.com/",
        timeoutMs: 1_000,
        headless: false,
        logger,
      },
      { navigateToChatGPT, ensureNotBlocked, ensurePromptReady },
    );

    expect(result).toEqual({ usedFallback: false });
    expect(navigateToChatGPT).toHaveBeenCalledTimes(1);
    expect(navigateToChatGPT).toHaveBeenCalledWith(page, runtime, requestedUrl, logger);
    expect(ensurePromptReady).toHaveBeenCalledTimes(1);
  });

  test("throws and does NOT fall back when requested /c/{id} redirected to base", async () => {
    const expectedId = "abc-123";
    const requestedUrl = `https://chatgpt.com/c/${expectedId}`;
    const runtime = makeRuntime(["https://chatgpt.com/"]);
    const page = makePage();
    const logger = makeLogger();
    const navigateToChatGPT = vi.fn(async () => {});
    const ensureNotBlocked = vi.fn(async () => {});
    const ensurePromptReady = vi.fn(async () => {});

    await expect(
      navigateToPromptReadyWithFallback(
        page,
        runtime,
        {
          url: requestedUrl,
          fallbackUrl: "https://chatgpt.com/",
          timeoutMs: 1_000,
          headless: false,
          logger,
        },
        { navigateToChatGPT, ensureNotBlocked, ensurePromptReady },
      ),
    ).rejects.toBeInstanceOf(BrowserAutomationError);

    expect(navigateToChatGPT).toHaveBeenCalledTimes(1);
    expect(ensurePromptReady).toHaveBeenCalledTimes(1);
  });

  test("throws and does NOT fall back when ensurePromptReady fails on a /c/{id} URL", async () => {
    const expectedId = "abc-123";
    const requestedUrl = `https://chatgpt.com/c/${expectedId}`;
    const runtime = makeRuntime([requestedUrl]);
    const page = makePage();
    const logger = makeLogger();
    const navigateToChatGPT = vi.fn(async () => {});
    const ensureNotBlocked = vi.fn(async () => {});
    const ensurePromptReady = vi.fn(async () => {
      throw new Error("Prompt textarea did not appear before timeout");
    });

    await expect(
      navigateToPromptReadyWithFallback(
        page,
        runtime,
        {
          url: requestedUrl,
          fallbackUrl: "https://chatgpt.com/",
          timeoutMs: 1_000,
          headless: false,
          logger,
        },
        { navigateToChatGPT, ensureNotBlocked, ensurePromptReady },
      ),
    ).rejects.toThrow("Prompt textarea did not appear before timeout");

    expect(navigateToChatGPT).toHaveBeenCalledTimes(1);
    expect(ensurePromptReady).toHaveBeenCalledTimes(1);
  });

  test("preserves fallback behavior when requested URL has no /c/{id}", async () => {
    const requestedUrl = "https://chatgpt.com/";
    const fallbackUrl = "https://chatgpt.com/g/some-project";
    const runtime = makeRuntime([requestedUrl, fallbackUrl]);
    const page = makePage();
    const logger = makeLogger();
    const navigateToChatGPT = vi.fn(async () => {});
    const ensureNotBlocked = vi.fn(async () => {});
    let promptCalls = 0;
    const ensurePromptReady = vi.fn(async () => {
      promptCalls += 1;
      if (promptCalls === 1) {
        throw new Error("Prompt textarea did not appear before timeout");
      }
    });

    const result = await navigateToPromptReadyWithFallback(
      page,
      runtime,
      {
        url: requestedUrl,
        fallbackUrl,
        timeoutMs: 1_000,
        fallbackTimeoutMs: 2_000,
        headless: false,
        logger,
      },
      { navigateToChatGPT, ensureNotBlocked, ensurePromptReady },
    );

    expect(result).toEqual({ usedFallback: true });
    expect(navigateToChatGPT).toHaveBeenCalledTimes(2);
    expect(navigateToChatGPT.mock.calls[0][2]).toBe(requestedUrl);
    expect(navigateToChatGPT.mock.calls[1][2]).toBe(fallbackUrl);
    expect(ensurePromptReady).toHaveBeenCalledTimes(2);
  });
});
