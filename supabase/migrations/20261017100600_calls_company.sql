-- ============================================================================
-- Calls to a company's main number (no contact) belong on that company's
-- timeline. calls.company_id records the company; the timeline trigger uses
-- it first, then the contact's company, then the deal's company.
-- ============================================================================
alter table public.calls add column if not exists company_id uuid references public.companies(id) on delete set null;
create index if not exists calls_company_idx on public.calls(company_id);

create or replace function public.calls_timeline()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_company uuid := new.company_id;
begin
  if v_company is null and new.contact_id is not null then
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
