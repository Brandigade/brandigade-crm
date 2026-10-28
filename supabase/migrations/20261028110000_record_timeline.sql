-- ============================================================================
-- Changes to leads, deals and companies go on the timeline by themselves.
--
-- source = 'record', type = 'update'. Events:
--   created / deleted
--   status   a lead's status changed      meta: from, to
--   stage    a deal's stage changed       meta: from, to
--   owner    the owner changed            meta: from, to
--   company  a lead moved to a company    meta: from, to
--   updated  other details changed       meta: fields (column names)
-- Each entry carries the record's lead and company, so a company's timeline
-- shows its own changes and those of its leads and deals. Repeated "updated"
-- edits by the same person within 10 minutes are folded into one entry.
-- Only these triggers write such rows; the app can't (activities policies
-- allow 'manual' only).
-- ============================================================================

do $$
declare c text;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.activities'::regclass and contype = 'c'
              and (pg_get_constraintdef(oid) ilike '%source%' or pg_get_constraintdef(oid) ilike '%type = ANY%'
                   or pg_get_constraintdef(oid) ilike '%type IN%') loop
    execute format('alter table public.activities drop constraint %I', c);
  end loop;
end $$;
alter table public.activities add constraint activities_type_check
  check (type in ('note', 'call', 'email', 'meeting', 'task', 'update'));
alter table public.activities add constraint activities_source_check
  check (source in ('manual', 'email', 'call', 'task', 'record'));

-- Writes one record entry, or folds an "updated" into the same person's last one.
create or replace function public.record_activity(p_workspace uuid, p_kind text, p_record uuid, p_event text,
                                                  p_subject text, p_contact uuid, p_company uuid, p_deal uuid,
                                                  p_meta jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_prev uuid;
begin
  if p_event = 'updated' and auth.uid() is not null then
    select a.id into v_prev from public.activities a
     where a.workspace_id = p_workspace and a.source = 'record' and a.event = 'updated'
       and a.meta->>'record_kind' = p_kind and a.meta->>'record_id' = p_record::text
       and a.actor_id = auth.uid() and a.occurred_at > now() - interval '10 minutes'
     order by a.occurred_at desc limit 1;
    if v_prev is not null then
      update public.activities a
         set occurred_at = now(), subject = left(p_subject, 500),
             contact_id = p_contact, company_id = p_company, deal_id = p_deal,
             meta = a.meta || jsonb_build_object('fields',
                      (select coalesce(jsonb_agg(distinct f), '[]'::jsonb)
                         from jsonb_array_elements_text(coalesce(a.meta->'fields', '[]'::jsonb) || coalesce(p_meta->'fields', '[]'::jsonb)) f))
       where a.id = v_prev;
      return;
    end if;
  end if;
  insert into public.activities (workspace_id, type, source, event, subject, occurred_at, actor_id,
                                 contact_id, company_id, deal_id, meta)
  values (p_workspace, 'update', 'record', p_event, left(coalesce(p_subject, ''), 500), now(), auth.uid(),
          p_contact, p_company, p_deal,
          coalesce(p_meta, '{}'::jsonb) || jsonb_build_object('record_kind', p_kind, 'record_id', p_record));
end;
$$;
revoke execute on function public.record_activity(uuid, text, uuid, text, text, uuid, uuid, uuid, jsonb) from public, anon, authenticated;

-- Which of these columns differ between two rows of the same table.
create or replace function public.changed_fields(p_old jsonb, p_new jsonb, p_fields text[])
returns text[] language sql immutable as $$
  select coalesce(array_agg(f order by f), '{}') from unnest(p_fields) f
   where (p_old->f) is distinct from (p_new->f);
$$;

create or replace function public.contacts_timeline()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  c public.contacts;
  v_name text;
  v_changed text[];
  v_rest text[];
begin
  if current_setting('app.skip_activity_triggers', true) = 'on' then return null; end if;
  c := case when tg_op = 'DELETE' then old else new end;
  if not exists (select 1 from public.workspaces where id = c.workspace_id) then return null; end if;
  v_name := trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''));
  if v_name = '' then v_name := coalesce(c.email, 'Lead'); end if;

  if tg_op = 'INSERT' then
    perform public.record_activity(c.workspace_id, 'contact', c.id, 'created', v_name, c.id, c.company_id, null, '{}');
  elsif tg_op = 'DELETE' then
    if old.company_id is not null then
      perform public.record_activity(c.workspace_id, 'contact', c.id, 'deleted', v_name, null, old.company_id, null, '{}');
    end if;
  else
    v_changed := public.changed_fields(to_jsonb(old), to_jsonb(new),
      array['first_name', 'last_name', 'email', 'phone', 'title', 'company_id', 'status', 'owner_id', 'source', 'notes']);
    if 'status' = any(v_changed) then
      perform public.record_activity(c.workspace_id, 'contact', c.id, 'status', v_name, c.id, c.company_id, null,
                                     jsonb_build_object('from', old.status, 'to', new.status));
    end if;
    if 'owner_id' = any(v_changed) then
      perform public.record_activity(c.workspace_id, 'contact', c.id, 'owner', v_name, c.id, c.company_id, null,
                                     jsonb_build_object('from', old.owner_id, 'to', new.owner_id));
    end if;
    if 'company_id' = any(v_changed) then
      perform public.record_activity(c.workspace_id, 'contact', c.id, 'company', v_name, c.id, coalesce(new.company_id, old.company_id), null,
                                     jsonb_build_object('from', old.company_id, 'to', new.company_id));
    end if;
    v_rest := array(select f from unnest(v_changed) f where f not in ('status', 'owner_id', 'company_id'));
    if cardinality(v_rest) > 0 then
      perform public.record_activity(c.workspace_id, 'contact', c.id, 'updated', v_name, c.id, c.company_id, null,
                                     jsonb_build_object('fields', to_jsonb(v_rest)));
    end if;
  end if;
  return null;
