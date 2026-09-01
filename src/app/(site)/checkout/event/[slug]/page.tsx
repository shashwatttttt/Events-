import { notFound, redirect } from "next/navigation";
import { CheckoutBuilder } from "@/components/CheckoutBuilder";
import { requirePageUser } from "@/lib/auth";
import { readSiteData } from "@/lib/data/documents";
import { canStartCheckout, isSalesWindowOpen } from "@/lib/event-state";
import { hasEventPasswordAccess } from "@/lib/event-access";
import { POST_CHECKOUT_MODE } from "@/lib/post-approval/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Event checkout" };

export default async function DirectCheckout({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await requirePageUser(`/checkout/event/${slug}`, ["customer"]);
  const site = await readSiteData();
  const event = site.events.find(
    (item) => item.slug === slug
      && ["direct_purchase", "free_rsvp", POST_CHECKOUT_MODE].includes(String(item.ticketMode))
      && canStartCheckout(item),
  );
  if (!event) notFound();
  if (!(await hasEventPasswordAccess(event))) redirect(`/events/${event.slug}`);
  const products = site.products.filter((item) => event.productIds.includes(item.id)
    && item.eventId === event.id
    && !item.requiresApproval
    && isSalesWindowOpen(item));

  return (
    <section className="checkout-page">
      <div className="shell checkout-grid">
        <div>
          <h1>{event.title}</h1>
        </div>
        <CheckoutBuilder event={event} products={products} />
      </div>
    </section>
  );
}
