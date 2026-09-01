import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PostCheckoutApplicationClient } from "@/components/PostCheckoutApplicationClient";
import { loadOwnedPostCheckoutApplication } from "@/lib/post-approval/service";
import { getCurrentUser } from "@/lib/security/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Complete application" };

export default async function AccountPostCheckoutApplicationPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const user = await getCurrentUser();
  const { orderId } = await params;
  if (!user) redirect(`/login?next=${encodeURIComponent(`/account/applications/${orderId}`)}`);
  const result = await loadOwnedPostCheckoutApplication(orderId, user.id);
  if (!result) notFound();
  return <section className="account-application-page"><div className="shell narrow-shell"><p className="eyebrow"><span aria-hidden="true" />Action required</p><h1>Complete your mandatory application.</h1><PostCheckoutApplicationClient initialApplication={result.application} eventTitle={result.event?.title || "your SKIE event"} /></div></section>;
}
