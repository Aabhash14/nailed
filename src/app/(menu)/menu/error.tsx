"use client";

import { MenuView } from "@/components/menu/menu-view";
import { fallbackSnapshot } from "@/components/menu/fallback";
import { Container } from "@/components/site/page-parts";

/** If rendering the live menu throws, show the break-glass menu from the repo snapshot with the warning banner. */
export default function MenuError() {
  return (
    <main className="pt-4">
      <Container width="reading">
        <MenuView initial={fallbackSnapshot()} fromFallback />
      </Container>
    </main>
  );
}
