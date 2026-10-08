-- Supabase grants these by default on the public schema.
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to authenticated, service_role;
grant all on all functions in schema public to authenticated, service_role;
