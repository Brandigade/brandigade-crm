-- ============================================================================
-- The unified activity timeline.
--
-- Every lead, company and deal shows one chronological list built from the
-- activities table. Emails, calls and task changes reach it through the
-- triggers below, so the timeline can never drift from the records it shows:
--
--   email_messages -> one activity per email. The same email synced from two
--                     teammates' mailboxes appears once. A "private" email gets
--                     an activity only its mailbox owner can see.
--   calls          -> one activity per call, updated as the call progresses.
--   tasks          -> an activity when a task is created, started, completed,
--                     reopened, reassigned, rescheduled or deleted.
--
-- It also queues the "task assigned" email and, when a lead gets a new email
-- address, a job that pulls in that lead's earlier emails from connected
-- mailboxes. get_timeline() reads the timeline with the caller's own
-- permissions (SECURITY INVOKER), so row level security always applies.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tasks -> timeline
-- ---------------------------------------------------------------------------
create or replace function public.tasks_timeline()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  t public.tasks;
  v_contact uuid;
  v_company uuid;
  v_events text[] := '{}';
  v_meta jsonb;
  ev text;
begin
  if current_setting('app.skip_activity_triggers', true) = 'on' then return null; end if;
  if tg_op = 'DELETE' then
    t := old;
    -- The whole workspace is being deleted: nothing to record.
    if not exists (select 1 from public.workspaces where id = old.workspace_id) then return null; end if;
  else
    t := new;
  end if;

  v_contact := t.contact_id;
  if v_contact is null and t.deal_id is not null then
    select d.contact_id into v_contact from public.deals d where d.id = t.deal_id;
  end if;
  if v_contact is not null then
    select c.company_id into v_company from public.contacts c where c.id = v_contact;
  end if;
  if v_company is null and t.deal_id is not null then
    select d.company_id into v_company from public.deals d where d.id = t.deal_id;
  end if;

  if tg_op = 'INSERT' then
    v_events := array['created'];
  elsif tg_op = 'DELETE' then
    v_events := array['deleted'];
  else
    if new.status is distinct from old.status then
      v_events := v_events || (case when new.status = 'done' then 'completed'
                                    when old.status = 'done' then 'reopened'
                                    when new.status = 'doing' then 'started'
                                    else 'moved' end);
    end if;
    if new.assigned_to is distinct from old.assigned_to then
      v_events := v_events || 'assigned'::text;
    end if;
    if new.due_date is distinct from old.due_date or new.due_time is distinct from old.due_time then
      v_events := v_events || 'rescheduled'::text;
    end if;
  end if;

  foreach ev in array v_events loop
    v_meta := jsonb_build_object('task_id', t.id, 'status', t.status, 'due_date', t.due_date, 'due_time', t.due_time,
                                 'priority', t.priority, 'assigned_to', t.assigned_to, 'workstream', t.workstream);
    if ev = 'assigned' then
      v_meta := v_meta || jsonb_build_object('previous_assignee', old.assigned_to);
    elsif ev = 'rescheduled' then
      v_meta := v_meta || jsonb_build_object('previous_due_date', old.due_date, 'previous_due_time', old.due_time);
    end if;
    insert into public.activities (workspace_id, type, source, event, subject, occurred_at, actor_id,
                                   contact_id, company_id, deal_id, task_id, meta)
    values (t.workspace_id, 'task', 'task', ev, left(t.title, 500), now(), auth.uid(),
            v_contact, v_company, t.deal_id, case when tg_op = 'DELETE' then null else t.id end, v_meta);
  end loop;
  return null;
end;
$$;
drop trigger if exists tasks_timeline on public.tasks;
create trigger tasks_timeline after insert or update or delete on public.tasks
  for each row execute function public.tasks_timeline();

