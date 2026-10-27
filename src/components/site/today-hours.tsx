"use client";

import { useEffect, useState } from "react";
import type { OpeningHours } from "@/types/contract";
import { todayHoursText } from "./open-status-logic";

/**
 * Home "Find us": today's hours on one line ("Today: 07:00 to 21:00" / "Closed today, opens …"). The page is cached,
 * so the day is worked out in the browser (Kathmandu time) and refreshed every minute, like the header badge. The line
 * keeps its height before it mounts, so nothing below it jumps. Renders nothing when no hours have been entered.
 */
export function TodayHours({ hours, className = "" }: { hours: OpeningHours; className?: string }) {
  const [text, setText] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const tick = () => setText(todayHoursText(hours));
    tick();
    setMounted(true);
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, [hours]);

  if (mounted && !text) return null;
  return (
    <p className={`min-h-[1lh] font-semibold tabular-nums ${className}`} data-testid="today-hours">
      {text}
    </p>
  );
}
