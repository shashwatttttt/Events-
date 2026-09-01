"use client";
import { useEffect, useMemo, useState } from "react";
import { MetaAdsPanel } from "@/components/admin/MetaAdsPanel";
import { moneyCents, statusLabel } from "@/lib/format";
import type { AnalyticsEventName, AnalyticsReport, EventItem } from "@/types/site";

type ResponseBody={report:AnalyticsReport;options:{campaigns:string[];channels:string[]};error?:string};
function localDate(offsetDays=0){const value=new Date();value.setDate(value.getDate()+offsetDays);return new Intl.DateTimeFormat("en-CA",{timeZone:"Australia/Melbourne"}).format(value);}

export function AnalyticsPanel({events}:{events:EventItem[]}){
  const [startDate,setStartDate]=useState(()=>localDate(-29));const[endDate,setEndDate]=useState(()=>localDate());const[eventId,setEventId]=useState("");const[campaign,setCampaign]=useState("");const[channel,setChannel]=useState("");
  const [body,setBody]=useState<ResponseBody|null>(null);const[loading,setLoading]=useState(true);const[error,setError]=useState("");
  const query=useMemo(()=>{const value=new URLSearchParams({startDate,endDate});if(eventId)value.set("eventId",eventId);if(campaign)value.set("campaign",campaign);if(channel)value.set("channel",channel);return value.toString();},[startDate,endDate,eventId,campaign,channel]);
  useEffect(()=>{let current=true;void fetch(`/api/admin/analytics?${query}`,{cache:"no-store"}).then(async(response)=>{const next=await response.json() as ResponseBody;if(!response.ok)throw new Error(next.error||"Analytics report failed.");if(current){setBody(next);setError("");}}).catch((reason)=>{if(current)setError(reason instanceof Error?reason.message:"Analytics report failed.");}).finally(()=>{if(current)setLoading(false);});return()=>{current=false;};},[query]);
  const count=(name:AnalyticsEventName)=>body?.report.byEventType.find((item)=>item.eventName===name)?.count||0;
  const quantity=(name:AnalyticsEventName)=>body?.report.byEventType.find((item)=>item.eventName===name)?.quantity||0;
  function download(){window.location.assign(`/api/admin/analytics?${query}&format=csv`);}
  return <div className="admin-stack">
    <MetaAdsPanel />
    <section className="admin-section admin-stack">
      <div className="admin-section-title"><div><h2>First-party analytics</h2><p>Privacy-reduced, Melbourne-local reporting backed by server-authoritative commerce and operational events.</p></div><button className="button button-ghost" onClick={download} type="button">Export CSV</button></div>
      <div className="admin-card admin-grid-three">
        <label className="admin-field"><span>Start date</span><input type="date" value={startDate} onChange={(event)=>setStartDate(event.target.value)}/></label><label className="admin-field"><span>End date</span><input type="date" value={endDate} onChange={(event)=>setEndDate(event.target.value)}/></label>
        <label className="admin-field"><span>Event</span><select value={eventId} onChange={(event)=>setEventId(event.target.value)}><option value="">All events</option>{events.map((event)=><option key={event.id} value={event.id}>{event.title}</option>)}</select></label>
        <label className="admin-field"><span>Campaign</span><select value={campaign} onChange={(event)=>setCampaign(event.target.value)}><option value="">All campaigns</option>{(body?.options.campaigns||[]).map((value)=><option key={value}>{value}</option>)}</select></label>
        <label className="admin-field"><span>Channel</span><select value={channel} onChange={(event)=>setChannel(event.target.value)}><option value="">All channels</option>{(body?.options.channels||[]).map((value)=><option key={value}>{statusLabel(value)}</option>)}</select></label>
      </div>
      {loading&&<div className="admin-loading" role="status"><span className="spinner"/><span>Loading analytics</span></div>}
      {error&&<p className="admin-notice" role="alert">{error}</p>}
      {!loading&&!error&&body&&<>
        <div className="stat-grid"><div><small>Ticket revenue</small><strong>{moneyCents(body.report.totals.revenueCents)}</strong><span>Integer cents</span></div><div><small>Tickets issued</small><strong>{body.report.totals.ticketQuantity}</strong><span>{count("payment_completed")} completed payments</span></div><div><small>Checkout conversion</small><strong>{count("checkout_started")?`${Math.round(count("payment_completed")/count("checkout_started")*100)}%`:"—"}</strong><span>{count("checkout_started")} started</span></div><div><small>Tracked events</small><strong>{body.report.totals.events}</strong><span>Melbourne dates</span></div></div>
        <div className="admin-grid-two">
          <Metric title="Application funnel" rows={[["Started",count("application_started")],["Completed",count("application_completed")],["Unlocked",count("allocation_unlocked")]]}/>
          <Metric title="Checkout funnel" rows={[["Started",count("checkout_started")],["Cancelled",count("checkout_cancelled")],["Paid",count("payment_completed")],["Failed",count("payment_failed")]]}/>
          <Metric title="Promo performance" rows={[["Applied",count("promo_applied")],["Rejected",count("promo_rejected")]]}/>
          <Metric title="Notification delivery" rows={[["Queued",count("notification_queued")],["Delivered",count("notification_delivered")],["Failed",count("notification_failed")]]}/>
          <Metric title="Video engagement" rows={[["Impressions",count("video_impression")],["Starts",count("video_started")],["Completions",count("video_completed")]]}/>
          <Metric title="Door and add-ons" rows={[["Scans accepted",count("ticket_scan_accepted")],["Scans rejected",count("ticket_scan_rejected")],["Duplicate scans",count("ticket_scan_duplicate")],["Add-ons redeemed",quantity("addon_redemption")],["Redemptions reversed",quantity("addon_redemption_reversal")]]}/>
        </div>
        {!body.report.totals.events&&<div className="admin-empty">No analytics events match these filters.</div>}
        {!!body.report.byDate.length&&<div className="admin-card"><h3>Daily activity · Australia/Melbourne</h3><div className="analytics-table"><div className="analytics-row analytics-head"><span>Date</span><span>Events</span><span>Revenue</span></div>{body.report.byDate.map((item)=><div className="analytics-row" key={item.date}><strong>{item.date}</strong><span>{item.count}</span><span>{moneyCents(item.revenueCents)}</span></div>)}</div></div>}
      </>}
    </section>
  </div>;
}
function Metric({title,rows}:{title:string;rows:Array<[string,number]>}){return <article className="admin-card"><h3>{title}</h3><div className="analytics-metrics">{rows.map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div></article>;}