-- "Task assigned" email: queued once per assignment (assignment_version), never
-- for tasks people assign to themselves or tasks that are already done.
create or replace function public.tasks_notify_assignment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('app.skip_activity_triggers', true) = 'on' then return null; end if;
  if new.assigned_to is null or new.status = 'done' then return null; end if;
  if tg_op = 'UPDATE' and new.assigned_to is not distinct from old.assigned_to then return null; end if;
  if auth.uid() is not null and auth.uid() = new.assigned_to then return null; end if;
  perform public.enqueue_job(
    'notify.task_assigned',
    jsonb_build_object('task_id', new.id, 'assignee_id', new.assigned_to, 'assigned_by', auth.uid(),
                       'assignment_version', new.assignment_version),
    'task_assigned:' || new.id || ':' || new.assignment_version,
    now(), new.workspace_id);
  return null;
end;
$$;
drop trigger if exists tasks_notify_assignment on public.tasks;
create trigger tasks_notify_assignment after insert or update of assigned_to on public.tasks
  for each row execute function public.tasks_notify_assignment();

-- ---------------------------------------------------------------------------
-- Emails -> timeline
-- ---------------------------------------------------------------------------

-- Writes (or refreshes) the activity for one email.
create or replace function public.upsert_email_activity(m public.email_messages, p_key text, p_contacts uuid[],
                                                        p_visibility text, p_owner uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_primary uuid;
  v_company uuid;
begin
  -- The lead the email is "about": the sender of an incoming email, else the
  -- first recipient of an outgoing one, else any matched lead.
  select c.id, c.company_id into v_primary, v_company
    from public.contacts c
   where c.id = any(p_contacts)
   order by case
              when m.direction = 'inbound' and c.email_normalized = lower(m.from_address) then 0
              when m.direction = 'outbound' and m.to_addresses @> jsonb_build_array(jsonb_build_object('email', c.email_normalized)) then 1
              else 2
            end, c.created_at
   limit 1;

  insert into public.activities (workspace_id, type, source, event, subject, body, occurred_at, actor_id,
                                 contact_id, company_id, related_contact_ids, visibility, owner_user_id,
                                 email_message_id, dedupe_key, meta)
  values (m.workspace_id, 'email', 'email', m.direction,
          left(coalesce(nullif(btrim(m.subject), ''), '(no subject)'), 500),
          left(m.snippet, 20000), m.sent_at,
          case when m.direction = 'outbound' then m.owner_user_id end,
          v_primary, v_company, p_contacts, p_visibility, p_owner, m.id, p_key,
          jsonb_build_object('from', m.from_address, 'from_name', m.from_name, 'to', m.to_addresses, 'cc', m.cc_addresses,
                             'has_attachments', m.has_attachments, 'provider', m.provider))
  on conflict (workspace_id, dedupe_key) where dedupe_key is not null do update set
    subject = excluded.subject,
    body = excluded.body,
    occurred_at = excluded.occurred_at,
    actor_id = excluded.actor_id,
    contact_id = excluded.contact_id,
    company_id = excluded.company_id,
    related_contact_ids = excluded.related_contact_ids,
    visibility = excluded.visibility,
    owner_user_id = excluded.owner_user_id,
    email_message_id = excluded.email_message_id,
    meta = excluded.meta
  where activities.email_message_id is distinct from excluded.email_message_id
     or activities.related_contact_ids is distinct from excluded.related_contact_ids
     or activities.visibility is distinct from excluded.visibility
     or activities.owner_user_id is distinct from excluded.owner_user_id
     or activities.contact_id is distinct from excluded.contact_id
     or activities.subject is distinct from excluded.subject
     or activities.body is distinct from excluded.body;
end;
$$;

-- Rebuilds the timeline entry for one email from every copy of it that the
-- workspace holds. Copies are grouped by the Message-ID header; an email
-- without one is its own group.
--   * any copy shared with the team -> one team activity (no private extras)
--   * only private copies           -> one private activity per mailbox owner
--   * no copy involves a lead       -> no activity
create or replace function public.refresh_email_activity(p_workspace uuid, p_internet_id text, p_message uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_key text := 'email:' || coalesce(p_internet_id, 'msg:' || p_message::text);
  v_private_prefix text := v_key || ':private:';
  rep public.email_messages;
  v_contacts uuid[];
  r record;
begin
  -- Every lead any copy of this email involves.
  select coalesce(array_agg(distinct x), '{}') into v_contacts
    from public.email_messages m, unnest(m.matched_contact_ids) x
   where m.workspace_id = p_workspace
     and ((p_internet_id is null and m.id = p_message) or (p_internet_id is not null and m.internet_message_id = p_internet_id));

  select m.* into rep
    from public.email_messages m
   where m.workspace_id = p_workspace
     and ((p_internet_id is null and m.id = p_message) or (p_internet_id is not null and m.internet_message_id = p_internet_id))
     and m.visibility = 'team' and cardinality(m.matched_contact_ids) > 0
   order by m.created_at, m.id
   limit 1;

  if rep.id is not null then
    delete from public.activities
     where workspace_id = p_workspace and left(dedupe_key, length(v_private_prefix)) = v_private_prefix;
    perform public.upsert_email_activity(rep, v_key, v_contacts, 'team', null);
    return;
  end if;

  delete from public.activities where workspace_id = p_workspace and dedupe_key = v_key;

  for r in
    select distinct on (m.owner_user_id) m.id
      from public.email_messages m
     where m.workspace_id = p_workspace
       and ((p_internet_id is null and m.id = p_message) or (p_internet_id is not null and m.internet_message_id = p_internet_id))
       and m.visibility = 'private' and cardinality(m.matched_contact_ids) > 0
     order by m.owner_user_id, m.created_at, m.id
  loop
    select * into rep from public.email_messages where id = r.id;
    select coalesce(array_agg(distinct x), '{}') into v_contacts
      from public.email_messages m, unnest(m.matched_contact_ids) x
     where m.workspace_id = p_workspace and m.owner_user_id = rep.owner_user_id
       and ((p_internet_id is null and m.id = p_message) or (p_internet_id is not null and m.internet_message_id = p_internet_id));
    perform public.upsert_email_activity(rep, v_private_prefix || rep.owner_user_id::text, v_contacts, 'private', rep.owner_user_id);
  end loop;

  -- Private entries whose owner no longer holds a copy.
  delete from public.activities a
   where a.workspace_id = p_workspace
     and left(a.dedupe_key, length(v_private_prefix)) = v_private_prefix
     and not exists (
       select 1 from public.email_messages m
        where m.workspace_id = p_workspace
          and ((p_internet_id is null and m.id = p_message) or (p_internet_id is not null and m.internet_message_id = p_internet_id))
          and m.visibility = 'private' and cardinality(m.matched_contact_ids) > 0
          and a.dedupe_key = v_private_prefix || m.owner_user_id::text);
end;
$$;

create or replace function public.email_messages_timeline()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.refresh_email_activity(new.workspace_id, new.internet_message_id, new.id);
  end if;
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.internet_message_id is distinct from new.internet_message_id) then
    if exists (select 1 from public.workspaces where id = old.workspace_id) then
      perform public.refresh_email_activity(old.workspace_id, old.internet_message_id, old.id);
    end if;
  end if;
  return null;
end;
$$;
drop trigger if exists email_messages_timeline on public.email_messages;
create trigger email_messages_timeline
  after insert or delete or update of matched_contact_ids, visibility, subject, snippet, internet_message_id, sent_at
  on public.email_messages
  for each row execute function public.email_messages_timeline();

-- ---------------------------------------------------------------------------
-- Calls -> timeline
-- ---------------------------------------------------------------------------
create or replace function public.calls_timeline()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_company uuid;
begin
  if new.contact_id is not null then
    select c.company_id into v_company from public.contacts c where c.id = new.contact_id;
  end if;
  if v_company is null and new.deal_id is not null then
    select d.company_id into v_company from public.deals d where d.id = new.deal_id;
  end if;
  insert into public.activities (workspace_id, type, source, event, subject, body, occurred_at, actor_id,
                                 contact_id, company_id, deal_id, task_id, call_id, dedupe_key, meta)
  values (new.workspace_id, 'call', 'call',
          case when new.is_voicemail then 'voicemail' else new.direction end,
          case when new.is_voicemail then 'Voicemail' when new.direction = 'inbound' then 'Incoming call' else 'Outgoing call' end,
          new.notes, new.started_at, new.user_id, new.contact_id, v_company, new.deal_id, new.task_id, new.id,
          'call:' || new.id,
          jsonb_build_object('status', new.status, 'duration_seconds', new.duration_seconds, 'disposition', new.disposition,
                             'direction', new.direction, 'from', new.from_number, 'to', new.to_number,
                             'is_voicemail', new.is_voicemail, 'recording_available', coalesce(new.recording_status = 'available', false)))
  on conflict (workspace_id, dedupe_key) where dedupe_key is not null do update set
    event = excluded.event,
    subject = excluded.subject,
    body = excluded.body,
    actor_id = excluded.actor_id,
    contact_id = excluded.contact_id,
    company_id = excluded.company_id,
    deal_id = excluded.deal_id,
    task_id = excluded.task_id,
    call_id = excluded.call_id,
    meta = excluded.meta;
  return null;
end;
$$;
drop trigger if exists calls_timeline on public.calls;
create trigger calls_timeline after insert or update on public.calls
  for each row execute function public.calls_timeline();

-- ---------------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------------

-- A deleted lead's emails go with it (we only keep emails that involve a lead),
-- unless the email also involves another lead.
create or replace function public.contacts_after_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.workspaces where id = old.workspace_id) then return null; end if;
  with touched as (
    update public.email_messages
       set matched_contact_ids = array_remove(matched_contact_ids, old.id)
     where workspace_id = old.workspace_id and matched_contact_ids @> array[old.id]
    returning id, matched_contact_ids)
  delete from public.email_messages m using touched t
   where m.id = t.id and cardinality(t.matched_contact_ids) = 0;
  update public.activities
     set related_contact_ids = array_remove(related_contact_ids, old.id)
   where workspace_id = old.workspace_id and related_contact_ids @> array[old.id];
  return null;
