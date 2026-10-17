import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./env.js";

let admin: SupabaseClient | null = null;

/**
 * Service-role client. It bypasses row level security, so only use it for
 * work no user client can do (tokens, webhooks, background jobs), and always
 * check permissions in code first. Never send anything from it to a browser
 * without filtering.
 */
export function adminClient(): SupabaseClient {
  if (!admin) {
    admin = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return admin;
}

/**
 * A client that acts as the signed-in person: every query runs through row
 * level security exactly as it would from the browser.
 */
export function userClient(accessToken: string): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** For tests: replace the cached admin client. */
export function __setAdminClientForTests(client: SupabaseClient | null) {
  admin = client;
}
