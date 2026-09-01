import { describe,expect,it } from "vitest";
import { aggregateAnalytics,analyticsCsv,deduplicateAnalyticsEvents } from "@/lib/analytics/store";
import type { AnalyticsEvent } from "@/types/site";

const event=(eventName:AnalyticsEvent["eventName"],overrides:Partial<AnalyticsEvent>={}):AnalyticsEvent=>({id:`id-${eventName}`,eventName,source:"server",deduplicationKey:`key-${eventName}`,eventId:"event-a",safeMetadata:{},occurredAt:"2026-07-22T14:30:00.000Z",melbourneDate:"2026-07-23",retentionUntil:"2027-08-27",createdAt:"2026-07-22T14:30:00.000Z",...overrides});
describe("analytics reporting",()=>{
  it("deduplicates repeated event keys",()=>expect(deduplicateAnalyticsEvents([event("page_view"),event("page_view",{id:"replay"})])).toHaveLength(1));
  it("deduplicates by the ledger input and aggregates integer cents and quantities",()=>{const report=aggregateAnalytics([event("checkout_started"),event("payment_completed",{revenueCents:4550}),event("ticket_issued",{quantity:2})],{startDate:"2026-07-23",endDate:"2026-07-23",eventId:"event-a"});expect(report.totals).toEqual({events:3,revenueCents:4550,ticketQuantity:2});expect(report.byDate).toEqual([{date:"2026-07-23",count:3,revenueCents:4550}]);});
  it("applies event, campaign and channel filters",()=>{const report=aggregateAnalytics([event("notification_delivered",{notificationChannel:"sms",utmCampaign:"winter"}),event("notification_failed",{notificationChannel:"email",utmCampaign:"winter"})],{startDate:"2026-07-23",endDate:"2026-07-23",campaign:"winter",channel:"sms"});expect(report.totals.events).toBe(1);expect(report.byEventType[0].eventName).toBe("notification_delivered");});
  it("exports safe CSV cells without customer or session identifiers",()=>{const csv=analyticsCsv([event("page_view",{utmCampaign:"=formula",customerId:"private-customer",anonymousSessionHash:"a".repeat(64)})]);expect(csv).toContain("'=formula");expect(csv).not.toContain("private-customer");expect(csv).not.toContain("a".repeat(64));});
});
