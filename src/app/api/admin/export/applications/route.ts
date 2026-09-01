import { NextResponse } from "next/server";
import { buildCombinedApplicationCsv } from "@/lib/admin/combined-application-export";
import { mutateOperationsData, readOperationsData, readSiteData } from "@/lib/data/documents";
import { apiError } from "@/lib/http";
import { listPostCheckoutAdminPage } from "@/lib/post-approval/admin-page-store";
import type { PostCheckoutAdminItem } from "@/lib/post-approval/types";
import { randomId } from "@/lib/security/crypto";
import { requireUser } from "@/lib/security/session";

async function listAllPostCheckoutApplications(eventId?: string) {
  const applications: PostCheckoutAdminItem[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 1_000; page += 1) {
    const result = await listPostCheckoutAdminPage({
      filter: "all",
      eventId,
      cursor,
      limit: 100,
    });
    applications.push(...result.items);
    if (!result.nextCursor) return applications;
    if (result.nextCursor === cursor) throw new Error("Post-checkout export pagination did not advance.");
    cursor = result.nextCursor;
  }

  throw new Error("Post-checkout export exceeded the safe pagination limit.");
}

export async function GET(request: Request) {
  try {
    const actor = await requireUser(["admin", "super_admin"]);
    const url = new URL(request.url);
    const eventId = url.searchParams.get("eventId");
    const [siteData, opsData] = await Promise.all([readSiteData(), readOperationsData()]);

    if (eventId && eventId !== "all" && !siteData.events.some((event) => event.id === eventId)) {
      throw new Error("Event not found.");
    }

    const postCheckoutApplications = await listAllPostCheckoutApplications(
      eventId && eventId !== "all" ? eventId : undefined,
    );
    const result = buildCombinedApplicationCsv(
      siteData as unknown as Record<string, unknown>,
      opsData as unknown as Record<string, unknown>,
      postCheckoutApplications,
      eventId,
    );

    await mutateOperationsData((current) => {
      current.auditLogs.push({
        id: randomId("audit"),
        actorId: actor.id,
        actorEmail: actor.email,
        action: "export.applications_csv",
        entityType: "export",
        entityId: eventId || "all",
        metadata: {
          records: result.records,
          preCheckoutRecords: result.preCheckoutRecords,
          postCheckoutRecords: result.postCheckoutRecords,
          type: "applications",
          eventId: eventId || "all",
          internalExport: true,
          applicationMethods: "pre_checkout_application,post_checkout_approval",
        },
        createdAt: new Date().toISOString(),
      });
    });

    return new NextResponse(result.csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
