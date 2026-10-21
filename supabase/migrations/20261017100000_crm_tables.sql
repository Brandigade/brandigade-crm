-- ============================================================================
-- CRM records move out of the single JSON document into real tables.
--
-- Until now every contact, company, deal, task and activity lived inside
-- workspace_state.data and each save rewrote the whole document. That made it
-- impossible for background work (email sync, call webhooks, notifications) to
-- add records safely, and it gave row level security nothing to work with.
--
-- This migration:
--   1. adds workspace settings, permission helpers and shared triggers,
--   2. creates companies, contacts, deals, tasks and activities with RLS,
--   3. copies every existing record out of workspace_state (ids are kept in
--      legacy_id so old reminder links keep working). workspace_state itself
--      is left untouched as a backup.
--
-- Re-running is safe: the copy skips records it has already copied.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Workspace settings (currency, timezone, calling options) get their own column.
-- ---------------------------------------------------------------------------
alter table public.workspaces add column if not exists settings jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- Permission helpers. SECURITY DEFINER so policies can call them without
-- recursing into workspace_members' own policies.
-- ---------------------------------------------------------------------------
create or replace function public.is_workspace_member(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members where workspace_id = ws and user_id = auth.uid());
$$;

create or replace function public.can_edit_workspace(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members
                 where workspace_id = ws and user_id = auth.uid() and role in ('owner', 'editor'));
$$;

create or replace function public.is_workspace_owner(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members
                 where workspace_id = ws and user_id = auth.uid() and role = 'owner');
$$;

