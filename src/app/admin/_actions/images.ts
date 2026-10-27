"use server";

import { runAction } from "@/lib/actions";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/data/server-admin";
import { AppError } from "@/lib/errors";
import { storageGuardMessage } from "@/lib/images/storage-errors";
import { createUploadUrlSchema } from "@/lib/validation/admin";
import { parseInput } from "@/lib/validation/common";

/**
 * Owner only. Path is `<folder>/<groupId>/<widthPx>.webp`: random group id, no user-supplied filename.
 * The first call omits groupId and gets a new one; calls 2 and 3 pass it back. Size caps are checked in the schema.
 */
export async function createUploadUrl(input: unknown) {
  return runAction(async () => {
    await requireRole("owner");
    const d = parseInput(createUploadUrlSchema, input);
    const groupId = d.groupId ?? crypto.randomUUID();
    const path = `${d.folder}/${groupId}/${d.widthPx}.webp`;
    const { data, error } = await createAdminClient().storage.from("public-media").createSignedUploadUrl(path);
    if (error || !data) {
      // The SEC-018 guard's own refusal ("public-media: ...", AccessDenied) is the owner's to fix, not ours.
      const guard = storageGuardMessage(error);
      if (guard) throw new AppError("VALIDATION", guard);
      throw new AppError("INTERNAL", undefined, { logDetail: `createSignedUploadUrl: ${error?.message ?? "no data"}`.slice(0, 200) });
    }
    return { groupId, path, uploadUrl: data.signedUrl, token: data.token };
  });
}
