#!/usr/bin/env bash
# ============================================================
# Runs every supabase/tests/*.sql suite against a disposable Postgres.
#
# Usage:
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
#     bash scripts/test-sql.sh
#
# DATABASE_URL must be an admin connection (able to CREATE/DROP DATABASE) on
# a server that's fine to lose: this script drops and recreates a database
# on every run. Works the same locally and against the postgres:16 service
# container used in CI.
#
# Steps: drop + create a fresh database, load the harness preamble (Supabase
# stubs), apply every migration in supabase/migrations/*.sql in order, then
# run every top-level supabase/tests/*.sql file. A preamble or migration
# failure aborts immediately. All test files run even if one fails; the
# script exits non-zero if any test file failed.
# ============================================================
set -euo pipefail

database_url="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/postgres}"
test_db_name="turnos_sql_tests"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
preamble_file="${repo_root}/supabase/tests/_harness/preamble.sql"
migrations_dir="${repo_root}/supabase/migrations"
tests_dir="${repo_root}/supabase/tests"

# admin_url talks to whatever database DATABASE_URL points at (used only to
# DROP/CREATE the test database). test_db_url talks to the fresh database
# itself, same connection string with the last path segment swapped out.
admin_url="${database_url}"
test_db_url="${database_url%/*}/${test_db_name}"

echo "==> Dropping and recreating database '${test_db_name}'"
psql "${admin_url}" -v ON_ERROR_STOP=1 -q -c "drop database if exists ${test_db_name};"
psql "${admin_url}" -v ON_ERROR_STOP=1 -q -c "create database ${test_db_name};"

echo "==> Loading harness preamble"
psql "${test_db_url}" -v ON_ERROR_STOP=1 -q -f "${preamble_file}"

echo "==> Applying migrations"
shopt -s nullglob
migration_files=("${migrations_dir}"/*.sql)
shopt -u nullglob

if [ "${#migration_files[@]}" -eq 0 ]; then
  echo "No migration files found in ${migrations_dir}" >&2
  exit 1
fi

for migration in "${migration_files[@]}"; do
  echo "    $(basename "${migration}")"
  psql "${test_db_url}" -v ON_ERROR_STOP=1 -q -f "${migration}"
done

echo "==> Running SQL test suites"
shopt -s nullglob
test_files=("${tests_dir}"/*.sql)
shopt -u nullglob

if [ "${#test_files[@]}" -eq 0 ]; then
  echo "No test files found in ${tests_dir}" >&2
  exit 1
fi

passed=0
failed_files=()
output_file="$(mktemp)"
trap 'rm -f "${output_file}"' EXIT

for test_file in "${test_files[@]}"; do
  name="$(basename "${test_file}")"
  if psql "${test_db_url}" -v ON_ERROR_STOP=1 -q -f "${test_file}" >"${output_file}" 2>&1; then
    echo "PASS  ${name}"
    passed=$((passed + 1))
  else
    echo "FAIL  ${name}"
    while IFS= read -r line; do
      echo "      ${line}"
    done <"${output_file}"
    failed_files+=("${name}")
  fi
done

echo
echo "==> ${passed} passed, ${#failed_files[@]} failed"

if [ "${#failed_files[@]}" -gt 0 ]; then
  echo "Failed suites: ${failed_files[*]}"
  exit 1
fi
