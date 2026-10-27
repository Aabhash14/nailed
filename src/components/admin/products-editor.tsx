"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { formatNpr } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Badge, Banner, EmptyState, Skeleton } from "@/components/ui/feedback";
import { CheckField, TextArea, TextField } from "@/components/ui/field";
import { StockBadge } from "@/components/shop/product-parts";
import { adminApi } from "@/data-access/admin";
import { paisaToRupees, rupeesToPaisa } from "@/components/format";
import type { AdminProduct, AdminProductVariant, UpsertProductInput } from "@/types/contract";
import { useAdminSession } from "./admin-shell";
import { DiscardConfirm, focusAndReveal, useReturnFocus, useRevealOnMount } from "./form-parts";
import { ImageUpload } from "./image-upload";
import {
  MAX_ALT_LENGTH,
  MAX_PRODUCT_PHOTOS,
  addPhoto,
  canMovePhoto,
  keptCount,
  keptDetailsSummary,
  detailsPatch,
  imagesField,
  movePhoto,
  photoErrors,
  photoNumber,
  photosFromProduct,
  rebaseListFields,
  removePhoto,
  restorePhoto,
  setPhotoAlt,
  type ListFields,
  type PhotoRow,
  type VariantFormRow,
} from "./product-form-logic";

export function ProductsEditor() {
  const { role } = useAdminSession();
  const owner = role === "owner";
  const [products, setProducts] = useState<AdminProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdminProduct | "new" | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocus = useReturnFocus();

  const load = useCallback(async () => {
    if (!owner) {
      setProducts([]); // stock is owner data; the server refuses staff
      return;
    }
    try {
      setProducts(await adminApi.getProducts());
    } catch {
      setError("Could not load products. Please try again.");
    }
  }, [owner]);
  useEffect(() => {
    void load();
  }, [load]);
  // Deep link from Stats > Stock alerts: /admin/products#product-<id> focuses that product once the list is in.
  const revealed = useRef(false);
  useEffect(() => {
    if (!products || revealed.current) return;
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (!hash.startsWith("product-")) return;
    revealed.current = true;
    focusAndReveal(document.getElementById(`${hash}-title`), "start");
  }, [products]);

  async function run(fn: () => Promise<{ ok: boolean; error?: { message: string } }>) {
    setError(null);
    const res = await fn();
    if (!res.ok) setError(res.error?.message ?? "That did not work.");
    await load();
  }

  function open(target: AdminProduct | "new", opener: HTMLElement) {
    returnFocus.remember(opener);
    setEditing(target);
  }

  if (!products && !error) {
    return (
      <div aria-busy="true" aria-label="Loading products" className="space-y-3">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  // BUG-007: the open form follows Publish / stock changes made in the list (see rebaseListFields)
  const latest = editing && editing !== "new" ? (products ?? []).find((p) => p.id === editing.id) : undefined;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 ref={headingRef} tabIndex={-1} className="font-display text-ink text-3xl tracking-[0.02em]">
          Products and stock
        </h1>
        {owner ? <Button onClick={(e) => open("new", e.currentTarget)}>Add a product</Button> : null}
      </div>
      {!owner ? <Banner tone="info">Products and stock are managed by the owner. Ask the owner if something needs changing.</Banner> : null}
      {error ? (
        <Banner tone="danger" live="alert">
          {error}
        </Banner>
      ) : null}

      {editing ? (
        <ProductForm
          // remount per product: otherwise switching Edit from one product to another keeps the first one's
          // photos and fields, and saving would write them onto the second
          key={editing === "new" ? "new" : editing.id}
          initial={editing === "new" ? null : editing}
          latest={latest}
          onCancel={() => {
            setEditing(null);
            returnFocus.restore(headingRef.current);
          }}
          onSaved={async () => {
            setEditing(null);
            await load();
            returnFocus.restore(headingRef.current);
          }}
        />
      ) : null}

      {(products ?? []).length === 0 && !error ? <EmptyState title="No products yet">Add the first one to start the shop.</EmptyState> : null}

      <ul className="space-y-4">
        {(products ?? []).map((p) => (
          <li key={p.id} id={`product-${p.id}`} className="bg-surface-raised border-line rounded-card shadow-card scroll-mt-4 space-y-3 border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 id={`product-${p.id}-title`} tabIndex={-1} className="font-display flex scroll-mt-4 items-center gap-2 text-xl">
                  {p.name} {p.isPublished ? <Badge tone="success">Published</Badge> : <Badge>Draft</Badge>}
                </h2>
                <p className="text-ink-muted text-sm">{formatNpr(p.price)} base price</p>
              </div>
              {owner ? (
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => void run(() => adminApi.setProductPublished({ productId: p.id, isPublished: !p.isPublished }))}>
                    {p.isPublished ? "Unpublish" : "Publish"}
                  </Button>
                  <Button variant="secondary" onClick={(e) => open(p, e.currentTarget)}>
                    Edit
                  </Button>
                </div>
              ) : null}
            </div>
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Stock for {p.name}</caption>
              <thead>
                <tr>
                  <th scope="col" className="py-1">
                    Size, colour
                  </th>
                  <th scope="col">Shown to guests as</th>
                  <th scope="col">Stock</th>
                </tr>
              </thead>
              <tbody>
                {p.variants.map((v) => (
                  <StockRow key={v.id} variant={v} owner={owner} onSave={(stock) => run(() => adminApi.setStock({ variantId: v.id, stock }))} />
                ))}
              </tbody>
            </table>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StockRow({ variant, owner, onSave }: { variant: AdminProductVariant; owner: boolean; onSave: (n: number) => Promise<void> }) {
  const [value, setValue] = useState(String(variant.stock));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setValue(String(variant.stock)), [variant.stock]);
  return (
    <tr className="border-line border-t">
      <th scope="row" className="py-2 font-semibold">
        {variant.size}, {variant.colour}
      </th>
      <td>{variant.stockState === "in_stock" ? "In stock" : <StockBadge state={variant.stockState} />}</td>
      <td>
        {owner ? (
          <form
            className="flex items-end gap-2 py-1"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              const n = Number(value);
              if (!Number.isInteger(n) || n < 0 || n > 9999) {
                setErr("0 to 9999");
                return;
              }
              setErr(null);
              void onSave(n);
            }}
          >
            <div className="w-24">
              <TextField label="Stock" required inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} error={err ?? undefined} />
            </div>
            <Button type="submit" variant="secondary">
              Save
            </Button>
          </form>
        ) : (
          variant.stock
        )}
      </td>
    </tr>
  );
}

const EMPTY_ROW: VariantFormRow = { size: "", colour: "", stock: "0", sku: "", override: "" };

function rowsFrom(p: AdminProduct | null): VariantFormRow[] {
  if (!p) return [{ ...EMPTY_ROW }];
  return p.variants.map((v) => ({
    id: v.id,
    size: v.size,
    colour: v.colour,
    stock: String(v.stock),
    sku: v.sku ?? "",
    override: v.price !== p.price ? paisaToRupees(v.price) : "",
  }));
}

/** Where focus goes after a photo button is pressed (BUG-009: the pressed button may be disabled, moved or replaced). */
type PhotoFocus = { path: string; want: "up" | "down" | "remove" | "undo" };

function ProductForm({
  initial,
  latest,
  onCancel,
  onSaved,
}: {
  initial: AdminProduct | null;
  /** The same product as stored now (after list actions), or undefined for a new product / when it is gone. */
  latest: AdminProduct | undefined;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const uid = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  useRevealOnMount(titleRef);
  const [name, setName] = useState(initial?.name ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [price, setPrice] = useState(initial ? paisaToRupees(initial.price) : "");
  const [published, setPublished] = useState(initial?.isPublished ?? false);
  const [fabric, setFabric] = useState(initial?.details.fabric ?? "");
  const [printMethod, setPrintMethod] = useState(initial?.details.printMethod ?? "");
  const [credit, setCredit] = useState(initial?.details.credit ?? "");
  // Start from the stored photos (each with its own alt text). An explicit `images` is the whole set (gap 3), so a
  // change always sends kept + new; storedPhotos is the baseline that decides whether to send `images` at all.
  const [storedPhotos] = useState<PhotoRow[]>(() => photosFromProduct(initial));
  const [photos, setPhotos] = useState<PhotoRow[]>(storedPhotos);
  const blobUrls = useRef<Set<string>>(new Set());
  useEffect(() => {
    const urls = blobUrls.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u)); // local previews of new uploads
  }, []);
  const keptDetails = keptDetailsSummary(initial?.details);
  const [rows, setRows] = useState<VariantFormRow[]>(() => rowsFrom(initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // BUG-007: `base` is the stored Published / stock the form last synced with. When the list changes them while the
  // form is open, untouched values follow (React "adjust state on prop change" pattern, no effect needed).
  const [base, setBase] = useState<ListFields | null>(initial);
  const [syncedFrom, setSyncedFrom] = useState<AdminProduct | undefined>(latest);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  if (latest !== syncedFrom) {
    setSyncedFrom(latest);
    if (latest && base) applyLatest(latest);
  }

  function applyLatest(fresh: ListFields): { published: boolean; rows: VariantFormRow[] } {
    const merged = rebaseListFields(base ?? fresh, fresh, { published, rows });
    setBase(fresh);
    if (merged.published !== published) setPublished(merged.published);
    if (merged.rows !== rows) setRows(merged.rows);
    if (merged.changed.length > 0) {
      // ASSUMPTION (copy, placeholder until T-052): a short note so the change in the form is not a surprise
      setSyncNote(`This form now shows the ${merged.changed.map((c) => (c === "published" ? "Published setting" : "stock")).join(" and ")} you changed in the list.`);
    }
    return merged;
  }

  // Unsaved-changes check for Cancel: compare with what is stored (Published / stock as last synced).
  const baseline = JSON.stringify({
    name: initial?.name ?? "",
    slug: initial?.slug ?? "",
    description: initial?.description ?? "",
    price: initial ? paisaToRupees(initial.price) : "",
    published: base?.isPublished ?? false,
    fabric: initial?.details.fabric ?? "",
    printMethod: initial?.details.printMethod ?? "",
    credit: initial?.details.credit ?? "",
    rows: initial && base ? rowsFrom({ ...initial, ...base }) : rowsFrom(null),
  });
  const current = JSON.stringify({ name, slug, description, price, published, fabric, printMethod, credit, rows });
  const dirty = current !== baseline || imagesField(storedPhotos, photos).images !== undefined || photos.some((p) => p.removed);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = "Enter a name";
    const p = rupeesToPaisa(price);
    if (p === null) errs.price = "Enter a price";
    Object.assign(errs, photoErrors(photos));
    rows.forEach((r, i) => {
      const stock = Number(r.stock);
      const ov = r.override.trim() ? rupeesToPaisa(r.override) : null;
      if (!r.size.trim() || !r.colour.trim() || !Number.isInteger(stock) || stock < 0 || stock > 9999 || (r.override.trim() && ov === null)) {
        errs[`r${i}`] = "Each row needs a size, a colour and a stock from 0 to 9999";
      }
    });
    if (rows.length === 0) errs.r0 = "Add at least one size";
    setErrors(errs);
    if (Object.keys(errs).length > 0 || p === null) return;
    setBusy(true);
    setFormError(null);

    // BUG-007: re-read the stored product right before saving, so a Publish or stock change made in the list (or in
    // another tab) since the form opened is not written back with old values.
    let finalPublished = published;
    let finalRows = rows;
    if (initial) {
      let fresh: AdminProduct | undefined;
      let readOk = true;
      try {
        fresh = (await adminApi.getProducts()).find((x) => x.id === initial.id);
      } catch {
        readOk = false; // could not re-check: save with what the form shows (already synced with the list)
      }
      if (readOk && !fresh) {
        setBusy(false);
        setFormError("This product no longer exists. It may have been deleted. Cancel to close this form.");
        return;
      }
      if (fresh) ({ published: finalPublished, rows: finalRows } = applyLatest(fresh));
    }

    const variants: UpsertProductInput["variants"] = finalRows.map((r) => ({
      id: r.id,
      size: r.size.trim(),
      colour: r.colour.trim(),
      sku: r.sku.trim() || undefined,
      stock: Number(r.stock),
      priceOverride: r.override.trim() ? rupeesToPaisa(r.override) : null,
    }));
    const res = await adminApi.upsertProduct({
      id: initial?.id,
      slug: slug.trim() || undefined,
      name: name.trim(),
      description: description.trim(), // always sent: an omitted description clears it on the server
      price: p,
      isPublished: finalPublished,
      // stored details first, then the three edited fields (cleared = null); gsm, sizeChartCm and the rest are kept
      details: detailsPatch(initial?.details, { fabric, printMethod, credit }),
      // omitted when the photos did not change (1.3.1: untouched); otherwise the FULL set, kept + new, in order
      ...imagesField(storedPhotos, photos),
      variants,
    });
    setBusy(false);
    if (!res.ok) {
      if (res.error.code === "NOT_FOUND") {
        setFormError("This product no longer exists. It may have been deleted. Cancel to close this form.");
        return;
      }
      const imageError = res.error.fieldErrors?.images?.join(", ");
      setFormError(imageError ? `${res.error.message} ${imageError}` : res.error.message);
      return;
    }
    await onSaved();
  }

  const upd = (i: number, patch: Partial<VariantFormRow>) => setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  // errors are keyed by position, so clear them when the order changes
  const clearPhotoErrors = () => setErrors((cur) => Object.fromEntries(Object.entries(cur).filter(([k]) => !k.startsWith("photo"))));

  // BUG-009: after Move / Remove / Undo, keep keyboard focus on the same photo
  const pendingFocus = useRef<PhotoFocus | null>(null);
  const photoBtnId = (path: string, what: string) => `${uid}-${path}-${what}`;
  useEffect(() => {
    const p = pendingFocus.current;
    if (!p) return;
    pendingFocus.current = null;
    const idx = photos.findIndex((r) => r.path === p.path);
    if (idx < 0) return;
    let want: string = p.want;
    if (want === "up" || want === "down") {
      const dir = want === "up" ? -1 : 1;
      // the pressed button can be disabled at the new position (top or bottom): use the other direction, then the text
      if (!canMovePhoto(photos, idx, dir)) want = canMovePhoto(photos, idx, dir === -1 ? 1 : -1) ? (want === "up" ? "down" : "up") : "alt";
    }
    if (want === "alt") document.getElementById(photoBtnId(p.path, "row"))?.querySelector("input")?.focus();
    else document.getElementById(photoBtnId(p.path, want))?.focus();
    // photoBtnId only depends on uid, which never changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos]);

  function photoAction(path: string, want: PhotoFocus["want"], change: (cur: PhotoRow[]) => PhotoRow[]) {
    clearPhotoErrors();
    pendingFocus.current = { path, want };
    setPhotos(change);
  }

  const full = keptCount(photos) >= MAX_PRODUCT_PHOTOS;
  const fullHintId = `${uid}-full`;

  return (
    <form onSubmit={submit} noValidate aria-labelledby={`${uid}-title`} className="border-primary bg-surface-raised rounded-card shadow-card scroll-mt-4 space-y-4 border-2 p-4">
      <h2 id={`${uid}-title`} ref={titleRef} tabIndex={-1} className="font-display scroll-mt-4 text-2xl">
        {initial ? `Edit ${initial.name}` : "Add a product"}
      </h2>
      {formError ? (
        <Banner tone="danger" live="alert">
          {formError}
        </Banner>
      ) : null}
      <div role="status" aria-live="polite">
        {syncNote ? <Banner tone="info">{syncNote}</Banner> : null}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
        <TextField label="Web address ending" hint="Leave empty to make one from the name." value={slug} onChange={(e) => setSlug(e.target.value)} />
        <TextField label="Base price (Rs.)" required inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} error={errors.price} />
      </div>
      <TextArea label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField label="Fabric" value={fabric} onChange={(e) => setFabric(e.target.value)} />
        <TextField label="Print method" value={printMethod} onChange={(e) => setPrintMethod(e.target.value)} />
        <TextField label="Design credit" value={credit} onChange={(e) => setCredit(e.target.value)} />
      </div>
      {keptDetails ? (
        // ASSUMPTION (ux-ui-designer): the form has no fields for these yet, so say they are kept rather than hide them
        <p className="text-ink-muted text-sm">Also saved for this product and kept as they are: {keptDetails}.</p>
      ) : null}

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Sizes and stock</legend>
        {rows.map((r, i) => (
          <div key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_6rem_8rem_auto]">
            <TextField label="Size" required value={r.size} onChange={(e) => upd(i, { size: e.target.value })} />
            <TextField label="Colour" required value={r.colour} onChange={(e) => upd(i, { colour: e.target.value })} />
            <TextField label="Stock" required inputMode="numeric" value={r.stock} onChange={(e) => upd(i, { stock: e.target.value })} />
            <TextField label="Own price (Rs.)" inputMode="decimal" value={r.override} onChange={(e) => upd(i, { override: e.target.value })} />
            <Button variant="ghost" onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))} aria-label={`Remove row ${i + 1}`}>
              Remove
            </Button>
            {errors[`r${i}`] ? <p className="text-danger text-sm font-semibold sm:col-span-5">{errors[`r${i}`]}</p> : null}
          </div>
        ))}
        <Button variant="secondary" onClick={() => setRows((cur) => [...cur, { ...EMPTY_ROW }])}>
          Add a size
        </Button>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Photos</legend>
        <p className="text-ink-muted text-sm">
          The first photo is the main one in the shop. Up to {MAX_PRODUCT_PHOTOS}. A removed photo stays here with an Undo
          button until you save.
        </p>
        {photos.length === 0 ? <p className="text-ink-muted text-sm">No photos yet.</p> : null}
        {photos.length > 0 ? (
          <ol className="space-y-3" aria-label="Product photos, in shop order">
            {photos.map((ph, i) => {
              const n = photoNumber(photos, i);
              return ph.removed ? (
                // design review T-048 fix 3: staged removal, in place, three signals (dimmed image, dashed border, text)
                <li key={ph.path} className="border-danger rounded-control flex flex-wrap items-center gap-3 border-2 border-dashed p-3">
                  <PhotoThumb row={ph} dimmed />
                  <div className="min-w-0 flex-1 space-y-1">
                    <Badge tone="danger">Removed on save</Badge>
                    <p id={`${uid}-${ph.path}-gone`} className="text-sm">
                      This photo{ph.alt.trim() ? ` ("${ph.alt.trim()}")` : ""} will be removed when you save.
                    </p>
                    {full ? (
                      <p id={fullHintId} className="text-ink-muted text-sm">
                        Remove another photo first.
                      </p>
                    ) : null}
                  </div>
                  <Button
                    id={photoBtnId(ph.path, "undo")}
                    variant="secondary"
                    // aria-disabled, not disabled: focus can land here after Remove even when the list is full
                    aria-disabled={full || undefined}
                    aria-describedby={`${uid}-${ph.path}-gone${full ? ` ${fullHintId}` : ""}`}
                    className={full ? "cursor-not-allowed opacity-50" : ""}
                    onClick={() => {
                      if (full) return;
                      photoAction(ph.path, "remove", (cur) => restorePhoto(cur, cur.findIndex((r) => r.path === ph.path)));
                    }}
                  >
                    Undo
                  </Button>
                </li>
              ) : (
                <li key={ph.path} id={photoBtnId(ph.path, "row")} className="border-line rounded-control grid gap-3 border p-3 sm:grid-cols-[6rem_1fr]">
                  <PhotoThumb row={ph} />
                  <div className="space-y-2">
                    <TextField
                      label={`Photo ${n} description (alt text)`}
                      required
                      maxLength={MAX_ALT_LENGTH}
                      value={ph.alt}
                      onChange={(e) => setPhotos((cur) => setPhotoAlt(cur, i, e.target.value))}
                      error={errors[`photo${i}`]}
                      hint={n === 1 ? "Main photo." : ph.isNew ? "New, not saved yet." : undefined}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        id={photoBtnId(ph.path, "up")}
                        variant="secondary"
                        disabled={!canMovePhoto(photos, i, -1)}
                        aria-label={`Move photo ${n} up`}
                        onClick={() => photoAction(ph.path, "up", (cur) => movePhoto(cur, cur.findIndex((r) => r.path === ph.path), -1))}
                      >
                        Move up
                      </Button>
                      <Button
                        id={photoBtnId(ph.path, "down")}
                        variant="secondary"
                        disabled={!canMovePhoto(photos, i, 1)}
                        aria-label={`Move photo ${n} down`}
                        onClick={() => photoAction(ph.path, "down", (cur) => movePhoto(cur, cur.findIndex((r) => r.path === ph.path), 1))}
                      >
                        Move down
                      </Button>
                      <Button
                        id={photoBtnId(ph.path, "remove")}
                        variant="ghost"
                        aria-label={`Remove photo ${n}`}
                        onClick={() => photoAction(ph.path, "undo", (cur) => removePhoto(cur, cur.findIndex((r) => r.path === ph.path)))}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : null}
        {!full ? (
          <ImageUpload
            folder="products"
            label="Add a photo"
            mode="add"
            onUploaded={(path, preview) => {
              const url = preview ? URL.createObjectURL(preview) : null;
              if (url) blobUrls.current.add(url);
              setPhotos((cur) => addPhoto(cur, path, url));
            }}
          />
        ) : (
          <p className="text-ink-muted text-sm">This product has the most photos allowed. Remove one to add another.</p>
        )}
      </fieldset>

      <CheckField label="Published (visible in the shop)" checked={published} onChange={(e) => setPublished(e.target.checked)} />

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving..." : "Save product"}
        </Button>
        <Button ref={cancelRef} variant="secondary" aria-expanded={confirmDiscard || undefined} onClick={() => (dirty ? setConfirmDiscard(true) : onCancel())}>
          Cancel
        </Button>
        {confirmDiscard ? (
          <DiscardConfirm
            onDiscard={onCancel}
            onKeep={() => {
              setConfirmDiscard(false);
              requestAnimationFrame(() => cancelRef.current?.focus());
            }}
          />
        ) : null}
      </div>
    </form>
  );
}

function PhotoThumb({ row, dimmed = false }: { row: PhotoRow; dimmed?: boolean }) {
  // the dimming applies to the image only, never to the text next to it (design review section 2)
  const dim = dimmed ? "opacity-50" : "";
  return row.previewUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- stored pre-sized WebP or a local blob preview (images.unoptimized)
    <img src={row.previewUrl} alt="" className={`rounded-control h-24 w-24 shrink-0 object-cover ${dim}`} />
  ) : (
    <div aria-hidden="true" className={`photo-placeholder rounded-control text-ink-muted flex h-24 w-24 shrink-0 items-end p-1 text-xs ${dim}`}>
      <span className="relative">New photo</span>
    </div>
  );
}
