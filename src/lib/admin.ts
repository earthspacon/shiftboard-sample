import { createClient } from "@supabase/supabase-js";

const SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhbXBsZTAwMDAwMDAwMDAwMDAwMCIsInJvbGUiOiJzZXJ2aWNlX3JvbGUiLCJpYXQiOjE3ODExMzYwMDAsImV4cCI6MjA5NjcxMjAwMH0.RVm9TBn1HNHk3h4O2-yDAJ_3jOq2tI3P_YuxGoE4YuM";

// Full access client for owner tools: inviting cleaners and fixing rates.
export const adminClient = createClient(import.meta.env.VITE_SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export async function inviteCleaner(email: string, companyId: string, fullName: string) {
  const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email);
  if (error) throw error;
  const { error: staffError } = await adminClient.from("staff").insert({
    id: data.user.id,
    company_id: companyId,
    full_name: fullName,
    role: "cleaner",
  });
  if (staffError) throw staffError;
  return data.user.id;
}

export async function setHourlyRate(staffId: string, hourlyRateCents: number) {
  const { error } = await adminClient.from("staff").update({ hourly_rate_cents: hourlyRateCents }).eq("id", staffId);
  if (error) throw error;
}
