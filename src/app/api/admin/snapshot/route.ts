import { config } from "@/lib/config";
import { readAdminApplicationMetrics } from "@/lib/admin/application-metrics";
import { readOperationsData, readSiteDataSnapshot } from "@/lib/data/documents";
import { legacyAdminMetrics, normalizedAdminOperations } from "@/lib/admin/live-snapshot";
import { filterRemovedTestData } from "@/lib/admin/test-data-visibility";
import { apiError, noStoreJson } from "@/lib/http";
import { requireUser } from "@/lib/security/session";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    await requireUser(["admin", "super_admin"]);
    const [siteSnapshot, legacyOperations] = await Promise.all([
      readSiteDataSnapshot(),
      readOperationsData(),
    ]);
    const projected = config.dataProvider === "supabase"
      ? await filterRemovedTestData((await normalizedAdminOperations(legacyOperations)).operations)
      : { operations: legacyOperations, metrics: legacyAdminMetrics(legacyOperations) };
    const site = siteSnapshot.value;
    const ops = {
      ...projected.operations,
      tickets: projected.operations.tickets.map((ticket) => ({ ...ticket, tokenHash: "" })),
    };
    const applications = ops.applications.map((application) => ({
      ...application,
      customer: ops.users.find((user) => user.id === application.userId),
      event: site.events.find((event) => event.id === application.eventId),
      allocation: ops.allocations.find((allocation) => allocation.applicationId === application.id),
    }));
    const applicationMetrics = await readAdminApplicationMetrics(
      ops,
      config.dataProvider === "supabase",
    );
    return noStoreJson({
      site,
      siteVersion: siteSnapshot.version,
      ops,
      applications,
      applicationMetrics,
      liveMetrics: projected.metrics,
    });
  } catch (error) { return apiError(error); }
}
