"use client";

import { useEffect, useState } from "react";

/**
 * QR code drawn in the browser (ADR 0002, F2/SEC-024): `qrcode-generator` 2.0.4 (MIT, about 50 KB unminified) is
 * imported dynamically, only when a QR is on screen, and renders nothing but module positions; we draw the SVG
 * ourselves in theme colours. No remote QR API, no image data URL, nothing sent anywhere.
 */
export function QrCode({ text, label, size = 240 }: { text: string; label: string; size?: number }) {
  const [path, setPath] = useState<{ d: string; n: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setPath(null);
    setFailed(false);
    import("qrcode-generator")
      .then(({ default: qrcode }) => {
        const qr = qrcode(0, "M");
        qr.addData(text);
        qr.make();
        const n = qr.getModuleCount();
        let d = "";
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
        if (live) setPath({ d, n });
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [text]);

  if (failed) {
    return <p className="text-danger text-sm font-semibold">The QR code could not be drawn. Read the code out instead.</p>;
  }
  if (!path) return <div aria-hidden="true" className="skeleton-shimmer animate-shimmer rounded-control" style={{ width: size, height: size }} />;
  const quiet = 4; // the quiet zone scanners need, in modules
  const box = path.n + quiet * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`${-quiet} ${-quiet} ${box} ${box}`}
      shapeRendering="crispEdges"
      className="bg-surface-raised text-ink rounded-control"
    >
      <rect x={-quiet} y={-quiet} width={box} height={box} className="fill-surface-raised" />
      <path d={path.d} className="fill-current" />
    </svg>
  );
}
