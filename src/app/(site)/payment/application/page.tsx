import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PostCheckoutApplicationClient } from "@/components/PostCheckoutApplicationClient";
import { loadOwnedPostCheckoutApplication } from "@/lib/post-approval/service";
import { getPostCheckoutStatusForStripeSession } from "@/lib/post-approval/status";
import { getCurrentUser } from "@/lib/security/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Mandatory ticket application" };

export default async function PostCheckoutApplicationPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string; order?: string }>;
}) {
  const user = await getCurrentUser();
  const params = await searchParams;
  const returnPath = params.session_id
    ? `/payment/application?session_id=${encodeURIComponent(params.session_id)}`
    : params.order ? `/payment/application?order=${encodeURIComponent(params.order)}` : "/account";
  if (!user) redirect(`/login?next=${encodeURIComponent(returnPath)}`);
  const result = params.session_id
    ? await getPostCheckoutStatusForStripeSession(params.session_id, user.id)
    : params.order ? await loadOwnedPostCheckoutApplication(params.order, user.id) : null;

  if (!result) {
    return <section className="success-page"><div className="shell narrow-shell"><p className="eyebrow"><span aria-hidden="true" />Payment update</p><h1>Application is being prepared.</h1><p>Stripe confirmation may still be processing. Open your account shortly to continue the mandatory application. No ticket is issued before the form is reviewed and payment is captured.</p><div className="success-actions"><Link className="button button-primary" href="/account">Open my account</Link><Link className="button button-ghost" href="/events">Back to events</Link></div></div></section>;
  }

  return <section className="application-page"><div className="shell narrow-shell"><p className="eyebrow"><span aria-hidden="true" />Payment authorised</p><h1>One final step is mandatory.</h1><p className="page-lead">Complete the application below to be considered for entry. Your card is only authorised at this stage and no ticket exists yet.</p><PostCheckoutApplicationClient initialApplication={result.application} eventTitle={result.event?.title || "your SKIE event"} /></div></section>;
}
