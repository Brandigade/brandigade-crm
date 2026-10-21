-- A CRM as it exists before the move to tables: two people and one JSON
-- document, including the odd values a hand-built JSON document can hold.
\set ON_ERROR_STOP on
insert into auth.users (id, email, email_confirmed_at) values
  ('90000000-0000-0000-0000-000000000001', 'admin@brandigade.com', now()),
  ('90000000-0000-0000-0000-000000000002', 'ed@brandigade.com', now());
insert into public.workspace_members (workspace_id, user_id, role)
  select id, '90000000-0000-0000-0000-000000000002', 'editor' from public.workspaces;

update public.workspace_state set data = jsonb_build_object(
  'companies', jsonb_build_array(
    jsonb_build_object('id', 'co1', 'name', 'Cedar & Crumb', 'industry', 'Food & beverage', 'city', 'San Francisco', 'createdAt', '2026-10-01T10:00:00.000Z'),
    jsonb_build_object('id', 'co2', 'name', ''),
    jsonb_build_object('id', 'co3', 'name', repeat('X', 250)),
    jsonb_build_object('name', 'No id, skipped'),
    'not an object'
  ),
  'contacts', jsonb_build_array(
    jsonb_build_object('id', 'c1', 'firstName', 'Maya', 'lastName', 'Rivera', 'email', 'Maya@CedarCrumb.example', 'phone', '+1 415 555 0143',
                       'companyId', 'co1', 'status', 'customer', 'ownerId', '90000000-0000-0000-0000-000000000001', 'source', 'Referral'),
    jsonb_build_object('id', 'c2', 'companyId', 'missing', 'ownerId', 'demo-sara', 'status', 'weird'),
    jsonb_build_object('id', 'c1', 'firstName', 'Duplicate id, skipped')
  ),
  'deals', jsonb_build_array(
    jsonb_build_object('id', 'd1', 'title', 'Wholesale packaging', 'value', '18500', 'stage', 'negotiation', 'closeDate', '2026-10-20',
                       'contactId', 'c1', 'companyId', 'co1', 'ownerId', '90000000-0000-0000-0000-000000000002'),
    jsonb_build_object('id', 'd2', 'title', 'Odd deal', 'value', 'abc', 'stage', 'unknown', 'closeDate', 'not a date', 'closedAt', '2026-01-01'),
    jsonb_build_object('id', 'd3', 'title', 'Negative', 'value', -5, 'stage', 'won')
  ),
  'board', jsonb_build_array(
    jsonb_build_object('id', 'b101', 'title', 'Send samples', 'workstream', 'Follow-up', 'column', 'done', 'dueDate', '2026-10-18', 'dueTime', '10:00',
                       'reminder', '1_hour', 'priority', 'high', 'assignedTo', '90000000-0000-0000-0000-000000000002', 'dealId', 'd1', 'notes', 'Matte finish', 'reminderFired', true),
    jsonb_build_object('id', 'b102', 'title', 'Old task without reminder', 'column', 'weird', 'dueDate', '2026-10-19', 'dueTime', '25:99'),
    jsonb_build_object('id', 'b103', 'title', 'Bad date', 'reminder', 'none', 'dueDate', '2026-13-45', 'assignedTo', 'nobody')
  ),
  'activities', jsonb_build_array(
    jsonb_build_object('id', 'a1', 'type', 'call', 'subject', 'Discovery call', 'body', 'Budget confirmed', 'contactId', 'c1', 'dealId', 'd1', 'companyId', 'co1',
                       'at', '2026-10-05T09:00:00.000Z', 'by', '90000000-0000-0000-0000-000000000001'),
    jsonb_build_object('id', 'a2', 'type', 'sms', 'subject', 'Unknown type', 'at', 'yesterday'),
    jsonb_build_object('id', 'a3', 'type', 'note', 'subject', 'By someone gone', 'by', 'demo-omar', 'contactId', 'c2', 'at', '2026-10-06T09:00:00.000Z')
  ),
  'settings', jsonb_build_object('currency', 'AED', 'timezone', 'Asia/Dubai'),
  'nextIds', jsonb_build_object('board', 104, 'company', 4, 'contact', 3, 'deal', 4, 'activity', 4)
);

-- Remember the document exactly, to prove the upgrade leaves it untouched.
create table public._fixture_state_md5 as select md5(data::text) as md5 from public.workspace_state;
