"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatNpr } from "@/lib/money";
import type { MenuItem, MenuVariant } from "@/types/contract";
import type { MenuSecondary } from "../i18n";
import type { TableText, TableUiKey } from "./i18n";
import { Both, Sheet } from "./sheet";
import { optionGroups, unitPriceWith } from "./table-logic";

const KIND_KEY: Record<MenuVariant["kind"], TableUiKey> = {
  size: "kind.size",
  milk: "kind.milk",
  addon: "kind.addon",
  temperature: "kind.temperature",
};

/**
 * Options and quantity for one item before it goes into the table cart: one radio group per option kind ("Regular" /
 * "None" = the base item), at most one choice per kind (contract 9.5). Sold-out options are disabled and say so.
 */
export function ItemSheet({
  item,
  onClose,
  onAdd,
  sec,
  t,
}: {
  item: MenuItem | null;
  onClose: () => void;
  onAdd: (item: MenuItem, variantIds: string[], qty: number) => void;
  sec: MenuSecondary | null;
  t: TableText;
}) {
  return (
    <Sheet
      open={item !== null}
      onClose={onClose}
      title={item?.name ?? ""}
      titleExtra={
        item && sec?.itemName(item) ? (
          <span lang={sec.bcp47} className="text-ink-muted block text-sm">
            {sec.itemName(item)}
          </span>
        ) : null
      }
      closeLabel={<Both en={t.en("sheet.close")} sec={t.sec("sheet.close")} lang={t.lang} />}
    >
      {item ? <ItemForm key={item.id} item={item} onAdd={onAdd} sec={sec} t={t} /> : null}
    </Sheet>
  );
}

function ItemForm({
  item,
  onAdd,
  sec,
  t,
}: {
  item: MenuItem;
  onAdd: (item: MenuItem, variantIds: string[], qty: number) => void;
  sec: MenuSecondary | null;
  t: TableText;
}) {
  const groups = optionGroups(item);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [qty, setQty] = useState(1);
  const variantIds = Object.values(picked).filter(Boolean);
  const unit = unitPriceWith(item, variantIds);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onAdd(item, variantIds, qty);
      }}
    >
      {groups.map((g) => (
        <fieldset key={g.kind} className="space-y-1.5">
          <legend className="text-sm font-semibold">
            <Both en={t.en(KIND_KEY[g.kind])} sec={t.sec(KIND_KEY[g.kind])} lang={t.lang} />
          </legend>
          <Choice
            name={`opt-${g.kind}`}
            checked={!picked[g.kind]}
            onChange={() => setPicked((p) => ({ ...p, [g.kind]: "" }))}
            label={
              <Both
                en={t.en(g.kind === "addon" ? "item.none" : "item.regular")}
                sec={t.sec(g.kind === "addon" ? "item.none" : "item.regular")}
                lang={t.lang}
              />
            }
          />
          {g.options.map((v) => (
            <Choice
              key={v.id}
              name={`opt-${g.kind}`}
              checked={picked[g.kind] === v.id}
              disabled={v.isSoldOut}
              onChange={() => setPicked((p) => ({ ...p, [g.kind]: v.id }))}
              label={
                <>
                  <span className={v.isSoldOut ? "line-through" : ""}>{v.label}</span>
                  {sec?.variantLabel(v) ? (
                    <span lang={sec.bcp47} className="ml-1">
                      {sec.variantLabel(v)}
                    </span>
                  ) : null}
                  {v.priceDelta !== 0 ? (
                    <span className="text-ink-muted ml-1 tabular-nums">
                      {v.priceDelta > 0 ? "+" : "-"}
                      {formatNpr(Math.abs(v.priceDelta))}
                    </span>
                  ) : null}
                  {v.isSoldOut ? <span className="ml-1 font-semibold">(sold out)</span> : null}
                </>
              }
            />
          ))}
        </fieldset>
      ))}

      <div className="space-y-1.5">
        <p className="text-sm font-semibold" id={`qty-${item.id}`}>
          <Both en={t.en("item.qty")} sec={t.sec("item.qty")} lang={t.lang} />
        </p>
        <Stepper
          value={qty}
          labelledBy={`qty-${item.id}`}
          onChange={setQty}
          lessLabel={t.en("cart.less")}
          moreLabel={t.en("cart.more")}
        />
      </div>

      <Button type="submit" className="w-full">
        <Both en={t.en("item.add")} sec={t.sec("item.add")} lang={t.lang} />
        <span className="tabular-nums">· {formatNpr(unit * qty)}</span>
      </Button>
    </form>
  );
}

function Choice({
  name,
  checked,
  disabled,
  onChange,
  label,
}: {
  name: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: React.ReactNode;
}) {
  return (
    <label
      className={`min-h-tap rounded-control flex items-center gap-3 border px-3 py-2 ${checked ? "border-primary border-2" : "border-line-strong"} ${disabled ? "hatch-soldout cursor-not-allowed opacity-70" : "cursor-pointer"}`}
    >
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onChange} className="accent-primary h-5 w-5 shrink-0" />
      <span className="min-w-0 wrap-break-word">{label}</span>
    </label>
  );
}

/** − qty + with 44 px targets. 1..20 (contract 9.5). */
export function Stepper({
  value,
  onChange,
  min = 1,
  max = 20,
  labelledBy,
  lessLabel,
  moreLabel,
  itemName,
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  labelledBy?: string;
  lessLabel: string;
  moreLabel: string;
  /** Adds the item name to the button labels when there are many steppers on screen. */
  itemName?: string;
}) {
  const suffix = itemName ? `: ${itemName}` : "";
  return (
    <div role="group" aria-labelledby={labelledBy} className="inline-flex items-center gap-1">
      <button
        type="button"
        className="min-h-tap min-w-tap rounded-control border-line-strong text-primary border text-xl font-semibold disabled:opacity-50"
        aria-label={`${lessLabel}${suffix}`}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        −
      </button>
      <output className="min-w-10 text-center text-lg font-semibold tabular-nums" aria-live="polite">
        {value}
      </output>
      <button
        type="button"
        className="min-h-tap min-w-tap rounded-control border-line-strong text-primary border text-xl font-semibold disabled:opacity-50"
        aria-label={`${moreLabel}${suffix}`}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        +
      </button>
    </div>
  );
}
