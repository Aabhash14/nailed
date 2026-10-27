import { hoursRows } from "@/components/format";
import type { OpeningHours } from "@/types/contract";

/** Opening hours as a ruled table (concept C: soot top rule, hairline rows, display-face times). Null = nothing entered. */
export function HoursTable({ hours, className = "" }: { hours: OpeningHours; className?: string }) {
  const rows = hoursRows(hours);
  if (!rows) return null;
  return (
    <table className={`border-ink w-full border-t-2 text-left ${className}`}>
      <caption className="sr-only">Opening hours by day</caption>
      <tbody>
        {rows.map((r) => (
          <tr key={r.day} className="border-line border-b">
            <th scope="row" className="py-2 pr-4 font-semibold">
              {r.day}
            </th>
            <td
              className={`py-2 text-right font-semibold tabular-nums ${r.text === "Closed" ? "text-ink-muted font-normal" : ""}`}
            >
              {r.text}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
