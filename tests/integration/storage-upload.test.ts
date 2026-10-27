/**
 * BUG-016 / SEC-018 regression: photo upload through storage-api itself (not just pgTAP inserts).
 *
 * LOCAL STACK ONLY. Skipped unless a local Supabase stack answers (`supabase status -o env`), or
 * STORAGE_IT_API_URL + STORAGE_IT_SERVICE_ROLE_KEY are set. Refuses to run against anything but 127.0.0.1/localhost,
 * so it can never touch a hosted project. Set STORAGE_IT=0 to skip it on purpose.
 *
 * What it proves, using the same calls as the app (`createSignedUploadUrl` with the service key, then
 * `uploadToSignedUrl` with the token, as the admin browser does):
 *   1. storage-api's permission dry-run on the sign request passes the public_media_object_guard trigger (BUG-016);
 *   2. a small WebP is stored at 480/960/1600 px;
 *   3. a WebP over the per-width cap (but under the 300 KB bucket ceiling) is rejected by the trigger on the final
 *      row, and no object is left behind;
 *   4. a PNG is rejected (the bucket allow-list answers first; the trigger's MIME rule is the second layer and is
 *      covered by pgTAP in supabase/tests/database/rls.test.sql).
 * It cleans up every object it created.
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const APP_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUCKET = "public-media";
const CAPS = { 480: 40 * 1024, 960: 120 * 1024, 1600: 300 * 1024 } as const;

type Stack = { apiUrl: string; serviceKey: string } | { skip: string };

function isLocal(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function findLocalStack(): Stack {
  if (process.env.STORAGE_IT === "0") return { skip: "STORAGE_IT=0" };
  let apiUrl = process.env.STORAGE_IT_API_URL;
  let serviceKey = process.env.STORAGE_IT_SERVICE_ROLE_KEY;
  if (!apiUrl || !serviceKey) {
    try {
      const out = execSync("pnpm exec supabase status -o env", {
        cwd: APP_ROOT,
        timeout: 20_000,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
      const env = Object.fromEntries(
        out
          .split(/\r?\n/)
          .map((line) => /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim()))
          .filter((m): m is RegExpExecArray => m !== null)
          .map((m) => [m[1], m[2]]),
      );
      apiUrl = env.API_URL;
      serviceKey = env.SERVICE_ROLE_KEY;
    } catch {
      return { skip: "no local Supabase stack running" };
    }
  }
  if (!apiUrl || !serviceKey)
    return { skip: "local stack did not report API_URL / SERVICE_ROLE_KEY" };
  if (!isLocal(apiUrl)) return { skip: `refusing non-local API URL ${apiUrl}` };
  return { apiUrl, serviceKey };
}

/** Smallest valid WebP: 1x1 lossless (VP8L), 34 bytes. */
const TINY_WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");

/**
 * A WebP of exactly `total` bytes: the 1x1 VP8L image followed by an unknown "PADX" chunk, with the RIFF size fixed
 * up. Storage never reads the bytes, so this is only about the measured size; it still starts with RIFF....WEBP.
 */
