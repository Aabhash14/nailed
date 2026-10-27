"use client";
// Owner: frontend-engineer. Admin "Translations" sections (contract 1.4.0). English stays the main text; each section
// is collapsed by default. Owner edits; staff see the same text read-only (the server refuses staff saves anyway).
// Admin is plain (design system 0.5): no ornament, Mukta, 44 px targets. Every input carries its language's lang="".
import { useState, type ReactNode } from "react";
import { MENU_LANGUAGES, TRANSLATION_LIMITS, type MenuLanguage } from "@/types/contract";
import { BCP47, SELF_NAME } from "@/components/menu/i18n";
import { Button } from "@/components/ui/button";
import { Banner } from "@/components/ui/feedback";
import { TextArea, TextField } from "@/components/ui/field";
import {
  categoryDraft,
  categoryFromDraft,
  charCount,
  filledCount,
  translationsPatch,
  type ItemTrDraft,
  type NameTrDraft,
  type TrErrors,
} from "./translations-logic";
import type {
  AdminMenuCategory,
  CategoryTranslations,
  ItemTranslations,
  VariantTranslations,
} from "@/types/contract";

const ENGLISH_NAME: Record<MenuLanguage, string> = {
  ne: "Nepali",
  zh: "Chinese, simplified",
  ja: "Japanese",
  ko: "Korean",
  pt: "Portuguese, Brazil",
};

/** "नेपाली (Nepali)": the own-script name in its own lang run, then the English name. */
export function LangName({ lang }: { lang: MenuLanguage }) {
  return (
    <>
      <span lang={BCP47[lang]}>{SELF_NAME[lang]}</span>{" "}
      <span className="text-ink-muted font-normal">({ENGLISH_NAME[lang]})</span>
    </>
  );
}

/** Collapsible admin section: a native <details>, so it is keyboard- and screen-reader-friendly with no script. */
export function Collapsible({
  summary,
  open,
  onToggle,
  children,
  className = "",
}: {
  summary: ReactNode;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details
      open={open}
      onToggle={onToggle ? (e) => onToggle(e.currentTarget.open) : undefined}
      className={`border-line rounded-control border ${className}`}
    >
      <summary className="min-h-tap text-primary flex cursor-pointer items-center gap-2 px-3 py-2 font-semibold">
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 16 16"
          width="16"
          height="16"
          className="details-chevron shrink-0"
        >
          <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.75" />
        </svg>
        {summary}
      </summary>
      <div className="border-line space-y-3 border-t px-3 pt-3 pb-4">{children}</div>
    </details>
  );
}

function countHint(text: string, max: number) {
  return `${charCount(text.trim())} / ${max} characters`;
}

/**
 * Owner: the item's Translations section inside the item form. One collapsible group per language with the name,
 * description, the Nepali "Say it" pronunciation (ne only) and every option label of this item.
 */