end;
$$;
drop trigger if exists contacts_after_delete on public.contacts;
create trigger contacts_after_delete after delete on public.contacts
  for each row execute function public.contacts_after_delete();

-- New lead, or a lead's email address changed: look for their earlier emails
-- in the team's connected mailboxes.
create or replace function public.contacts_queue_email_backfill()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('app.skip_activity_triggers', true) = 'on' then return null; end if;
  if new.email_normalized is null then return null; end if;
  if tg_op = 'UPDATE' and new.email_normalized is not distinct from old.email_normalized then return null; end if;
  if exists (select 1 from public.email_accounts a where a.workspace_id = new.workspace_id and a.status = 'active' and a.sync_enabled) then
    perform public.enqueue_job('email.backfill_contact',
      jsonb_build_object('contact_id', new.id, 'email', new.email_normalized),
      'email_backfill:' || new.id || ':' || new.email_normalized,
      now() + interval '15 seconds', new.workspace_id);
  end if;
  return null;
end;
$$;
drop trigger if exists contacts_queue_email_backfill on public.contacts;
create trigger contacts_queue_email_backfill after insert or update of email on public.contacts
  for each row execute function public.contacts_queue_email_backfill();

-- "Last touch" on the contacts list. Private activities don't count, so they
-- can't be inferred from it.
create or replace function public.activities_touch_contacts()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.visibility <> 'team' then return null; end if;
  update public.contacts
     set last_activity_at = new.occurred_at
   where workspace_id = new.workspace_id
     and (id = new.contact_id or id = any(new.related_contact_ids))
     and (last_activity_at is null or last_activity_at < new.occurred_at);
  return null;
