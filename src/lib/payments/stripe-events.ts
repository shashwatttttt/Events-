import "server-only";

import Stripe from "stripe";
import { config } from "@/lib/config";

function replayStripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || (!key.startsWith("sk_test_") && !key.startsWith("sk_live_"))) {
    throw new Error("STRIPE_CONFIGURATION_INVALID");
  }
  return new Stripe(key);
}

export async function retrieveVerifiedStripeEvent(stripeEventId: string) {
  if (config.appMode !== "live") return null;
  if (!/^evt_[A-Za-z0-9_]+$/.test(stripeEventId)) {
    throw new Error("WEBHOOK_REPLAY_EVENT_INVALID");
  }
  return replayStripeClient().events.retrieve(stripeEventId);
}
