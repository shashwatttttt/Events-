import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import {
  postCheckoutOperationsHealthy,
  readPostCheckoutOperationsHealth,
} from "@/lib/post-approval/health";
import { REQUIRED_POST_CHECKOUT_SCHEMA_VERSION } from "@/lib/post-approval/readiness";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

type SchemaHealthRow = {
  schema_version?: unknown;
  ready?: unknown;
};

function response(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=30",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET() {
  const checkedAt = new Date().toISOString();

  if (config.appMode !== "live" || config.dataProvider !== "supabase") {
    return response({
      status: "degraded",
      checkedAt,
      checkout: {
        direct: false,
        postApproval: false,
      },
      automation: false,
    }, 503);
  }

  try {
    const [schemaResult, operations] = await Promise.all([
      createSupabaseAdminClient().rpc("skie_post_checkout_schema_health"),
      readPostCheckoutOperationsHealth(),
    ]);

    const row = (Array.isArray(schemaResult.data)
      ? schemaResult.data[0]
      : schemaResult.data) as SchemaHealthRow | null;
    const schemaVersion = Number(row?.schema_version || 0);
    const schemaReady = !schemaResult.error
      && row?.ready === true
      && schemaVersion >= REQUIRED_POST_CHECKOUT_SCHEMA_VERSION;
    const automationHealthy = postCheckoutOperationsHealthy(operations);
    const postApprovalReady = config.postCheckoutApprovalEnabled
      && schemaReady
      && automationHealthy;
    const ready = schemaReady && automationHealthy;

    return response({
      status: ready ? "ready" : "degraded",
      checkedAt,
      checkout: {
        direct: true,
        postApproval: postApprovalReady,
      },
      automation: automationHealthy,
      operations,
      schemaVersion,
    }, ready ? 200 : 503);
  } catch {
    return response({
      status: "degraded",
      checkedAt,
      checkout: {
        direct: true,
        postApproval: false,
      },
      automation: false,
    }, 503);
  }
}
