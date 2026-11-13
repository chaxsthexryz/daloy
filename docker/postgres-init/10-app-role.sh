#!/bin/sh
# Runs once, when the Postgres volume is created. Creates the DML-only role the API and the worker use.
set -eu
: "${APP_DB_PASSWORD:?set APP_DB_PASSWORD in .env}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f /daloy/app-role.sql
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v pw="$APP_DB_PASSWORD" <<'SQL'
ALTER ROLE daloy_app PASSWORD :'pw';
SQL
