import { notFound } from "next/navigation";
import { CheckoutBuilder } from "@/components/CheckoutBuilder";
import { requirePageUser } from "@/lib/auth";
import { config } from "@/lib/config";
import { readOperationsData, readSiteData } from "@/lib/data/documents";
import { canStartCheckout, isSalesWindowOpen } from "@/lib/event-state";
import { formatDateTime } from "@/lib/format";
import { getNormalizedAllocation } from "@/lib/payments/transaction-store";

export const dynamic = "force-dynamic";
export const metadata = { title: "Checkout" };

function allocationIsCurrent(expiresAt: string) {
  return new Date(expiresAt).getTime() > Date.now();
}

export default async function AllocationCheckout({
  params,
}: {
  params: Promise<{ allocationId: string }>;
}) {
  const { allocationId } = await params;
  const user = await requirePageUser(`/checkout/${allocationId}`, ["customer"]);
  const site = await readSiteData();
  const allocation = config.dataProvider === "supabase"
    ? await getNormalizedAllocation(allocationId, user.id)
    : (await readOperationsData()).allocations.find((item) => item.id === allocationId && item.userId === user.id) || null;

  if (!allocation
    || !["unlocked", "checkout_started"].includes(allocation.status)
    || !allocationIsCurrent(allocation.expiresAt)) {
    notFound();
  }

  const event = site.events.find((item) => item.id === allocation.eventId && canStartCheckout(item));
  if (!event) notFound();
  const products = site.products.filter((item) => event.productIds.includes(item.id)
    && item.eventId === event.id
    && isSalesWindowOpen(item));

  return (
    <section className="checkout-page">
      <div className="shell checkout-grid">
        <div>
          <p className="eyebrow"><span />Unlocked checkout</p>
          <h1>Build your release.</h1>
          <p>
            Your allocation expires {formatDateTime(allocation.expiresAt, site.settings.timezone)}.
            The cart is lightweight and a payment session is created only when you continue.
          </p>
        </div>
        <CheckoutBuilder event={event} allocation={allocation} products={products} />
      </div>
    </section>
  );
}