end;
$$;
drop trigger if exists activities_touch_contacts on public.activities;
create trigger activities_touch_contacts after insert or update of contact_id, related_contact_ids, occurred_at, visibility
  on public.activities
  for each row execute function public.activities_touch_contacts();

update public.contacts c
   set last_activity_at = (select max(a.occurred_at) from public.activities a
                            where a.visibility = 'team' and (a.contact_id = c.id or a.related_contact_ids @> array[c.id]))
 where c.last_activity_at is null;

-- ---------------------------------------------------------------------------
-- Reading the timeline
--   p_kind: 'contact' | 'company' | 'deal' | 'workspace'
--   p_before / p_before_id: cursor from the last row of the previous page
--   p_types: optional filter, e.g. '{email,call}'
-- ---------------------------------------------------------------------------
drop function if exists public.get_timeline(text, uuid, timestamptz, uuid, integer, text[]);
create or replace function public.get_timeline(p_kind text, p_id uuid, p_before timestamptz default null,
                                               p_before_id uuid default null, p_limit integer default 50,
                                               p_types text[] default null)
returns table (
  id uuid, type text, source text, event text, subject text, body text, occurred_at timestamptz,
  actor_id uuid, contact_id uuid, company_id uuid, deal_id uuid, related_contact_ids uuid[],
  visibility text, owner_user_id uuid, email_message_id uuid, call_id uuid, task_id uuid, meta jsonb,
  email jsonb, call jsonb, task jsonb
) language sql stable security invoker set search_path = public as $$
  with company_contacts as (
    select coalesce(array_agg(c.id), '{}'::uuid[]) as ids
      from public.contacts c where p_kind = 'company' and c.company_id = p_id
  ), deal_contact as (
    select d.contact_id from public.deals d where p_kind = 'deal' and d.id = p_id
  )
  select a.id, a.type, a.source, a.event, a.subject, a.body, a.occurred_at,
         a.actor_id, a.contact_id, a.company_id, a.deal_id, a.related_contact_ids,
         a.visibility, a.owner_user_id, a.email_message_id, a.call_id, a.task_id, a.meta,
         (select jsonb_build_object('id', m.id, 'direction', m.direction, 'from_address', m.from_address, 'from_name', m.from_name,
                                    'to', m.to_addresses, 'cc', m.cc_addresses, 'subject', m.subject, 'snippet', m.snippet,
                                    'sent_at', m.sent_at, 'has_attachments', m.has_attachments, 'has_html', m.body_html is not null,
                                    'provider', m.provider, 'owner_user_id', m.owner_user_id, 'visibility', m.visibility)
            from public.email_messages m where m.id = a.email_message_id) as email,
         (select jsonb_build_object('id', c.id, 'direction', c.direction, 'status', c.status, 'duration_seconds', c.duration_seconds,
                                    'disposition', c.disposition, 'notes', c.notes, 'user_id', c.user_id,
                                    'from_number', c.from_number, 'to_number', c.to_number, 'is_voicemail', c.is_voicemail,
                                    'recording_status', c.recording_status, 'recording_available', c.recording_status = 'available',
                                    'started_at', c.started_at, 'ended_at', c.ended_at)
            from public.calls c where c.id = a.call_id) as call,
         (select jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status, 'due_date', t.due_date, 'due_time', t.due_time,
                                    'assigned_to', t.assigned_to, 'priority', t.priority)
            from public.tasks t where t.id = a.task_id) as task
    from public.activities a
   where (case p_kind
            when 'contact' then a.contact_id = p_id or a.related_contact_ids @> array[p_id]
            when 'company' then a.company_id = p_id
                                or a.contact_id in (select c.id from public.contacts c where c.company_id = p_id)
                                or a.related_contact_ids && (select ids from company_contacts)
            when 'deal' then a.deal_id = p_id
                             or exists (select 1 from deal_contact dc where dc.contact_id is not null
                                          and (a.contact_id = dc.contact_id or a.related_contact_ids @> array[dc.contact_id]))
            when 'workspace' then true
            else false
          end)
     and (p_before is null
          or a.occurred_at < p_before
          or (p_before_id is not null and a.occurred_at = p_before and a.id < p_before_id))
     and (p_types is null or a.type = any(p_types))
   order by a.occurred_at desc, a.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;
revoke execute on function public.get_timeline(text, uuid, timestamptz, uuid, integer, text[]) from public, anon;
grant execute on function public.get_timeline(text, uuid, timestamptz, uuid, integer, text[]) to authenticated;

-- Internal helpers are not part of the API.
revoke execute on function public.upsert_email_activity(public.email_messages, text, uuid[], text, uuid) from public, anon, authenticated;
revoke execute on function public.refresh_email_activity(uuid, text, uuid) from public, anon, authenticated;
