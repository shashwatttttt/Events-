import Link from "next/link";
import { verifyTicket } from "@/lib/operations";
import { statusLabel } from "@/lib/format";
export const dynamic="force-dynamic";
export default async function PublicVerify({searchParams}:{searchParams:Promise<{ticket?:string;token?:string}>}){const{ticket,token}=await searchParams;const result=ticket&&token?await verifyTicket(ticket,token):{result:"invalid" as const,ticket:null};return <section className="verify-page"><div className={`verify-card verify-${result.result}`}><p className="eyebrow"><span/>Ticket verification</p><h1>{statusLabel(result.result)}</h1>{result.ticket?<><p>{result.ticket.holderName}</p><strong>{result.ticket.ticketCode}</strong><small>This public page verifies authenticity. Door staff must use the protected check-in tool to admit the ticket.</small></>:<p>This QR is invalid or incomplete.</p>}<Link href="/" className="button button-ghost">Back to Skie</Link></div></section>}
