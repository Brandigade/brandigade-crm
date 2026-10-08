-- RLS and trigger checks. Each block raises an exception on failure.
\set ON_ERROR_STOP on
\pset tuples_only on

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), false);
  perform set_config('request.jwt.claim.role', case when uid is null then 'anon' else 'authenticated' end, false);
end $$;

-- Users: admin signs up first; alice and bob run their own agencies; carol is invited by alice.
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@brandigade.com', now()),
  ('00000000-0000-0000-0000-0000000000a1', 'alice@one.co', now()),
  ('00000000-0000-0000-0000-0000000000b0', 'bob@two.co', now()),
  ('00000000-0000-0000-0000-0000000000c0', 'carol@one.co', null);

do $$ begin
  assert (select is_platform_admin from public.profiles where email = 'admin@brandigade.com'), 'first user is platform admin';
  assert not (select is_platform_admin from public.profiles where email = 'alice@one.co'), 'later users are not platform admin';
end $$;

set role authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select public.create_workspace('Alice Agency') as alice_ws \gset
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b0');
select public.create_workspace('Bob Studio') as bob_ws \gset

-- Invite carol into Alice's workspace (done by the edge function with the service role).
reset role;
insert into public.workspace_members (workspace_id, user_id, role, invited)
  values (:'alice_ws', '00000000-0000-0000-0000-0000000000c0', 'editor', true);
set role authenticated;

-- Alice writes CRM data.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
update public.workspace_state set data = '{"contacts":[{"id":"c1"}],"deals":[{"id":"d1","value":5000,"stage":"proposal"}]}' where workspace_id = :'alice_ws';
do $$ begin
  assert (select count(*) from public.workspaces) = 1, 'alice sees only her workspace';
  assert (select jsonb_array_length(data->'contacts') from public.workspace_state) = 1, 'alice saved a contact';
  assert (select count(*) from public.workspace_members) = 2, 'alice sees her 2 members';
end $$;

-- Bob can't see or touch Alice's data.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b0');
update public.workspace_state set data = '{"hacked":true}' where workspace_id = :'alice_ws';
do $$ begin
  assert (select count(*) from public.workspaces) = 1, 'bob sees only his workspace';
  assert not exists (select 1 from public.workspace_state where data ? 'contacts'), 'bob cannot read alice data';
  assert (select count(*) from public.profiles) = 1, 'bob sees only himself';
end $$;
reset role;
do $$ begin
  assert not exists (select 1 from public.workspace_state where data ? 'hacked'), 'bob update had no effect';
end $$;
set role authenticated;

-- Carol (editor) can write; she can't promote herself or change the plan.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c0');
update public.workspace_state set data = data || '{"note":"carol"}' where workspace_id = :'alice_ws';
update public.workspace_members set role = 'owner' where user_id = '00000000-0000-0000-0000-0000000000c0';
update public.workspaces set plan_id = 'business' where id = :'alice_ws';
update public.profiles set is_platform_admin = true where id = '00000000-0000-0000-0000-0000000000c0';
reset role;
do $$ begin
  assert exists (select 1 from public.workspace_state where data ? 'note'), 'editor can save';
  assert (select role from public.workspace_members where user_id = '00000000-0000-0000-0000-0000000000c0') = 'editor', 'editor cannot self-promote';
  assert (select plan_id from public.workspaces where name = 'Alice Agency') = 'free', 'members cannot change plan';
  assert not (select is_platform_admin from public.profiles where email = 'carol@one.co'), 'cannot self-grant platform admin';
end $$;

-- Owner: change carol to viewer, rename, cannot change own plan, cannot remove self.
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
update public.workspace_members set role = 'viewer' where user_id = '00000000-0000-0000-0000-0000000000c0';
update public.workspaces set name = 'Alice & Co', plan_id = 'business', status = 'active' where id = :'alice_ws';
delete from public.workspace_members where user_id = '00000000-0000-0000-0000-0000000000a1';
reset role;
do $$ begin
  assert (select role from public.workspace_members where user_id = '00000000-0000-0000-0000-0000000000c0') = 'viewer', 'owner changes roles';
  assert (select name from public.workspaces where plan_id = 'free' and name like 'Alice%') = 'Alice & Co', 'owner renames, plan unchanged';
  assert exists (select 1 from public.workspace_members where user_id = '00000000-0000-0000-0000-0000000000a1'), 'owner cannot remove self';
end $$;

-- Viewer cannot write.
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c0');
update public.workspace_state set data = '{}' where workspace_id = :'alice_ws';
reset role;
do $$ begin
  assert exists (select 1 from public.workspace_state where data ? 'contacts' and workspace_id = (select id from public.workspaces where name = 'Alice & Co')), 'viewer cannot overwrite';
end $$;

-- Invite accepted clears the invited flag (Supabase Auth does this with no user session).
select pg_temp.act_as(null);
update auth.users set email_confirmed_at = now() where email = 'carol@one.co';
do $$ begin
  assert not (select invited from public.workspace_members where user_id = '00000000-0000-0000-0000-0000000000c0'), 'confirmed invite clears flag';
end $$;

-- Seat limit (free = 3): alice + carol + one more fits, the 4th fails.
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000d0', 'dan@one.co', now()), ('00000000-0000-0000-0000-0000000000e0', 'eve@one.co', now());
insert into public.workspace_members (workspace_id, user_id, role) values (:'alice_ws', '00000000-0000-0000-0000-0000000000d0', 'viewer');
do $$ begin
  begin
    insert into public.workspace_members (workspace_id, user_id, role)
      select id, '00000000-0000-0000-0000-0000000000e0', 'viewer' from public.workspaces where name = 'Alice & Co';
    raise exception 'seat limit not enforced';
  exception when sqlstate 'P0001' then
    if sqlerrm not like 'Seat limit%' then raise; end if;
  end;
end $$;

-- Contact limit (free = 250).
do $$ begin
  begin
    update public.workspace_state set data = jsonb_build_object('contacts', (select jsonb_agg(jsonb_build_object('id', g)) from generate_series(1, 251) g))
      where workspace_id = (select id from public.workspaces where name = 'Alice & Co');
    raise exception 'contact limit not enforced';
  exception when sqlstate 'P0001' then
    if sqlerrm not like 'Contact limit%' then raise; end if;
  end;
end $$;

-- Platform admin sees everything and can upgrade/suspend.
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
do $$ begin
  assert (select count(*) from public.admin_list_workspaces()) = 2, 'admin lists all workspaces';
  assert (select open_pipeline from public.admin_list_workspaces() where name = 'Alice & Co') = 5000, 'admin sees open pipeline';
  assert (select count(*) from public.admin_list_users()) = 6, 'admin lists all users';
end $$;
update public.workspaces set plan_id = 'pro', status = 'suspended' where id = :'bob_ws';
reset role;
do $$ begin
  assert (select plan_id || '/' || status from public.workspaces where name = 'Bob Studio') = 'pro/suspended', 'admin changes plan and status';
end $$;

-- Suspended workspace is read-only for its owner; non-admins can't call admin RPCs.
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b0');
update public.workspace_state set data = '{"x":1}' where workspace_id = :'bob_ws';
do $$ begin
  begin
    perform public.admin_list_workspaces();
    raise exception 'admin rpc not protected';
  exception when others then
    if sqlerrm not like 'Platform admins only%' then raise; end if;
  end;
  assert (select count(*) from public.workspace_state) = 1, 'suspended owner can still read';
end $$;
reset role;
do $$ begin
  assert not exists (select 1 from public.workspace_state where data ? 'x'), 'suspended workspace is read-only';
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

select 'ALL SQL CHECKS PASSED' as result;
