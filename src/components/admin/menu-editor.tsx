"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { formatNpr } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Badge, Banner, EmptyState, Skeleton } from "@/components/ui/feedback";
import { CheckField, SelectField, TextArea, TextField } from "@/components/ui/field";
import { DietMark } from "@/components/menu/menu-parts";
import { adminApi } from "@/data-access/admin";
import { paisaToRupees, rupeesToPaisa } from "@/components/format";
import type {
  AdminMenuCategory,
  AdminMenuItem,
  Diet,
  MenuLanguage,
  MenuTag,
  MenuVariant,
  UpsertMenuItemInput,
  VariantTranslations,
} from "@/types/contract";
import { useAdminSession } from "./admin-shell";
import { DiscardConfirm, useReturnFocus, useRevealOnMount } from "./form-parts";
import { ImageUpload } from "./image-upload";
import {
  CategoryTranslations,
  ItemTranslationsFields,
  ItemTranslationsReadOnly,
} from "./translations-fields";
import {
  itemDraft,
  itemFromDraft,
  mapServerTranslationErrors,
  translationsPatch,
  variantDraft,
  variantFromDraft,
  type NameTrDraft,
  type TrErrors,
} from "./translations-logic";

const TAGS: { value: MenuTag; label: string }[] = [
  { value: "spicy", label: "Spicy" },
  { value: "new", label: "New" },
  { value: "bestseller", label: "Bestseller" },
  { value: "chef_pick", label: "Chef's pick" },
];
const KINDS: MenuVariant["kind"][] = ["size", "milk", "addon", "temperature"];

