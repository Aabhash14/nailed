import type { Metadata } from "next";
import { DraftNote } from "@/components/ui/feedback";
import { Container, PageHeader } from "@/components/site/page-parts";

export const metadata: Metadata = { title: "Order and privacy policies" };

const SECTIONS = [
  {
    id: "p-pay",
    title: "How you pay",
    body: "We take cash only. Choose delivery and you pay cash on delivery. Choose pickup and you pay cash when you collect your order. There is no online payment on this site.",
  },
  {
    id: "p-confirm",
    title: "We call to confirm every order",
    body: "After you order we will call the phone number you gave to confirm. Please keep your phone nearby. If we cannot reach you, we may cancel the order.",
  },
  {
    id: "p-cancel",
    title: "Cancelling or changing an order",
    body: "You can cancel from your order page until we have confirmed it. After that, please call us. [Placeholder: the cafe's rules for returns and exchanges after handover.]",
  },
  {
    id: "p-limits",
    title: "Order limits",
    body: "To prevent misuse we may limit how many open orders one phone number can have, and we may decline some orders. If we cannot take your order online, please call us.",
  },
  {
    id: "p-privacy",
    title: "What we keep about you",
    body: "For an order we keep your name, phone number, address (for delivery) and what you ordered, so that we can deliver it and call you. Only cafe staff can see it. [Placeholder: how long we keep it, and who to contact to remove it.]",
  },
];

export default function PoliciesPage() {
  return (
    <main className="pt-section-sm">
      <Container className="space-y-stack">
        <PageHeader title="Order and privacy policies">
          <div className="flex justify-center pt-2">
            <DraftNote>
              DRAFT. This describes how the site works today. The wording has not been reviewed by
              the legal role or approved by the cafe. Do not publish as final.
            </DraftNote>
          </div>
        </PageHeader>

        <div className="grid gap-10 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-16">
          <nav aria-label="On this page" className="hidden lg:block">
            <ol className="border-line sticky top-6 space-y-1 border-l pl-4 text-sm">
              {SECTIONS.map((s, i) => (
                <li key={s.id}>
                  <a
                    href={`#${s.id}`}
                    className="text-ink-muted hover:text-primary min-h-tap flex items-center gap-2 transition-colors duration-(--motion-base)"
                  >
                    <span className="font-display tabular-nums">{i + 1}.</span> {s.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
          <div className="max-w-reading divide-line divide-y">
            {SECTIONS.map((s, i) => (
              <section key={s.id} aria-labelledby={s.id} className="space-y-3 py-6 first:pt-0">
                <h2
                  id={s.id}
                  className="font-display text-title-3 flex scroll-mt-6 items-baseline gap-3"
                >
                  <span aria-hidden="true" className="text-primary tabular-nums">
                    {i + 1}.
                  </span>
                  {s.title}
                </h2>
                <p className="text-body leading-relaxed">{s.body}</p>
              </section>
            ))}
          </div>
        </div>
      </Container>
    </main>
  );
}
