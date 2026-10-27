import type { ImageVariant } from "@/types/contract";
import { ratioFromClass } from "./media-ratio";

/**
 * Picture from pre-sized WebP variants (contract: three widths, srcset built here, never an image-transform service;
 * next.config sets images.unoptimized, so next/image would add nothing). Falls back to a clearly labelled placeholder.
 */
export function srcSetFor(variants: ImageVariant[]): string {
  return [...variants]
    .sort((a, b) => a.widthPx - b.widthPx)
    .map((v) => `${v.url} ${v.widthPx}w`)
    .join(", ");
}

export function Picture({
  url,
  variants,
  alt,
  sizes,
  ratio = "aspect-[4/3]",
  placeholderLabel,
  shotId,
  priority = false,
  compact = false,
  className = "",
}: {
  url: string | null;
  variants: ImageVariant[];
  alt: string;
  sizes: string;
  ratio?: string;
  placeholderLabel: string;
  /** Shot-list ID (design/photography/shot-list.md), shown on the placeholder so the shoot and the slot match. */
  shotId?: string;
  priority?: boolean;
  /** Small slots (product cards, menu thumbnails): the placeholder says only "Photo to come"; the name is beside it. */
  compact?: boolean;
  className?: string;
}) {
  if (!url) {
    const text = shotId ? `${shotId}, ${placeholderLabel}` : placeholderLabel;
    // R24-1: a light caption, not a sticker. The children are presentational under role="img": screen readers hear
    // only the aria-label, which keeps the full "Photo to come: <shot>, <label>".
    return (
      <div
        role="img"
        aria-label={`Photo to come: ${text}`}
        className={`photo-placeholder flex flex-col justify-end gap-1 p-3 ${ratio} ${className}`}
      >
        {compact ? (
          <span className="relative text-xs font-semibold">Photo to come</span>
        ) : (
          <>
            {shotId ? (
              <span className="text-eyebrow tracking-label relative font-semibold uppercase">
                {shotId}
              </span>
            ) : null}
            <span className="relative max-w-[32ch] text-sm leading-snug">
              Photo to come: {placeholderLabel}
            </span>
          </>
        )}
      </div>
    );
  }
  const widest = variants.length > 0 ? Math.max(...variants.map((v) => v.widthPx)) : 960;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- pre-sized WebP variants with our own srcset (see above)
    <img
      src={url}
      srcSet={variants.length > 0 ? srcSetFor(variants) : undefined}
      sizes={sizes}
      alt={alt}
      width={widest}
      height={Math.round(widest / ratioFromClass(ratio))}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : undefined}
      decoding="async"
      className={`h-full w-full object-cover ${ratio} ${className}`}
    />
  );
}
