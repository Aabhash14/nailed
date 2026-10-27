import type { Db } from "@/lib/data/types";
import { AppError } from "@/lib/errors";
import { IMAGE_SIZE_CAPS } from "@/lib/validation/admin";

/**
 * SEC-018 post-upload check. The signed upload URL is not bound to the size the browser declared and Storage
 * trusts the client's Content-Type, so before an image group is attached to a menu item or product the server
 * reads the three stored objects and checks, for each width:
 *   - it exists,
 *   - its real size is within the per-width cap (40 / 120 / 300 KB),
 *   - its bytes start with a WebP header ("RIFF" .... "WEBP").
 * A group that fails is deleted (all three widths) and the save is refused with VALIDATION on the image field.
 * Reads are bounded: the bucket itself refuses objects over 300 KB.
 */

export const IMAGE_WIDTHS = [480, 960, 1600] as const;
const BUCKET = "public-media";

export function isWebp(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
}

export type ImageCheck = { ok: true } | { ok: false; problem: string };

/** Check one stored group "<folder>/<groupId>". Never throws for bad content; returns the first problem. */
export async function checkImageGroup(db: Db, groupPath: string): Promise<ImageCheck> {
  for (const w of IMAGE_WIDTHS) {
    const path = `${groupPath}/${w}.webp`;
    let blob: Blob | null = null;
    try {
      const { data, error } = await db.storage.from(BUCKET).download(path);
      if (error) return { ok: false, problem: `${w}px missing` };
      blob = data;
    } catch {
      return { ok: false, problem: `${w}px unreadable` };
    }
    if (!blob) return { ok: false, problem: `${w}px missing` };
    if (blob.size > IMAGE_SIZE_CAPS[w]) return { ok: false, problem: `${w}px too large` };
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (!isWebp(head)) return { ok: false, problem: `${w}px not webp` };
  }
  return { ok: true };
}

/**
 * Verify every NEW group path (paths already stored on the row were checked when they were attached).
 * On failure: best-effort delete of the bad group, then VALIDATION on `field`.
 */
export async function assertImageGroupsValid(db: Db, groupPaths: string[], field: string): Promise<void> {
  for (const g of [...new Set(groupPaths)]) {
    const r = await checkImageGroup(db, g);
    if (!r.ok) {
      try {
        await db.storage.from(BUCKET).remove(IMAGE_WIDTHS.map((w) => `${g}/${w}.webp`));
      } catch {
        // cleanup is best effort
      }
      throw new AppError("VALIDATION", undefined, {
        fieldErrors: { [field]: ["The photo did not upload correctly (it must be a WebP within the size limit). Please upload it again."] },
        logDetail: `image check failed: ${r.problem}`,
      });
    }
  }
}
