"use client";

import { useId, useState } from "react";
import { Banner } from "@/components/ui/feedback";
import { adminApi } from "@/data-access/admin";
import { resizeToWebpVariants } from "./image-resize";
import { uploadRefusalMessage } from "./upload-errors";

/**
 * Pick a photo, shrink it in the browser to three WebP widths (480 / 960 / 1600), upload each through
 * createUploadUrl, and hand back the GROUP path (`<folder>/<groupId>`) that upsertMenuItem / upsertProduct store.
 *
 * ASSUMPTION (check with backend-engineer): the signed `uploadUrl` accepts a plain HTTP PUT of the file body with
 * Content-Type image/webp. If Supabase needs its own client call (uploadToSignedUrl with `token`), only the
 * `putFile` function below changes.
 */
async function putFile(uploadUrl: string, blob: Blob): Promise<void> {
  if (uploadUrl.startsWith("mock://")) return; // development: nothing is stored anywhere
  const res = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "image/webp" }, body: blob });
  if (!res.ok) {
    // the storage guard explains a refusal in the JSON body (e.g. a variant over its size limit): show that reason
    const body: unknown = await res.json().catch(() => null);
    throw new Error(uploadRefusalMessage(body));
  }
}

export function ImageUpload({
  folder,
  label = "Photo",
  currentPath,
  onUploaded,
  mode = "replace",
  disabled = false,
  showPreview = true,
}: {
  folder: "menu" | "products" | "site";
  label?: string;
  currentPath?: string | null;
  /** `preview` is the 960 px WebP, for callers that show their own thumbnail (mode "add"). */
  onUploaded: (groupPath: string, preview?: Blob) => void;
  /**
   * "replace" (one photo, e.g. a menu item): shows its own preview of the chosen photo.
   * "add" (a list, e.g. product photos): the caller shows the photos; the picker is cleared after each upload so the
   * next photo can be chosen straight away.
   */
  mode?: "replace" | "add";
  disabled?: boolean;
  /** false when the caller shows the chosen photo itself (menu editor: one thumbnail slot, design review fix 1). */
  showPreview?: boolean;
}) {
  const id = useId();
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [message, setMessage] = useState<string>("");
  const [preview, setPreview] = useState<string | null>(null);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  // "replace" mode: the preview and the "uploaded" note describe the photo the form holds. When the caller drops that
  // photo (e.g. menu editor "Remove photo"), hide them; they come back if the caller restores it (Undo).
  const showUpload = mode !== "replace" || state !== "done" || currentPath === uploadedPath;

  async function onPick(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file) return;
    setState("working");
    setMessage("Shrinking and uploading your photo...");
    try {
      const variants = await resizeToWebpVariants(file);
      let groupId: string | undefined;
      for (const v of variants) {
        const res = await adminApi.createUploadUrl({
          folder,
          groupId,
          widthPx: v.widthPx,
          contentType: "image/webp",
          sizeBytes: v.sizeBytes,
        });
        if (!res.ok) throw new Error(res.error.fieldErrors?.sizeBytes?.[0] ?? res.error.message);
        groupId = res.data.groupId;
        await putFile(res.data.uploadUrl, v.blob);
      }
      if (!groupId) throw new Error("Upload failed");
      const mid = variants.find((v) => v.widthPx === 960)?.blob;
      if (mid && mode === "replace" && showPreview) {
        setPreview((old) => {
          if (old) URL.revokeObjectURL(old);
          return URL.createObjectURL(mid);
        });
      }
      setUploadedPath(`${folder}/${groupId}`);
      onUploaded(`${folder}/${groupId}`, mid);
      setState("done");
      // design review fix 15: the list renders ABOVE the picker. Copy is a working draft (T-052).
      setMessage(mode === "add" ? "Photo added to the list above. Describe it, then save." : "Photo uploaded. Save the form to keep it.");
      if (mode === "add") input.value = "";
    } catch (e) {
      setState("error");
      setMessage(e instanceof Error ? e.message : "Could not upload that photo.");
    }
  }

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-semibold">
        {label} <span className="text-ink-muted font-normal">(optional)</span>
      </label>
      <input
        id={id}
        type="file"
        accept="image/*"
        disabled={disabled || state === "working"}
        onChange={(e) => void onPick(e.currentTarget)}
        className="min-h-tap block w-full text-sm"
      />
      {preview && showUpload ? (
        // eslint-disable-next-line @next/next/no-img-element -- local blob preview
        <img src={preview} alt="Preview of the chosen photo" className="rounded-control h-24 w-24 object-cover" />
      ) : null}
      <div role="status" aria-live="polite">
        {message && showUpload ? (
          <Banner tone={state === "error" ? "danger" : state === "done" ? "success" : "info"}>{message}</Banner>
        ) : null}
      </div>
    </div>
  );
}
