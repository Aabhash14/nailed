import localFont from "next/font/local";

/*
  Self-hosted web fonts for the placeholder direction (concept C "Mato & Dhaka", calmed with concept A).
  Files are the Google Fonts woff2 subsets, committed under ./fonts (SIL OFL 1.1, licences alongside), so builds make
  no network call and the CSP stays `font-src 'self'`. next/font serves them from /_next/static/media.

  - Display: Marcellus 400 (Latin only), preloaded.
  - Body: Mukta 400 + 600 (Latin), preloaded. Mukta also sets Devanagari, so bilingual lines sit evenly.
  - Devanagari: Mukta 400 (Devanagari subset), NOT preloaded, limited by unicode-range, so the ~100 KB file is only
    fetched on a page that actually shows Devanagari. 600 weight Devanagari is synthesised by the browser.

  Components never reference these directly. theme.css maps them to --font-display / --font-sans / --font-deva, so a
  different client direction swaps this file and theme.css only.
*/

// unicode-range values are the Google Fonts subset ranges. next/font needs them written inline (literals only).

export const displayFont = localFont({
  src: [{ path: "./fonts/marcellus-400-latin.woff2", weight: "400", style: "normal" }],
  variable: "--nf-display",
  display: "swap",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  adjustFontFallback: "Times New Roman",
});

export const sansFont = localFont({
  src: [
    { path: "./fonts/mukta-400-latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/mukta-600-latin.woff2", weight: "600", style: "normal" },
  ],
  variable: "--nf-sans",
  display: "swap",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});

export const devaFont = localFont({
  src: [{ path: "./fonts/mukta-400-devanagari.woff2", weight: "400", style: "normal" }],
  variable: "--nf-deva",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0900-097F, U+1CD0-1CF4, U+1CF7-1CF9, U+200C-200D, U+20A8, U+20B9, U+20F0, U+25CC, U+A830-A839, U+A8E0-A8FF, U+11B00-11B0A",
    },
  ],
});

/** Put on <html>: defines the three CSS variables that theme.css reads. */
export const fontVariables = `${displayFont.variable} ${sansFont.variable} ${devaFont.variable}`;
