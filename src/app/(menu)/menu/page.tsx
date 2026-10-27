import type { Metadata } from "next";
import { MenuView } from "@/components/menu/menu-view";
import { Container } from "@/components/site/page-parts";
import { fallbackSnapshot } from "@/components/menu/fallback";
import { isMock } from "@/data-access/mode";
import { getMenuSnapshot } from "@/data-access/public-server";
import type { MenuSnapshot } from "@/types/contract";

export const metadata: Metadata = {
  title: "Menu",
  description: "The live menu at Nailed Cafe & Lodge.",
};

// ISR page. Safety-net revalidate is long on purpose (Workers KV free write limit);
// on-demand revalidateTag("menu") from the admin actions is the primary refresh.
export const revalidate = 3600;

export default async function MenuPage() {
  let snapshot: MenuSnapshot;
  let fromFallback = false;
  try {
    snapshot = await getMenuSnapshot();
  } catch {
    snapshot = fallbackSnapshot();
    fromFallback = true;
  }
  return (
    <main className="pt-4">
      <Container width="reading" className="lg:max-w-page">
        <MenuView initial={snapshot} fromFallback={fromFallback} showSampleBanner={isMock} />
      </Container>
    </main>
  );
}
