"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { formatNpr } from "@/lib/money";
import { Button, LinkButton } from "@/components/ui/button";
import { Banner, EmptyState, Skeleton } from "@/components/ui/feedback";
import { SelectField, TextArea, TextField } from "@/components/ui/field";
import { isMock } from "@/data-access/mode";
import { mockSettingsForBrowser, submitCheckout } from "@/data-access/public-client";
import { telHref } from "@/components/format";
import {
  isOrdersPausedError,
  ordersArePaused,
  type Fulfilment,
  type PublicSettings,
} from "@/types/contract";
import { estimateTotals } from "./cart-logic";
import { useCart } from "./cart-provider";
import {
  availableFulfilments,
  buildRequest,
  mapServerFieldErrors,
  payLine,
  refusedMessage,
  validateCheckout,
  type CheckoutValues,
  type FieldErrors,
} from "./checkout-logic";
import { OrdersPausedNotice } from "./orders-paused";
import { botCheckFailedMessage, CHECKOUT_TICK_MESSAGE } from "./turnstile-logic";
import { TurnstileSlot, useTurnstileGate } from "./turnstile-slot";

/** S25-2: the bot check runs invisibly, so "Place order" may be pressed before its token is back. Wait this long for it. */
const TOKEN_WAIT_MS = 10_000;

const legendClass = "font-display text-title-3 flex items-center gap-3 pb-1";

/** Decorative step number for the checkout sections (the legend text carries the meaning). */
function StepNumber({ n }: { n: number }) {
  return (
    <span aria-hidden="true" className="numeral-diamond font-display ml-1 text-sm">
      <span>{n}</span>
    </span>
  );
}

const EMPTY: CheckoutValues = {
  fulfilment: "pickup",
  name: "",
  phone: "",
  email: "",
  address: "",
  landmark: "",
  area: "",
  notes: "",
};

