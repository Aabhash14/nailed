"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Banner, Skeleton } from "@/components/ui/feedback";
import { CheckField, TextArea, TextField } from "@/components/ui/field";
import { adminApi, type AdminSettings } from "@/data-access/admin";
import { ordersArePaused, TABLE_LIMITS, type OrderRules } from "@/types/contract";
import {
  dayName,
  isPlausiblePhone,
  paisaToRupees,
  parseSlots,
  rupeesToPaisa,
  safeHttpsUrl,
  slotsProblem,
  slotsToText,
} from "@/components/format";
import type { PaymentMethod, PublicSettings } from "@/types/contract";
import { useAdminSession } from "./admin-shell";
import { useAdminStatus } from "./admin-status";

type S = AdminSettings;
const DAYS = [1, 2, 3, 4, 5, 6, 0] as const;

export function SettingsForm() {
  const { role } = useAdminSession();
  const [settings, setSettings] = useState<S | null>(null);
  const [failed, setFailed] = useState(false);
  const { setOrdersPaused, setAnnouncement } = useAdminStatus();
  useEffect(() => {
    if (role !== "owner") return; // getSettings is owner-only; staff only edit the notice banner
    adminApi.getSettings().then(
      (s) => {
        setSettings(s);
        // the freshest values: keep the admin-wide pause banner in step with them
        setOrdersPaused(ordersArePaused(s));
        setAnnouncement(s.announcement);
      },
      () => setFailed(true),
    );
  }, [role, setOrdersPaused, setAnnouncement]);

  if (role !== "owner") return <StaffAnnouncement />;
  if (failed) return <Banner tone="danger" live="alert">Could not load settings. Please reload the page.</Banner>;

  if (!settings) {
    return (
      <div aria-busy="true" aria-label="Loading settings" className="space-y-3">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-60 w-full" />
      </div>
    );
  }
  return (
    <div className="max-w-3xl space-y-8">
      <h1 className="font-display text-ink text-3xl tracking-[0.02em]">Settings</h1>
      <OrdersPauseSwitch />
      <OwnerSettings initial={settings} />
    </div>
  );
}

/**
 * Owner kill switch (SEC-003): saves immediately, separate from the big form, so it works even when the form has
 * unsaved or invalid edits. While paused, cart and checkout tell customers to phone the cafe.
 */
function OrdersPauseSwitch() {
  // shared with the "Online orders are paused" banner on every admin page (design review fix 6)
  const { ordersPaused: paused, setOrdersPaused: setPaused } = useAdminStatus();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function toggle() {
    setBusy(true);
    setMsg(null);
    const want = !paused;
    const res = await adminApi.setOrdersPaused({ paused: want });
    setBusy(false);
    if (res.ok) {
      setPaused(want);
      setMsg({
        ok: true,
        text: want
          ? "Online orders are paused. Customers see a message asking them to call you."
          : "Online orders are open again.",
      });
    } else setMsg({ ok: false, text: res.error.message });
  }

  return (
    <section id="orders-pause" aria-labelledby="pause-h" className="border-line bg-surface-raised rounded-card shadow-card scroll-mt-4 space-y-3 border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="pause-h" className="font-display text-xl">
          Online shop orders
        </h2>
        <Badge tone={paused ? "danger" : "success"}>{paused ? "Paused" : "Open"}</Badge>
      </div>
      <p className="text-ink-muted text-sm">
        Pause if you get fake orders or cannot handle more today. Orders already placed are not affected. This saves
        straight away.
      </p>
      <Button variant={paused ? "primary" : "danger"} disabled={busy} onClick={() => void toggle()}>
        {busy ? "Saving..." : paused ? "Resume online orders" : "Pause online orders"}
      </Button>
      <div role="status" aria-live="polite">
        {msg ? <Banner tone={msg.ok ? "success" : "danger"}>{msg.text}</Banner> : null}
      </div>
    </section>
  );
}

