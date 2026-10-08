-- ============================================================================
-- Brandigade CRM: multi-tenant SaaS schema
--
-- Every customer gets a workspace. People belong to workspaces with a role.
-- Each workspace's CRM data (contacts, companies, deals, activities, tasks)
-- lives in one JSON document in workspace_state. Plans set seat and contact
-- limits. Platform admins (you) can see and manage every workspace.
--
-- Applied automatically by `supabase db push` in the GitHub deploy workflow.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.plans (
  id            text primary key,
  name          text not null,
  seat_limit    integer not null check (seat_limit > 0),
  contact_limit integer check (contact_limit is null or contact_limit > 0), -- null = unlimited
  price_monthly numeric(10,2) not null default 0,
  sort_order    integer not null default 0
);

insert into public.plans (id, name, seat_limit, contact_limit, price_monthly, sort_order) values
  ('free',     'Free',     3,  250,  0,   1),
  ('pro',      'Pro',      10, null, 29,  2),
  ('business', 'Business', 50, null, 99,  3)
on conflict (id) do nothing;

create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  email             text not null,
  display_name      text,
  avatar_data       text,                 -- small square JPEG as a data: URL
  is_platform_admin boolean not null default false,
  created_at        timestamptz not null default now()
);

create table if not exists public.workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 80),
  plan_id    text not null default 'free' references public.plans(id),
  status     text not null default 'active' check (status in ('active', 'suspended')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  role         text not null default 'viewer' check (role in ('owner', 'editor', 'viewer')),
  invited      boolean not null default false,   -- true until the invite is accepted
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists workspace_members_user_idx on public.workspace_members(user_id);

create table if not exists public.workspace_state (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  data         jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references public.profiles(id) on delete set null
);

-- De-duplication log for the due-task email function (service role only).
create table if not exists public.sent_task_emails (
  key          text primary key,                -- workspaceId|taskId|dueDate|dueTime
  workspace_id uuid references public.workspaces(id) on delete cascade,
  task_id      text not null,
  sent_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Helper functions (security definer so policies can use them without recursion)
-- ---------------------------------------------------------------------------
create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_platform_admin from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.workspace_role(ws uuid)
returns text language sql stable security definer set search_path = public as $$
  select role from public.workspace_members where workspace_id = ws and user_id = auth.uid();
$$;

create or replace function public.shares_workspace_with(other uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workspace_members a
    join public.workspace_members b on a.workspace_id = b.workspace_id
    where a.user_id = auth.uid() and b.user_id = other
  );
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.plans             enable row level security;
alter table public.profiles          enable row level security;
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_state   enable row level security;
alter table public.sent_task_emails  enable row level security;

-- plans: everyone signed in can read; platform admins edit.
drop policy if exists plans_read on public.plans;
create policy plans_read on public.plans for select to authenticated using (true);
drop policy if exists plans_admin_write on public.plans;
create policy plans_admin_write on public.plans for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- profiles: yourself, your teammates, or a platform admin.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_workspace_with(id) or public.is_platform_admin());
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_platform_admin());

-- workspaces: members read; owners rename; platform admins do anything.
drop policy if exists workspaces_read on public.workspaces;
create policy workspaces_read on public.workspaces for select to authenticated
  using (public.workspace_role(id) is not null or public.is_platform_admin());
drop policy if exists workspaces_update on public.workspaces;
create policy workspaces_update on public.workspaces for update to authenticated
  using (public.workspace_role(id) = 'owner' or public.is_platform_admin());
drop policy if exists workspaces_delete on public.workspaces;
create policy workspaces_delete on public.workspaces for delete to authenticated
  using (public.is_platform_admin());

-- workspace_members: members see their team; owners change roles and remove people.
drop policy if exists members_read on public.workspace_members;
create policy members_read on public.workspace_members for select to authenticated
  using (public.workspace_role(workspace_id) is not null or public.is_platform_admin());
drop policy if exists members_update on public.workspace_members;
create policy members_update on public.workspace_members for update to authenticated
  using ((public.workspace_role(workspace_id) = 'owner' and user_id <> auth.uid()) or public.is_platform_admin());
