import { getFallbackMenu } from "@/lib/data/menu-fallback";
import type { MenuCategory, MenuSnapshot } from "@/types/contract";

/** Break-glass menu: the repo snapshot (backend's getFallbackMenu), refreshed by scripts/export-menu-fallback.ts. */
export function fallbackSnapshot(): MenuSnapshot {
  const fb = getFallbackMenu();
  return {
    categories: fb.categories as unknown as MenuCategory[],
    specials: [],
    settings: {
      hours: {
        weekly: { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null },
        closures: [],
      },
      announcement: null,
      pricesIncludeVat: true, // ASSUMPTION: matches the default in settings until the client answers
      serviceChargePct: 0,
      vatPct: 13,
      // 2.0.0: the break-glass menu never offers table ordering (the database is unreachable when it is shown). A
      // snapshot file without the key also reads as "off" everywhere (tableOrderingOf in src/types/contract.ts).
      tableOrdering: "off",
    },
    tables: null,
    updatedAt: fb.generatedAt ?? new Date(0).toISOString(),
    degraded: true,
  };
}
