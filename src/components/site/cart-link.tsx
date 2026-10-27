"use client";

import Link from "next/link";
import { useCart } from "@/components/shop/cart-provider";

export function CartLink() {
  const { count, ready } = useCart();
  return (
    <Link
      href="/cart"
      className="group min-h-tap rounded-pill border-line text-ink hover:border-primary hover:text-primary bg-surface-raised/60 inline-flex items-center gap-2 border px-3.5 font-semibold transition-colors duration-(--motion-base)"
    >
      Cart
      <span
        aria-label={ready ? `${count} items in cart` : "cart loading"}
        className="bg-primary text-on-primary rounded-pill grid h-6 min-w-6 place-items-center px-1.5 text-sm leading-none tabular-nums"
      >
        {ready ? count : "-"}
      </span>
    </Link>
  );
}
