import { config } from "@/lib/config";
import { readPersistenceMetadata } from "@/lib/data/documents";
import { apiError, noStoreJson } from "@/lib/http";
import { requireUser } from "@/lib/security/session";

export async function GET() {
  try {
    await requireUser(["admin", "super_admin"]);
    const metadata = await readPersistenceMetadata();
    return noStoreJson({
      appMode: config.appMode,
      dataProvider: config.dataProvider,
      isDurableProvider: config.dataProvider === "supabase",
      siteVersion: metadata.site.version,
      siteUpdatedAt: metadata.site.updatedAt,
      operationsVersion: metadata.operations.version,
      operationsUpdatedAt: metadata.operations.updatedAt,
    });
  } catch (error) {
    return apiError(error);
  }
}
