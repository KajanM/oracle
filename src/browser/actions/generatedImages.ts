import type { ChromeClient, BrowserGeneratedImage, BrowserLogger } from "../types.js";
import { delay } from "../utils.js";

export function buildGeneratedImagesExpressionForTest(): string {
  return buildGeneratedImagesExpression();
}

export async function collectGeneratedImages(
  runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<BrowserGeneratedImage[]> {
  const { result } = await runtime.evaluate({
    expression: buildGeneratedImagesExpression(),
    awaitPromise: true,
    returnByValue: true,
  });
  const value = result.value as { images?: BrowserGeneratedImage[]; error?: string } | undefined;
  if (value?.error) {
    logger(`[browser] [image] generated image capture warning: ${value.error}`);
  }
  const images = Array.isArray(value?.images) ? value.images : [];
  if (images.length > 0) {
    logger(
      `[browser] [image] captured ${images.length} generated image${images.length === 1 ? "" : "s"}`,
    );
  }
  return images;
}

export async function countGeneratedImages(runtime: ChromeClient["Runtime"]): Promise<number> {
  const { result } = await runtime.evaluate({
    expression: `(() => Array.from(document.querySelectorAll('img[alt="Generated image"]')).filter((img) => {
      if (!(img instanceof HTMLImageElement)) return false;
      const rect = img.getBoundingClientRect();
      return img.src && rect.width > 0 && rect.height > 0;
    }).length)()`,
    returnByValue: true,
  });
  const value = result.value;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function waitForNewGeneratedImage(
  runtime: ChromeClient["Runtime"],
  baselineCount: number,
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<void> {
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  let lastCount = baselineCount;
  let stableCount = 0;
  while (Date.now() < deadline) {
    const count = await countGeneratedImages(runtime).catch(() => lastCount);
    if (count > baselineCount) {
      if (count === lastCount) {
        stableCount += 1;
      } else {
        stableCount = 0;
      }
      lastCount = count;
      if (stableCount >= 2) {
        logger(
          `[browser] [image] detected ${count - baselineCount} new generated image element(s)`,
        );
        return;
      }
    } else {
      lastCount = count;
    }
    await delay(750);
  }
  throw new Error("Timed out waiting for generated image elements.");
}

function buildGeneratedImagesExpression(): string {
  return `(async () => {
    const images = Array.from(document.querySelectorAll('img[alt="Generated image"]'))
      .filter((node) => node instanceof HTMLImageElement)
      .map((node) => /** @type {HTMLImageElement} */ (node))
      .filter((img) => {
        const rect = img.getBoundingClientRect();
        return img.src && rect.width > 0 && rect.height > 0;
      });
    const seen = new Set();
    const unique = images.filter((img) => {
      if (seen.has(img.src)) return false;
      seen.add(img.src);
      return true;
    }).slice(0, 8);

    const toBase64 = (blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('file-reader-failed'));
      reader.onloadend = () => {
        const dataUrl = String(reader.result || '');
        const comma = dataUrl.indexOf(',');
        resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
      };
      reader.readAsDataURL(blob);
    });

    const out = [];
    for (let index = 0; index < unique.length; index += 1) {
      const img = unique[index];
      const item = {
        src: img.src,
        alt: img.alt || undefined,
        width: img.naturalWidth || img.width || undefined,
        height: img.naturalHeight || img.height || undefined,
      };
      try {
        const response = await fetch(img.src, { credentials: 'include' });
        if (!response.ok) throw new Error('fetch-' + response.status);
        const blob = await response.blob();
        item.mimeType = blob.type || response.headers.get('content-type') || 'image/png';
        item.dataBase64 = await toBase64(blob);
      } catch (error) {
        item.error = error instanceof Error ? error.message : String(error);
      }
      out.push(item);
    }
    return { images: out };
  })()`;
}
