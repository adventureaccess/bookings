// Sends a signed, made-up Stripe event to the LOCAL webhook, to exercise the
// webhook route without the Stripe CLI or a real payment.
//
// It signs with STRIPE_WEBHOOK_SECRET from .env.local, exactly as Stripe
// would, so the route's signature check runs for real. Local dev server and
// dev database only: it refuses any address that is not localhost.
//
// Usage:
//   node scripts/fake-stripe-event.mjs <reference> <amount_cents> <fee_cents> [options]
// Options:
//   --session=<id>     reuse a session id (send the same one twice to test a replay)
//   --event=<id>       reuse an event id
//   --charged=<cents>  what "Stripe" says it charged; defaults to amount + fee
//   --bad-signature    sign with the wrong secret
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

function readEnvFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return values;
}

const env = { ...readEnvFile(".env.local"), ...process.env };
const [reference, amountText, feeText, ...flags] = process.argv.slice(2);
const option = (name) => flags.find((f) => f.startsWith(`--${name}=`))?.split("=")[1];

const target = env.WEBHOOK_URL ?? "http://localhost:4321/api/stripe/webhook";
if (!/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+\//.test(target)) {
  console.error("Refusing: this script only talks to a local dev server.");
  process.exit(1);
}
if (!reference || !/^\d+$/.test(amountText ?? "") || !/^\d+$/.test(feeText ?? "")) {
  console.error("Usage: node scripts/fake-stripe-event.mjs <reference> <amount_cents> <fee_cents>");
  process.exit(1);
}
if (!env.STRIPE_WEBHOOK_SECRET || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Set STRIPE_WEBHOOK_SECRET, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.");
  process.exit(1);
}

const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data: booking } = await db.from("bookings").select("id").eq("reference", reference).maybeSingle();
if (!booking) {
  console.error(`No booking with reference ${reference}.`);
  process.exit(1);
}

const amount = Number(amountText);
const fee = Number(feeText);
const tag = randomBytes(6).toString("hex");
const sessionId = option("session") ?? `cs_test_fake_${tag}`;
const payload = JSON.stringify({
  id: option("event") ?? `evt_test_fake_${tag}`,
  object: "event",
  type: "checkout.session.completed",
  data: {
    object: {
      id: sessionId,
      object: "checkout.session",
      mode: "payment",
      payment_status: "paid",
      currency: "usd",
      amount_total: Number(option("charged") ?? amount + fee),
      payment_intent: `pi_test_fake_${sessionId.slice(-12)}`,
      metadata: {
        booking_id: booking.id,
        reference,
        amount_cents: String(amount),
        fee_cents: String(fee),
      },
    },
  },
});

// The key is only needed to build the client; no call is made to Stripe.
const stripe = new Stripe("sk_test_unused");
const secret = flags.includes("--bad-signature") ? "whsec_wrong" : env.STRIPE_WEBHOOK_SECRET;
const signature = await stripe.webhooks.generateTestHeaderStringAsync({ payload, secret });

const response = await fetch(target, {
  method: "POST",
  headers: { "Content-Type": "application/json", "stripe-signature": signature },
  body: payload,
});
console.log(response.status, await response.text(), `session=${sessionId}`);
