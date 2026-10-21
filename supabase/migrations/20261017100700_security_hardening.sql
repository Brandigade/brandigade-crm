-- ============================================================================
-- Security review fixes.
--
-- 1. People removed from the CRM can no longer change the sharing of the
--    mailboxes or emails they once connected (they keep a login, not access).
-- 2. Copies of one email are only grouped when they also come from the same
--    sender (the Message-ID header is chosen by the sender and could be reused
--    to merge an unrelated message with someone's private one), and a shared
--    timeline entry only lists the leads of the shared copies (a private copy's
--    Bcc'd leads are not revealed).
-- 3. A hand-logged note, call or meeting can only be changed or deleted by its
--    author or the CRM owner. Deleting a lead or deal removes the notes that
--    only belonged to it (as the app always did), now in the database.
-- 4. Profile names and photos are bounded, and photos must be embedded images.
-- 5. Browsers can't read mailbox sync internals, and the owner sees the
--    connection status of shared mailboxes only.
-- ============================================================================

-- 1 -------------------------------------------------------------------------
create or replace function public.update_email_account_settings(p_account uuid, p_sharing text default null, p_sync_enabled boolean default null)
returns void language plpgsql security definer set search_path = public as $$
declare acc public.email_accounts;
begin
  select * into acc from public.email_accounts where id = p_account;
  if acc.id is null or acc.user_id <> auth.uid() or not public.is_workspace_member(acc.workspace_id) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_sharing is not null and p_sharing not in ('team', 'private') then raise exception 'Invalid sharing' using errcode = '22023'; end if;
  update public.email_accounts
     set sharing = coalesce(p_sharing, sharing),
         sync_enabled = coalesce(p_sync_enabled, sync_enabled),
         next_sync_at = case when p_sync_enabled then now() else next_sync_at end
   where id = p_account;
  if p_sharing is not null and p_sharing <> acc.sharing then
    update public.email_messages set visibility = p_sharing where account_id = p_account and visibility <> p_sharing;
  end if;
end;
$$;

create or replace function public.set_email_visibility(p_message uuid, p_visibility text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_visibility not in ('team', 'private') then raise exception 'Invalid visibility' using errcode = '22023'; end if;
  update public.email_messages m set visibility = p_visibility
   where m.id = p_message and m.owner_user_id = auth.uid() and public.is_workspace_member(m.workspace_id);
  if not found then raise exception 'Not allowed' using errcode = '42501'; end if;
end;
$$;

-- 2 -------------------------------------------------------------------------
-- Copies belong together when they share the Message-ID AND the sender.
create or replace function public.email_group_key(p_internet_id text, p_from text, p_message uuid)
returns text language sql immutable as $$
  select 'email:' || case when p_internet_id is null then 'msg:' || p_message::text
                          else p_internet_id || '|' || coalesce(lower(p_from), '') end;
$$;

-- The copies of one email: same Message-ID and sender (or just the message itself when it has no Message-ID).
create or replace function public.email_group_ids(p_workspace uuid, p_internet_id text, p_from text, p_message uuid)
returns setof uuid language sql stable security definer set search_path = public as $$
  select m.id from public.email_messages m
   where m.workspace_id = p_workspace
     and ((p_internet_id is null and m.id = p_message)
          or (p_internet_id is not null and m.internet_message_id = p_internet_id
              and lower(coalesce(m.from_address, '')) = coalesce(p_from, '')));
$$;
revoke execute on function public.email_group_ids(uuid, text, text, uuid) from public, anon, authenticated;

create or replace function public.refresh_email_activity(p_workspace uuid, p_internet_id text, p_message uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_from text;
  v_key text;
  v_private_prefix text;
  rep public.email_messages;
  v_contacts uuid[];
  r record;
begin
  -- The sender of the message that changed defines the group.
  select lower(m.from_address) into v_from from public.email_messages m where m.id = p_message;
  if v_from is null and p_internet_id is not null then
    -- The message is gone (deleted): fall back to its old activities' sender.
    select lower(a.meta->>'from') into v_from from public.activities a
     where a.workspace_id = p_workspace and a.email_message_id is null
       and left(a.dedupe_key, length('email:' || p_internet_id || '|')) = 'email:' || p_internet_id || '|'
     limit 1;
  end if;
  v_key := public.email_group_key(p_internet_id, v_from, p_message);
  v_private_prefix := v_key || ':private:';

  select m.* into rep
    from public.email_messages m join public.email_group_ids(p_workspace, p_internet_id, v_from, p_message) g(id) on g.id = m.id
   where m.visibility = 'team' and cardinality(m.matched_contact_ids) > 0
   order by m.created_at, m.id
   limit 1;

  if rep.id is not null then
    -- Shared entry: only the leads of shared copies.
    select coalesce(array_agg(distinct x), '{}') into v_contacts
      from public.email_messages m join public.email_group_ids(p_workspace, p_internet_id, v_from, p_message) g(id) on g.id = m.id, unnest(m.matched_contact_ids) x
     where m.visibility = 'team';
    delete from public.activities
     where workspace_id = p_workspace and left(dedupe_key, length(v_private_prefix)) = v_private_prefix;
    perform public.upsert_email_activity(rep, v_key, v_contacts, 'team', null);
    return;
  end if;

  delete from public.activities where workspace_id = p_workspace and dedupe_key = v_key;

  for r in
    select distinct on (m.owner_user_id) m.id
      from public.email_messages m join public.email_group_ids(p_workspace, p_internet_id, v_from, p_message) g(id) on g.id = m.id
     where m.visibility = 'private' and cardinality(m.matched_contact_ids) > 0
     order by m.owner_user_id, m.created_at, m.id
  loop
    select * into rep from public.email_messages where id = r.id;
    select coalesce(array_agg(distinct x), '{}') into v_contacts
      from public.email_messages m join public.email_group_ids(p_workspace, p_internet_id, v_from, p_message) g(id) on g.id = m.id, unnest(m.matched_contact_ids) x
     where m.owner_user_id = rep.owner_user_id;
    perform public.upsert_email_activity(rep, v_private_prefix || rep.owner_user_id::text, v_contacts, 'private', rep.owner_user_id);
  end loop;

  delete from public.activities a
   where a.workspace_id = p_workspace
     and left(a.dedupe_key, length(v_private_prefix)) = v_private_prefix
     and not exists (
       select 1 from public.email_messages m join public.email_group_ids(p_workspace, p_internet_id, v_from, p_message) g(id) on g.id = m.id
        where m.visibility = 'private' and cardinality(m.matched_contact_ids) > 0
          and a.dedupe_key = v_private_prefix || m.owner_user_id::text);
end;
$$;
revoke execute on function public.refresh_email_activity(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.email_group_key(text, text, uuid) from public, anon;

-- A deleted email still knows its sender through OLD; refresh with it.
create or replace function public.email_messages_timeline()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.refresh_email_activity(new.workspace_id, new.internet_message_id, new.id);
  end if;
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and (old.internet_message_id is distinct from new.internet_message_id
                                                 or lower(coalesce(old.from_address, '')) is distinct from lower(coalesce(new.from_address, '')))) then
    if exists (select 1 from public.workspaces where id = old.workspace_id) then
      if old.internet_message_id is null then
        delete from public.activities where workspace_id = old.workspace_id
          and (dedupe_key = 'email:msg:' || old.id::text or left(dedupe_key, length('email:msg:' || old.id::text || ':')) = 'email:msg:' || old.id::text || ':');
      else
        perform public.refresh_email_group(old.workspace_id, old.internet_message_id, lower(old.from_address));
      end if;
    end if;
  end if;
  return null;
end;
$$;

-- Rebuild a group whose message may already be deleted (used on delete).
create or replace function public.refresh_email_group(p_workspace uuid, p_internet_id text, p_from text)
returns void language plpgsql security definer set search_path = public as $$
declare v_any uuid;
begin
  select m.id into v_any from public.email_messages m
   where m.workspace_id = p_workspace and m.internet_message_id = p_internet_id
     and lower(coalesce(m.from_address, '')) = coalesce(p_from, '')
   order by m.created_at limit 1;
  if v_any is not null then
    perform public.refresh_email_activity(p_workspace, p_internet_id, v_any);
  else
    delete from public.activities a
     where a.workspace_id = p_workspace
       and (a.dedupe_key = public.email_group_key(p_internet_id, p_from, null)
            or left(a.dedupe_key, length(public.email_group_key(p_internet_id, p_from, null) || ':private:'))
               = public.email_group_key(p_internet_id, p_from, null) || ':private:');
  end if;
end;
$$;
revoke execute on function public.refresh_email_group(uuid, text, text) from public, anon, authenticated;

drop trigger if exists email_messages_timeline on public.email_messages;
create trigger email_messages_timeline
  after insert or delete or update of matched_contact_ids, visibility, subject, snippet, internet_message_id, sent_at, from_address
  on public.email_messages
  for each row execute function public.email_messages_timeline();

-- Existing email entries get the new keys.
do $$
declare m record;
begin
  delete from public.activities where source = 'email';
  for m in select distinct on (workspace_id, internet_message_id, lower(coalesce(from_address, '')), case when internet_message_id is null then id end)
              id, workspace_id, internet_message_id from public.email_messages loop
    perform public.refresh_email_activity(m.workspace_id, m.internet_message_id, m.id);
  end loop;
end $$;

-- 3 -------------------------------------------------------------------------
drop policy if exists activities_update on public.activities;
create policy activities_update on public.activities for update to authenticated
  using (public.crm_can_write(workspace_id) and source = 'manual'
         and (visibility = 'team' or owner_user_id = auth.uid())
         and (actor_id = auth.uid() or public.is_workspace_owner(workspace_id)))
  with check (
    public.crm_can_write(workspace_id)
    and source = 'manual' and email_message_id is null and call_id is null and task_id is null and dedupe_key is null
    and (visibility = 'team' or owner_user_id = auth.uid())
  );
drop policy if exists activities_delete on public.activities;
create policy activities_delete on public.activities for delete to authenticated
  using (public.crm_can_write(workspace_id) and source = 'manual'
         and (visibility = 'team' or owner_user_id = auth.uid())
         and (actor_id = auth.uid() or public.is_workspace_owner(workspace_id)));

-- Notes that only belonged to a deleted lead (or deal) go with it.
create or replace function public.delete_record_notes()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'contacts' then
    delete from public.activities where source = 'manual' and contact_id = old.id and deal_id is null;
  elsif tg_table_name = 'deals' then
    delete from public.activities where source = 'manual' and deal_id = old.id and contact_id is null;
  end if;
  return old;
end;
$$;
drop trigger if exists delete_record_notes on public.contacts;
create trigger delete_record_notes before delete on public.contacts for each row execute function public.delete_record_notes();
drop trigger if exists delete_record_notes on public.deals;
create trigger delete_record_notes before delete on public.deals for each row execute function public.delete_record_notes();

-- 4 -------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_display_name_length;
alter table public.profiles add constraint profiles_display_name_length
  check (display_name is null or char_length(display_name) <= 100) not valid;
alter table public.profiles drop constraint if exists profiles_avatar_is_image;
alter table public.profiles add constraint profiles_avatar_is_image
  check (avatar_data is null or (avatar_data ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$' and char_length(avatar_data) <= 300000)) not valid;

-- 5 -------------------------------------------------------------------------
revoke select on public.email_accounts from authenticated;
grant select (id, workspace_id, user_id, provider, email_address, display_name, status, sharing, sync_enabled,
              initial_sync_done, last_synced_at, last_error, last_error_at, consecutive_failures, connected_at,
              created_at, updated_at)
  on public.email_accounts to authenticated;
drop policy if exists email_accounts_read on public.email_accounts;
create policy email_accounts_read on public.email_accounts for select to authenticated
  using (user_id = auth.uid() or (sharing = 'team' and public.is_workspace_owner(workspace_id)));
