-- ============================================================================
-- Checks for due tasks every minute by calling the send-due-task-emails edge
-- function. The function does nothing until an email sender is set up, so this is
-- safe to run before reminder emails are switched on.
--
-- The key below is the project's public anon key (it ships in the website too);
-- the function itself runs with the service role key, which never leaves Supabase.
-- Skipped where pg_cron isn't available (for example the local test database).
-- ============================================================================
do $outer$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron')
     or not exists (select 1 from pg_available_extensions where name = 'pg_net') then
    raise notice 'pg_cron or pg_net is not available; task reminder schedule not created';
    return;
  end if;

  create extension if not exists pg_cron;
  create extension if not exists pg_net with schema extensions;

  perform cron.unschedule(jobid) from cron.job where jobname = 'send-due-task-emails';
  perform cron.schedule(
    'send-due-task-emails',
    '* * * * *',
    $job$
    select net.http_post(
      url     := 'https://wqdysxpormmxxaakfgtu.supabase.co/functions/v1/send-due-task-emails',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndxZHlzeHBvcm1teHhhYWtmZ3R1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0ODMxNTcsImV4cCI6MjEwNzA1OTE1N30.OAqkIeHV60fHjcMxedzCDQkqzU1JLBUZxBN6YwpGf00'
      ),
      body    := '{}'::jsonb
    );
    $job$
  );
end
$outer$;