drop policy if exists members_delete on public.workspace_members;
create policy members_delete on public.workspace_members for delete to authenticated
  using ((public.workspace_role(workspace_id) = 'owner' and user_id <> auth.uid()) or public.is_platform_admin());

-- workspace_state: members read; editors and owners write while the workspace is active.
drop policy if exists state_read on public.workspace_state;
create policy state_read on public.workspace_state for select to authenticated
  using (public.workspace_role(workspace_id) is not null or public.is_platform_admin());
drop policy if exists state_update on public.workspace_state;
create policy state_update on public.workspace_state for update to authenticated
  using (
    (public.workspace_role(workspace_id) in ('owner', 'editor')
      and exists (select 1 from public.workspaces w where w.id = workspace_id and w.status = 'active'))
    or public.is_platform_admin()
  );

-- ---------------------------------------------------------------------------
-- Guard triggers
-- ---------------------------------------------------------------------------

-- Only platform admins can grant platform admin.
create or replace function public.guard_profile_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.is_platform_admin is distinct from old.is_platform_admin and not public.is_platform_admin() then
    new.is_platform_admin := old.is_platform_admin;
  end if;
  if new.email is distinct from old.email and auth.uid() is not null and not public.is_platform_admin() then
    new.email := old.email;
  end if;
  return new;
end;
$$;
drop trigger if exists before_profile_update on public.profiles;
create trigger before_profile_update before update on public.profiles
  for each row execute function public.guard_profile_update();

-- Only platform admins change a workspace's plan or status; owners can only rename.
create or replace function public.guard_workspace_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_platform_admin() then
    new.plan_id := old.plan_id;
    new.status := old.status;
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;
drop trigger if exists before_workspace_update on public.workspaces;
create trigger before_workspace_update before update on public.workspaces
  for each row execute function public.guard_workspace_update();

-- Owners can't hand out the owner role, and a workspace always keeps its owner.
create or replace function public.guard_member_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_platform_admin() then
    if new.role = 'owner' or old.role = 'owner' then
      new.role := old.role;
    end if;
    new.invited := old.invited;
  end if;
  return new;
end;
$$;
drop trigger if exists before_member_update on public.workspace_members;
create trigger before_member_update before update on public.workspace_members
  for each row execute function public.guard_member_update();

create or replace function public.guard_member_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'owner' and auth.uid() is not null and not public.is_platform_admin()
     and exists (select 1 from public.workspaces where id = old.workspace_id) then
    raise exception 'A workspace owner cannot be removed';
  end if;
  return old;
end;
$$;
drop trigger if exists before_member_delete on public.workspace_members;
create trigger before_member_delete before delete on public.workspace_members
  for each row execute function public.guard_member_delete();

-- Seat limit from the workspace's plan.
create or replace function public.enforce_seat_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  seats integer;
  used integer;
begin
  select p.seat_limit into seats from public.workspaces w join public.plans p on p.id = w.plan_id where w.id = new.workspace_id;
  select count(*) into used from public.workspace_members where workspace_id = new.workspace_id;
  if seats is not null and used >= seats then
    raise exception 'Seat limit reached: this plan allows % people', seats using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists before_member_insert on public.workspace_members;
create trigger before_member_insert before insert on public.workspace_members
  for each row execute function public.enforce_seat_limit();

-- Contact limit from the plan. Only blocks saves that add contacts beyond the limit.
create or replace function public.enforce_contact_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  lim integer;
  new_count integer := coalesce(jsonb_array_length(case when jsonb_typeof(new.data->'contacts') = 'array' then new.data->'contacts' end), 0);
  old_count integer := coalesce(jsonb_array_length(case when jsonb_typeof(old.data->'contacts') = 'array' then old.data->'contacts' end), 0);
begin
  select p.contact_limit into lim from public.workspaces w join public.plans p on p.id = w.plan_id where w.id = new.workspace_id;
  if lim is not null and new_count > lim and new_count > old_count then
    raise exception 'Contact limit reached: this plan allows % contacts', lim using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists before_state_update on public.workspace_state;
