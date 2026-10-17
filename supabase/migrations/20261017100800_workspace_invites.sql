-- Invites for people who already have a login.
--
-- Anyone can sign up with any address, so an existing account proves nothing
-- about who owns the mailbox. Instead of adding such an account to the team
-- straight away, the server keeps a pending invite here and emails a join link
-- to the address. The membership is only created when the link is opened while
-- signed in as that address (POST /api/team/join), and at that moment the
-- account's password is replaced and its other sessions are signed out, so
-- whoever registered the address beforehand loses access.
--
-- Only the server writes this table (service role). Owners can list their
-- team's invites; nobody can read the token hashes.

create table if not exists public.workspace_invites (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email        text not null check (email = lower(email) and length(email) between 3 and 320),
  role         text not null check (role in ('editor', 'viewer')),
  token_hash   text not null unique,
  invited_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  accepted_by  uuid references public.profiles(id) on delete set null
);
-- One open invite per address and team (inviting again replaces it).
create unique index if not exists workspace_invites_open_idx on public.workspace_invites(workspace_id, email) where accepted_at is null;

alter table public.workspace_invites enable row level security;

drop policy if exists invites_owner_read on public.workspace_invites;
create policy invites_owner_read on public.workspace_invites for select to authenticated
  using (public.is_workspace_owner(workspace_id));

revoke all on public.workspace_invites from anon, authenticated;
grant select (id, workspace_id, email, role, invited_by, created_at, expires_at, accepted_at) on public.workspace_invites to authenticated;
grant all on public.workspace_invites to service_role;

-- The profile checks from the security hardening migration were added NOT
-- VALID. Profiles saved by the app always pass (160 px JPEG avatars), so
-- validate them now; if an old row doesn't, leave the check as it was (new and
-- changed rows are still checked) instead of failing the migration.
do $$
declare c text;
begin
  foreach c in array array['profiles_display_name_length', 'profiles_avatar_is_image'] loop
    begin
      execute format('alter table public.profiles validate constraint %I', c);
    exception when check_violation then
      raise notice 'profiles: % not validated, some existing rows do not pass it', c;
    end;
  end loop;
end $$;
