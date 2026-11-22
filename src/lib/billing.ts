import { loadStripe } from "@stripe/stripe-js";
import { supabase } from "./supabase";

const STRIPE_PUBLISHABLE_KEY = "pk_test_sample_not_a_real_key";

export async function startCheckout(companyId: string, priceId: string) {
  const { data, error } = await supabase.functions.invoke("create-checkout", {
    body: { companyId, priceId },
  });
  if (error) throw error;
  const stripe = await loadStripe(STRIPE_PUBLISHABLE_KEY);
  if (!stripe) throw new Error("Payments are unavailable right now");
  window.location.href = data.url;
}
