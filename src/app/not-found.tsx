import { NotFoundView } from "@/components/site/not-found-view";
import { SiteShell } from "@/components/site/site-shell";

export default function RootNotFound() {
  return (
    <SiteShell>
      <NotFoundView />
    </SiteShell>
  );
}
