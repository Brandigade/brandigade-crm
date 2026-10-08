-- ============================================================================
-- email_reminders_cron.sql — OPTIONAL: due-task emails, checked every minute
-- Run AFTER you have deployed the send-due-task-emails edge function.
--
-- Replace the two placeholders below, then run it in the SQL editor:
--   <PROJECT-REF>  -> the xxxx part of https://xxxx.supabase.co
--   <ANON-KEY>     -> Project Settings → API → anon / publishable key
-- (The anon key is public by design; the function itself uses the service role
--  key, which Supabase injects into the function and never leaves the server.)
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Re-running replaces the job instead of creating a duplicate.
select cron.unschedule('send-due-task-emails')
where exists (select 1 from cron.job where jobname = 'send-due-task-emails');

select cron.schedule(
  'send-due-task-emails',
  '* * * * *',                              -- every minute
  $$
  select net.http_post(
    url     := 'https://<PROJECT-REF>.supabase.co/functions/v1/send-due-task-emails',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer <ANON-KEY>'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- To stop the emails later:  select cron.unschedule('send-due-task-emails');