export function MenuEditor() {
  const { role } = useAdminSession();
  const owner = role === "owner";
  const [cats, setCats] = useState<AdminMenuCategory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ item: AdminMenuItem | null; categoryId: string } | null>(
    null,
  );
  const [newCat, setNewCat] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocus = useReturnFocus();

  const load = useCallback(async () => {
    try {
      setCats(await adminApi.getMenu());
    } catch {
      setError("Could not load the menu. Please try again.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (fn: () => Promise<{ ok: boolean; error?: { message: string } }>) => {
      setError(null);
      const res = await fn();
      if (!res.ok) setError(res.error?.message ?? "That did not work.");
      await load();
    },
    [load],
  );

  if (!cats && !error) {
    return (
      <div aria-busy="true" aria-label="Loading the menu" className="space-y-3">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  function open(target: { item: AdminMenuItem | null; categoryId: string }, opener: HTMLElement) {
    returnFocus.remember(opener);
    setNotice(null);
    setEditing(target);
  }

  // the stored copy of the item being edited (price changes made in the list follow into the form)
  const latestItem = editing?.item
    ? (cats ?? []).flatMap((c) => c.items).find((i) => i.id === editing.item!.id)
    : undefined;

  return (
    <div className="space-y-6">
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="font-display text-ink text-3xl tracking-[0.02em]"
      >
        Menu
      </h1>
      <p className="text-ink-muted">
        Tap <strong>Mark sold out</strong> when something runs out. Guests see the change within a
        few seconds.
      </p>
      {error ? (
        <Banner tone="danger" live="alert">
          {error}
        </Banner>
      ) : null}
      <div role="status" aria-live="polite">
        {notice ? <Banner tone="info">{notice}</Banner> : null}
      </div>

      {editing ? (
        <ItemForm
          // remount per item: otherwise switching Edit to another item keeps the first item's fields and photo
          key={editing.item?.id ?? `new-${editing.categoryId}`}
          cats={cats ?? []}
          initial={editing.item}
          latest={latestItem}
          categoryId={editing.categoryId}
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

      {(cats ?? []).length === 0 && !error ? (
        <EmptyState title="No menu yet">
          {owner
            ? "Add a category below, then add items to it."
            : "The owner needs to add the menu first."}
        </EmptyState>
      ) : null}

      {(cats ?? []).map((c) => (
        <section key={c.id} aria-labelledby={`c-${c.id}`} className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id={`c-${c.id}`} className="font-display text-2xl">
              {c.name} {!c.isVisible ? <Badge>Hidden</Badge> : null}
            </h2>
            {owner ? (
              <Button
                variant="secondary"
                onClick={(e) => open({ item: null, categoryId: c.id }, e.currentTarget)}
              >
                Add item to {c.name}
              </Button>
            ) : null}
          </div>
          <CategoryTranslations
            category={c}
            owner={owner}
            onSave={async (translations) => {
              setError(null);
              // name, slug and visibility are sent as they are, so only the translations change
              const res = await adminApi.upsertCategory({
                id: c.id,
                name: c.name,
                slug: c.slug,
                isVisible: c.isVisible,
                translations,
              });
              await load();
              return res.ok
                ? { ok: true }
                : { ok: false, message: res.error.message, fieldErrors: res.error.fieldErrors };
            }}
          />
          {c.items.length === 0 ? (
            <p className="text-ink-muted">No items in this category.</p>
          ) : null}
          {/* S25-11: one card per category, hairlines between the items */}
          {c.items.length > 0 ? (
            <ul className="border-line bg-surface-raised rounded-card shadow-card divide-line divide-y border">
              {c.items.map((it) => (
                <ItemRow
                  key={it.id}
                  item={it}
                  owner={owner}
                  onToggle={() =>
                    run(() => adminApi.toggleSoldOut({ itemId: it.id, isSoldOut: !it.isSoldOut }))
                  }
                  onToggleVariant={(v) =>
                    run(() =>
                      adminApi.toggleVariantSoldOut({ variantId: v.id, isSoldOut: !v.isSoldOut }),
                    )
                  }
                  onPrice={(price) => run(() => adminApi.setItemPrice({ itemId: it.id, price }))}
                  onEdit={(el) => open({ item: it, categoryId: c.id }, el)}
                  onDelete={async () => {
                    // BUG-010: an open form for this item would re-create it on Save, so close it with the delete
                    if (editing?.item?.id === it.id) {
                      setEditing(null);
                      setNotice(`${it.name} was deleted, so its edit form was closed.`);
                    }
                    await run(() => adminApi.deleteMenuItem({ itemId: it.id }));
                    requestAnimationFrame(() => headingRef.current?.focus()); // its row (and the focused button) is gone
                  }}
                />
              ))}
            </ul>
          ) : null}
        </section>
      ))}

      {owner ? (
        <form
          className="border-line rounded-control flex flex-wrap items-end gap-3 border p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!newCat.trim()) return;
            await run(() => adminApi.upsertCategory({ name: newCat.trim(), isVisible: true }));
            setNewCat("");
          }}
        >
          <div className="min-w-48 flex-1">
            <TextField
              label="New category name"
              required
              value={newCat}
              onChange={(e) => setNewCat(e.target.value)}
            />
          </div>
          <Button type="submit">Add category</Button>
        </form>
      ) : null}
    </div>
  );
}

function ItemRow({
  item,
  owner,
  onToggle,
  onToggleVariant,
  onPrice,
  onEdit,
  onDelete,
}: {
  item: AdminMenuItem;
  owner: boolean;
  onToggle: () => Promise<void>;
  onToggleVariant: (v: MenuVariant) => Promise<void>;
  onPrice: (p: number) => Promise<void>;
  onEdit: (opener: HTMLElement) => void;
  onDelete: () => Promise<void>;
}) {
  const [price, setPrice] = useState(paisaToRupees(item.price));
  const [priceError, setPriceError] = useState<string | null>(null);
  const [priceOpen, setPriceOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const priceFormId = useId();
  const priceFormRef = useRef<HTMLFormElement>(null);
  const changePriceRef = useRef<HTMLButtonElement>(null);
  useEffect(() => setPrice(paisaToRupees(item.price)), [item.price]);
  // "Change price" opens the field in place and moves focus into it
  useEffect(() => {
    if (priceOpen) priceFormRef.current?.querySelector("input")?.focus();
  }, [priceOpen]);

  function closePrice() {
    setPriceOpen(false);
    setPriceError(null);
    setPrice(paisaToRupees(item.price));
    requestAnimationFrame(() => changePriceRef.current?.focus());
  }

  // R24-6 (layout D): two columns, the sold-out toggle always top-right so the thumb learns its place; the name in
  // Mukta 600; the price once; owner actions as one line of ghost buttons. "Mark sold out" is the only bordered button.
  // S25-11: rows sit in one card per category. From md a plain row is one line: name, owner actions, toggle. While the
  // price field or the delete confirmation is open, the owner actions take their own line so the name keeps its width.
  const actionsOwnLine = priceOpen || confirmDelete;
  return (
    <li
      className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 p-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center md:py-2 ${item.isSoldOut ? "hatch-soldout" : ""}`}
    >
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-lg leading-snug font-semibold">
          <DietMark diet={item.diet} />
          <span className="min-w-0 wrap-anywhere">{item.name}</span>
          {!item.isVisible ? <Badge>Hidden</Badge> : null}
          {item.isSoldOut ? <Badge tone="danger">Sold out</Badge> : null}
        </p>
        <p className="text-ink-muted text-sm whitespace-nowrap tabular-nums">
          {formatNpr(item.price)}
        </p>
      </div>
      <Button
        className="self-start md:col-start-3 md:row-start-1 md:self-center"
        variant={item.isSoldOut ? "primary" : "secondary"}
        aria-pressed={item.isSoldOut}
        onClick={() => void onToggle()}
      >
        {item.isSoldOut ? "Back in stock" : "Mark sold out"}
      </Button>

      {item.variants.length > 0 ? (
        <ul
          className="col-span-2 flex flex-wrap gap-2 md:col-span-3"
          aria-label={`Options for ${item.name}`}
        >
          {item.variants.map((v) => (
            <li key={v.id}>
              {/* R24-10: short labels that fit one line on a phone. Worded so they never contain "Mark sold out" or
                  "Back in stock" (the item toggle's names, which the e2e selectors match as substrings) */}
              <Button
                variant={v.isSoldOut ? "primary" : "secondary"}
                className="text-sm"
                aria-pressed={v.isSoldOut}
                onClick={() => void onToggleVariant(v)}
              >
                {v.isSoldOut ? `${v.label} sold out · Restore` : `Mark ${v.label} sold out`}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Staff cannot edit translations (owner only, server-enforced): they can still read what guests see */}
      {!owner ? (
        <div className="col-span-2 md:col-span-3">
          <ItemTranslationsReadOnly translations={item.translations} variants={item.variants} />
        </div>
      ) : null}

      {owner ? (
        <div
          className={`col-span-2 space-y-2 ${actionsOwnLine ? "md:col-span-3" : "md:col-span-1 md:col-start-2 md:row-start-1"}`}
        >
          {priceOpen ? (
            <form
              id={priceFormId}
              ref={priceFormRef}
              aria-label={`Change the price of ${item.name}`}
              className="flex flex-wrap items-end gap-2"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  closePrice();
                }
              }}
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                const p = rupeesToPaisa(price);
                if (p === null || p > 1_000_000) {
                  setPriceError("Enter a price up to Rs. 10,000");
                  return;
                }
                setPriceError(null);
                void onPrice(p).then(closePrice);
              }}
            >
              <div className="w-32">
                <TextField
                  label="Price (Rs.)"
                  required
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  error={priceError ?? undefined}
                />
              </div>
              <Button type="submit">Save price</Button>
              <Button variant="ghost" onClick={closePrice}>
                Cancel
              </Button>
            </form>
          ) : null}
          <div className="-ml-3 flex flex-wrap items-center gap-x-1">
            <Button
              ref={changePriceRef}
              variant="ghost"
              className="px-3"
              aria-expanded={priceOpen}
              aria-controls={priceOpen ? priceFormId : undefined}
              onClick={() => (priceOpen ? closePrice() : setPriceOpen(true))}
            >
              Change price
            </Button>
            <Button variant="ghost" className="px-3" onClick={(e) => onEdit(e.currentTarget)}>
              Edit details
            </Button>
            {!confirmDelete ? (
              <Button variant="ghost" className="px-3" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            ) : (
              <span className="flex flex-wrap items-center gap-2 pl-3">
                <span className="font-semibold">Delete {item.name}?</span>
                <Button variant="danger" onClick={() => void onDelete()}>
                  Yes, delete
                </Button>
                <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
                  No
                </Button>
              </span>
            )}
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** One option row in the form. `tr` = its label in each language; `trStored` = what the server has (to send only changes). */
type VariantRow = {
  id?: string;
  kind: MenuVariant["kind"];
  label: string;
  delta: string;
  tr: NameTrDraft;
  trStored?: VariantTranslations;
};

function ItemForm({
  cats,
  initial,
  latest,
  categoryId,
  onCancel,
  onSaved,
}: {
  cats: AdminMenuCategory[];
  initial: AdminMenuItem | null;
  /** The stored copy of this item now (after list actions such as Save price), or undefined. */
  latest: AdminMenuItem | undefined;
  categoryId: string;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const uid = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  useRevealOnMount(titleRef);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [price, setPrice] = useState(initial ? paisaToRupees(initial.price) : "");
  const [cat, setCat] = useState(initial?.categoryId ?? categoryId);
  const [diet, setDiet] = useState<Diet>(initial?.diet ?? "veg");
  const [tags, setTags] = useState<MenuTag[]>(initial?.tags ?? []);
  const [visible, setVisible] = useState(initial?.isVisible ?? true);
  const [imagePath, setImagePath] = useState<string | null>(initial?.imagePath ?? null);
  // "Remove photo" is staged like the product editor: the photo goes on Save (imagePath: null), Cancel discards.
  // removedPath holds the photo the owner removed so Undo can put it back before saving.
  const [removedPath, setRemovedPath] = useState<string | null>(null);
  // the latest upload in this form, with a local preview (it takes the saved photo's place until Save)
  const [upload, setUpload] = useState<{ path: string; url: string } | null>(null);
  const uploadUrl = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (uploadUrl.current) URL.revokeObjectURL(uploadUrl.current);
    },
    [],
  );
  const focusAfter = useRef<"remove" | "undo" | null>(null);
  useEffect(() => {
    // keyboard users: the button they pressed is replaced, so move focus to its counterpart
    if (focusAfter.current) document.getElementById(`${uid}-${focusAfter.current}`)?.focus();
    focusAfter.current = null;
  }, [removedPath, uid]);
  const [variants, setVariants] = useState<VariantRow[]>(
    (initial?.variants ?? []).map((v) => ({
      id: v.id,
      kind: v.kind,
      label: v.label,
      delta: paisaToRupees(v.priceDelta),
      tr: variantDraft(v.translations),
      trStored: v.translations,
    })),
  );
  // Translations (contract 1.4.0): collapsed by default; sent only when they changed
  const [itemTr, setItemTr] = useState(() => itemDraft(initial?.translations));
  const [trOpen, setTrOpen] = useState(false);
  const [trErrors, setTrErrors] = useState<TrErrors>({});
  const [optTrErrors, setOptTrErrors] = useState<Record<number, TrErrors>>({});
  const [trGeneral, setTrGeneral] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Same idea as BUG-007 for the menu: "Save price" in the list while this form is open. An untouched price follows
  // the stored one, so Save item does not write the old price back.
  const [basePrice, setBasePrice] = useState(initial?.price ?? null);
  const [syncedFrom, setSyncedFrom] = useState(latest);
  if (latest !== syncedFrom) {
    setSyncedFrom(latest);
    if (latest && basePrice !== null && latest.price !== basePrice) {
      if (price.trim() === paisaToRupees(basePrice)) setPrice(paisaToRupees(latest.price));
      setBasePrice(latest.price);
    }
  }

  const baseline = JSON.stringify({
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    price: basePrice === null ? "" : paisaToRupees(basePrice),
    cat: initial?.categoryId ?? categoryId,
    diet: initial?.diet ?? "veg",
    tags: initial?.tags ?? [],
    visible: initial?.isVisible ?? true,
    imagePath: initial?.imagePath ?? null,
    variants: (initial?.variants ?? []).map((v) => ({
      id: v.id,
      kind: v.kind,
      label: v.label,
      delta: paisaToRupees(v.priceDelta),
      tr: variantDraft(v.translations),
      trStored: v.translations,
    })),
    itemTr: itemDraft(initial?.translations),
  });
  const dirty =
    JSON.stringify({
      name,
      description,
      price,
      cat,
      diet,
      tags,
      visible,
      imagePath,
      variants,
      itemTr,
    }) !== baseline;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim() || name.length > 80) errs.name = "Enter a name (up to 80 characters)";
    if (description.length > 240) errs.description = "Up to 240 characters";
    const p = rupeesToPaisa(price);
    if (p === null || p > 1_000_000) errs.price = "Enter a price up to Rs. 10,000";
    const vs: UpsertMenuItemInput["variants"] = [];
    const optErrs: Record<number, TrErrors> = {};
    variants.forEach((v, i) => {
      const d = rupeesToPaisa(v.delta || "0");
      const vt = variantFromDraft(v.tr);
      if (Object.keys(vt.errors).length > 0) optErrs[i] = vt.errors;
      // 1.4.0: omitted = unchanged for a stored option, none for a new one; sent only when it changed
      const trPatch = translationsPatch(v.trStored, vt.value);
      if (!v.label.trim() || d === null)
        errs[`v${i}`] = "Give each option a name and a valid extra price";
      else
        vs.push({
          id: v.id,
          kind: v.kind,
          label: v.label.trim(),
          priceDelta: d,
          ...(trPatch !== undefined ? { translations: trPatch } : {}),
        });
    });
    const it = itemFromDraft(itemTr);
    setErrors(errs);
    setTrErrors(it.errors);
    setOptTrErrors(optErrs);
    setTrGeneral([]);
    const trBad = Object.keys(it.errors).length > 0 || Object.keys(optErrs).length > 0;
    if (trBad) {
      setTrOpen(true); // never leave a problem inside a closed section
      if (Object.keys(errs).length === 0) setFormError("Please check the translations.");
    }
    if (Object.keys(errs).length > 0 || p === null || trBad) return;
    const itemTrPatch = translationsPatch(initial?.translations, it.value);
    setBusy(true);
    setFormError(null);
    const res = await adminApi.upsertMenuItem({
      id: initial?.id,
      categoryId: cat,
      name: name.trim(),
      description: description.trim() || null,
      price: p,
      diet,
      tags,
      isVisible: visible,
      // 1.3.1: omitted = keep the stored photo, null = remove it, a path = replace it. Sent only when it changed:
      // a new upload sends the new path, "Remove photo" sends null, an untouched photo is omitted.
      ...(imagePath !== (initial?.imagePath ?? null) ? { imagePath } : {}),
      // 1.4.0: omitted = keep the stored translations; an object replaces the whole set (every language is in it)
      ...(itemTrPatch !== undefined ? { translations: itemTrPatch } : {}),
      variants: vs,
    });
    setBusy(false);
    if (!res.ok) {
      if (res.error.code === "NOT_FOUND") {
        // BUG-010 (live): the item was deleted while this form was open
        setFormError(
          "This item no longer exists. It may have been deleted. Cancel to close this form.",
        );
        return;
      }
      const fe = res.error.fieldErrors ?? {};
      const tr = mapServerTranslationErrors(fe);
      setErrors(
        Object.fromEntries(
          Object.entries(fe)
            .filter(([k]) => !/(^|\.)translations/.test(k))
            .map(([k, m]) => [k, m.join(", ")]),
        ),
      );
      setTrErrors(tr.item);
      setOptTrErrors(tr.variants);
      setTrGeneral(tr.general);
      if (Object.keys(tr.item).length + Object.keys(tr.variants).length + tr.general.length > 0)
        setTrOpen(true);
      setFormError(res.error.message);
      return;
    }
    await onSaved();
  }

  // design review T-048 fixes 1 and 2: one thumbnail slot. The saved photo (480 px variant, the 1:1 crop guests see),
  // or the new upload in its place; a staged removal stays in the same spot, dimmed, with Undo.
  const savedUrl =
    initial?.imageVariants?.find((v) => v.widthPx === 480)?.url ?? initial?.imageUrl ?? null;
  const shownPath = imagePath ?? removedPath;
  const isNewUpload = !!shownPath && shownPath !== initial?.imagePath;
  const thumbUrl =
    shownPath && upload?.path === shownPath ? upload.url : isNewUpload ? null : savedUrl;
  const removed = !imagePath && !!removedPath;

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-labelledby={`${uid}-title`}
      className="border-primary bg-surface-raised rounded-card shadow-card space-y-4 border-2 p-4"
    >
      <h2
        id={`${uid}-title`}
        ref={titleRef}
        tabIndex={-1}
        className="font-display scroll-mt-4 text-2xl"
      >
        {initial ? `Edit ${initial.name}` : "Add an item"}
      </h2>
      {formError ? (
        <Banner tone="danger" live="alert">
          {formError}
        </Banner>
      ) : null}
      <TextField
        label="Name"
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={errors.name}
      />
      <TextArea
        label="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        error={errors.description}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          label="Price (Rs.)"
          required
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          error={errors.price}
        />
        <SelectField label="Category" required value={cat} onChange={(e) => setCat(e.target.value)}>
          {cats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Diet"
          required
          value={diet}
          onChange={(e) => setDiet(e.target.value as Diet)}
        >
          <option value="veg">Vegetarian</option>
          <option value="non_veg">Non-vegetarian</option>
          <option value="egg">Contains egg</option>
        </SelectField>
      </div>
      <fieldset>
        <legend className="text-sm font-semibold">Labels</legend>
        <div className="flex flex-wrap gap-x-5">
          {TAGS.map((t) => (
            <CheckField
              key={t.value}
              label={t.label}
              checked={tags.includes(t.value)}
              onChange={(e) =>
                setTags((cur) =>
                  e.target.checked ? [...cur, t.value] : cur.filter((x) => x !== t.value),
                )
              }
            />
          ))}
        </div>
      </fieldset>
      <CheckField
        label="Show on the menu"
        checked={visible}
        onChange={(e) => setVisible(e.target.checked)}
      />

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Options (size, milk, add-ons)</legend>
        {variants.map((v, i) => (
          <div key={i} className="grid items-end gap-2 sm:grid-cols-[8rem_1fr_8rem_auto]">
            <SelectField
              label="Type"
              required
              value={v.kind}
              onChange={(e) =>
                setVariants((cur) =>
                  cur.map((x, j) =>
                    j === i ? { ...x, kind: e.target.value as MenuVariant["kind"] } : x,
                  ),
                )
              }
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </SelectField>
            <TextField
              label="Option name"
              required
              value={v.label}
              onChange={(e) =>
                setVariants((cur) =>
                  cur.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                )
              }
              error={errors[`v${i}`]}
            />
            <TextField
              label="Extra (Rs.)"
              required
              inputMode="decimal"
              value={v.delta}
              onChange={(e) =>
                setVariants((cur) =>
                  cur.map((x, j) => (j === i ? { ...x, delta: e.target.value } : x)),
                )
              }
            />
            <Button
              variant="ghost"
              onClick={() => setVariants((cur) => cur.filter((_, j) => j !== i))}
              aria-label={`Remove option ${i + 1}`}
            >
              Remove
            </Button>
          </div>
        ))}
        {variants.length < 12 ? (
          <Button
            variant="secondary"
            onClick={() =>
              setVariants((cur) => [
                ...cur,
                { kind: "size", label: "", delta: "0", tr: variantDraft(undefined) },
              ])
            }
          >
            Add an option
          </Button>
        ) : null}
      </fieldset>

      <ItemTranslationsFields
        draft={itemTr}
        onChange={(l: MenuLanguage, field, value) =>
          setItemTr((d) => ({ ...d, [l]: { ...d[l], [field]: value } }))
        }
        options={variants.map((v) => ({ label: v.label, draft: v.tr }))}
        onOptionChange={(i, l, value) =>
          setVariants((cur) =>
            cur.map((x, j) => (j === i ? { ...x, tr: { ...x.tr, [l]: value } } : x)),
          )
        }
        errors={trErrors}
        optionErrors={optTrErrors}
        general={trGeneral}
        open={trOpen}
        onToggle={setTrOpen}
      />

      {/* imagePath starts from the stored photo and is sent only when it changes, so saving without a new photo keeps it */}
      <div className="space-y-2">
        {shownPath ? (
          <div
            role="group"
            aria-labelledby={`${uid}-cap`}
            className={`rounded-control flex flex-wrap items-center gap-3 ${removed ? "border-danger border-2 border-dashed p-2" : ""}`}
          >
            <PhotoSlot url={thumbUrl} isNew={isNewUpload} dimmed={removed} />
            <div className="min-w-0 flex-1 space-y-1">
              <p id={`${uid}-cap`} className="text-sm font-semibold">
                {isNewUpload ? "New photo, not saved yet" : "Saved photo"}
              </p>
              {removed ? (
                <>
                  <Badge tone="danger">Removed on save</Badge>
                  <p className="text-sm">This photo goes when you tap Save item.</p>
                </>
              ) : null}
            </div>
            {removed ? (
              <Button
                id={`${uid}-undo`}
                variant="secondary"
                onClick={() => {
                  focusAfter.current = "remove";
                  setImagePath(removedPath);
                  setRemovedPath(null);
                }}
              >
                Undo
              </Button>
            ) : (
              <Button
                id={`${uid}-remove`}
                variant="ghost"
                onClick={() => {
                  focusAfter.current = "undo";
                  setRemovedPath(imagePath);
                  setImagePath(null);
                }}
              >
                Remove photo
              </Button>
            )}
          </div>
        ) : null}
        <div role="status" aria-live="polite" className="sr-only">
          {removed ? "Photo removed. It goes when you tap Save item. Undo brings it back." : ""}
        </div>
        <ImageUpload
          folder="menu"
          label={shownPath ? "Replace with a new photo" : "Photo"}
          currentPath={imagePath}
          showPreview={false}
          onUploaded={(path, preview) => {
            if (uploadUrl.current) URL.revokeObjectURL(uploadUrl.current);
            uploadUrl.current = preview ? URL.createObjectURL(preview) : null;
            setUpload(uploadUrl.current ? { path, url: uploadUrl.current } : null);
            setImagePath(path);
            setRemovedPath(null); // a new photo replaces the removed one; nothing left to undo
          }}
        />
      </div>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving..." : "Save item"}
        </Button>
        <Button
          ref={cancelRef}
          variant="secondary"
          aria-expanded={confirmDiscard || undefined}
          onClick={() => (dirty ? setConfirmDiscard(true) : onCancel())}
        >
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

/** 96 px square thumbnail, 1:1 like the menu (design review section 3). The item name is the form heading, so alt="". */
function PhotoSlot({
  url,
  isNew,
  dimmed,
}: {
  url: string | null;
  isNew: boolean;
  dimmed: boolean;
}) {
  const dim = dimmed ? "opacity-50" : ""; // the image only, never the text
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element -- stored pre-sized WebP or a local blob preview (images.unoptimized)
    <img
      src={url}
      alt={isNew ? "Preview of the chosen photo" : ""}
      className={`rounded-control h-24 w-24 shrink-0 object-cover ${dim}`}
    />
  ) : (
    <div
      aria-hidden="true"
      className={`photo-placeholder rounded-control text-ink-muted flex h-24 w-24 shrink-0 items-end p-1 text-xs ${dim}`}
    >
      <span className="relative">{isNew ? "New photo" : "Photo"}</span>
    </div>
  );
}
