"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { categorizeReferrer } from "@/lib/analytics/privacy";
import { sendAnalytics } from "@/lib/analytics/client";

export function AnalyticsPageTracker(){const pathname=usePathname();useEffect(()=>{const query=new URLSearchParams(window.location.search);sendAnalytics("page_view",{deduplicationKey:`${pathname}:${Date.now()}`,utmSource:query.get("utm_source")||undefined,utmMedium:query.get("utm_medium")||undefined,utmCampaign:query.get("utm_campaign")||undefined,referrerCategory:categorizeReferrer(document.referrer,window.location.origin),metadata:{path:pathname}});},[pathname]);return null;}

export function AnalyticsEventView({eventId}:{eventId:string}){useEffect(()=>sendAnalytics("event_page_view",{deduplicationKey:`${eventId}:${Date.now()}`,eventId}),[eventId]);return null;}
