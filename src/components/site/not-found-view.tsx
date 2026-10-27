import Link from "next/link";
import { LinkButton } from "@/components/ui/button";
import { Container } from "./page-parts";

export function NotFoundView() {
  return (
    <main className="pt-section">
      <Container width="narrow" className="rise-stagger space-y-5 text-center">
        <p
          aria-hidden="true"
          className="font-display text-primary/80 text-[clamp(4.5rem,3rem+8vw,8rem)] leading-none tracking-[0.04em]"
        >
          404
        </p>
        <h1 className="font-display text-title-1">Page not found</h1>
        <p className="text-ink-muted text-lead">Check the link, or ask us at the counter.</p>
        <div aria-hidden="true" className="ornament-rule">
          <i />
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3 pt-2">
          <LinkButton href="/" size="lg">
            Go to the home page
          </LinkButton>
          <Link
            href="/menu"
            className="text-primary min-h-tap link-underline inline-flex items-center font-semibold"
          >
            See the menu
          </Link>
        </div>
      </Container>
    </main>
  );
}
