import { describe,expect,it } from "vitest";
import { categorizeBrowser,categorizeDevice,categorizeReferrer,melbourneDate,sanitizeAnalyticsMetadata,sanitizeAnalyticsText } from "@/lib/analytics/privacy";

describe("analytics privacy reduction",()=>{
  it("drops prohibited and complex metadata",()=>expect(sanitizeAnalyticsMetadata({path:"/events/night",email:"private@example.test",cardNumber:"4111",nested:{secret:true},count:2,valid:true})).toEqual({path:"/events/night",count:2,valid:true}));
  it("bounds campaign text and removes control characters",()=>expect(sanitizeAnalyticsText(" winter\nlaunch<script> ",18)).toBe("winterlaunchscript"));
  it("reduces referrer, device and browser without retaining raw values",()=>{expect(categorizeReferrer("https://www.google.com/search?q=skie","https://skie.test")).toBe("search");expect(categorizeReferrer("https://skie.test/events","https://skie.test")).toBe("internal");expect(categorizeDevice("Mozilla iPhone Mobile")).toBe("mobile");expect(categorizeBrowser("Mozilla Chrome/140 Safari/537")).toBe("chrome");});
  it("groups UTC timestamps on Melbourne dates",()=>expect(melbourneDate("2026-07-22T14:30:00.000Z")).toBe("2026-07-23"));
});
