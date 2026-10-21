-- ============================================================================
-- Explicit table and function privileges.
--
-- Until now the schema relied on Supabase's default grants, which differ
-- between projects (older projects give anon and authenticated every
-- privilege, including TRUNCATE, on every table; newer ones give none). Row
-- level security still decided what people could see, but the grants were
-- broader than needed and not visible in the code.
--
-- From here on the privileges are spelled out:
--   anon           nothing (signing in uses Supabase Auth, not these tables)
--   authenticated  only the statements the app makes; RLS filters the rows
--   service_role   everything (the server and background jobs)
-- ============================================================================

-- Start from nothing for the browser roles.
revoke all on all tables in schema public from anon, authenticated;

-- CRM records: read and write, filtered by RLS (viewers can only read).
grant select, insert, update, delete on public.companies, public.contacts, public.deals, public.tasks, public.activities to authenticated;
grant select, insert, update, delete on public.user_preferences to authenticated;

-- Integration data the browser may read (RLS filters it); writes go through the server.
grant select on public.email_accounts, public.email_messages, public.email_sends, public.calls to authenticated;

-- Existing tables, as the app uses them.
grant select on public.plans to authenticated;
grant select, update on public.profiles to authenticated;
grant select, update on public.workspaces to authenticated;
grant select, update, delete on public.workspace_members to authenticated;
grant select, update on public.workspace_state to authenticated;

-- The server.
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- Functions used inside RLS policies run as the querying user.
grant execute on function
  public.is_platform_admin(),
  public.workspace_role(uuid),
  public.shares_workspace_with(uuid),
  public.is_workspace_member(uuid),
  public.can_edit_workspace(uuid),
  public.is_workspace_owner(uuid),
  public.crm_can_read(uuid),
  public.crm_can_write(uuid)
to authenticated;

-- Tables and functions added by future migrations reach the server by default;
-- browser access must always be granted explicitly.
alter default privileges for role postgres in schema public grant all on tables to service_role;
alter default privileges for role postgres in schema public grant usage, select on sequences to service_role;
alter default privileges for role postgres in schema public grant execute on functions to service_role;
