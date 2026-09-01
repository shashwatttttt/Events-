"use client";
import { useEffect, useMemo, useState } from "react";
import type { AdminSnapshot } from "@/components/admin/types";
import { formatDateTime } from "@/lib/format";
import type { AuditLog } from "@/types/site";

export function AuditLogsPanel({snapshot}:{snapshot:AdminSnapshot}) {
  const [recoveryAudits,setRecoveryAudits]=useState<AuditLog[]>([]); const [search,setSearch]=useState("");
  useEffect(()=>{let active=true;void fetch("/api/admin/operations",{cache:"no-store"}).then(async(response)=>response.ok?response.json():null).then((body)=>{if(active&&body?.operationAudits)setRecoveryAudits(body.operationAudits)}).catch(()=>undefined);return()=>{active=false}},[]);
  const logs=useMemo(()=>{const byId=new Map<string,AuditLog>();for(const item of [...snapshot.ops.auditLogs,...recoveryAudits])byId.set(item.id,item);return [...byId.values()].filter((item)=>`${item.actorEmail} ${item.action} ${item.entityType} ${item.entityId}`.toLowerCase().includes(search.toLowerCase())).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));},[recoveryAudits,search,snapshot.ops.auditLogs]);
  return <section className="admin-section admin-stack"><div className="admin-section-title"><div><h2>Audit logs</h2><p>Document and reason-required recovery actions, with actor, time and affected record.</p></div></div><div className="admin-filter-bar"><input aria-label="Search audit logs" placeholder="Search actor, action or record" value={search} onChange={(event)=>setSearch(event.target.value)}/></div><div className="audit-table"><div className="audit-row audit-head"><span>Time</span><span>Actor</span><span>Action</span><span>Entity</span></div>{logs.map(log=><div className="audit-row" key={log.id}><span>{formatDateTime(log.createdAt,snapshot.site.settings.timezone)}</span><span>{log.actorEmail}</span><strong>{log.action}</strong><span>{log.entityType} / {log.entityId.slice(-10)}{log.metadata.reason?` · ${String(log.metadata.reason)}`:""}</span></div>)}</div>{!logs.length&&<div className="admin-empty">No audit entries match this search.</div>}</section>;
}
