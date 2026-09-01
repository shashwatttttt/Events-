import type { Metadata } from "next";
import Link from "next/link";
import { getCustomerWorkspace } from "@/lib/operations";
import { retrieveStripeOrder } from "@/lib/payments";
import { getCurrentUser } from "@/lib/security/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {title:"Payment status"};

export default async function PaymentSuccess({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string; order?: string }>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  let confirmed = false;

  if (user) {
    const workspace = await getCustomerWorkspace(user.id);
    if (params.order) {
      const order = workspace.orders.find((item) => item.id === params.order);
      confirmed = Boolean(order && ["paid", "fulfilled"].includes(order.status));
    } else if (params.session_id) {
      const result = await retrieveStripeOrder(params.session_id);
      confirmed = Boolean(
        result?.order
        && workspace.orders.some((item) => item.id === result.order?.id)
        && ["paid", "fulfilled"].includes(result.order.status),
      );
    }
  }

  return (
    <section className="success-page">
      <div className="shell narrow-shell" role="status" aria-live="polite" aria-atomic="true">
        <p className="eyebrow"><span aria-hidden="true" />Payment update</p>
        <h1>{confirmed ? "You are in." : "Payment processing."}</h1>
        <p>
          {confirmed
            ? "Your verified checkout is fulfilled and your QR ticket is ready in your account."
            : "We are waiting for verified checkout confirmation. Your ticket will appear only after fulfilment completes."}
        </p>
        <div className="success-actions">
          <Link href={user ? "/account" : "/login"} className="button button-primary">Open my account</Link>
          <Link href="/events" className="button button-ghost">Back to events</Link>
        </div>
      </div>
    </section>
  );
}
