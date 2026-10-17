import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, userClient } from "./supabase.js";
import { bearerToken, forbidden, unauthorized } from "./http.js";

export type Role = "owner" | "editor" | "viewer";

export interface AuthContext {
  userId: string;
  email: string | null;
  /** The caller's Supabase access token (JWT). */
  token: string;
  /** The CRM workspace the caller belongs to. */
  workspaceId: string;
  role: Role;
  isPlatformAdmin: boolean;
  /** Supabase client acting as the caller (row level security applies). */
  db: SupabaseClient;
}

/**
 * Authenticates a request from the CRM front end.
 *
 * The bearer token is verified by Supabase Auth (signature, expiry, revoked
 * sessions), then the caller's membership is read from the database. Pass
 * `roles` to require one of them; viewers are read-only in the CRM, so any
 * route that changes data should require owner or editor.
 */
export async function requireAuth(req: Request, opts: { roles?: Role[] } = {}): Promise<AuthContext> {
  const token = bearerToken(req);
  if (!token) throw unauthorized("Sign in first.");
  const admin = adminClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) throw unauthorized();
  const user = data.user;

  const [{ data: membership, error: mErr }, { data: profile }] = await Promise.all([
    admin
      .from("workspace_members")
      .select("workspace_id, role")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    admin.from("profiles").select("is_platform_admin").eq("id", user.id).maybeSingle(),
  ]);
  if (mErr) throw mErr;
  if (!membership) throw forbidden("You haven't been added to the CRM yet.");
  const role = membership.role as Role;
  if (opts.roles && !opts.roles.includes(role)) {
    throw forbidden(role === "viewer" ? "Viewers can't make changes in the CRM." : "Only the CRM owner can do that.");
  }
  return {
    userId: user.id,
    email: user.email ?? null,
    token,
    workspaceId: membership.workspace_id as string,
    role,
    isPlatformAdmin: !!profile?.is_platform_admin,
    db: userClient(token),
  };
}

export const EDITORS: Role[] = ["owner", "editor"];
export const OWNER: Role[] = ["owner"];