/**
 * Staff can change only the notice banner. BUG-011 / design review fix 7: the field starts from the notice that is
 * showing now (public settings, readable by staff), and taking the notice down is an explicit "Remove notice", never an
 * empty Save. Copy is a working draft (placeholder until content-writer T-052).
 */
function StaffAnnouncement() {
  const { announcement, known, setAnnouncement, refresh } = useAdminStatus();
  const [text, setText] = useState(announcement ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // read the notice again on opening this page (the value from the first page load may be old)
  useEffect(() => refresh(), [refresh]);
  // a fresher value arrives: follow it unless the person has started typing
  const [synced, setSynced] = useState(announcement);
  if (announcement !== synced) {
    setSynced(announcement);
    if (text === (synced ?? "")) setText(announcement ?? "");
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!text.trim()) {
      setError(announcement ? "Type the new notice, or use Remove notice to take it down." : "Type a notice first.");
      return;
    }
    setError(null);
    setBusy(true);
    const res = await adminApi.setAnnouncement({ text: text.trim() });
    setBusy(false);
    if (res.ok) {
      setAnnouncement(text.trim());
      setSynced(text.trim());
      setMsg({ ok: true, text: "Saved. It shows on the home page and the menu." });
    } else setMsg({ ok: false, text: res.error.message });
  }

  async function remove() {
    setMsg(null);
    setError(null);
    setBusy(true);
    const res = await adminApi.setAnnouncement({ text: null });
    setBusy(false);
    if (res.ok) {
      setAnnouncement(null);
      setSynced(null);
      setText("");
      setMsg({ ok: true, text: "Notice removed. Guests no longer see it." });
    } else setMsg({ ok: false, text: res.error.message });
  }

  return (
    <form onSubmit={save} noValidate className="max-w-xl space-y-4">
      <h1 className="font-display text-ink text-3xl tracking-[0.02em]">Settings</h1>
      <Banner tone="info">Staff can change the notice banner. The owner manages everything else.</Banner>
      {!known ? (
        <Banner tone="warning" title="Could not load the current notice">
          Reload the page before saving, so you do not replace a notice by mistake.
        </Banner>
      ) : announcement ? (
        <div className="border-line bg-surface-raised rounded-card shadow-card space-y-2 border p-3">
          <p className="text-sm">
            <span className="font-semibold">Showing now:</span> {announcement}
          </p>
          <Button variant="secondary" disabled={busy} onClick={() => void remove()}>
            Remove notice
          </Button>
        </div>
      ) : (
        <p className="text-ink-muted text-sm">No notice is showing now.</p>
      )}
      <TextArea
        label="Notice banner"
        hint="For example: closed for a festival. Shows on the home page and the menu."
        maxLength={240}
        value={text}
        onChange={(e) => setText(e.target.value)}
        error={error ?? undefined}
      />
      <Button type="submit" disabled={busy}>
        {busy ? "Saving..." : "Save notice"}
      </Button>
      <div role="status" aria-live="polite">
        {msg ? <Banner tone={msg.ok ? "success" : "danger"}>{msg.text}</Banner> : null}
      </div>
    </form>
  );
}

