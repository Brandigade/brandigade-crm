-- RLS and trigger checks. Each block raises an exception on failure.
\set ON_ERROR_STOP on
\pset tuples_only on

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), false);
  perform set_config('request.jwt.claim.role', case when uid is null then 'anon' else 'authenticated' end, false);
end $$;

-- Users: the admin signs up first; carol is invited; mallory signs up without an invite.
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@brandigade.com', now()),
  ('00000000-0000-0000-0000-0000000000c0', 'carol@brandigade.com', null),
  ('00000000-0000-0000-0000-0000000000f0', 'mallory@else.co', now());

do $$ begin
  assert (select is_platform_admin from public.profiles where email = 'admin@brandigade.com'), 'first user is platform admin';
  assert not (select is_platform_admin from public.profiles where email = 'mallory@else.co'), 'later users are not platform admin';
  assert (select count(*) from public.workspaces) = 1, 'the company CRM is created for the first user';
  assert (select role from public.workspace_members where user_id = '00000000-0000-0000-0000-00000000000a') = 'owner', 'first user owns the CRM';
  assert (select count(*) from public.workspace_members) = 1, 'nobody else joins without an invite';
end $$;
select id as crm from public.workspaces \gset

-- Invite carol (done by the edge function with the service role).
insert into public.workspace_members (workspace_id, user_id, role, invited)
  values (:'crm', '00000000-0000-0000-0000-0000000000c0', 'editor', true);

-- The admin writes CRM data.
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
update public.workspace_state set data = '{"contacts":[{"id":"c1"}],"deals":[{"id":"d1","value":5000,"stage":"proposal"}]}' where workspace_id = :'crm';
do $$ begin
  assert (select jsonb_array_length(data->'contacts') from public.workspace_state) = 1, 'admin saved a contact';
  assert (select count(*) from public.workspace_members) = 2, 'admin sees the 2 members';
end $$;

-- Mallory (not invited) can't see or touch anything.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f0');
update public.workspace_state set data = '{"hacked":true}' where workspace_id = :'crm';
do $$ begin
  assert (select count(*) from public.workspaces) = 0, 'uninvited user sees no CRM';
  assert (select count(*) from public.workspace_state) = 0, 'uninvited user cannot read data';
  assert (select count(*) from public.workspace_members) = 0, 'uninvited user sees no team';
  assert (select count(*) from public.profiles) = 1, 'uninvited user sees only themself';
end $$;
reset role;
do $$ begin
  assert not exists (select 1 from public.workspace_state where data ? 'hacked'), 'uninvited update had no effect';
end $$;

-- Nobody can start another workspace.
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f0');
do $$ begin
  begin
    perform public.create_workspace('Mallory Inc');
    raise exception 'create_workspace still exists';
  exception when undefined_function then null;
  end;
end $$;
reset role;
do $$ begin
  begin
    insert into public.workspaces (name) values ('Second CRM');
    raise exception 'a second workspace was allowed';
  exception when unique_violation then null;
  end;
end $$;

-- Carol (editor) can write; she can't promote herself or grant herself admin.
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c0');
update public.workspace_state set data = data || '{"note":"carol"}' where workspace_id = :'crm';
update public.workspace_members set role = 'owner' where user_id = '00000000-0000-0000-0000-0000000000c0';
update public.profiles set is_platform_admin = true where id = '00000000-0000-0000-0000-0000000000c0';
reset role;
do $$ begin
  assert exists (select 1 from public.workspace_state where data ? 'note'), 'editor can save';
  assert (select role from public.workspace_members where user_id = '00000000-0000-0000-0000-0000000000c0') = 'editor', 'editor cannot self-promote';
  assert not (select is_platform_admin from public.profiles where email = 'carol@brandigade.com'), 'cannot self-grant platform admin';
end $$;

-- Owner: change carol to viewer, cannot remove self.
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
update public.workspace_members set role = 'viewer' where user_id = '00000000-0000-0000-0000-0000000000c0';
do $$ begin
  delete from public.workspace_members where user_id = '00000000-0000-0000-0000-00000000000a';
exception when others then
  if sqlerrm not like 'The CRM owner cannot be removed%' then raise; end if;
end $$;
reset role;
do $$ begin
  assert (select role from public.workspace_members where user_id = '00000000-0000-0000-0000-0000000000c0') = 'viewer', 'owner changes roles';
  assert exists (select 1 from public.workspace_members where user_id = '00000000-0000-0000-0000-00000000000a'), 'owner cannot remove self';
end $$;

-- Viewer cannot write.
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c0');
update public.workspace_state set data = '{}' where workspace_id = :'crm';
reset role;
do $$ begin
  assert exists (select 1 from public.workspace_state where data ? 'contacts'), 'viewer cannot overwrite';
end $$;

-- Invite accepted clears the invited flag (Supabase Auth does this with no user session).
select pg_temp.act_as(null);
update auth.users set email_confirmed_at = now() where email = 'carol@brandigade.com';
do $$ begin
  assert not (select invited from public.workspace_members where user_id = '00000000-0000-0000-0000-0000000000c0'), 'confirmed invite clears flag';
end $$;

-- No limits: many people and many contacts are fine.
insert into auth.users (id, email, email_confirmed_at)
  select ('00000000-0000-0000-0000-0000000001' || lpad(g::text, 2, '0'))::uuid, 'p' || g || '@brandigade.com', now() from generate_series(1, 12) g;
insert into public.workspace_members (workspace_id, user_id, role)
  select :'crm', ('00000000-0000-0000-0000-0000000001' || lpad(g::text, 2, '0'))::uuid, 'viewer' from generate_series(1, 12) g;
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
update public.workspace_state set data = jsonb_build_object('contacts', (select jsonb_agg(jsonb_build_object('id', g)) from generate_series(1, 300) g))
  where workspace_id = :'crm';
reset role;
do $$ begin
  assert (select count(*) from public.workspace_members) = 14, 'no seat limit';
  assert (select jsonb_array_length(data->'contacts') from public.workspace_state) = 300, 'no contact limit';
end $$;

-- Anonymous visitors see nothing.
set role anon;
select pg_temp.act_as(null);
do $$ begin
  begin
    perform 1 from public.workspace_state;
    raise exception 'anon can read state';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- If the only account is deleted, the next person to sign up becomes admin and owner.
delete from auth.users;
do $$ begin
  assert (select count(*) from public.workspaces) = 1, 'the CRM and its data survive';
  assert (select count(*) from public.workspace_members) = 0, 'no members left';
end $$;
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-0000-0000-0000000000aa', 'new-admin@brandigade.com', now());
do $$ begin
  assert (select is_platform_admin from public.profiles where email = 'new-admin@brandigade.com'), 'next first user is admin';
  assert (select role from public.workspace_members where user_id = '00000000-0000-0000-0000-0000000000aa') = 'owner', 'next first user owns the CRM';
  assert (select count(*) from public.workspaces) = 1, 'still one CRM';
end $$;

select 'ALL SQL CHECKS PASSED' as result;
