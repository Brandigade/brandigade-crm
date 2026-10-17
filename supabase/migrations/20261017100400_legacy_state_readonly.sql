-- ============================================================================
-- The old JSON document becomes a read-only backup.
--
-- After the move to real tables, a browser still running the previous version
-- of the CRM would keep saving into workspace_state, and those changes would
-- never reach the new tables. Rather than let such saves "succeed" silently,
-- they now fail with a clear message, so the old page shows "Change not saved"
-- and people switch to the new address. The data in workspace_state is kept
-- exactly as it was at the moment of the move.
-- ============================================================================
create or replace function public.workspace_state_read_only()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null then
    raise exception 'The CRM has moved to a new version. Reload the page or open the new CRM address.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists workspace_state_read_only on public.workspace_state;
create trigger workspace_state_read_only before update on public.workspace_state
  for each row execute function public.workspace_state_read_only();

comment on table public.workspace_state is
  'Legacy: the CRM as one JSON document, frozen when records moved to the companies, contacts, deals, tasks and activities tables (migration 20261017100000). Kept as a backup; not used by the app.';
