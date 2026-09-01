import type { AnalyticsEventName } from "@/types/site";

function sessionId() { const key="skie_analytics_session"; const current=sessionStorage.getItem(key); if(current) return current; const value=crypto.randomUUID(); sessionStorage.setItem(key,value); return value; }
export function sendAnalytics(eventName:AnalyticsEventName,input:{deduplicationKey:string;eventId?:string;ticketTypeId?:string;utmSource?:string;utmMedium?:string;utmCampaign?:string;referrerCategory?:string;metadata?:Record<string,unknown>}) {
  if(typeof window==="undefined" || (navigator as Navigator&{globalPrivacyControl?:boolean}).globalPrivacyControl===true || navigator.doNotTrack==="1") return;
  const contextKey="skie_analytics_attribution";let context:Record<string,string>={};try{context=JSON.parse(sessionStorage.getItem(contextKey)||"{}");}catch{context={};}
  for(const key of ["utmSource","utmMedium","utmCampaign","referrerCategory"] as const)if(input[key])context[key]=input[key];
  sessionStorage.setItem(contextKey,JSON.stringify(context));
  void fetch("/api/analytics",{method:"POST",headers:{"Content-Type":"application/json"},keepalive:true,body:JSON.stringify({...context,...input,eventName,anonymousSessionId:sessionId()})}).catch(()=>undefined);
}
