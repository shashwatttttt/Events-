import "server-only";

import { config } from "@/lib/config";
import { readSiteData } from "@/lib/data/documents";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type PostCheckoutAccountSummary = {
  id: string;
  orderId: string;
  eventId: string;
  eventTitle: string;
  status: string;
  paymentStatus: string;
  completionPercentage: number;
  formDueAt: string;
  captureBefore?: string;
  createdAt: string;
  totalCents: number;
  currency: string;
  requiresAction: boolean;
};

export async function listCustomerPostCheckoutApplications(customerId: string): Promise<PostCheckoutAccountSummary[]> {
  if (config.dataProvider !== "supabase") return [];
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_applications")
    .select("id,order_id,event_id,status,payment_status,completion_percentage,form_due_at,capture_before,created_at,orders(total_cents,currency)")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error("Post-checkout applications could not be loaded.");
  const site = await readSiteData();
  return (data || []).map((row) => {
    const joined = Array.isArray(row.orders) ? row.orders[0] : row.orders;
    const event = site.events.find((item) => item.id === String(row.event_id));
    const status = String(row.status);
    const paymentStatus = String(row.payment_status);
    return {
      id: String(row.id),
      orderId: String(row.order_id),
      eventId: String(row.event_id),
      eventTitle: event?.title || String(row.event_id),
      status,
      paymentStatus,
      completionPercentage: Number(row.completion_percentage || 0),
      formDueAt: String(row.form_due_at),
      captureBefore: row.capture_before ? String(row.capture_before) : undefined,
      createdAt: String(row.created_at),
      totalCents: Number(joined?.total_cents || 0),
      currency: String(joined?.currency || "AUD"),
      requiresAction: ["awaiting_form", "draft"].includes(status)
        && ["authorized", "not_required"].includes(paymentStatus),
    };
  });
}
