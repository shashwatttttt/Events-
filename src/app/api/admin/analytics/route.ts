import { NextResponse } from "next/server";
import { analyticsCsv, analyticsEvents, analyticsReport } from "@/lib/analytics/store";
import { apiError, noStoreJson, PublicApiError } from "@/lib/http";
import { requireUser } from "@/lib/security/session";

function date(value: string | null, fallback: string) { return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback; }
function filter(value: string | null, pattern=/^[A-Za-z0-9 _.-]{1,120}$/) { if(!value) return undefined; if(!pattern.test(value)) throw new PublicApiError("INVALID_ANALYTICS_FILTER","Analytics filters are invalid.",422); return value; }

export async function GET(request:Request) {
  try {
    await requireUser(["admin","super_admin"]); const url=new URL(request.url); const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Australia/Melbourne"}).format(new Date()); const startDefault=new Date(`${today}T00:00:00Z`);startDefault.setUTCDate(startDefault.getUTCDate()-29);
    const filters={ startDate:date(url.searchParams.get("startDate"),startDefault.toISOString().slice(0,10)), endDate:date(url.searchParams.get("endDate"),today), eventId:filter(url.searchParams.get("eventId"),/^[A-Za-z0-9_-]{1,120}$/), campaign:filter(url.searchParams.get("campaign")), channel:filter(url.searchParams.get("channel"),/^(email|sms|in_app|whatsapp)$/) };
    if(filters.startDate>filters.endDate) throw new PublicApiError("INVALID_ANALYTICS_FILTER","The start date must not follow the end date.",422);
    if(url.searchParams.get("format")==="csv") return new NextResponse(analyticsCsv(await analyticsEvents(filters)),{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":`attachment; filename="skie-analytics-${filters.startDate}-${filters.endDate}.csv"`,"Cache-Control":"no-store"}});
    const [report,events]=await Promise.all([analyticsReport(filters),analyticsEvents(filters)]);
    return noStoreJson({report,options:{campaigns:[...new Set(events.map((item)=>item.utmCampaign).filter(Boolean))].sort(),channels:[...new Set(events.map((item)=>item.notificationChannel).filter(Boolean))].sort()}});
  } catch(error){return apiError(error);}
}
