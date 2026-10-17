-- ============================================================================
-- Background work runs every minute: Supabase's pg_cron calls the app's
-- /api/cron/tick endpoint, which sends due notifications, works through the
-- job queue and syncs mailboxes.
--
-- Why pg_cron and not Vercel Cron: on Vercel's Hobby plan cron jobs can only
-- run once a day. pg_cron is part of the Supabase project and already ran the
-- old reminder emails every minute.
--
-- The app address and the shared secret are read from Supabase Vault when the
-- job runs, so no secret is ever stored in this file or in git. Set them once
-- with `npm run setup:cron` (see README). Until then the job does nothing.
--
-- The old every-minute job called the send-due-task-emails edge function,
-- which reads tasks from the old JSON document. It is replaced here; reminder
-- emails now come from the new notification worker.
-- ============================================================================

create or replace function public.crm_cron_tick()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_url text;
  v_secret text;
begin
  if to_regclass('vault.decrypted_secrets') is null
     or not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'net' and p.proname = 'http_post') then
    return;
  end if;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'crm_app_url' limit 1$q$ into v_url;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'crm_cron_secret' limit 1$q$ into v_secret;
  if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then
    return;
  end if;
  execute $q$select net.http_post(url := $1, headers := $2, body := '{}'::jsonb, timeout_milliseconds := 30000)$q$
    using rtrim(v_url, '/') || '/api/cron/tick',
          jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret);
end;
$$;
revoke execute on function public.crm_cron_tick() from public, anon, authenticated;

-- Stores the app URL and cron secret in Vault (called by `npm run setup:cron`
-- through the service role; never from the browser).
create or replace function public.configure_cron(p_app_url text, p_secret text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if to_regclass('vault.secrets') is null then raise exception 'Supabase Vault is not available'; end if;
  if coalesce(p_app_url, '') !~ '^https?://' then raise exception 'p_app_url must be an http(s) URL'; end if;
  if char_length(coalesce(p_secret, '')) < 24 then raise exception 'p_secret must be at least 24 characters'; end if;
  execute $q$delete from vault.secrets where name in ('crm_app_url', 'crm_cron_secret')$q$;
  execute $q$select vault.create_secret($1, 'crm_app_url', 'Brandigade CRM base URL for pg_cron')$q$ using p_app_url;
  execute $q$select vault.create_secret($1, 'crm_cron_secret', 'Bearer token pg_cron sends to /api/cron/tick')$q$ using p_secret;
end;
$$;
revoke execute on function public.configure_cron(text, text) from public, anon, authenticated;
grant execute on function public.configure_cron(text, text) to service_role;

-- Reports whether the schedule exists and how its last runs went (shown to the
-- owner on the Team page via /api/system/status).
create or replace function public.scheduler_status()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  out jsonb := '{}'::jsonb;
  v jsonb;
begin
  if to_regclass('cron.job') is null then
    return jsonb_build_object('cron', 'not installed');
  end if;
  execute $q$select coalesce(jsonb_agg(jsonb_build_object('name', jobname, 'schedule', schedule, 'active', active)), '[]'::jsonb)
             from cron.job where jobname in ('crm-tick', 'send-due-task-emails')$q$ into v;
  out := out || jsonb_build_object('jobs', v);
  if to_regclass('cron.job_run_details') is not null then
    execute $q$select coalesce(jsonb_agg(r), '[]'::jsonb) from (
               select d.status, left(d.return_message, 200) as message, d.start_time from cron.job_run_details d
               join cron.job j on j.jobid = d.jobid where j.jobname = 'crm-tick'
               order by d.start_time desc limit 3) r$q$ into v;
    out := out || jsonb_build_object('lastRuns', v);
  end if;
  if to_regclass('vault.decrypted_secrets') is not null then
    execute $q$select to_jsonb(count(*) = 2) from vault.decrypted_secrets where name in ('crm_app_url', 'crm_cron_secret')$q$ into v;
    out := out || jsonb_build_object('configured', v);
  end if;
  return out;
end;
$$;
revoke execute on function public.scheduler_status() from public, anon, authenticated;
grant execute on function public.scheduler_status() to service_role;

do $outer$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron')
     or not exists (select 1 from pg_available_extensions where name = 'pg_net') then
    raise notice 'pg_cron or pg_net is not available; the CRM schedule was not created';
    return;
  end if;
  create extension if not exists pg_cron;
  create extension if not exists pg_net with schema extensions;

  perform cron.unschedule(jobid) from cron.job where jobname in ('send-due-task-emails', 'crm-tick');
  perform cron.schedule('crm-tick', '* * * * *', 'select public.crm_cron_tick()');
end
$outer$;
