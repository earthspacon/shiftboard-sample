// Stripe calls this after checkout. It upgrades the company to the paid plan.
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
});
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const PLAN_BY_PRICE: Record<string, string> = {
  price_team_monthly: "team",
  price_pro_monthly: "pro",
};

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing signature", { status: 400 });
  }

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
  } catch (error) {
    console.error("Bad webhook signature", error);
    return new Response("Bad signature", { status: 400 });
  }

  if (event.type !== "checkout.session.completed") {
    return new Response("Ignored", { status: 200 });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const companyId = session.client_reference_id;
  if (!companyId) {
    return new Response("No company on session", { status: 400 });
  }
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
  const priceId = lineItems.data[0]?.price?.id ?? "";
  const plan = PLAN_BY_PRICE[priceId] ?? "team";

  await supabase.from("payments").upsert({
    company_id: companyId,
    stripe_session_id: session.id,
    amount_cents: session.amount_total ?? 0,
    status: session.payment_status,
  }, { onConflict: "stripe_session_id" });

  const { error } = await supabase.from("companies").update({
    plan,
    stripe_customer_id: typeof session.customer === "string" ? session.customer : null,
  }).eq("id", companyId);

  if (error) {
    console.error("Plan update failed", error);
    return new Response("Update failed", { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true, plan }), {
    headers: { "Content-Type": "application/json" },
  });
});
