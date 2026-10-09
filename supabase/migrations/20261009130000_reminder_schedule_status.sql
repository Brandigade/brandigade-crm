-- ============================================================================
-- Lets the send-due-task-emails function report whether its every-minute
-- schedule exists and how its last runs went (the deploy prints this). Only the
-- service role can call it.
-- ============================================================================
create or replace function public.reminder_schedule_status()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  out jsonb := '{}'::jsonb;
  v jsonb;
begin
  if to_regclass('cron.job') is null then
    return jsonb_build_object('cron', 'not installed');
  end if;
  execute $q$select coalesce(jsonb_agg(jsonb_build_object('schedule', schedule, 'active', active)), '[]'::jsonb)
             from cron.job where jobname = 'send-due-task-emails'$q$ into v;
  out := out || jsonb_build_object('job', v);
  if to_regclass('cron.job_run_details') is not null then
    execute $q$select coalesce(jsonb_agg(r), '[]'::jsonb) from (
               select d.status, d.return_message, d.start_time from cron.job_run_details d
               join cron.job j on j.jobid = d.jobid
               where j.jobname = 'send-due-task-emails' order by d.start_time desc limit 3) r$q$ into v;
    out := out || jsonb_build_object('lastRuns', v);
  end if;
  if to_regclass('net._http_response') is not null then
    execute $q$select coalesce(jsonb_agg(r), '[]'::jsonb) from (
               select status_code, left(coalesce(content, error_msg, ''), 300) as body, created
               from net._http_response order by created desc limit 3) r$q$ into v;
    out := out || jsonb_build_object('lastCalls', v);
  end if;
  return out;
end;
$$;
revoke execute on function public.reminder_schedule_status() from public, anon, authenticated;
grant execute on function public.reminder_schedule_status() to service_role;