export function ItemTranslationsFields({
  draft,
  onChange,
  options,
  onOptionChange,
  errors,
  optionErrors,
  general,
  open,
  onToggle,
}: {
  draft: ItemTrDraft;
  onChange: (
    lang: MenuLanguage,
    field: "name" | "description" | "pronunciation",
    value: string,
  ) => void;
  /** The form's option rows, in order: English label (may still be empty) + their translation drafts. */
  options: { label: string; draft: NameTrDraft }[];
  onOptionChange: (index: number, lang: MenuLanguage, value: string) => void;
  errors: TrErrors;
  optionErrors: Record<number, TrErrors>;
  general: string[];
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const filled = MENU_LANGUAGES.filter((l) => draft[l].name.trim()).length;
  const langHasError = (l: MenuLanguage) =>
    Object.keys(errors).some((k) => k.startsWith(`${l}.`)) ||
    Object.values(optionErrors).some((e) => Object.keys(e).some((k) => k.startsWith(`${l}.`)));
  return (
    <Collapsible
      open={open}
      onToggle={onToggle}
      summary={
        <>
          Translations <span className="text-ink-muted font-normal">· {filled} of 5 languages</span>
        </>
      }
    >
      <p className="text-ink-muted text-sm">
        The English above is always shown. Guests can add one of these languages on the menu. Leave
        a language empty to show English only.
      </p>
      {general.length > 0 ? (
        <Banner tone="danger" live="alert">
          {general.join(" ")}
        </Banner>
      ) : null}
      {MENU_LANGUAGES.map((l) => (
        <Collapsible
          key={l}
          // a language with a problem opens itself, so the error is never hidden in a closed group
          open={langHasError(l) ? true : undefined}
          summary={
            <>
              <LangName lang={l} />
              <span className="text-ink-muted ml-auto text-sm font-normal">
                {draft[l].name.trim() ? "Filled" : "Empty"}
              </span>
            </>
          }
        >
          <TextField
            label="Name"
            lang={BCP47[l]}
            value={draft[l].name}
            onChange={(e) => onChange(l, "name", e.target.value)}
            hint={countHint(draft[l].name, TRANSLATION_LIMITS.name)}
            error={errors[`${l}.name`]}
          />
          <TextArea
            label="Description"
            lang={BCP47[l]}
            value={draft[l].description}
            onChange={(e) => onChange(l, "description", e.target.value)}
            hint={countHint(draft[l].description, TRANSLATION_LIMITS.description)}
            error={errors[`${l}.description`]}
          />
          {l === "ne" ? (
            <TextField
              label="Say it (pronunciation in English letters)"
              lang="ne-Latn"
              value={draft.ne.pronunciation}
              onChange={(e) => onChange("ne", "pronunciation", e.target.value)}
              hint={`Shown as "Say it: ..." in Nepali mode, e.g. masala chiya. ${countHint(draft.ne.pronunciation, TRANSLATION_LIMITS.pronunciation)}`}
              error={errors["ne.pronunciation"]}
            />
          ) : null}
          {options.length > 0 ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold">Option names</legend>
              {options.map((o, i) => (
                <TextField
                  key={i}
                  label={`Option: ${o.label.trim() || `option ${i + 1}`}`}
                  lang={BCP47[l]}
                  value={o.draft[l]}
                  onChange={(e) => onOptionChange(i, l, e.target.value)}
                  hint={countHint(o.draft[l], TRANSLATION_LIMITS.label)}
                  error={optionErrors[i]?.[`${l}.label`]}
                />
              ))}
            </fieldset>
          ) : null}
        </Collapsible>
      ))}
    </Collapsible>
  );
}

/** Staff (and the owner's list view): what guests see in each language, read-only. Nothing when there is none. */
export function ItemTranslationsReadOnly({
  translations,
  variants,
}: {
  translations: ItemTranslations | undefined;
  variants: { label: string; translations?: VariantTranslations }[];
}) {
  const langs = MENU_LANGUAGES.filter(
    (l) => translations?.[l] || variants.some((v) => v.translations?.[l]),
  );
  if (langs.length === 0) return null;
  return (
    <Collapsible
      summary={
        <>
          Translations{" "}
          <span className="text-ink-muted font-normal">
            · {filledCount(translations)} of 5 languages
          </span>
        </>
      }
    >
      <dl className="space-y-3">
        {langs.map((l) => {
          const t = translations?.[l];
          const opts = variants.filter((v) => v.translations?.[l]);
          return (
            <div key={l}>
              <dt className="text-sm font-semibold">
                <LangName lang={l} />
              </dt>
              <dd lang={BCP47[l]}>
                {t ? (
                  <>
                    <span className="block">{t.name}</span>
                    {t.description ? (
                      <span className="text-ink-muted block text-sm">{t.description}</span>
                    ) : null}
                  </>
                ) : null}
                {l === "ne" && t?.pronunciation ? (
                  <span lang="ne-Latn" className="text-ink-muted block text-sm">
                    Say it: {t.pronunciation}
                  </span>
                ) : null}
                {opts.length > 0 ? (
                  <span className="text-ink-muted block text-sm">
                    Options:{" "}
                    {opts.map((v, i) => (
                      <span key={i}>
                        {i > 0 ? ", " : ""}
                        <span lang="en">{v.label}</span> = {v.translations?.[l]?.label}
                      </span>
                    ))}
                  </span>
                ) : null}
              </dd>
            </div>
          );
        })}
      </dl>
    </Collapsible>
  );
}

