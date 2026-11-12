#!/usr/bin/env bash
# Teste la migration + scénarios sur un PostgreSQL local (sudo -u postgres).
set -euo pipefail
cd "$(dirname "$0")"
DB=localiser_test
psql_() { sudo -u postgres psql -v ON_ERROR_STOP=1 -q "$@"; }
psql_ -c "drop database if exists $DB" -c "create database $DB"
psql_ -d $DB -f local_stubs.sql
cat ../migrations/*.sql | grep -v -E "create extension if not exists pg_(net|cron)" > /tmp/localiser_migration.sql
psql_ -d $DB -f /tmp/localiser_migration.sql
psql_ -d $DB -f scenarios.sql
echo "OK : tous les scénarios passent"
