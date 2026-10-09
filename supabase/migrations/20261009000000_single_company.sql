-- ============================================================================
-- Brandigade CRM as one shared company CRM
--
-- There is a single workspace (the Brandigade CRM) instead of one per customer,
-- and no plans or limits. The first person to sign up becomes the admin and owner;
-- everyone else gets in when the owner invites them from the Team page. People who
-- sign up without an invite can log in but see nothing until they are added.
-- ============================================================================

-- No seat or contact limits.
drop trigger if exists before_member_insert on public.workspace_members;
drop function if exists public.enforce_seat_limit();

create or replace function public.touch_state_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists before_state_update on public.workspace_state;
create trigger before_state_update before update on public.workspace_state
  for each row execute function public.touch_state_updated_at();
drop function if exists public.enforce_contact_limit();

-- No self-serve workspaces and no multi-customer admin console.
drop function if exists public.create_workspace(text);
drop function if exists public.admin_list_workspaces();
drop function if exists public.admin_list_users();

-- Only one workspace can ever exist.
create unique index if not exists workspaces_single_company on public.workspaces ((true));

-- Creates the company CRM if it doesn't exist yet, and makes owner_id its owner
-- if it has none (for example after the first account was deleted and re-created).
create or replace function public.ensure_company_workspace(owner_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
begin
  if owner_id is null then return; end if;
  select id into ws from public.workspaces limit 1;
  if ws is null then
    insert into public.workspaces (name, created_by) values ('Brandigade', owner_id) returning id into ws;
    insert into public.workspace_state (workspace_id, data, updated_by) values (ws, '{}'::jsonb, owner_id);
  end if;
  if not exists (select 1 from public.workspace_members where workspace_id = ws and role = 'owner') then
    insert into public.workspace_members (workspace_id, user_id, role) values (ws, owner_id, 'owner')
    on conflict (workspace_id, user_id) do update set role = 'owner', invited = false;
  end if;
end;
$$;
revoke execute on function public.ensure_company_workspace(uuid) from public, anon, authenticated;

-- New auth user -> profile. The first person to sign up becomes admin and owner.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  first_user boolean := not exists (select 1 from public.profiles);
begin
  insert into public.profiles (id, email, is_platform_admin)
  values (new.id, new.email, first_user)
  on conflict (id) do nothing;
  if first_user then
    perform public.ensure_company_workspace(new.id);
  end if;
  return new;
end;
$$;

-- Accounts that already exist: give the earliest admin the company CRM.
select public.ensure_company_workspace(
  (select id from public.profiles where is_platform_admin order by created_at limit 1)
);

-- The CRM always keeps its owner, even against an admin's own client.
create or replace function public.guard_member_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'owner' and auth.uid() is not null
     and exists (select 1 from public.workspaces where id = old.workspace_id) then
    raise exception 'The CRM owner cannot be removed';
  end if;
  return old;
end;
$$;
