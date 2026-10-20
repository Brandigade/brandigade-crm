-- The CRM's server is the Supabase Edge Function "api" and the site is on
-- GitHub Pages, so Supabase also runs the daily housekeeping (pruning old
-- background jobs, expired sign-in attempts and long-expired invites).
--
-- The base address in Vault (crm_app_url, set by `npm run setup:cron`) is the
-- server's: https://<ref>.supabase.co/functions/v1, so the calls go to
-- .../functions/v1/api/cron/tick and .../functions/v1/api/cron/daily.

-- The every-minute tick: same as before, with a timeout longer than the
-- tick's own 50 second budget.
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
  execute $q$select net.http_post(url := $1, headers := $2, body := '{}'::jsonb, timeout_milliseconds := 60000)$q$
    using rtrim(v_url, '/') || '/api/cron/tick',
          jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret);
end;
$$;
revoke execute on function public.crm_cron_tick() from public, anon, authenticated;

create or replace function public.crm_cron_daily()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_url text;
  v_secret text;
begin
  if to_regclass('vault.decrypted_secrets') is null
     or not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'net' and p.proname = 'http_get') then
    return;
  end if;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'crm_app_url' limit 1$q$ into v_url;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'crm_cron_secret' limit 1$q$ into v_secret;
  if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then
    return;
  end if;
  execute $q$select net.http_get(url := $1, headers := $2, timeout_milliseconds := 60000)$q$
    using rtrim(v_url, '/') || '/api/cron/daily',
          jsonb_build_object('Authorization', 'Bearer ' || v_secret);
end;
$$;
revoke execute on function public.crm_cron_daily() from public, anon, authenticated;

do $outer$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not installed; the daily CRM job was not created';
    return;
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'crm-daily';
  perform cron.schedule('crm-daily', '15 4 * * *', 'select public.crm_cron_daily()');
end
$outer$;
