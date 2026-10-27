import { Banner } from "@/components/ui/feedback";
import { buttonClass, LinkButton } from "@/components/ui/button";
import { telHref } from "@/components/format";

/**
 * Shown on cart and checkout while the owner has paused online orders (SEC-003 kill switch, error ORDERS_PAUSED).
 * Design review T-048 fix 23: the phone is a 44 px button, and with no phone set the notice points to /visit.
 */
export function OrdersPausedNotice({ phone }: { phone: string | null }) {
  return (
    <Banner tone="warning" live="status" title="Online orders are paused">
      <p>
        We are not taking online orders right now. Your cart is saved.{" "}
        {phone ? "Please call us to order, or try again later." : "Please call the cafe to order, or try again later."}
      </p>
      <div className="mt-3">
        {phone ? (
          <a href={telHref(phone)} className={buttonClass("primary")}>
            Call {phone}
          </a>
        ) : (
          <LinkButton href="/visit" variant="secondary">
            See how to reach us
          </LinkButton>
        )}
      </div>
    </Banner>
  );
}
