"use client";

import { useEffect, useState } from "react";
import type { AdminSnapshot } from "@/components/admin/types";
import { moneyCents } from "@/lib/format";

export function OverviewPanel({ snapshot }: { snapshot: AdminSnapshot }) {
  const { site, ops } = snapshot;
  const fallbackInvitePending = ops.applications.filter((application) => application.status === "pending").length;
  const snapshotApplicationMetrics = snapshot.applicationMetrics || {
    invitePendingReview: fallbackInvitePending,
    inviteTotal: ops.applications.length,
    postCheckoutPendingReview: 0,
    postCheckoutTotal: 0,
    pendingReviewTotal: fallbackInvitePending,
    applicationTotal: ops.applications.length,
    updatedAt: snapshot.liveMetrics.updatedAt,
  };
  const [polledMetrics, setPolledMetrics] = useState<AdminSnapshot["liveMetrics"] | null>(null);
  const [polledApplicationMetrics, setPolledApplicationMetrics] = useState<AdminSnapshot["applicationMetrics"] | null>(null);
  const liveMetrics = polledMetrics && polledMetrics.updatedAt >= snapshot.liveMetrics.updatedAt
    ? polledMetrics
    : snapshot.liveMetrics;
  const applicationMetrics = polledApplicationMetrics
    && polledApplicationMetrics.updatedAt >= snapshotApplicationMetrics.updatedAt
    ? polledApplicationMetrics
    : snapshotApplicationMetrics;
  const failedEmails = ops.emailLogs.filter((email) => email.status === "failed").length;
  const duplicateScans = ops.checkIns.filter((checkIn) => checkIn.result === "already_checked_in").length;

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      if (document.visibilityState !== "visible") return;
      const response = await fetch("/api/admin/snapshot", { cache: "no-store" }).catch(() => null);
      if (!response?.ok) return;
      const body = await response.json() as AdminSnapshot;
      if (!cancelled) {
        setPolledMetrics(body.liveMetrics);
        if (body.applicationMetrics) setPolledApplicationMetrics(body.applicationMetrics);
      }
    }
    const interval = window.setInterval(() => void refresh(), 15_000);
    const onVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <section className="admin-section">
      <div className="stat-grid">
        <div>
          <small>Published events</small>
          <strong>{site.events.filter((event) => event.lifecycle === "published").length}</strong>
          <span>{site.events.length} total</span>
        </div>
        <div>
          <small>Pending applications</small>
          <strong>{applicationMetrics.pendingReviewTotal}</strong>
          <span>{applicationMetrics.applicationTotal} total · {applicationMetrics.postCheckoutTotal} post-checkout</span>
        </div>
        <div>
          <small>Live tickets issued</small>
          <strong>{liveMetrics.issuedTickets}</strong>
          <span>{liveMetrics.checkedInTickets} checked in</span>
        </div>
        <div>
          <small>Net live revenue</small>
          <strong>{moneyCents(liveMetrics.netRevenueCents)}</strong>
          <span>
            {liveMetrics.paidOrders} Stripe order{liveMetrics.paidOrders === 1 ? "" : "s"}
            {liveMetrics.refundedCents > 0 ? ` · ${moneyCents(liveMetrics.refundedCents)} refunded` : ""}
          </span>
        </div>
      </div>

      <div className="admin-callout">
        <p className="eyebrow"><span />Production data</p>
        <h2>{liveMetrics.source === "normalized" ? "LIVE SUPABASE METRICS" : "LOCAL TEST METRICS"}</h2>
        <p>
          Revenue excludes test-provider payments and subtracts recorded refunds. Orders, tickets and application review counts refresh automatically from the production transaction tables.
          Last refreshed {new Date(liveMetrics.updatedAt).toLocaleTimeString()}.
        </p>
      </div>

      <div className="admin-grid-two">
        <div className="admin-card">
          <h3>Operations health</h3>
          <ul className="admin-health">
            <li><span />Customer accounts</li>
            <li><span />Invite + post-checkout applications</li>
            <li><span />Unlocked allocations</li>
            <li><span />Checkout + fulfilment</li>
            <li><span />QR validation</li>
            <li><span />Email outbox</li>
          </ul>
        </div>
        <div className="admin-card">
          <h3>Attention queue</h3>
          <p>{applicationMetrics.pendingReviewTotal} applications need review.</p>
          <p>{applicationMetrics.invitePendingReview} invite · {applicationMetrics.postCheckoutPendingReview} post-checkout.</p>
          <p>{failedEmails} emails failed.</p>
          <p>{liveMetrics.pendingOrders} live orders require completion or review.</p>
          <p>{duplicateScans} duplicate scans recorded.</p>
        </div>
      </div>
    </section>
  );
}