end;
$$;
drop trigger if exists contacts_timeline on public.contacts;
create trigger contacts_timeline after insert or update or delete on public.contacts
  for each row execute function public.contacts_timeline();

create or replace function public.deals_timeline()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  d public.deals;
  v_company uuid;
  v_changed text[];
  v_rest text[];
begin
  if current_setting('app.skip_activity_triggers', true) = 'on' then return null; end if;
  d := case when tg_op = 'DELETE' then old else new end;
  if not exists (select 1 from public.workspaces where id = d.workspace_id) then return null; end if;
  v_company := d.company_id;
  if v_company is null and d.contact_id is not null then
    select company_id into v_company from public.contacts where id = d.contact_id;
  end if;

  if tg_op = 'INSERT' then
    perform public.record_activity(d.workspace_id, 'deal', d.id, 'created', d.title, d.contact_id, v_company, d.id,
                                   jsonb_build_object('stage', d.stage, 'value', d.value));
  elsif tg_op = 'DELETE' then
    if d.contact_id is not null or v_company is not null then
      perform public.record_activity(d.workspace_id, 'deal', d.id, 'deleted', d.title, d.contact_id, v_company, null,
                                     jsonb_build_object('stage', d.stage, 'value', d.value));
    end if;
  else
    v_changed := public.changed_fields(to_jsonb(old), to_jsonb(new),
      array['title', 'company_id', 'contact_id', 'value', 'stage', 'owner_id', 'close_date', 'notes']);
    if 'stage' = any(v_changed) then
      perform public.record_activity(d.workspace_id, 'deal', d.id, 'stage', d.title, d.contact_id, v_company, d.id,
                                     jsonb_build_object('from', old.stage, 'to', new.stage, 'value', new.value));
    end if;
    if 'owner_id' = any(v_changed) then
      perform public.record_activity(d.workspace_id, 'deal', d.id, 'owner', d.title, d.contact_id, v_company, d.id,
                                     jsonb_build_object('from', old.owner_id, 'to', new.owner_id));
    end if;
    v_rest := array(select f from unnest(v_changed) f where f not in ('stage', 'owner_id'));
    if cardinality(v_rest) > 0 then
      perform public.record_activity(d.workspace_id, 'deal', d.id, 'updated', d.title, d.contact_id, v_company, d.id,
                                     jsonb_build_object('fields', to_jsonb(v_rest), 'value', new.value));
    end if;
  end if;
  return null;
end;
$$;
drop trigger if exists deals_timeline on public.deals;
create trigger deals_timeline after insert or update or delete on public.deals
  for each row execute function public.deals_timeline();

create or replace function public.companies_timeline()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_changed text[];
begin
  if current_setting('app.skip_activity_triggers', true) = 'on' then return null; end if;
  if tg_op = 'INSERT' then
    perform public.record_activity(new.workspace_id, 'company', new.id, 'created', new.name, null, new.id, null, '{}');
  else
    v_changed := public.changed_fields(to_jsonb(old), to_jsonb(new),
      array['name', 'industry', 'website', 'phone', 'city', 'notes']);
    if cardinality(v_changed) > 0 then
      perform public.record_activity(new.workspace_id, 'company', new.id, 'updated', new.name, null, new.id, null,
                                     jsonb_build_object('fields', to_jsonb(v_changed)));
    end if;
  end if;
  return null;
end;
$$;
drop trigger if exists companies_timeline on public.companies;
create trigger companies_timeline after insert or update on public.companies
  for each row execute function public.companies_timeline();

-- "Last touch" on the leads list means talking to the lead (emails, calls,
-- notes, tasks), not editing their details.
create or replace function public.activities_touch_contacts()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.visibility <> 'team' or new.source = 'record' then return null; end if;
  update public.contacts
     set last_activity_at = new.occurred_at
   where workspace_id = new.workspace_id
     and (id = new.contact_id or id = any(new.related_contact_ids))
     and (last_activity_at is null or last_activity_at < new.occurred_at);
  return null;
end;
$$;
