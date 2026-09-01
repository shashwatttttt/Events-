import Link from "next/link";
import { LogoutButton } from "@/components/LogoutButton";
import { NotificationPreferencesPanel } from "@/components/NotificationPreferencesPanel";
import { formatDateTime, moneyCents, statusLabel } from "@/lib/format";
import { getCustomerWorkspace } from "@/lib/operations";
import { listCustomerPostCheckoutApplications } from "@/lib/post-approval/account";
import { customerFormTargetAt } from "@/lib/post-approval/types";
import { requirePageUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const user = await requirePageUser("/account");
  const [workspace, postCheckoutApplications] = await Promise.all([
    getCustomerWorkspace(user.id),
    listCustomerPostCheckoutApplications(user.id),
  ]);
  const activeAllocations = workspace.allocations.filter((item) => ["unlocked", "checkout_started"].includes(item.status));
  const requiredPostCheckoutApplications = postCheckoutApplications.filter((item) => item.requiresAction);

  return <section className="account-page"><div className="shell">
    <header className="account-header"><div><p className="eyebrow"><span />My Skie</p><h1>Hi, {user.firstName || "there"}.</h1><p>{user.email}</p></div><LogoutButton /></header>
    {requiredPostCheckoutApplications.length > 0 && <section className="post-checkout-account-alert" role="alert"><p className="eyebrow"><span aria-hidden="true" />Action required</p><h2>Complete your mandatory application.</h2><p>No ticket will be issued until the form is submitted and SKIE approves the application. Where payment is required, fulfilment also waits for verified payment.</p>{requiredPostCheckoutApplications.map((item) => <article key={item.id}><div><strong>{item.eventTitle}</strong><span>{item.completionPercentage}% complete · requested by {formatDateTime(customerFormTargetAt(item), workspace.timezone)}</span></div><Link className="button button-primary" href={`/account/applications/${item.orderId}`}>Complete application <span aria-hidden="true">↗</span></Link></article>)}</section>}
    <div className="account-stats">
      <div><small>Applications</small><strong>{workspace.applications.length + postCheckoutApplications.length}</strong></div>
      <div><small>Unlocked</small><strong>{activeAllocations.length}</strong></div>
      <div><small>Tickets</small><strong>{workspace.tickets.length}</strong></div>
      <div><small>Orders</small><strong>{workspace.orders.length}</strong></div>
    </div>
    <NotificationPreferencesPanel />
    <section className="account-section"><div className="account-section-title"><div><p className="eyebrow"><span />Ready to buy</p><h2>Unlocked tickets</h2></div><Link href="/events" className="text-link">Find events <span>↗</span></Link></div>
      <div className="account-card-grid">{activeAllocations.map((item) => <article className="account-card allocation-card" key={item.id}><span className="status-pill status-approved">UNLOCKED</span><h3>{item.event?.title || "Event"}</h3><p>Up to {item.maxQuantity - item.purchasedQuantity} ticket(s) · {moneyCents(item.priceCents)} each</p><small>Expires {formatDateTime(item.expiresAt, workspace.timezone)}</small><Link href={`/checkout/${item.id}`} className="button button-primary">Build checkout <span aria-hidden="true">↗</span></Link></article>)}{!activeAllocations.length && <div className="empty-state compact-empty">No active ticket allocations.</div>}</div>
    </section>
    <section className="account-section"><div className="account-section-title"><div><p className="eyebrow"><span />Review status</p><h2>Applications</h2></div></div>
      <div className="account-list">
        {postCheckoutApplications.map((item) => <article key={item.id}><div><span className={`status-pill status-${item.status}`}>{item.status.replaceAll("_", " ")}</span><h3>{item.eventTitle}</h3><p>Payment {item.paymentStatus.replaceAll("_", " ")} · form {item.completionPercentage}% complete</p></div>{item.requiresAction ? <Link className="button button-primary" href={`/account/applications/${item.orderId}`}>Complete form</Link> : <span>{moneyCents(item.totalCents)}</span>}</article>)}
        {workspace.applications.map((item) => <article key={item.id}><div><span className={`status-pill status-${item.status}`}>{statusLabel(item.status)}</span><h3>{item.event?.title || "Event"}</h3><p>Submitted {formatDateTime(item.createdAt, workspace.timezone)}</p></div>{item.status === "approved" && <span>Ticket allocation created</span>}</article>)}
        {!workspace.applications.length && !postCheckoutApplications.length && <div className="empty-state compact-empty">No applications yet.</div>}
      </div>
    </section>
    <section className="account-section"><div className="account-section-title"><div><p className="eyebrow"><span />At the door</p><h2>My tickets</h2></div></div>
      <div className="account-card-grid">{workspace.tickets.map((item) => <article className="account-card ticket-mini" key={item.id}><span className={`status-pill status-${item.status}`}>{statusLabel(item.status)}</span><h3>{item.event?.title || "Event"}</h3><p>{item.ticketCode}</p><Link href={`/account/tickets/${item.id}`} className="button button-ghost">Open QR <span>↗</span></Link></article>)}{!workspace.tickets.length && <div className="empty-state compact-empty">Tickets appear here after fulfilment.</div>}</div>
    </section>
    <section className="account-section"><div className="account-section-title"><div><p className="eyebrow"><span />Payment trail</p><h2>Orders</h2></div></div>
      <div className="account-list">{workspace.orders.map((item) => <article key={item.id}><div><span className={`status-pill status-${item.status}`}>{statusLabel(item.status)}</span><h3>{item.event?.title || "Event"}</h3><p>{item.items.map((line) => `${line.quantity} × ${line.name}`).join(" · ")}</p></div><strong>{moneyCents(item.totalCents)}</strong></article>)}{!workspace.orders.length && <div className="empty-state compact-empty">No orders yet.</div>}</div>
    </section>
  </div></section>;
}