export function CheckoutForm({ settings: serverSettings }: { settings: PublicSettings }) {
  const router = useRouter();
  const cart = useCart();
  const [settings, setSettings] = useState(serverSettings);
  const [values, setValues] = useState<CheckoutValues>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [lineErrors, setLineErrors] = useState<Record<number, string>>({});
  const [formError, setFormError] = useState<{ message: string; refused?: boolean } | null>(null);
  // BUG-019: a token or "Try again" clears an old bot-check error.
  const clearBotError = useCallback(
    () => setErrors((p) => (p.turnstile ? Object.fromEntries(Object.entries(p).filter(([k]) => k !== "turnstile")) : p)),
    [],
  );
  // Turnstile: the token (a ref inside the gate, nothing renders from it) plus the submits waiting for it.
  const gate = useTurnstileGate(clearBotError);
  // After a failed bot check the slot moves focus to "Try again", so the summary must not take it back.
  const keepFocusOnSlot = useRef(false);
  const [busy, setBusy] = useState(false);
  const [pausedByServer, setPausedByServer] = useState(false);
  const summary = useRef<HTMLDivElement>(null);

  // Mock mode: the demo settings (edited in /admin/settings) live in this browser.
  useEffect(() => {
    if (isMock) setSettings(mockSettingsForBrowser());
  }, []);

  const options = availableFulfilments(settings);
  const fulfilment: Fulfilment = options.includes(values.fulfilment)
    ? values.fulfilment
    : (options[0] ?? "pickup");
  const totals = estimateTotals(cart.lines, fulfilment, settings);
  const set = <K extends keyof CheckoutValues>(k: K, v: CheckoutValues[K]) =>
    setValues((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    if (keepFocusOnSlot.current) {
      keepFocusOnSlot.current = false;
      return;
    }
    if ((formError || Object.keys(errors).length > 0) && summary.current) summary.current.focus();
  }, [formError, errors]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const v = { ...values, fulfilment };
    const found = validateCheckout(v, cart.lines, settings, totals.subtotal);
    setErrors(found);
    setLineErrors({});
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    // The token is still required before anything is sent; the server verifies it exactly as before.
    // A check that has already failed answers at once; otherwise wait for the invisible widget's token.
    const t = await gate.getToken(TOKEN_WAIT_MS);
    if (t.token === null) {
      setBusy(false);
      if (t.reason === "failed") {
        // BUG-019: nothing to tick. The slot shows the message with "Try again" and has moved focus to it.
        keepFocusOnSlot.current = true;
        setErrors({ turnstile: botCheckFailedMessage(settings.phone) });
      } else setErrors({ turnstile: CHECKOUT_TICK_MESSAGE }); // the widget is on screen and waiting for a tick
      return;
    }
    const res = await submitCheckout(buildRequest(v, cart.lines, t.token));
    setBusy(false);

    if (res.ok) {
      cart.clear();
      router.push(`/order/${res.data.orderToken}?placed=1`);
      return;
    }
    if (isOrdersPausedError(res.error)) {
      setPausedByServer(true); // the owner paused orders after this page loaded
      return;
    }
    const { code, message, fieldErrors } = res.error;
    const mapped = mapServerFieldErrors(fieldErrors);
    setErrors(mapped.fields);
    setLineErrors(mapped.lines);
    if (code === "ORDER_REFUSED")
      setFormError({ message: refusedMessage(settings.phone), refused: true });
    else if (code === "OUT_OF_STOCK")
      setFormError({
        message:
          "Some items are not available in the quantity you chose. See the notes in your order below.",
      });
    else if (code === "BOT_CHECK_FAILED")
      setFormError({ message: "The bot check did not pass. Please try again." });
    else setFormError({ message });
  }

  if (!cart.ready) {
    return (
      <div aria-busy="true" aria-label="Loading checkout" className="space-y-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (cart.lines.length === 0) {
    return (
      <EmptyState
        title="Your cart is empty"
        action={<LinkButton href="/shop">Browse the shop</LinkButton>}
      >
        Add something from the shop before checking out.
      </EmptyState>
    );
  }

  if (ordersArePaused(settings) || pausedByServer) {
    return (
      <div className="space-y-4">
        <OrdersPausedNotice phone={settings.phone} />
        <LinkButton href="/cart" variant="secondary">
          Back to your cart
        </LinkButton>
      </div>
    );
  }

  if (options.length === 0) {
    return (
      <Banner tone="warning" title="Online ordering is not available right now">
        Please call us to order{settings.phone ? ` on ${settings.phone}` : ""}.
      </Banner>
    );
  }

  const errorList = Object.entries(errors).filter(([, m]) => m);

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start"
    >
      <div className="space-y-6">
        <div ref={summary} tabIndex={-1} className="outline-none" aria-live="assertive">
          {formError ? (
            <Banner
              tone="danger"
              live="alert"
              title={
                formError.refused
                  ? "We cannot take this order online"
                  : "We could not place your order"
              }
            >
              {formError.message}
              {formError.refused && settings.phone ? (
                <>
                  {" "}
                  <a href={telHref(settings.phone)} className="font-semibold underline">
                    Call {settings.phone}
                  </a>
                </>
              ) : null}
            </Banner>
          ) : null}
          {!formError && errorList.length > 0 ? (
            <Banner
              tone="danger"
              live="alert"
              title={
                // BUG-019: a bot-check problem alone highlights no field
                errorList.length === 1 && errorList[0]![0] === "turnstile"
                  ? "We could not place your order"
                  : "Please fix the highlighted fields"
              }
            >
              <ul className="list-disc pl-5">
                {errorList.map(([k, m]) => (
                  <li key={k}>{m}</li>
                ))}
              </ul>
            </Banner>
          ) : null}
        </div>

        <fieldset className="space-y-3">
          <legend className={legendClass}>
            <StepNumber n={1} />
            How do you want it?
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {options.map((o) => (
              <label
                key={o}
                className="border-line-strong bg-surface-raised has-[:checked]:border-primary has-[:checked]:ring-primary rounded-card min-h-tap hover:border-ink flex cursor-pointer items-start gap-3 border p-4 transition-[border-color,box-shadow] duration-(--motion-fast) has-[:checked]:ring-2"
              >
                <input
                  type="radio"
                  name="fulfilment"
                  value={o}
                  checked={fulfilment === o}
                  onChange={() => set("fulfilment", o)}
                  className="accent-primary mt-1 h-5 w-5"
                />
                <span>
                  <span className="block font-semibold">
                    {o === "delivery" ? "Delivery" : "Pickup at the cafe"}
                  </span>
                  <span className="text-ink-muted block text-sm">
                    {o === "delivery"
                      ? `Pay cash on delivery. Delivery fee ${formatNpr(settings.deliveryFee)}.`
                      : "Pay cash when you collect it."}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className={legendClass}>
            <StepNumber n={2} />
            About you
          </legend>
          <TextField
            label="Name"
            required
            autoComplete="name"
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            error={errors.name}
          />
          <TextField
            label="Phone"
            required
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            hint="We will call this number to confirm your order."
            value={values.phone}
            onChange={(e) => set("phone", e.target.value)}
            error={errors.phone}
          />
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            hint="Optional. We email you once we have confirmed your order by phone."
            value={values.email}
            onChange={(e) => set("email", e.target.value)}
            error={errors.email}
          />
        </fieldset>

        {fulfilment === "delivery" ? (
          <fieldset className="space-y-4">
            <legend className={legendClass}>
              <StepNumber n={3} />
              Delivery address
            </legend>
            <SelectField
              label="Area"
              required
              value={values.area}
              onChange={(e) => set("area", e.target.value)}
              error={errors.area}
            >
              <option value="">Choose your area</option>
              {settings.deliveryAreas.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </SelectField>
            <TextField
              label="Address"
              required
              autoComplete="street-address"
              value={values.address}
              onChange={(e) => set("address", e.target.value)}
              error={errors.address}
            />
            <TextField
              label="Landmark"
              required
              hint="A nearby shop, temple or building."
              value={values.landmark}
              onChange={(e) => set("landmark", e.target.value)}
              error={errors.landmark}
            />
          </fieldset>
        ) : null}

        <TextArea
          label="Notes for us"
          maxLength={300}
          value={values.notes}
          onChange={(e) => set("notes", e.target.value)}
          error={errors.notes}
        />
      </div>

      <aside
        aria-labelledby="sum"
        className="border-line bg-surface-raised rounded-card shadow-card relative h-fit space-y-4 overflow-hidden border p-5 pt-6 lg:sticky lg:top-6"
      >
        <div aria-hidden="true" className="ornament-band-sm absolute inset-x-0 top-0" />
        <h2 id="sum" className="font-display text-title-3">
          Your order
        </h2>
        <ul className="space-y-2">
          {cart.lines.map((l, i) => (
            <li key={l.variantId} className="text-sm">
              <div className="flex justify-between gap-2">
                <span>
                  {l.qty} x {l.productName} ({l.size}, {l.colour})
                </span>
                <span className="price">{formatNpr(l.unitPrice * l.qty)}</span>
              </div>
              {lineErrors[i] ? (
                <p className="text-danger font-semibold">Problem: {lineErrors[i]}</p>
              ) : null}
            </li>
          ))}
        </ul>
        <p className="text-sm">
          <Link href="/cart" className="text-primary underline">
            Change your cart
          </Link>
        </p>
        <dl className="border-line space-y-1.5 border-t pt-3 tabular-nums">
          <div className="flex justify-between">
            <dt>Subtotal</dt>
            <dd>{formatNpr(totals.subtotal)}</dd>
          </div>
          {fulfilment === "delivery" ? (
            <div className="flex justify-between">
              <dt>Delivery fee</dt>
              <dd>{formatNpr(totals.deliveryFee)}</dd>
            </div>
          ) : null}
          {totals.vat > 0 ? (
            <div className="flex justify-between">
              <dt>VAT ({settings.vatPct}%)</dt>
              <dd>{formatNpr(totals.vat)}</dd>
            </div>
          ) : null}
          <div className="border-ink mt-2 flex items-baseline justify-between border-t-2 pt-2 text-lg font-semibold">
            <dt>Total</dt>
            <dd className="price text-2xl">{formatNpr(totals.total)}</dd>
          </div>
        </dl>
        {errors.items ? <p className="text-danger text-sm font-semibold">{errors.items}</p> : null}
        <p className="font-semibold">{payLine(totals.total, fulfilment)}</p>
        <p className="text-sm">
          We will call you to confirm your order. Please keep your phone nearby.
        </p>
        <p className="text-ink-muted text-sm">
          {totals.vatIncluded ? `Prices include ${settings.vatPct}% VAT. ` : ""}The cafe confirms
          the final total when it calls.
        </p>

        <TurnstileSlot
          ref={gate.slot}
          onToken={gate.onToken}
          onFail={gate.onFail}
          onRetry={gate.onRetry}
          phone={settings.phone}
        />
        {errors.turnstile === CHECKOUT_TICK_MESSAGE ? (
          <p className="text-danger text-sm font-semibold">{errors.turnstile}</p>
        ) : null}

        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          {busy ? "Placing your order..." : "Place order"}
        </Button>
        <p className="text-ink-muted text-xs">
          By ordering you agree to our{" "}
          <Link href="/policies" className="underline">
            order policies
          </Link>
          .
        </p>
      </aside>
    </form>
  );
}
