import type { Metadata } from "next";
import { DraftNote } from "@/components/ui/feedback";
import { Picture } from "@/components/ui/media";
import { ACCENT, devanagariNumeral } from "@/components/site/accents";
import { Container, PageHeader } from "@/components/site/page-parts";

export const metadata: Metadata = { title: "Our story" };

/** Chapter heading: Devanagari numeral in a diamond (decorative) + the h2. */
function Chapter({ n, id, title }: { n: number; id: string; title: string }) {
  return (
    <div className="flex items-center gap-4">
      <span aria-hidden="true" lang="ne" className="numeral-diamond font-deva ml-1 text-base">
        <span>{devanagariNumeral(n)}</span>
      </span>
      <h2 id={id} className="font-display text-title-2">
        {title}
      </h2>
    </div>
  );
}

export default function StoryPage() {
  return (
    <main className="pt-section-sm">
      <Container className="space-y-section-sm">
        <PageHeader
          title="Our story"
          accent={ACCENT.story}
          intro="Nailed Cafe & Lodge is on Uphar Marg, Baluwatar, Kathmandu."
        >
          <div className="flex justify-center pt-2">
            <DraftNote>
              the cafe has not given us its story yet. Nothing on this page is a fact about the cafe
              except its name and address. The content writer fills it in from the client&apos;s own
              words.
            </DraftNote>
          </div>
        </PageHeader>

        <section
          aria-labelledby="story-people"
          className="grid items-center gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] md:gap-12"
        >
          <div className="space-y-4">
            <Chapter n={1} id="story-people" title="The people" />
            <p className="text-ink-muted text-lead">
              [Placeholder: who runs the cafe and why they started it.]
            </p>
          </div>
          <div className="border-line bg-surface-raised rounded-card shadow-card border p-2">
            <Picture
              url={null}
              variants={[]}
              alt=""
              sizes="(min-width: 768px) 416px, 100vw"
              shotId="P-01"
              placeholderLabel="the people"
              ratio="aspect-[4/3]"
            />
          </div>
        </section>

        {/* R24-2: no band here; the frame below is this view's craft detail, and the section spacing separates them */}

        <section aria-labelledby="story-place" className="space-y-6">
          <div className="max-w-reading space-y-4">
            <Chapter n={2} id="story-place" title="The place" />
            <p className="text-ink-muted text-lead">
              [Placeholder: the room, the art on the walls, community events, the lodge.]
            </p>
          </div>
          {/* Design review T-048 section 5, S25-10: 21:9 on desktop, 4:3 on phones (same file, centre-cropped). */}
          <div className="frame-window mx-2 md:mx-8">
            <Picture
              url={null}
              variants={[]}
              alt=""
              sizes="(min-width: 1280px) 1150px, 100vw"
              shotId="H-03"
              placeholderLabel="the room, wide"
              ratio="aspect-[4/3] md:aspect-[21/9]"
            />
          </div>
        </section>
      </Container>
    </main>
  );
}
