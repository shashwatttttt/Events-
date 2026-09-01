import "server-only";

import { config } from "@/lib/config";
import { readSiteData } from "@/lib/data/documents";
import { sendTemplateEmail } from "@/lib/email";
import {
  getPostCheckoutAdminItemById,
  listPostCheckoutAdminPage,
  type PostCheckoutAdminPageOptions,
} from "@/lib/post-approval/admin-page-store";
import { addPostCheckoutAudit } from "@/lib/post-approval/store";
import { customerFormTargetAt } from "@/lib/post-approval/types";

export async function listPostCheckoutApplicationsForAdminPage(
  options: PostCheckoutAdminPageOptions,
) {
  const [page, site] = await Promise.all([
    listPostCheckoutAdminPage(options),
    readSiteData(),
  ]);
  return {
    ...page,
    items: page.items.map((item) => {
      const event = site.events.find((candidate) => candidate.id === item.eventId);
      return {
        ...item,
        event: {
          title: event?.title || item.eventId,
          slug: event?.slug || item.eventId,
        },
      };
    }),
  };
}

export async function sendPostCheckoutFormReminderById(
  applicationId: string,
  requestedBy: string,
  final = false,
) {
  const item = await getPostCheckoutAdminItemById(applicationId);
  if (!item) throw new Error("Application not found.");
  if (!["awaiting_form", "draft"].includes(item.status)
    || !["authorized", "not_required"].includes(item.paymentStatus)) {
    throw new Error("This application no longer needs a form reminder.");
  }
  const site = await readSiteData();
  const event = site.events.find((candidate) => candidate.id === item.eventId);
  const templateKey = final
    ? "post_checkout_form_final_reminder"
    : "post_checkout_form_reminder";
  const resendBucket = Math.floor(Date.now() / (5 * 60_000));
  await sendTemplateEmail({
    templateKey,
    to: item.customer.email,
    recipientUserId: item.customerId,
    eventId: item.eventId,
    orderId: item.orderId,
    variables: {
      first_name: item.customer.firstName,
      event_title: event?.title || "your SKIE event",
      completion_percentage: item.completionPercentage,
      expires_at: new Date(customerFormTargetAt(item, config.postCheckoutCustomerUrgencyMinutes)).toLocaleString("en-AU", {
        timeZone: config.timezone,
      }),
      account_url: `${config.siteUrl}/account/applications/${encodeURIComponent(item.orderId)}`,
    },
    idempotencyKey: `${templateKey}:${item.id}:manual:${resendBucket}`,
  });
  await addPostCheckoutAudit({
    applicationId: item.id,
    orderId: item.orderId,
    actorId: requestedBy,
    action: final
      ? "post_checkout.final_reminder_sent"
      : "post_checkout.form_reminder_sent",
    safeMetadata: { manual: true, paymentRequired: item.paymentStatus !== "not_required" },
  });
  return { queued: true };
}
