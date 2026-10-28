-- ============================================================================
-- Everyone edits their own records and reads everyone else's.
--
-- Roles (workspace_members.role):
--   owner   everything, including the team and settings
--   admin   reads and edits every record (the team and settings stay with the owner)
--   editor  reads every record; creates records and edits or deletes the ones
--           that are theirs
--   viewer  reads every record, changes nothing
--
-- "Theirs" means: companies they created; leads and deals they own or created;
-- tasks assigned to them or created by them. Records with neither (old imports)
-- are left to the owner and admins.
-- ============================================================================

-- The admin role.
do $$
declare c text;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.workspace_members'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ilike '%role%' loop
    execute format('alter table public.workspace_members drop constraint %I', c);
  end loop;
  for c in select conname from pg_constraint
            where conrelid = 'public.workspace_invites'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ilike '%role%' loop
    execute format('alter table public.workspace_invites drop constraint %I', c);
  end loop;
end $$;
alter table public.workspace_members add constraint workspace_members_role_check
  check (role in ('owner', 'admin', 'editor', 'viewer'));
alter table public.workspace_invites add constraint workspace_invites_role_check
  check (role in ('admin', 'editor', 'viewer'));

-- Admins can do whatever editors can (mailboxes, calls, recordings, writes).
create or replace function public.can_edit_workspace(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members
                 where workspace_id = ws and user_id = auth.uid() and role in ('owner', 'admin', 'editor'));
$$;

-- Owner, admin (or the platform admin): may edit every record.
create or replace function public.crm_is_admin(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_platform_admin()
      or exists (select 1 from public.workspace_members
                 where workspace_id = ws and user_id = auth.uid() and role in ('owner', 'admin'));
$$;

-- May the signed-in person change a record owned by p_owner / created by p_creator?
create or replace function public.crm_can_edit_record(ws uuid, p_owner uuid, p_creator uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.crm_is_admin(ws)
      or (public.can_edit_workspace(ws) and auth.uid() is not null
          and (p_owner = auth.uid() or p_creator = auth.uid()));
$$;

revoke execute on function public.crm_is_admin(uuid) from public, anon;
revoke execute on function public.crm_can_edit_record(uuid, uuid, uuid) from public, anon;
grant execute on function public.crm_is_admin(uuid) to authenticated, service_role;
grant execute on function public.crm_can_edit_record(uuid, uuid, uuid) to authenticated, service_role;

-- Everyone who can write may create records (created_by is set to them by the
-- set_created_by trigger). Changing and deleting follow ownership. The update
-- check also runs on the new row, so an editor can't hand a record they don't
-- own over to someone else and keep it.
drop policy if exists companies_update on public.companies;
create policy companies_update on public.companies for update to authenticated
  using (public.crm_can_edit_record(workspace_id, null, created_by))
  with check (public.crm_can_edit_record(workspace_id, null, created_by));
drop policy if exists companies_delete on public.companies;
create policy companies_delete on public.companies for delete to authenticated
  using (public.crm_can_edit_record(workspace_id, null, created_by));

drop policy if exists contacts_update on public.contacts;
create policy contacts_update on public.contacts for update to authenticated
  using (public.crm_can_edit_record(workspace_id, owner_id, created_by))
  with check (public.crm_can_edit_record(workspace_id, owner_id, created_by));
drop policy if exists contacts_delete on public.contacts;
create policy contacts_delete on public.contacts for delete to authenticated
  using (public.crm_can_edit_record(workspace_id, owner_id, created_by));

drop policy if exists deals_update on public.deals;
create policy deals_update on public.deals for update to authenticated
  using (public.crm_can_edit_record(workspace_id, owner_id, created_by))
  with check (public.crm_can_edit_record(workspace_id, owner_id, created_by));
drop policy if exists deals_delete on public.deals;
create policy deals_delete on public.deals for delete to authenticated
  using (public.crm_can_edit_record(workspace_id, owner_id, created_by));

drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using (public.crm_can_edit_record(workspace_id, assigned_to, created_by))
  with check (public.crm_can_edit_record(workspace_id, assigned_to, created_by));
drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks for delete to authenticated
  using (public.crm_can_edit_record(workspace_id, assigned_to, created_by));

-- Recordings: "owners and editors" now includes admins.
create or replace function public.can_play_recording(p_call uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  c public.calls;
  role_name text;
  access text;
begin
  select * into c from public.calls where id = p_call;
  if c.id is null then return false; end if;
  role_name := public.workspace_role(c.workspace_id);
  if role_name is null then return false; end if;
  select coalesce(settings->>'recordingAccess', 'editors') into access from public.workspaces where id = c.workspace_id;
  return case access
    when 'all' then true
    when 'owner' then role_name = 'owner' or c.user_id = auth.uid()
    else role_name in ('owner', 'admin', 'editor')
  end;
end;
$$;

-- Mailbox sync: admins' mailboxes sync too.
create or replace function public.claim_email_accounts(p_limit integer, p_lease_seconds integer)
returns setof public.email_accounts language plpgsql security definer set search_path = public as $$
begin
  return query
  update public.email_accounts a
     set sync_lock_until = now() + make_interval(secs => greatest(p_lease_seconds, 10)),
         last_sync_started_at = now()
   where a.id in (
     select e.id from public.email_accounts e
      join public.workspace_members m on m.workspace_id = e.workspace_id and m.user_id = e.user_id and m.role in ('owner', 'admin', 'editor')
      where e.status = 'active' and e.sync_enabled
        and e.next_sync_at <= now()
        and (e.sync_lock_until is null or e.sync_lock_until < now())
      order by e.next_sync_at
      limit greatest(p_limit, 0)
      for update of e skip locked)
  returning a.*;
end;
$$;