function webpOfSize(total: number): Buffer {
  const image = TINY_WEBP.subarray(12); // the VP8L chunk, without the 12-byte RIFF/WEBP header
  const padLen = total - 12 - image.length - 8;
  if (padLen < 0 || padLen % 2 !== 0) throw new Error(`webpOfSize: cannot build ${total} bytes`);
  const pad = Buffer.alloc(8 + padLen);
  pad.write("PADX", 0, "ascii");
  pad.writeUInt32LE(padLen, 4);
  const out = Buffer.concat([TINY_WEBP.subarray(0, 12), image, pad]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

/** 1x1 PNG, 70 bytes. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const stack = findLocalStack();
const runIt = !("skip" in stack);

describe.skipIf(!runIt)(
  "Storage upload through storage-api (local stack, BUG-016 / SEC-018)",
  () => {
    let db: SupabaseClient;
    const created: string[] = [];
    const group = randomUUID();
    const path = (width: 480 | 960 | 1600, g = group) => `menu/${g}/${width}.webp`;

    async function signAndUpload(objectPath: string, body: Buffer, contentType: string) {
      const signed = await db.storage.from(BUCKET).createSignedUploadUrl(objectPath);
      if (signed.error) return { stage: "sign" as const, error: signed.error };
      created.push(objectPath);
      const up = await db.storage
        .from(BUCKET)
        .uploadToSignedUrl(objectPath, signed.data.token, body, { contentType });
      return { stage: "upload" as const, error: up.error };
    }

    async function exists(objectPath: string): Promise<{ size: number | null } | null> {
      const dir = objectPath.slice(0, objectPath.lastIndexOf("/"));
      const name = objectPath.slice(objectPath.lastIndexOf("/") + 1);
      const { data, error } = await db.storage.from(BUCKET).list(dir, { search: name });
      if (error) throw error;
      const hit = data.find((o) => o.name === name);
      return hit ? { size: (hit.metadata?.size as number | undefined) ?? null } : null;
    }

    beforeAll(() => {
      if ("skip" in stack) return;
      db = createClient(stack.apiUrl, stack.serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    });

    afterAll(async () => {
      if (!db || created.length === 0) return;
      await db.storage.from(BUCKET).remove(created);
    });

    it("signs an upload URL for every width (the permission dry-run passes the trigger)", async () => {
      for (const width of [480, 960, 1600] as const) {
        const signed = await db.storage
          .from(BUCKET)
          .createSignedUploadUrl(`menu/${randomUUID()}/${width}.webp`);
        expect(signed.error, `sign ${width}: ${signed.error?.message}`).toBeNull();
        expect(signed.data?.token).toBeTruthy();
      }
    });

    it("stores a small valid WebP at 480, 960 and 1600 px", async () => {
      for (const width of [480, 960, 1600] as const) {
        const body = webpOfSize(2000);
        const res = await signAndUpload(path(width), body, "image/webp");
        expect(res.error, `${res.stage} ${width}: ${res.error?.message}`).toBeNull();
        expect(await exists(path(width))).toEqual({ size: body.length });
      }
    });

    it("accepts a WebP exactly at the 480 px cap", async () => {
      const p = path(480, randomUUID());
      const res = await signAndUpload(p, webpOfSize(CAPS[480]), "image/webp");
      expect(res.error, `${res.stage}: ${res.error?.message}`).toBeNull();
      expect(await exists(p)).toEqual({ size: CAPS[480] });
    });

    it("rejects a WebP over the per-width cap on the real object and leaves nothing behind", async () => {
      const cases = [
        [480, CAPS[480] + 2],
        [960, CAPS[960] + 2],
      ] as const; // both under the 300 KB bucket ceiling, so the trigger (not the bucket) must refuse them
      for (const [width, bytes] of cases) {
        const p = path(width, randomUUID());
        const res = await signAndUpload(p, webpOfSize(bytes), "image/webp");
        expect(res.stage, `${width}: the sign step must pass, only the upload may fail`).toBe(
          "upload",
        );
        expect(res.error, `${width}: an over-cap upload must fail`).not.toBeNull();
        expect(res.error?.message).toMatch(
          /public-media: \d+ px image is \d+ bytes, the limit is \d+ bytes/,
        );
        // storage-api answers HTTP 400 with body {statusCode: "403", code: "AccessDenied"} (trigger raises 42501).
        // Before 20261023000001 the trigger raised 23514, which Storage turned into a 500 "database error".
        const err = res.error as { status?: number; statusCode?: string } | null;
        expect(err?.status).toBe(400);
        expect(err?.statusCode).toBe("403");
        expect(await exists(p)).toBeNull();
      }
    });

    it("rejects a PNG and leaves nothing behind", async () => {
      const p = path(480, randomUUID());
      const res = await signAndUpload(p, TINY_PNG, "image/png");
      expect(res.stage).toBe("upload");
      expect(res.error, "a PNG upload must fail").not.toBeNull();
      expect(await exists(p)).toBeNull();
    });
  },
);

if ("skip" in stack) {
  // Shows the reason in the Vitest output instead of silently passing.
  describe.skip(`Storage upload through storage-api: skipped (${stack.skip})`, () => {
    it("needs a local Supabase stack", () => {});
  });
}