create trigger before_state_update before update on public.workspace_state
  for each row execute function public.enforce_contact_limit();

-- ---------------------------------------------------------------------------
-- Auth triggers
-- ---------------------------------------------------------------------------

-- New auth user -> profile. The very first person to sign up becomes a platform admin.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, is_platform_admin)
  values (new.id, new.email, not exists (select 1 from public.profiles))
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Invite accepted (email confirmed) -> memberships stop being "invited".
create or replace function public.handle_user_confirmed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email_confirmed_at is not null and old.email_confirmed_at is null then
    update public.workspace_members set invited = false where user_id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed after update on auth.users
  for each row execute function public.handle_user_confirmed();

-- ---------------------------------------------------------------------------
-- RPCs called by the app
-- ---------------------------------------------------------------------------

-- Any signed-in person can start a workspace and becomes its owner.
create or replace function public.create_workspace(ws_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if coalesce(trim(ws_name), '') = '' then raise exception 'Workspace name is required'; end if;
  insert into public.workspaces (name, created_by) values (trim(ws_name), auth.uid()) returning id into ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws, auth.uid(), 'owner');
  insert into public.workspace_state (workspace_id, data, updated_by) values (ws, '{}'::jsonb, auth.uid());
  return ws;
end;
$$;

-- Platform console: every workspace with its plan, owner and usage.
create or replace function public.admin_list_workspaces()
returns table (
  id uuid, name text, plan_id text, status text, created_at timestamptz,
  owner_email text, member_count bigint, contact_count integer, deal_count integer,
  open_pipeline numeric, updated_at timestamptz
) language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admins only'; end if;
  return query
  select w.id, w.name, w.plan_id, w.status, w.created_at,
    (select p.email from public.workspace_members m join public.profiles p on p.id = m.user_id
      where m.workspace_id = w.id and m.role = 'owner' order by m.created_at limit 1),
    (select count(*) from public.workspace_members m where m.workspace_id = w.id),
    coalesce(jsonb_array_length(case when jsonb_typeof(s.data->'contacts') = 'array' then s.data->'contacts' end), 0),
    coalesce(jsonb_array_length(case when jsonb_typeof(s.data->'deals') = 'array' then s.data->'deals' end), 0),
    coalesce((select sum(coalesce((d->>'value')::numeric, 0))
      from jsonb_array_elements(case when jsonb_typeof(s.data->'deals') = 'array' then s.data->'deals' else '[]'::jsonb end) d
      where d->>'stage' in ('lead', 'qualified', 'proposal', 'negotiation')), 0),
    s.updated_at
  from public.workspaces w
  left join public.workspace_state s on s.workspace_id = w.id
  order by w.created_at desc;
end;
$$;

-- Platform console: every user with how many workspaces they're in.
create or replace function public.admin_list_users()
returns table (id uuid, email text, display_name text, is_platform_admin boolean, created_at timestamptz, workspace_count bigint, workspaces text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admins only'; end if;
  return query
  select p.id, p.email, p.display_name, p.is_platform_admin, p.created_at,
    (select count(*) from public.workspace_members m where m.user_id = p.id),
    (select string_agg(w.name || ' (' || m.role || ')', ', ' order by w.name)
      from public.workspace_members m join public.workspaces w on w.id = m.workspace_id where m.user_id = p.id)
  from public.profiles p
  order by p.created_at desc;
end;
$$;

-- Clients only call RPCs as signed-in users.
revoke execute on function public.create_workspace(text) from public, anon;
revoke execute on function public.admin_list_workspaces() from public, anon;
revoke execute on function public.admin_list_users() from public, anon;
grant execute on function public.create_workspace(text) to authenticated;
grant execute on function public.admin_list_workspaces() to authenticated;
grant execute on function public.admin_list_users() to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: open browsers see changes instantly
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'workspace_state') then
      alter publication supabase_realtime add table public.workspace_state;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'workspace_members') then
      alter publication supabase_realtime add table public.workspace_members;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'workspaces') then
      alter publication supabase_realtime add table public.workspaces;
    end if;
  end if;
end $$;
