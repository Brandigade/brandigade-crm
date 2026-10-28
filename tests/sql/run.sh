#!/usr/bin/env bash
# Database tests on throwaway Postgres databases (plain Postgres 16/17, no Supabase).
#
#   1. Security and behaviour of the full schema (RLS, grants, triggers, timeline).
#   2. Upgrade rehearsal: the schema as it was before 2026-10-17 with a CRM still
#      stored as one JSON document, then the new migrations, then checks that
#      every record was copied correctly.
#
# Usage:  PGHOST=... PGUSER=... PGPASSWORD=... tests/sql/run.sh
#         PSQL="docker exec -i crm-pgtest psql -U postgres" tests/sql/run.sh
set -euo pipefail
cd "$(dirname "$0")"
PSQL="${PSQL:-psql}"
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
MIG=../../supabase/migrations
DB="${PGDATABASE_TEST:-crm_rls_test}"
DB2="${DB}_upgrade"

q() { $PSQL -v ON_ERROR_STOP=1 -q -X "$@"; }
# Feed a file with notices silenced (PGOPTIONS does not reach a dockerised psql).
qf() { local db=$1 f=$2; { echo "set client_min_messages = warning;"; cat "$f"; } | q -d "$db"; }
fresh() {
  q -d postgres -c "drop database if exists $1" -c "create database $1"
  qf "$1" supabase_stubs.sql
}
apply() {
  local db=$1; shift
  for f in "$@"; do qf "$db" "$f" > /dev/null || { echo "Migration failed: $f"; exit 1; }; done
}

echo "== schema, security and timeline ($DB)"
fresh "$DB"
apply "$DB" "$MIG"/*.sql
for t in rls_test.sql crm_rls_test.sql timeline_test.sql ownership_test.sql; do
  echo "-- $t"
  qf "$DB" "$t"
done

echo "== upgrade from the JSON document ($DB2)"
fresh "$DB2"
legacy=(); current=()
for f in "$MIG"/*.sql; do
  if [[ "$(basename "$f")" < "20261017" ]]; then legacy+=("$f"); else current+=("$f"); fi
done
apply "$DB2" "${legacy[@]}"
qf "$DB2" upgrade_fixture.sql
apply "$DB2" "${current[@]}"
# Running the copy again must not duplicate anything.
apply "$DB2" "$MIG/20261017100000_crm_tables.sql"
qf "$DB2" upgrade_test.sql

echo "All database tests passed"