function OwnerSettings({ initial }: { initial: S }) {
  const [v, setV] = useState({
    cafeName: initial.cafeName,
    announcement: initial.announcement ?? "",
    phone: initial.phone ?? "",
    whatsapp: initial.whatsapp ?? "",
    email: initial.email ?? "",
    address: initial.address ?? "",
    landmark: initial.landmark ?? "",
    mapUrl: initial.mapUrl ?? "",
    pricesIncludeVat: initial.pricesIncludeVat,
    serviceChargePct: String(initial.serviceChargePct),
    deliveryFee: paisaToRupees(initial.deliveryFee),
    deliveryAreas: initial.deliveryAreas.join("\n"),
    minOrderDelivery: paisaToRupees(initial.minOrderDelivery),
    minOrderPickup: paisaToRupees(initial.minOrderPickup),
    cod: initial.paymentMethods.includes("cod"),
    pickup: initial.paymentMethods.includes("pickup"),
    codMaxTotal: initial.codMaxTotal === null ? "" : paisaToRupees(initial.codMaxTotal),
    maxOpen: String(initial.maxOpenOrdersPerPhone),
    ipOpen: initial.ipOpenOrdersMax === undefined ? "" : String(initial.ipOpenOrdersMax),
    ipDay: initial.ipOrdersMaxPerDay === undefined ? "" : String(initial.ipOrdersMaxPerDay),
    autoCancel:
      initial.autoCancelPlacedAfterMinutes === undefined || initial.autoCancelPlacedAfterMinutes === null
        ? ""
        : String(initial.autoCancelPlacedAfterMinutes),
    // 2.2.0 (contract 9.10a / 9.10): table ordering rules
    cancelWindow: initial.staffCancelWindowMinutes === undefined ? "" : String(initial.staffCancelWindowMinutes),
    hours: Object.fromEntries(DAYS.map((d) => [d, slotsToText(initial.hours.weekly[d])])) as Record<number, string>,
    closures: initial.hours.closures.map((c) => `${c.date} | ${c.label}`).join("\n"),
  });
  const hasAbuseRules = initial.ipOpenOrdersMax !== undefined;
  // 2.2.0 fields: shown and sent only when the server returned them (updateSettings refuses unknown keys)
  const hasTableRules = initial.staffCancelWindowMinutes !== undefined;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const focusInvalid = useRef(false);
  const { setAnnouncement } = useAdminStatus();
  useEffect(() => {
    if (!focusInvalid.current) return;
    focusInvalid.current = false;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [errors]);
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV((p) => ({ ...p, [k]: val }));

  async function save(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const fee = rupeesToPaisa(v.deliveryFee || "0");
    const minD = rupeesToPaisa(v.minOrderDelivery || "0");
    const minP = rupeesToPaisa(v.minOrderPickup || "0");
    // BUG-003 (Manager decision): empty or 0 = no limit. Sent as null so the server never sees an ambiguous 0.
    const maxCodRaw = v.codMaxTotal.trim() ? rupeesToPaisa(v.codMaxTotal) : null;
    const maxCod = maxCodRaw === 0 ? null : maxCodRaw;
    const svc = Number(v.serviceChargePct || "0");
    const maxOpen = Number(v.maxOpen);
    if (!v.cafeName.trim()) errs.cafeName = "Enter the cafe name";
    const money = "Enter rupees like 150 or 150.50 (use a dot for paisa, not a comma)";
    if (fee === null) errs.deliveryFee = money;
    if (minD === null) errs.minOrderDelivery = money;
    if (minP === null) errs.minOrderPickup = money;
    if (v.codMaxTotal.trim() && maxCodRaw === null) errs.codMaxTotal = `${money}, or 0 for no limit`;
    if (v.phone.trim() && !isPlausiblePhone(v.phone)) errs.phone = "Enter a phone number with digits only, for example 01-4XXXXXX or 98XXXXXXXX";
    if (v.whatsapp.trim() && !isPlausiblePhone(v.whatsapp)) errs.whatsapp = "Enter a phone number with digits only, for example 98XXXXXXXX";
    if (v.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) errs.email = "That email does not look right";
    if (v.mapUrl.trim() && !safeHttpsUrl(v.mapUrl)) errs.mapUrl = "Paste the full link starting with https://, for example from Google Maps";
    if (!(svc >= 0 && svc <= 30)) errs.serviceChargePct = "Enter 0 to 30";
    if (!Number.isInteger(maxOpen) || maxOpen < 1 || maxOpen > 5) errs.maxOpen = "Enter 1 to 5";
    // Contract 1.3.0 rules. Still only shown and sent when the server returned them (hasAbuseRules), so an older backend keeps working.
    const extra: Partial<OrderRules> = {};
    if (hasAbuseRules) {
      const intIn = (t: string, lo: number, hi: number) => /^\d+$/.test(t.trim()) && Number(t) >= lo && Number(t) <= hi;
      if (!intIn(v.ipOpen, 1, 100)) errs.ipOpen = "Enter a whole number from 1 to 100";
      else extra.ipOpenOrdersMax = Number(v.ipOpen);
      if (!intIn(v.ipDay, 1, 1000)) errs.ipDay = "Enter a whole number from 1 to 1000";
      else extra.ipOrdersMaxPerDay = Number(v.ipDay);
      if (!v.autoCancel.trim()) extra.autoCancelPlacedAfterMinutes = null;
      else if (!intIn(v.autoCancel, 15, 10080)) errs.autoCancel = "Enter 15 to 10080 minutes, or leave empty to turn it off";
      else extra.autoCancelPlacedAfterMinutes = Number(v.autoCancel);
    }
    if (hasTableRules) {
      if (!/^\d+$/.test(v.cancelWindow.trim()) || Number(v.cancelWindow) > TABLE_LIMITS.maxStaffCancelWindowMinutes)
        errs.cancelWindow = "Enter a whole number from 0 to 60";
      else extra.staffCancelWindowMinutes = Number(v.cancelWindow);
      // 2.3.0: ownerAlertWhatsApp is unused and hidden; never sent
    }
    if (!v.cod && !v.pickup) errs.payment = "Turn on at least one way to pay";
    const areas = v.deliveryAreas.split("\n").map((a) => a.trim()).filter(Boolean);
    // BUG-006: delivery with no areas used to save and then silently vanish from checkout.
    if (v.cod && areas.length === 0) errs.deliveryAreas = "Add at least one delivery area, or turn delivery off";

    const weekly = {} as PublicSettings["hours"]["weekly"];
    for (const d of DAYS) {
      const t = v.hours[d]?.trim() ?? "";
      if (!t || t.toLowerCase() === "closed") weekly[d] = null;
      else {
        const slots = parseSlots(t);
        if (!slots) errs[`h${d}`] = "Use times like 07:00-20:00, or leave empty if closed";
        else {
          const problem = slotsProblem(slots); // BUG-006: closing must be after opening
          if (problem) errs[`h${d}`] = problem;
          else weekly[d] = slots;
        }
      }
    }
    const closures: PublicSettings["hours"]["closures"] = [];
    for (const line of v.closures.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const [date = "", label = ""] = line.split("|").map((s) => s.trim());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        errs.closures = "Each line: 2026-10-21 | Dashain";
        break;
      }
      closures.push({ date, label });
    }
    focusInvalid.current = true;
    setErrors(errs);
    if (Object.keys(errs).length > 0 || fee === null || minD === null || minP === null) {
      setMsg({ ok: false, text: "Please fix the highlighted fields." });
      return;
    }

    const methods: PaymentMethod[] = [];
    if (v.cod) methods.push("cod");
    if (v.pickup) methods.push("pickup");
    setBusy(true);
    const res = await adminApi.updateSettings({
      cafeName: v.cafeName.trim(),
      announcement: v.announcement.trim() || null,
      phone: v.phone.trim() || null,
      whatsapp: v.whatsapp.trim() || null,
      email: v.email.trim() || null,
      address: v.address.trim() || null,
      landmark: v.landmark.trim() || null,
      mapUrl: v.mapUrl.trim() || null,
      pricesIncludeVat: v.pricesIncludeVat,
      serviceChargePct: svc,
      deliveryFee: fee,
      deliveryAreas: areas,
      minOrderDelivery: minD,
      minOrderPickup: minP,
      paymentMethods: methods,
      codMaxTotal: maxCod,
      maxOpenOrdersPerPhone: maxOpen,
      hours: { weekly, closures },
      ...extra,
    });
    setBusy(false);
    if (res.ok) {
      // show what was stored (e.g. a 0 cash limit comes back as "no limit")
      set("codMaxTotal", res.data.codMaxTotal === null ? "" : paisaToRupees(res.data.codMaxTotal));
      setAnnouncement(res.data.announcement ?? null);
      setMsg({ ok: true, text: "Settings saved." });
    } else {
      const fe = res.error.fieldErrors ?? {};
      const mapped: Record<string, string> = {};
      const alias: Record<string, string> = {
        maxOpenOrdersPerPhone: "maxOpen",
        ipOpenOrdersMax: "ipOpen",
        ipOrdersMaxPerDay: "ipDay",
        autoCancelPlacedAfterMinutes: "autoCancel",
        staffCancelWindowMinutes: "cancelWindow",
      };
      for (const [k, m] of Object.entries(fe)) mapped[alias[k] ?? k] = m.join(", ");
      focusInvalid.current = true;
      setErrors(mapped);
      setMsg({ ok: false, text: res.error.message });
    }
  }

  return (
    <form ref={formRef} onSubmit={save} noValidate className="space-y-8">

      <fieldset className="space-y-4">
        <legend className="font-display text-xl">The cafe</legend>
        <TextField label="Cafe name" required value={v.cafeName} onChange={(e) => set("cafeName", e.target.value)} error={errors.cafeName} />
        <TextArea label="Notice banner" hint="Shows on the home page and the menu. Leave empty for none." maxLength={240} value={v.announcement} onChange={(e) => set("announcement", e.target.value)} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Phone" type="tel" value={v.phone} onChange={(e) => set("phone", e.target.value)} error={errors.phone} />
          <TextField label="WhatsApp" type="tel" value={v.whatsapp} onChange={(e) => set("whatsapp", e.target.value)} error={errors.whatsapp} />
          <TextField label="Email" type="email" value={v.email} onChange={(e) => set("email", e.target.value)} error={errors.email} />
          <TextField label="Map link" type="url" hint="Starts with https://" value={v.mapUrl} onChange={(e) => set("mapUrl", e.target.value)} error={errors.mapUrl} />
          <TextField label="Address" value={v.address} onChange={(e) => set("address", e.target.value)} />
          <TextField label="Landmark" value={v.landmark} onChange={(e) => set("landmark", e.target.value)} />
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="font-display text-xl">Opening hours</legend>
        <p className="text-ink-muted text-sm">
          Write times like 07:00-20:00 (24-hour clock; closing after opening, 24:00 for midnight). For a split day:
          07:00-12:00, 14:00-20:00. Leave empty if closed.
        </p>
        {DAYS.map((d) => (
          <TextField key={d} label={dayName(d)} value={v.hours[d] ?? ""} onChange={(e) => setV((p) => ({ ...p, hours: { ...p.hours, [d]: e.target.value } }))} error={errors[`h${d}`]} />
        ))}
        <TextArea label="Closed days (festivals)" hint="One per line: 2026-10-21 | Dashain" value={v.closures} onChange={(e) => set("closures", e.target.value)} error={errors.closures} />
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="font-display text-xl">Prices and tax</legend>
        <CheckField label="Prices already include 13% VAT" hint="Ask the cafe's accountant if unsure." checked={v.pricesIncludeVat} onChange={(e) => set("pricesIncludeVat", e.target.checked)} />
        <TextField label="Service charge (%)" inputMode="decimal" value={v.serviceChargePct} onChange={(e) => set("serviceChargePct", e.target.value)} error={errors.serviceChargePct} />
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="font-display text-xl">Shop orders</legend>
        <p className="text-ink-muted text-sm">Customers pay in cash only. There is no online payment.</p>
        <CheckField label="Delivery, pay cash on delivery" checked={v.cod} onChange={(e) => set("cod", e.target.checked)} />
        <CheckField label="Pickup at the cafe, pay cash at pickup" checked={v.pickup} onChange={(e) => set("pickup", e.target.checked)} />
        {errors.payment ? <p className="text-danger text-sm font-semibold">{errors.payment}</p> : null}
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField label="Delivery fee (Rs.)" required inputMode="decimal" value={v.deliveryFee} onChange={(e) => set("deliveryFee", e.target.value)} error={errors.deliveryFee} />
          <TextField label="Minimum order, delivery (Rs.)" inputMode="decimal" hint="0 means none." value={v.minOrderDelivery} onChange={(e) => set("minOrderDelivery", e.target.value)} error={errors.minOrderDelivery} />
          <TextField label="Minimum order, pickup (Rs.)" inputMode="decimal" hint="0 means none." value={v.minOrderPickup} onChange={(e) => set("minOrderPickup", e.target.value)} error={errors.minOrderPickup} />
          <TextField label="Largest cash order (Rs.)" inputMode="decimal" hint="Bigger orders are declined online. 0 or empty means no limit." value={v.codMaxTotal} onChange={(e) => set("codMaxTotal", e.target.value)} error={errors.codMaxTotal} />
          <TextField label="Open orders per phone" required inputMode="numeric" hint="1 to 5." value={v.maxOpen} onChange={(e) => set("maxOpen", e.target.value)} error={errors.maxOpen} />
          {hasAbuseRules ? (
            <>
              <TextField
                label="Open orders per device"
                required
                inputMode="numeric"
                hint="Orders not yet finished from one internet connection. 1 to 100."
                value={v.ipOpen}
                onChange={(e) => set("ipOpen", e.target.value)}
                error={errors.ipOpen}
              />
              <TextField
                label="Orders per device per day"
                required
                inputMode="numeric"
                hint="Includes cancelled orders. 1 to 1000."
                value={v.ipDay}
                onChange={(e) => set("ipDay", e.target.value)}
                error={errors.ipDay}
              />
              <TextField
                label="Auto-cancel unconfirmed after (minutes)"
                inputMode="numeric"
                hint="Orders nobody confirmed by phone are cancelled and restocked. 15 to 10080. Empty turns it off."
                value={v.autoCancel}
                onChange={(e) => set("autoCancel", e.target.value)}
                error={errors.autoCancel}
              />
            </>
          ) : null}
        </div>
        <TextArea
          label="Delivery areas"
          required={v.cod}
          hint="One per line. Customers choose from this list. Needed while delivery is on."
          value={v.deliveryAreas}
          onChange={(e) => set("deliveryAreas", e.target.value)}
          error={errors.deliveryAreas}
        />
      </fieldset>

      {hasTableRules ? (
        <fieldset className="space-y-4">
          <legend className="font-display text-xl">Table orders</legend>
          <TextField
            label="Staff can cancel an accepted order for (minutes)"
            required
            inputMode="numeric"
            hint="After the kitchen accepts a table's order, staff can cancel it for this long; after that only the owner can. 0 to 60. You get an alert for every cancelled accepted order."
            value={v.cancelWindow}
            onChange={(e) => set("cancelWindow", e.target.value)}
            error={errors.cancelWindow}
          />
          <p className="text-ink-muted text-sm">Owner alerts appear under Admin &gt; Alerts. Phone alerts are not set up yet.</p>
        </fieldset>
      ) : null}

      {/* design review fix 8: the result sits next to Save (the form is ~4 screens tall). On phones the bar sticks to
          the bottom of the screen. ASSUMPTION: one live region here instead of a second, screen-reader-only one at
          the top, so the result is announced once. */}
      <div className="bg-surface-raised border-line sticky bottom-0 -mx-4 flex flex-wrap items-center gap-3 border-t px-4 py-3 md:static md:mx-0 md:border-0 md:bg-transparent md:p-0">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving..." : "Save settings"}
        </Button>
        <div role="status" aria-live="polite" className="min-w-0 flex-1">
          {msg ? (
            <p className={`text-sm font-semibold ${msg.ok ? "text-success" : "text-danger"}`}>
              {msg.ok ? "" : "Not saved: "}
              {msg.text}
            </p>
          ) : null}
        </div>
      </div>
    </form>
  );
}
