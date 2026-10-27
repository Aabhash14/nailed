"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { OpeningHours } from "@/types/contract";
import { openStatus, openStatusText, type OpenStatus } from "./open-status-logic";

/**
 * Small "Open now · until 21:00" / "Closed · opens 07:00" badge for the header.
 * Computed in the browser (Kathmandu time) and refreshed every minute, so cached pages never show a stale state.
 * Renders nothing until mounted, and nothing at all when the cafe has not entered its hours.
 */
export function OpenStatusBadge({ hours }: { hours: OpeningHours | null }) {
  const [status, setStatus] = useState<OpenStatus | null>(null);

  useEffect(() => {
    if (!hours) return;
    const tick = () => setStatus(openStatus(hours));
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, [hours]);

  if (!hours || !status) return null;
  const { short, detail } = openStatusText(status);
  const open = status.state === "open";
  const dot = open ? (status.closingSoon ? "bg-accent" : "bg-success") : "bg-ink-muted";

  return (
    <Link
      href="/visit"
      aria-label={`${short}${detail ? `, ${detail}` : ""}. Opening hours`}
      className="min-h-tap text-ink hover:text-primary inline-flex items-center gap-1.5 px-1 text-sm whitespace-nowrap transition-colors duration-(--motion-base)"
    >
      <span aria-hidden="true" className={`relative inline-flex h-2.5 w-2.5 rounded-full ${dot}`}>
        {open && !status.closingSoon ? (
          <span className="bg-success absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping" />
        ) : null}
      </span>
      <span className="font-semibold">{short}</span>
      {detail ? <span className="text-ink-muted hidden sm:inline">· {detail}</span> : null}
    </Link>
  );
}