-- Read / write gates used by every CRM table. Platform admins keep the access
-- they already had to workspace_state.
create or replace function public.crm_can_read(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_workspace_member(ws) or public.is_platform_admin();
$$;

create or replace function public.crm_can_write(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.can_edit_workspace(ws) or public.is_platform_admin();
$$;

-- ---------------------------------------------------------------------------
-- Shared triggers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Records created by a signed-in person are attributed to them, whatever the
-- client sent. Service-role inserts (migrations, webhooks) keep their value.
create or replace function public.set_created_by()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

-- Small casting helpers for the one-off copy out of the JSON document.
create or replace function pg_temp.j_text(v jsonb, max_len integer default 20000)
returns text language sql immutable as $$
  select nullif(left(btrim(v #>> '{}'), max_len), '');
$$;
create or replace function pg_temp.j_date(v jsonb)
returns date language plpgsql immutable as $$
begin
  if v is null or jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^\d{4}-\d{2}-\d{2}' then return null; end if;
  return left(v #>> '{}', 10)::date;
exception when others then return null;
end;
$$;
create or replace function pg_temp.j_time(v jsonb)
returns time language plpgsql immutable as $$
begin
  if v is null or jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^\d{1,2}:\d{2}' then return null; end if;
  return (v #>> '{}')::time;
exception when others then return null;
end;
$$;
create or replace function pg_temp.j_ts(v jsonb)
returns timestamptz language plpgsql immutable as $$
begin
  if v is null or jsonb_typeof(v) <> 'string' then return null; end if;
  return (v #>> '{}')::timestamptz;
exception when others then return null;
end;
$$;
create or replace function pg_temp.j_num(v jsonb)
returns numeric language plpgsql immutable as $$
begin
  if v is null then return 0; end if;
  return greatest(0, least(coalesce((v #>> '{}')::numeric, 0), 999999999999));
exception when others then return 0;
end;
$$;
create or replace function pg_temp.j_profile(v jsonb)
returns uuid language sql stable as $$
  select p.id from public.profiles p where p.id::text = (v #>> '{}');
$$;

-- ---------------------------------------------------------------------------
-- Companies
-- ---------------------------------------------------------------------------
create table if not exists public.companies (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  legacy_id    text,
  name         text not null check (char_length(name) between 1 and 200),
  industry     text check (char_length(industry) <= 100),
  website      text check (char_length(website) <= 300),
  phone        text check (char_length(phone) <= 50),
  city         text check (char_length(city) <= 100),
  notes        text check (char_length(notes) <= 20000),
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists companies_workspace_idx on public.companies(workspace_id);
create unique index if not exists companies_legacy_idx on public.companies(workspace_id, legacy_id) where legacy_id is not null;

-- ---------------------------------------------------------------------------
-- Contacts (the CRM's leads). email_normalized and phone_digits are what email
-- sync and incoming calls match on.
-- ---------------------------------------------------------------------------
create table if not exists public.contacts (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  legacy_id        text,
  first_name       text not null default '' check (char_length(first_name) <= 100),
  last_name        text check (char_length(last_name) <= 100),
  email            text check (char_length(email) <= 320),
  phone            text check (char_length(phone) <= 50),
  title            text check (char_length(title) <= 150),
  company_id       uuid references public.companies(id) on delete set null,
  status           text not null default 'lead' check (status in ('lead', 'prospect', 'customer', 'inactive')),
  owner_id         uuid references public.profiles(id) on delete set null,
  source           text check (char_length(source) <= 100),
  notes            text check (char_length(notes) <= 20000),
  email_normalized text generated always as (nullif(lower(btrim(email)), '')) stored,
  phone_digits     text generated always as (nullif(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), '')) stored,
  last_activity_at timestamptz,
  created_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists contacts_workspace_idx on public.contacts(workspace_id);
create index if not exists contacts_company_idx on public.contacts(company_id);
create index if not exists contacts_email_idx on public.contacts(workspace_id, email_normalized) where email_normalized is not null;
create index if not exists contacts_phone_idx on public.contacts(workspace_id, right(phone_digits, 9)) where phone_digits is not null;
create unique index if not exists contacts_legacy_idx on public.contacts(workspace_id, legacy_id) where legacy_id is not null;

-- ---------------------------------------------------------------------------
-- Deals
-- ---------------------------------------------------------------------------
create table if not exists public.deals (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  legacy_id    text,
  title        text not null check (char_length(title) between 1 and 200),
  company_id   uuid references public.companies(id) on delete set null,
  contact_id   uuid references public.contacts(id) on delete set null,
  value        numeric(14, 2) not null default 0 check (value >= 0),
  stage        text not null default 'lead' check (stage in ('lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost')),
  owner_id     uuid references public.profiles(id) on delete set null,
  close_date   date,
  closed_at    date,
  notes        text check (char_length(notes) <= 20000),
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists deals_workspace_idx on public.deals(workspace_id);
create index if not exists deals_company_idx on public.deals(company_id);
create index if not exists deals_contact_idx on public.deals(contact_id);
create unique index if not exists deals_legacy_idx on public.deals(workspace_id, legacy_id) where legacy_id is not null;

-- ---------------------------------------------------------------------------
-- Tasks. contact_id is new: a task can now point straight at a lead.
-- assigned_at / assigned_by / assignment_version are kept by a trigger and
-- drive the "task assigned" email (one email per assignment).
-- ---------------------------------------------------------------------------
create table if not exists public.tasks (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces(id) on delete cascade,
  legacy_id          text,
  title              text not null check (char_length(title) between 1 and 300),
  workstream         text not null default 'General' check (char_length(workstream) <= 50),
  status             text not null default 'todo' check (status in ('todo', 'doing', 'done')),
  due_date           date,
  due_time           time,
  reminder           text not null default 'none' check (reminder in ('none', 'at_due', '15_min', '1_hour', '1_day')),
  priority           text not null default 'none' check (priority in ('none', 'low', 'medium', 'high')),
  assigned_to        uuid references public.profiles(id) on delete set null,
  deal_id            uuid references public.deals(id) on delete set null,
  contact_id         uuid references public.contacts(id) on delete set null,
  notes              text check (char_length(notes) <= 20000),
  completed_at       timestamptz,
  assigned_at        timestamptz,
  assigned_by        uuid references public.profiles(id) on delete set null,
  assignment_version integer not null default 0,
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists tasks_workspace_idx on public.tasks(workspace_id);
create index if not exists tasks_open_due_idx on public.tasks(workspace_id, due_date) where status <> 'done';
create index if not exists tasks_assignee_idx on public.tasks(assigned_to);
create index if not exists tasks_deal_idx on public.tasks(deal_id);
create index if not exists tasks_contact_idx on public.tasks(contact_id);
create unique index if not exists tasks_legacy_idx on public.tasks(workspace_id, legacy_id) where legacy_id is not null;

create or replace function public.tasks_before_write()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.assigned_to is not null then
      new.assignment_version := 1;
      new.assigned_at := now();
      new.assigned_by := coalesce(auth.uid(), new.assigned_by);
    else
      new.assignment_version := 0;
      new.assigned_at := null;
      new.assigned_by := null;
    end if;
    if new.status = 'done' and new.completed_at is null then new.completed_at := now(); end if;
  else
    -- Clients can't rewrite the assignment bookkeeping.
    if new.assigned_to is distinct from old.assigned_to then
      new.assignment_version := old.assignment_version + 1;
      new.assigned_at := case when new.assigned_to is null then null else now() end;
      new.assigned_by := case when new.assigned_to is null then null else auth.uid() end;
    else
      new.assignment_version := old.assignment_version;
      new.assigned_at := old.assigned_at;
      new.assigned_by := old.assigned_by;
    end if;
    if new.status = 'done' and old.status <> 'done' then new.completed_at := now();
    elsif new.status <> 'done' then new.completed_at := null;
    else new.completed_at := old.completed_at;
    end if;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Activities: the one timeline every lead, company and deal shows.
--   source = 'manual'  notes, meetings and calls/emails logged by hand
--   source = 'email'   a synced or sent email (email_message_id)
--   source = 'call'    a call placed or received through the dialer (call_id)
--   source = 'task'    a task being created, completed, reassigned... (task_id)
-- Only manual activities can be written by the app; the others are kept in
-- step with their source record by triggers (see the timeline migration).
-- visibility = 'private' rows are only visible to owner_user_id.
-- ---------------------------------------------------------------------------
create table if not exists public.activities (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces(id) on delete cascade,
  legacy_id           text,
  type                text not null check (type in ('note', 'call', 'email', 'meeting', 'task')),
  source              text not null default 'manual' check (source in ('manual', 'email', 'call', 'task')),
  event               text check (char_length(event) <= 40),
  subject             text not null default '' check (char_length(subject) <= 500),
  body                text check (char_length(body) <= 20000),
  occurred_at         timestamptz not null default now(),
  actor_id            uuid references public.profiles(id) on delete set null,
  contact_id          uuid references public.contacts(id) on delete set null,
  company_id          uuid references public.companies(id) on delete set null,
  deal_id             uuid references public.deals(id) on delete set null,
  related_contact_ids uuid[] not null default '{}',
  visibility          text not null default 'team' check (visibility in ('team', 'private')),
  owner_user_id       uuid references public.profiles(id) on delete cascade,
  email_message_id    uuid,
  call_id             uuid,
  task_id             uuid references public.tasks(id) on delete set null,
  dedupe_key          text,
  meta                jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint activities_private_has_owner check (visibility = 'team' or owner_user_id is not null)
);
create index if not exists activities_workspace_time_idx on public.activities(workspace_id, occurred_at desc);
create index if not exists activities_contact_time_idx on public.activities(contact_id, occurred_at desc);
create index if not exists activities_company_time_idx on public.activities(company_id, occurred_at desc);
create index if not exists activities_deal_time_idx on public.activities(deal_id, occurred_at desc);
create index if not exists activities_related_contacts_idx on public.activities using gin (related_contact_ids);
create index if not exists activities_task_idx on public.activities(task_id);
create unique index if not exists activities_dedupe_idx on public.activities(workspace_id, dedupe_key) where dedupe_key is not null;
create unique index if not exists activities_legacy_idx on public.activities(workspace_id, legacy_id) where legacy_id is not null;

-- People logging an activity by hand are its actor, whatever the client sent.
create or replace function public.activities_before_write()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null and new.source = 'manual' then
    if tg_op = 'INSERT' then
      new.actor_id := auth.uid();
    else
      new.actor_id := old.actor_id;
      new.created_at := old.created_at;
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['companies', 'contacts', 'deals', 'tasks', 'activities'] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
  foreach t in array array['companies', 'contacts', 'deals', 'tasks'] loop
    execute format('drop trigger if exists set_created_by on public.%I', t);
    execute format('create trigger set_created_by before insert on public.%I for each row execute function public.set_created_by()', t);
  end loop;
end $$;

drop trigger if exists tasks_before_write on public.tasks;
create trigger tasks_before_write before insert or update on public.tasks
  for each row execute function public.tasks_before_write();

drop trigger if exists activities_before_write on public.activities;
create trigger activities_before_write before insert or update on public.activities
  for each row execute function public.activities_before_write();

-- Contacts, deals and companies keep their creator and creation time.
create or replace function public.keep_creation_fields()
returns trigger language plpgsql as $$
begin
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.workspace_id := old.workspace_id;
  return new;
end;
$$;
do $$
declare t text;
begin
  foreach t in array array['companies', 'contacts', 'deals'] loop
    execute format('drop trigger if exists keep_creation_fields on public.%I', t);
    execute format('create trigger keep_creation_fields before update on public.%I for each row execute function public.keep_creation_fields()', t);
  end loop;
end $$;

-- A record can never be moved to another workspace.
create or replace function public.keep_workspace()
returns trigger language plpgsql as $$
begin
  new.workspace_id := old.workspace_id;
  return new;
end;
$$;
drop trigger if exists keep_workspace on public.tasks;
create trigger keep_workspace before update on public.tasks for each row execute function public.keep_workspace();
drop trigger if exists keep_workspace on public.activities;
create trigger keep_workspace before update on public.activities for each row execute function public.keep_workspace();

-- ---------------------------------------------------------------------------
-- Row level security
--   every member reads; owners and editors write; viewers are read-only.
-- ---------------------------------------------------------------------------
alter table public.companies  enable row level security;
alter table public.contacts   enable row level security;
alter table public.deals      enable row level security;
alter table public.tasks      enable row level security;
alter table public.activities enable row level security;

do $$
declare t text;
begin
  foreach t in array array['companies', 'contacts', 'deals', 'tasks'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.crm_can_read(workspace_id))', t || '_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.crm_can_write(workspace_id))', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.crm_can_write(workspace_id)) with check (public.crm_can_write(workspace_id))', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.crm_can_write(workspace_id))', t || '_delete', t);
  end loop;
end $$;

-- Activities: private rows are only ever visible to their owner (not even to
-- platform admins). The app may only write manual activities.
drop policy if exists activities_read on public.activities;
create policy activities_read on public.activities for select to authenticated
  using (public.crm_can_read(workspace_id) and (visibility = 'team' or owner_user_id = auth.uid()));
drop policy if exists activities_insert on public.activities;
create policy activities_insert on public.activities for insert to authenticated
  with check (
    public.crm_can_write(workspace_id)
    and source = 'manual' and email_message_id is null and call_id is null and task_id is null and dedupe_key is null
    and (visibility = 'team' or owner_user_id = auth.uid())
  );
drop policy if exists activities_update on public.activities;
create policy activities_update on public.activities for update to authenticated
  using (public.crm_can_write(workspace_id) and source = 'manual' and (visibility = 'team' or owner_user_id = auth.uid()))
  with check (
    public.crm_can_write(workspace_id)
    and source = 'manual' and email_message_id is null and call_id is null and task_id is null and dedupe_key is null
    and (visibility = 'team' or owner_user_id = auth.uid())
  );
drop policy if exists activities_delete on public.activities;
create policy activities_delete on public.activities for delete to authenticated
  using (public.crm_can_write(workspace_id) and source = 'manual' and (visibility = 'team' or owner_user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- Workspace settings: the owner edits them (existing workspaces_update policy).
-- Editors may record the team's time zone the first time, as before.
-- ---------------------------------------------------------------------------
create or replace function public.ensure_workspace_timezone(p_workspace uuid, p_timezone text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_edit_workspace(p_workspace) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_timezone is null or not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'Unknown time zone %', p_timezone using errcode = '22023';
  end if;
  update public.workspaces
     set settings = settings || jsonb_build_object('timezone', p_timezone)
   where id = p_workspace and coalesce(settings->>'timezone', '') = '';
end;
$$;
revoke execute on function public.ensure_workspace_timezone(uuid, text) from public, anon;
grant execute on function public.ensure_workspace_timezone(uuid, text) to authenticated;

-- Owners may change the name and settings only (plan/status stay guarded).
create or replace function public.guard_workspace_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_platform_admin() then
    new.plan_id := old.plan_id;
    new.status := old.status;
    new.created_by := old.created_by;
  end if;
  if jsonb_typeof(new.settings) <> 'object' then
    new.settings := old.settings;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Copy the existing CRM data out of the JSON document.
-- ---------------------------------------------------------------------------
do $$
declare
  s record;
  arr jsonb;
begin
  for s in select ws.workspace_id, ws.data from public.workspace_state ws loop
    -- Settings (currency, timezone) move to workspaces.settings.
    if jsonb_typeof(s.data->'settings') = 'object' then
      update public.workspaces w
         set settings = (s.data->'settings') || w.settings
       where w.id = s.workspace_id;
    end if;

    arr := case when jsonb_typeof(s.data->'companies') = 'array' then s.data->'companies' else '[]'::jsonb end;
    insert into public.companies (workspace_id, legacy_id, name, industry, website, phone, city, notes, created_at)
    select s.workspace_id, left(c->>'id', 64),
           coalesce(pg_temp.j_text(c->'name', 200), 'Unnamed company'),
           pg_temp.j_text(c->'industry', 100), pg_temp.j_text(c->'website', 300), pg_temp.j_text(c->'phone', 50),
           pg_temp.j_text(c->'city', 100), pg_temp.j_text(c->'notes'),
           coalesce(pg_temp.j_ts(c->'createdAt'), now())
      from jsonb_array_elements(arr) c
     where jsonb_typeof(c) = 'object' and coalesce(c->>'id', '') <> ''
    on conflict (workspace_id, legacy_id) where legacy_id is not null do nothing;

    arr := case when jsonb_typeof(s.data->'contacts') = 'array' then s.data->'contacts' else '[]'::jsonb end;
    insert into public.contacts (workspace_id, legacy_id, first_name, last_name, email, phone, title, company_id, status, owner_id, source, notes, created_at)
    select s.workspace_id, left(c->>'id', 64),
           coalesce(pg_temp.j_text(c->'firstName', 100), ''), pg_temp.j_text(c->'lastName', 100),
           pg_temp.j_text(c->'email', 320), pg_temp.j_text(c->'phone', 50), pg_temp.j_text(c->'title', 150),
           (select co.id from public.companies co where co.workspace_id = s.workspace_id and co.legacy_id = c->>'companyId'),
           case when c->>'status' in ('lead', 'prospect', 'customer', 'inactive') then c->>'status' else 'lead' end,
           pg_temp.j_profile(c->'ownerId'), pg_temp.j_text(c->'source', 100), pg_temp.j_text(c->'notes'),
           coalesce(pg_temp.j_ts(c->'createdAt'), now())
      from jsonb_array_elements(arr) c
     where jsonb_typeof(c) = 'object' and coalesce(c->>'id', '') <> ''
    on conflict (workspace_id, legacy_id) where legacy_id is not null do nothing;

    arr := case when jsonb_typeof(s.data->'deals') = 'array' then s.data->'deals' else '[]'::jsonb end;
    insert into public.deals (workspace_id, legacy_id, title, company_id, contact_id, value, stage, owner_id, close_date, closed_at, notes, created_at)
    select s.workspace_id, left(d->>'id', 64),
           coalesce(pg_temp.j_text(d->'title', 200), 'Untitled deal'),
           (select co.id from public.companies co where co.workspace_id = s.workspace_id and co.legacy_id = d->>'companyId'),
           (select ct.id from public.contacts ct where ct.workspace_id = s.workspace_id and ct.legacy_id = d->>'contactId'),
           pg_temp.j_num(d->'value'),
           case when d->>'stage' in ('lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost') then d->>'stage' else 'lead' end,
           pg_temp.j_profile(d->'ownerId'), pg_temp.j_date(d->'closeDate'), pg_temp.j_date(d->'closedAt'),
           pg_temp.j_text(d->'notes'), coalesce(pg_temp.j_ts(d->'createdAt'), now())
      from jsonb_array_elements(arr) d
     where jsonb_typeof(d) = 'object' and coalesce(d->>'id', '') <> ''
    on conflict (workspace_id, legacy_id) where legacy_id is not null do nothing;

    -- Tasks saved before reminders existed had no setting and were emailed at
    -- the due time, so they keep "at due time".
    arr := case when jsonb_typeof(s.data->'board') = 'array' then s.data->'board' else '[]'::jsonb end;
    insert into public.tasks (workspace_id, legacy_id, title, workstream, status, due_date, due_time, reminder, priority, assigned_to, deal_id, notes, created_at)
    select s.workspace_id, left(t->>'id', 64),
           coalesce(pg_temp.j_text(t->'title', 300), 'Untitled task'),
           coalesce(pg_temp.j_text(t->'workstream', 50), 'General'),
           case when t->>'column' in ('todo', 'doing', 'done') then t->>'column' else 'todo' end,
           pg_temp.j_date(t->'dueDate'), pg_temp.j_time(t->'dueTime'),
           case when t->>'reminder' in ('none', 'at_due', '15_min', '1_hour', '1_day') then t->>'reminder'
                when t ? 'reminder' then 'none' else 'at_due' end,
           case when t->>'priority' in ('none', 'low', 'medium', 'high') then t->>'priority' else 'none' end,
           pg_temp.j_profile(t->'assignedTo'),
           (select dl.id from public.deals dl where dl.workspace_id = s.workspace_id and dl.legacy_id = t->>'dealId'),
           pg_temp.j_text(t->'notes'), now()
      from jsonb_array_elements(arr) t
     where jsonb_typeof(t) = 'object' and coalesce(t->>'id', '') <> ''
    on conflict (workspace_id, legacy_id) where legacy_id is not null do nothing;

    arr := case when jsonb_typeof(s.data->'activities') = 'array' then s.data->'activities' else '[]'::jsonb end;
    insert into public.activities (workspace_id, legacy_id, type, source, subject, body, occurred_at, actor_id, contact_id, company_id, deal_id)
    select s.workspace_id, left(a->>'id', 64),
           case when a->>'type' in ('note', 'call', 'email', 'meeting') then a->>'type' else 'note' end,
           'manual',
           coalesce(pg_temp.j_text(a->'subject', 500), ''), pg_temp.j_text(a->'body'),
           coalesce(pg_temp.j_ts(a->'at'), now()),
           pg_temp.j_profile(a->'by'),
           (select ct.id from public.contacts ct where ct.workspace_id = s.workspace_id and ct.legacy_id = a->>'contactId'),
           (select co.id from public.companies co where co.workspace_id = s.workspace_id and co.legacy_id = a->>'companyId'),
           (select dl.id from public.deals dl where dl.workspace_id = s.workspace_id and dl.legacy_id = a->>'dealId')
      from jsonb_array_elements(arr) a
     where jsonb_typeof(a) = 'object' and coalesce(a->>'id', '') <> ''
    on conflict (workspace_id, legacy_id) where legacy_id is not null do nothing;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Realtime: open browsers see every change straight away.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['companies', 'contacts', 'deals', 'tasks', 'activities'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
