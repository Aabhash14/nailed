/**
 * Client-side image resize for admin uploads (api-contract.md, createUploadUrl):
 * one photo -> three WebP files at 480, 960 and 1600 px wide, quality about 0.72.
 * Server caps: 480 px max 40 KB, 960 px max 120 KB, 1600 px max 300 KB.
 */

export const TARGET_WIDTHS = [480, 960, 1600] as const;
export type TargetWidth = (typeof TARGET_WIDTHS)[number];

export const MAX_BYTES: Record<TargetWidth, number> = {
  480: 40 * 1024,
  960: 120 * 1024,
  1600: 300 * 1024,
};

export const START_QUALITY = 0.72;
const MIN_QUALITY = 0.4;
const QUALITY_STEP = 0.08;

/** Target size for a given source. Never upscales: a small photo is stored at its own width for larger variants. */
export function targetSize(
  srcW: number,
  srcH: number,
  width: TargetWidth,
): { width: number; height: number } {
  if (srcW <= 0 || srcH <= 0) throw new Error("Image has no size");
  const w = Math.min(width, srcW);
  return { width: w, height: Math.max(1, Math.round((srcH * w) / srcW)) };
}

export type ResizedImage = { widthPx: TargetWidth; blob: Blob; sizeBytes: number };

function canvasToWebp(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
}

/**
 * Resizes in the browser. Lowers quality step by step until the file is under the per-width cap.
 * Throws a readable Error when the browser cannot encode WebP or the picture cannot be made small enough.
 */
export async function resizeToWebpVariants(file: File): Promise<ResizedImage[]> {
  if (!file.type.startsWith("image/")) throw new Error("Please choose an image file.");
  const bitmap = await createImageBitmap(file);
  try {
    const out: ResizedImage[] = [];
    for (const widthPx of TARGET_WIDTHS) {
      const { width, height } = targetSize(bitmap.width, bitmap.height, widthPx);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("This browser cannot resize images.");
      ctx.drawImage(bitmap, 0, 0, width, height);
      let quality = START_QUALITY;
      let blob = await canvasToWebp(canvas, quality);
      if (!blob || blob.type !== "image/webp") {
        throw new Error("This browser cannot make WebP images. Try Chrome, Edge or Firefox.");
      }
      while (blob.size > MAX_BYTES[widthPx] && quality > MIN_QUALITY) {
        quality -= QUALITY_STEP;
        const next = await canvasToWebp(canvas, quality);
        if (!next) break;
        blob = next;
      }
      if (blob.size > MAX_BYTES[widthPx]) {
        throw new Error("This photo is too detailed to shrink enough. Try a simpler or smaller photo.");
      }
      out.push({ widthPx, blob, sizeBytes: blob.size });
    }
    return out;
  } finally {
    bitmap.close();
  }
}
