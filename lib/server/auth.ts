import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, userClient } from "./supabase.js";
import { bearerToken, forbidden, unauthorized } from "./http.js";

export type Role = "owner" | "admin" | "editor" | "viewer";

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
 * Verifies the caller's Supabase access token only: for the few routes a
 * signed-in person may use before they are on the team (joining it).
 */
export async function requireUser(req: Request): Promise<{ user: { id: string; email?: string | null }; token: string }> {
  const token = bearerToken(req);
  if (!token) throw unauthorized("Sign in first.");
  const { data, error } = await adminClient().auth.getUser(token);
  if (error || !data?.user) throw unauthorized();
  return { user: data.user, token };
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
  const { user, token } = await requireUser(req);
  const admin = adminClient();

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

/** Everyone who may change CRM data (which records: row level security decides). */
export const EDITORS: Role[] = ["owner", "admin", "editor"];
export const OWNER: Role[] = ["owner"];
