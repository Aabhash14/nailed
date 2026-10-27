#!/usr/bin/env sh
# run-safeupdate-check.sh — LOCAL ONLY. Runs supabase/checks/safeupdate_check.sql against the running local Supabase
# stack as role `authenticator`, which preloads pg_safeupdate exactly like PostgREST does. Everything runs in one
# transaction that is rolled back. Exit status 0 = PASSED.
#
# Usage (from engineering/app):   sh supabase/checks/run-safeupdate-check.sh
# Env overrides: SUPABASE_DB_CONTAINER (default supabase_db_<project_id from supabase/config.toml>),
#                AUTHENTICATOR_PASSWORD (default "postgres", the local stack's password; never a hosted one).
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_id=$(sed -n 's/^project_id *= *"\(.*\)"/\1/p' "$here/../config.toml" | head -n 1)
container=${SUPABASE_DB_CONTAINER:-supabase_db_${project_id}}
password=${AUTHENTICATOR_PASSWORD:-postgres}

# TCP (-h 127.0.0.1) inside the container: the socket uses peer auth, and only a real login as authenticator gets
# its session_preload_libraries (supautils, safeupdate).
docker exec -i -e PGPASSWORD="$password" "$container" \
  psql -h 127.0.0.1 -U authenticator -d postgres -X -q -v ON_ERROR_STOP=1 < "$here/safeupdate_check.sql"
