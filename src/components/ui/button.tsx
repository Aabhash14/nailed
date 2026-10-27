import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, Ref } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost" | "inverse";
/** md = practical UI button (admin, forms). lg = display CTA (public hero and section calls to action). */
type Size = "md" | "lg";

const base =
  "inline-flex min-h-tap items-center justify-center gap-2 rounded-control text-center select-none transition-[background-color,color,border-color,box-shadow,transform] duration-(--motion-base) ease-soft active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0";

const sizes: Record<Size, string> = {
  md: "px-5 py-2 text-base font-semibold",
  lg: "min-h-[3.25rem] px-7 py-3 font-display text-label uppercase tracking-label",
};

const variants: Record<Variant, string> = {
  primary: "button-rule bg-primary text-on-primary hover:bg-primary-strong",
  secondary: "border border-primary bg-transparent text-primary hover:bg-surface-alt",
  danger: "bg-danger text-on-danger hover:opacity-90",
  ghost: "text-primary underline-offset-4 hover:underline",
  inverse: "border border-on-inverse bg-transparent text-on-inverse hover:bg-on-inverse hover:text-surface-inverse",
};

export function buttonClass(variant: Variant = "primary", extra = "", size: Size = "md"): string {
  return `${base} ${sizes[size]} ${variants[variant]} ${extra}`.trim();
}

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; ref?: Ref<HTMLButtonElement> }) {
  // React 19: `ref` arrives as a normal prop and is passed on with the rest (used for focus management)
  return <button type={type} className={buttonClass(variant, className, size)} {...rest} />;
}

export function LinkButton({
  variant = "primary",
  size = "md",
  className = "",
  ...rest
}: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link className={buttonClass(variant, className, size)} {...rest} />;
}
