#!/usr/bin/env bash
# Поднимает локальный Postgres с заглушкой Supabase и применяет миграции.
# Использование: tests/stack/pg.sh start|stop
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DATA="${CRM_PG_DATA:-/tmp/crm-bot-pg}"
BIN=/usr/lib/postgresql/16/bin
PORT="${CRM_PG_PORT:-54329}"
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
case "${1:-start}" in
  start)
    run "$BIN/pg_ctl -D $DATA -m immediate stop" >/dev/null 2>&1 || true
    rm -rf "$DATA"; mkdir -p "$DATA"; [ "$(id -u)" = 0 ] && chown postgres "$DATA"
    run "$BIN/initdb -D $DATA -U postgres --auth=trust -E UTF8 --locale=C.UTF-8" >/dev/null
    run "$BIN/pg_ctl -D $DATA -o '-p $PORT -k /tmp -c listen_addresses=127.0.0.1' -l $DATA/server.log -w start" >/dev/null
    export PGPASSWORD=postgres
    P="psql -h 127.0.0.1 -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -q"
    $P -f "$ROOT/tests/stack/supabase_stub.sql"
    for f in "$ROOT"/supabase/migrations/*.sql; do $P -f "$f"; done
    echo "postgres://postgres@127.0.0.1:$PORT/postgres"
    ;;
  stop) run "$BIN/pg_ctl -D $DATA -m immediate stop" >/dev/null 2>&1 || true ;;
esac
