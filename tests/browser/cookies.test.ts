import { beforeEach, describe, expect, test, vi } from "vitest";
import { syncCookies, ChromeCookieSyncError } from "../../src/browser/cookies.js";
import type { ChromeClient } from "../../src/browser/types.js";

const getCookies = vi.hoisted(() => vi.fn());
vi.mock("@steipete/sweet-cookie", () => ({ getCookies }));

const logger = vi.fn();

beforeEach(() => {
  getCookies.mockReset();
  logger.mockReset();
});

describe("syncCookies", () => {
  test("replays cookies via DevTools Network.setCookie", async () => {
    getCookies.mockResolvedValue({
      cookies: [
        {
          name: "sid",
          value: "abc",
          domain: "chatgpt.com",
          path: "/",
          secure: true,
          httpOnly: true,
        },
        {
          name: "csrftoken",
          value: "xyz",
          domain: "chatgpt.com",
          path: "/",
          secure: true,
          httpOnly: true,
        },
      ],
      warnings: [],
    });
    const setCookie = vi.fn().mockResolvedValue({ success: true });
    const applied = await syncCookies(
      { setCookie } as unknown as ChromeClient["Network"],
      "https://chatgpt.com",
      null,
      logger,
    );
    expect(applied).toBe(2);
    expect(setCookie).toHaveBeenCalledTimes(2);
  });

  test("throws when cookie load fails", async () => {
    getCookies.mockRejectedValue(new Error("boom"));
    await expect(
      syncCookies(
        { setCookie: vi.fn() } as unknown as ChromeClient["Network"],
        "https://chatgpt.com",
        null,
        logger,
      ),
    ).rejects.toBeInstanceOf(ChromeCookieSyncError);
  });

  test("surfaces macOS Keychain cookie read failures", async () => {
    getCookies.mockResolvedValue({
      cookies: [],
      warnings: ["Failed to read macOS Keychain (Chrome Safe Storage): exit 36"],
    });

    await expect(
      syncCookies(
        { setCookie: vi.fn() } as unknown as ChromeClient["Network"],
        "https://chatgpt.com",
        null,
        logger,
      ),
    ).rejects.toThrow("Chrome cookie sync could not read Chrome Safe Storage");
  });

  test("can opt into continuing on cookie failures", async () => {
    getCookies.mockRejectedValue(new Error("boom"));
    const applied = await syncCookies(
      { setCookie: vi.fn() } as unknown as ChromeClient["Network"],
      "https://chatgpt.com",
      null,
      logger,
      { allowErrors: true },
    );
    expect(applied).toBe(0);
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("Cookie sync failed (continuing with override)"),
    );
  });

  test("reports cookie failures through allow-errors callback", async () => {
    getCookies.mockResolvedValue({
      cookies: [],
      warnings: ["Failed to read macOS Keychain (Chrome Safe Storage): exit 36"],
    });
    const onError = vi.fn();

    const applied = await syncCookies(
      { setCookie: vi.fn() } as unknown as ChromeClient["Network"],
      "https://chatgpt.com",
      null,
      logger,
      { allowErrors: true, onError },
    );

    expect(applied).toBe(0);
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("Chrome cookie sync could not read Chrome Safe Storage"),
    );
  });

  test("retries once after a cookie read failure when wait is set", async () => {
    vi.useFakeTimers();
    getCookies.mockRejectedValueOnce(new Error("keychain locked")).mockResolvedValueOnce({
      cookies: [
        {
          name: "sid",
          value: "abc",
          domain: "chatgpt.com",
          path: "/",
          secure: true,
          httpOnly: true,
        },
      ],
      warnings: [],
    });
    const setCookie = vi.fn().mockResolvedValue({ success: true });

    const promise = syncCookies(
      { setCookie } as unknown as ChromeClient["Network"],
      "https://chatgpt.com",
      null,
      logger,
      { waitMs: 1000 },
    );
    await vi.advanceTimersByTimeAsync(1000);
    const applied = await promise;

    expect(applied).toBe(1);
    expect(getCookies).toHaveBeenCalledTimes(2);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("Cookie read failed"));
    vi.useRealTimers();
  });

  test("retries once after an empty cookie read when wait is set", async () => {
    vi.useFakeTimers();
    getCookies.mockResolvedValueOnce({ cookies: [], warnings: [] }).mockResolvedValueOnce({
      cookies: [
        {
          name: "sid",
          value: "abc",
          domain: "chatgpt.com",
          path: "/",
          secure: true,
          httpOnly: true,
        },
      ],
      warnings: [],
    });
    const setCookie = vi.fn().mockResolvedValue({ success: true });

    const promise = syncCookies(
      { setCookie } as unknown as ChromeClient["Network"],
      "https://chatgpt.com",
      null,
      logger,
      { waitMs: 500 },
    );
    await vi.advanceTimersByTimeAsync(500);
    const applied = await promise;

    expect(applied).toBe(1);
    expect(getCookies).toHaveBeenCalledTimes(2);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("No cookies found"));
    vi.useRealTimers();
  });
});
