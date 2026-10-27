"use client";

import { useSearchParams } from "next/navigation";
import type { MenuSecondary } from "./i18n";
import { Sec } from "./secondary";
import { parseTableParam } from "./table/hint";
import { useHintTable } from "./table/table-entry";

/**
 * QR codes open /menu?t=7. Display only; validated 1-99 (architecture.md section 2). Kept tiny so the page stays static.
 * 2.0.0: a guest who joined a table (local join hint, section 9.2) keeps the seal after reloading /menu without `t`.
 * The hint is not a credential; the seal is decoration, the table UI checks the real session.
 */
export function TableBadge({ sec = null }: { sec?: MenuSecondary | null }) {
  const fromQr = parseTableParam(useSearchParams().get("t"));
  const joined = useHintTable();
  const n = fromQr ?? joined;
  if (n === null) return null;
  // concept C "chhap": a round brick seal. "Table 7" stays one text run, so it is read (and matched) as one phrase;
  // the secondary language goes on its own small line inside the seal.
  return (
    <p className="seal animate-rise text-sm font-semibold">
      <span>Table {n}</span>
      <Sec text={sec?.t("table.badge", { n })} lang={sec?.bcp47} block className="text-xs font-normal" />
    </p>
  );
}
