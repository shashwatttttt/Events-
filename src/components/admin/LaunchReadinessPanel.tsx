"use client";
import { useEffect, useMemo, useState } from "react";
import { useAccessibleDialog } from "@/components/AccessibleDialog";
import type { AdminSnapshot } from "@/components/admin/types";
import type { EventLaunchReadiness } from "@/types/site";

const manualChecks = [
  ["provider_sandbox_verified", "Provider sandbox configuration verified"],
  ["notification_preview_checked", "Notification previews checked"],
  ["door_workflow_rehearsed", "Door scanning and recovery workflow rehearsed"],
  ["manual_accessibility_checked", "Keyboard and screen-reader-oriented checks completed"],
] as const;

export function LaunchReadinessPanel({ snapshot }: { snapshot: AdminSnapshot }) {
  const dialog=useAccessibleDialog();
  const [eventId,setEventId]=useState(snapshot.site.events[0]?.id||""); const [saved,setSaved]=useState<EventLaunchReadiness[]>([]);
  const [checklist,setChecklist]=useState<Record<string,boolean>>({}); const [lowStock,setLowStock]=useState(10); const [capacityWarning,setCapacityWarning]=useState(90); const [status,setStatus]=useState(""); const [busy,setBusy]=useState(false);
  useEffect(()=>{let active=true;void fetch("/api/admin/operations",{cache:"no-store"}).then(async(response)=>response.ok?response.json():null).then((body)=>{if(active&&body)setSaved(body.readiness||[])}).catch(()=>undefined);return()=>{active=false}},[]);
  const event=snapshot.site.events.find((item)=>item.id===eventId);
  const current=useMemo(()=>saved.find((item)=>item.eventId===eventId),[eventId,saved]);
  useEffect(()=>{if(!current)return;queueMicrotask(()=>{setChecklist(current.checklist);setLowStock(current.lowStockThreshold);setCapacityWarning(current.capacityWarningPercent)})},[current]);
  const eventOrders=snapshot.ops.orders.filter((item)=>item.eventId===eventId); const paidTickets=snapshot.ops.tickets.filter((item)=>item.eventId===eventId&&!['cancelled','refunded'].includes(item.status)).length;
  const automatic=[
    ["Event is published and publicly visible",event?.lifecycle==="published"&&event.visibility==="public"],
    ["At least one active ticket type has stock",Boolean(event?.ticketTypes.some((item)=>item.active&&item.capacity>item.sold))],
    ["Capacity buckets fit inside venue capacity",Boolean(event&&(event.publicCapacity+event.sponsorAllocation+event.guestlistAllocation+event.teamAllocation+event.safetyBuffer)<=event.venueCapacity)],
    ["No failed event notifications",!snapshot.ops.notificationOutbox.some((item)=>item.eventId===eventId&&item.status==="failed")],
    ["No unresolved payment recovery orders",!eventOrders.some((item)=>["paid_unfulfilled","manual_review","recovery_failed"].includes(item.status))],
    ["Published video is ready or safely absent",!snapshot.site.media.some((item)=>item.eventId===eventId&&item.type==="video"&&item.published&&item.processingStatus!=="ready")],
  ] as const;
  const percent=event?.publicCapacity?Math.round((paidTickets/event.publicCapacity)*100):0; const warning=percent>=capacityWarning;
  async function save(){if(!eventId||!await dialog.confirm({title:"Save launch-readiness checklist?",description:"Save and audit this event launch-readiness checklist?",confirmLabel:"Save checklist"}))return;setBusy(true);const response=await fetch("/api/admin/operations",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"save_readiness",eventId,checklist,lowStockThreshold:lowStock,capacityWarningPercent:capacityWarning,operationId:`readiness_${crypto.randomUUID()}`})});const body=await response.json();setStatus(response.ok?"Launch checklist saved and audited.":body.error||"Checklist save failed.");if(response.ok)setSaved((items)=>[...items.filter((item)=>item.eventId!==eventId),body.readiness]);setBusy(false)}
  return <section className="admin-section admin-stack"><div className="admin-section-title"><div><h2>Launch readiness</h2><p>Operational checks support launch decisions; they do not replace provider, accessibility or venue sign-off.</p></div></div><div className="admin-card admin-grid-three"><label className="admin-field"><span>Event</span><select value={eventId} onChange={(e)=>setEventId(e.target.value)}>{snapshot.site.events.map((item)=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label className="admin-field"><span>Low-stock warning units</span><input type="number" min="0" value={lowStock} onChange={(e)=>setLowStock(Number(e.target.value))}/></label><label className="admin-field"><span>Capacity warning percent</span><input type="number" min="1" max="100" value={capacityWarning} onChange={(e)=>setCapacityWarning(Number(e.target.value))}/></label></div>{warning&&<p className="admin-notice" role="alert">Capacity warning: {percent}% of the public allocation has issued tickets.</p>}<div className="admin-grid-two"><div className="admin-card"><h3>Automatic checks</h3><ul className="admin-health">{automatic.map(([label,pass])=><li key={label}><span className={pass?"":"is-warning"}/>{pass?"Pass":"Needs attention"}: {label}</li>)}</ul></div><div className="admin-card"><h3>Manual checks</h3>{manualChecks.map(([key,label])=><label className="toggle-row" key={key}><input type="checkbox" checked={Boolean(checklist[key])} onChange={(e)=>setChecklist({...checklist,[key]:e.target.checked})}/>{label}</label>)}</div></div><button type="button" className="button button-primary" disabled={busy||!eventId} onClick={()=>void save()}>{busy?"Saving...":"Save launch checklist"}</button>{status&&<p className="admin-notice" role="status">{status}</p>}</section>;
}
