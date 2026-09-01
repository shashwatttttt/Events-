import type { AdminApplicationMetrics } from "@/lib/admin/application-metric-values";
import type { AdminOperationalMetrics } from "@/lib/admin/live-snapshot";
import type { Application,OperationsData,SiteData,TicketAllocation,UserProfile,EventItem } from "@/types/site";

export type EnrichedApplication=Application&{customer?:UserProfile;event?:EventItem;allocation?:TicketAllocation};
export type AdminSnapshot={
  site:SiteData;
  siteVersion:string;
  ops:OperationsData;
  applications:EnrichedApplication[];
  applicationMetrics:AdminApplicationMetrics;
  liveMetrics:AdminOperationalMetrics;
};
