import { AppError, HTTP_STATUS, logAppError, newRequestId, toApiError, toAppError } from "@/lib/errors";
import { ok } from "@/lib/validation/api";

/** Route-handler helpers: JSON envelope, status codes, Retry-After, no-store. */

const NO_STORE = "no-store";

export function jsonOk<T>(data: T, init: { status?: number; headers?: Record<string, string> } = {}) {
  return Response.json(ok(data), {
    status: init.status ?? 200,
    headers: { "Cache-Control": NO_STORE, ...init.headers },
  });
}

export function jsonError(e: unknown, requestId: string = newRequestId()): Response {
  const app = toAppError(e, requestId);
  logAppError(app, requestId);
  const headers: Record<string, string> = { "Cache-Control": NO_STORE };
  if (app.code === "RATE_LIMITED") headers["Retry-After"] = String(app.retryAfterSeconds ?? 60);
  return Response.json({ ok: false, error: toApiError(app, requestId) }, { status: HTTP_STATUS[app.code], headers });
}

export const MAX_JSON_BYTES = 32_768;

const tooLarge = () => new AppError("VALIDATION", "Request body is too large.");
const badJson = () => new AppError("VALIDATION", "Request body must be valid JSON.");

/**
 * Read at most `maxBytes` bytes of the body. Stops and cancels the stream as soon as the limit is passed,
 * so an oversized body is never buffered in full (SEC-015).
 */
async function readBodyLimited(req: Request, maxBytes: number): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Read a JSON body safely (SEC-015). Order: Content-Type (when required) -> declared Content-Length
 * (rejected before anything is read) -> bounded streaming read (counts bytes, not UTF-16 units) ->
 * strict UTF-8 decode -> JSON.parse. Every failure is VALIDATION 400, never a 500.
 */
export async function readJson(
  req: Request,
  opts: { maxBytes?: number; requireJsonContentType?: boolean } = {},
): Promise<unknown> {
  const maxBytes = opts.maxBytes ?? MAX_JSON_BYTES;
  if (opts.requireJsonContentType) {
    const ct = req.headers.get("content-type") ?? "";
    if (!/^application\/json(\s*;|$)/i.test(ct.trim())) {
      throw new AppError("VALIDATION", "Request body must be sent as application/json.");
    }
  }
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const t = declared.trim();
    if (!/^\d{1,12}$/.test(t)) throw badJson();
    if (Number(t) > maxBytes) throw tooLarge();
  }
  const bytes = await readBodyLimited(req, maxBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw badJson();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw badJson();
  }
}