/**
 * A category's Translations section. Owner: one name field per language + Save (sends `translations` only when it
 * changed, with the category's current name, slug and visibility, so nothing else moves). Staff: read-only.
 */
export function CategoryTranslations({
  category,
  owner,
  onSave,
}: {
  category: AdminMenuCategory;
  owner: boolean;
  onSave: (
    translations: CategoryTranslations,
  ) => Promise<{ ok: boolean; message?: string; fieldErrors?: Record<string, string[]> }>;
}) {
  const stored = category.translations ?? {};
  const [draft, setDraft] = useState<NameTrDraft>(() => categoryDraft(stored));
  const [errors, setErrors] = useState<TrErrors>({});
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // a save elsewhere (or another tab) changed the stored names: follow them while this form is untouched
  const [syncedFrom, setSyncedFrom] = useState(stored);
  if (stored !== syncedFrom) {
    setSyncedFrom(stored);
    if (!translationsPatch(syncedFrom, categoryFromDraft(draft).value))
      setDraft(categoryDraft(stored));
  }

  if (!owner) {
    const langs = MENU_LANGUAGES.filter((l) => stored[l]);
    if (langs.length === 0) return null;
    return (
      <Collapsible
        summary={
          <>
            Category name translations{" "}
            <span className="text-ink-muted font-normal">· {langs.length} of 5</span>
          </>
        }
      >
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
          {langs.map((l) => (
            <div key={l} className="contents">
              <dt className="text-sm font-semibold">
                <LangName lang={l} />
              </dt>
              <dd lang={BCP47[l]}>{stored[l]?.name}</dd>
            </div>
          ))}
        </dl>
      </Collapsible>
    );
  }

  const { value } = categoryFromDraft(draft);
  const patch = translationsPatch(stored, value);
  return (
    <Collapsible
      summary={
        <>
          Category name translations{" "}
          <span className="text-ink-muted font-normal">· {filledCount(value)} of 5</span>
        </>
      }
    >
      <form
        className="space-y-3"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          const r = categoryFromDraft(draft);
          setErrors(r.errors);
          setMessage(null);
          if (Object.keys(r.errors).length > 0) return;
          const send = translationsPatch(stored, r.value);
          if (send === undefined) {
            setMessage({ tone: "success", text: "No changes to save." });
            return;
          }
          setBusy(true);
          const res = await onSave(send);
          setBusy(false);
          if (res.ok)
            setMessage({ tone: "success", text: `Saved the translations for ${category.name}.` });
          else {
            const fe = res.fieldErrors ?? {};
            setErrors(
              Object.fromEntries(
                Object.entries(fe)
                  .map(
                    ([k, m]) =>
                      [
                        /^translations\.(ne|zh|ja|ko|pt)\.name$/.exec(k)?.[1],
                        m.join(", "),
                      ] as const,
                  )
                  .filter(([l]) => l)
                  .map(([l, m]) => [`${l}.name`, m]),
              ),
            );
            setMessage({ tone: "danger", text: res.message ?? "That did not work." });
          }
        }}
      >
        <p className="text-ink-muted text-sm">
          The English name is always shown. Leave a language empty to show English only.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {MENU_LANGUAGES.map((l) => (
            <TextField
              key={l}
              label={<LangName lang={l} />}
              lang={BCP47[l]}
              value={draft[l]}
              onChange={(e) => setDraft((d) => ({ ...d, [l]: e.target.value }))}
              hint={countHint(draft[l], TRANSLATION_LIMITS.name)}
              error={errors[`${l}.name`]}
            />
          ))}
        </div>
        <div role="status" aria-live="polite">
          {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}
        </div>
        <Button type="submit" variant="secondary" disabled={busy || patch === undefined}>
          {busy ? "Saving..." : "Save translations"}
        </Button>
      </form>
    </Collapsible>
  );
}
