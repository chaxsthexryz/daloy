-- The role the API and the worker connect as: read and write rows, nothing else (decision 0013).
-- Run as the owner role that also runs the migrations, in the app database, before or after migrating.
-- The password is set separately (docker/postgres-init/10-app-role.sh), so this file holds no secret.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'daloy_app') THEN
    CREATE ROLE daloy_app LOGIN;
  END IF;
END
$$;

-- pg-boss keeps its tables in its own schema. Created here so the grants below can name it.
CREATE SCHEMA IF NOT EXISTS pgboss;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public, pgboss TO daloy_app;

-- Tables that exist already, and tables the owner creates later (migrations, pg-boss install).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public, pgboss TO daloy_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public, pgboss TO daloy_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public, pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO daloy_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public, pgboss GRANT USAGE, SELECT ON SEQUENCES TO daloy_app;
