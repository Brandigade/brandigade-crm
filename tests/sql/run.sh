#!/usr/bin/env bash
# Runs the migration and RLS checks against a throwaway Postgres database.
# Usage: PGHOST=... PGUSER=... PGPASSWORD=... tests/sql/run.sh
set -euo pipefail
cd "$(dirname "$0")"
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
DB="${PGDATABASE_TEST:-crm_rls_test}"
psql -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists $DB" -c "create database $DB"
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f supabase_stubs.sql
for f in ../../supabase/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$f"; done
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f grants.sql
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f rls_test.sql
