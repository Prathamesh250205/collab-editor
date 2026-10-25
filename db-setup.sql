-- One-time local setup: a dev-only login and database for the editor.
-- Run with: psql -U postgres -f db-setup.sql
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'collab') THEN
    ALTER ROLE collab LOGIN PASSWORD 'collab';
  ELSE
    CREATE ROLE collab LOGIN PASSWORD 'collab' CREATEDB;
  END IF;
END $$;

SELECT 'CREATE DATABASE collab OWNER collab'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'collab')\gexec
