/**
 * One secondary-language run next to the English. Renders nothing for null / empty text, so a missing translation
 * leaves no gap. Always carries its own lang="" (ne, zh-Hans, ja, ko, pt-BR): the browser then picks the right
 * system glyphs for CJK (the app ships no CJK font) and screen readers switch voice. Never aria-hidden: it is real
 * content for a guest who reads that language. Smaller and muted by default; `block` puts it on its own line.
 * BUG-017: a long word with no spaces (owner-typed, up to 80 code points) breaks inside the run instead of pushing the
 * page sideways. `wrap-break-word` does not change the run's min-content width, so badges and tabs keep their size.
 * (The menu language picker lives in lang-picker.tsx: it is a client component, this file is also used on the server.)
 */
export function Sec({
  text,
  lang,
  block = false,
  className = "",
}: {
  text: string | null | undefined;
  lang: string | undefined;
  block?: boolean;
  className?: string;
}) {
  if (!text || !lang) return null;
  return (
    <span lang={lang} className={`wrap-break-word ${block ? "block" : ""} ${className}`.trim()}>
      {text}
    </span>
  );
}
