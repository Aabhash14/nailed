import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DraftNote } from "@/components/ui/feedback";
import { buttonClass } from "@/components/ui/button";
import { Picture } from "@/components/ui/media";
import { hoursRows, safeHttpsUrl, telHref } from "@/components/format";
import { ACCENT } from "@/components/site/accents";
import { HoursTable } from "@/components/site/hours";
import { Container, PageHeader } from "@/components/site/page-parts";
import { getPublicSettingsSafe } from "@/data-access/public-server";

export const metadata: Metadata = { title: "Visit" };
export const revalidate = 3600;

function Card({
  id,
  title,
  children,
  className = "",
}: {
  id: string;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className={`border-line bg-surface-raised rounded-card shadow-card space-y-3 border p-4 md:p-5 ${className}`}
    >
      <h2 id={id} className="font-display text-title-3 flex items-center gap-3">
        <span aria-hidden="true" className="ornament-diamond text-primary" />
        {title}
      </h2>
      {children}
    </section>
  );
}

export default async function VisitPage() {
  const s = await getPublicSettingsSafe();
  const mapHref = safeHttpsUrl(s?.mapUrl); // SEC-012: never render javascript:/data:/http: links from settings
  const hasHours = s ? hoursRows(s.hours) !== null : false;
  return (
    <main className="pt-section-sm">
      <Container className="space-y-stack">
        <PageHeader title="Visit" accent={ACCENT.visit} />

        {/* S25-4: one grid. Phones read Address, Hours, Contact, then the entrance photo ("this is the door").
            From md the photo sits above the address on the left, hours and contact on the right. The photo is a
            role="img" placeholder with nothing focusable, so the focus order follows the DOM. */}
        <div className="grid gap-4 md:grid-cols-2 md:gap-6">
          <Card id="visit-address" title="Address" className="md:col-start-1 md:row-start-2">
            <p className="text-lead">{s?.address ?? "Uphar Marg, Baluwatar, Kathmandu"}</p>
            {s?.landmark ? (
              <p>Landmark: {s.landmark}</p>
            ) : (
              <p className="text-ink-muted">Landmark: to be added by the cafe.</p>
            )}
            {mapHref ? (
              <a href={mapHref} className={buttonClass("secondary")} rel="noopener noreferrer">
                Open in maps
              </a>
            ) : (
              <p className="text-ink-muted">Map link: to be added by the cafe.</p>
            )}
          </Card>

          <div className="space-y-4 md:col-start-2 md:row-span-2 md:row-start-1 md:space-y-6">
            <Card id="visit-hours" title="Opening hours">
              {s && hasHours ? (
                <HoursTable hours={s.hours} />
              ) : (
                <>
                  <p>Opening hours to be confirmed.</p>
                  <DraftNote>
                    the cafe has not confirmed its hours. They are entered in Admin, Settings.
                  </DraftNote>
                </>
              )}
              {s && s.hours.closures.length > 0 ? (
                <ul className="space-y-1.5">
                  {s.hours.closures.map((c) => (
                    <li key={c.date} className="flex gap-3">
                      <span aria-hidden="true" className="ornament-diamond text-accent mt-2" />
                      <span>
                        {c.date}: closed ({c.label})
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>

            <Card id="visit-contact" title="Contact">
              {s?.phone ? (
                <p>
                  Phone:{" "}
                  <a
                    className="text-primary font-semibold underline underline-offset-4"
                    href={telHref(s.phone)}
                  >
                    {s.phone}
                  </a>
                </p>
              ) : (
                <p className="text-ink-muted">Phone: to be added by the cafe.</p>
              )}
              {s?.whatsapp ? <p>WhatsApp: {s.whatsapp}</p> : null}
              {s?.email ? (
                <p>
                  Email:{" "}
                  <a
                    className="text-primary font-semibold underline underline-offset-4"
                    href={`mailto:${s.email}`}
                  >
                    {s.email}
                  </a>
                </p>
              ) : null}
            </Card>
          </div>

          {/* Entrance photo (shot E-01): 4:3 at every width. The sign must sit in the centre 75%. */}
          <div className="border-line bg-surface-raised rounded-card shadow-card border p-2 md:col-start-1 md:row-start-1">
            <Picture
              url={null}
              variants={[]}
              alt=""
              sizes="(min-width: 768px) 50vw, 100vw"
              shotId="E-01"
              placeholderLabel="the entrance from Uphar Marg"
              ratio="aspect-[4/3]"
            />
          </div>
        </div>
      </Container>
    </main>
  );
}
