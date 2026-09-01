import { redirect } from "next/navigation";
import { QRScanner } from "@/components/QRScanner";
import { LogoutButton } from "@/components/LogoutButton";
import { readSiteData } from "@/lib/data/documents";
import { getCurrentUser,isDoorRole } from "@/lib/security/session";
import { listAccessibleEventIds } from "@/lib/staff";
export const dynamic="force-dynamic";
export const metadata={title:"Door check-in"};
export default async function DoorMode(){const user=await getCurrentUser();if(!user||!isDoorRole(user.role))redirect("/skie-control/login");const[site,eventIds]=await Promise.all([readSiteData(),listAccessibleEventIds(user)]);const events=site.events.filter(event=>event.lifecycle==="published"&&(!eventIds||eventIds.includes(event.id)));return <><a className="skip-link" href="#door-main">Skip to door controls</a><main className="door-page" id="door-main" tabIndex={-1}><header><div className="admin-wordmark"><strong>SKIE</strong><small>DOOR</small></div><div><span>{user.email}</span><LogoutButton admin/></div></header><section aria-labelledby="door-heading"><p className="eyebrow"><span aria-hidden="true"/>Fast entry mode</p><h1 id="door-heading">Scan. Decide. Move.</h1>{events.length?<QRScanner events={events}/>:<p className="form-message" role="status">No active event assignment is available for this account.</p>}</section></main></>}
