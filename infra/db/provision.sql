\set VERBOSITY terse
\getenv migrator_password SOLD_MIGRATOR_PASSWORD
\getenv runtime_password SOLD_RUNTIME_PASSWORD
\getenv collector_password SOLD_COLLECTOR_PASSWORD
\getenv backup_password SOLD_BACKUP_PASSWORD

BEGIN;
SET LOCAL password_encryption = 'scram-sha-256';
SELECT pg_advisory_xact_lock(hashtext('soldbench:migrations'));

DO $$
DECLARE
  name text;
  expected_roles text[] := ARRAY['soldbench_migrator', 'soldbench_runtime', 'soldbench_collector', 'soldbench_backup'];
BEGIN
  IF current_user = ANY(expected_roles) THEN
    RAISE EXCEPTION 'SoldBench bootstrap must use its separate administrator';
  END IF;
  -- Never silently reuse a role that already inherits or owns cluster-wide authority.
  IF EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname = ANY(expected_roles)
      AND (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
        OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid)
        OR EXISTS (SELECT 1 FROM pg_database d WHERE d.datdba = r.oid))
  ) THEN
    RAISE EXCEPTION 'Existing deployment role has unexpected authority';
  END IF;
  FOREACH name IN ARRAY expected_roles LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', name);
    END IF;
  END LOOP;
END $$;

ALTER ROLE soldbench_migrator LOGIN NOINHERIT PASSWORD :'migrator_password';
ALTER ROLE soldbench_runtime LOGIN NOINHERIT PASSWORD :'runtime_password';
ALTER ROLE soldbench_collector LOGIN NOINHERIT PASSWORD :'collector_password';
ALTER ROLE soldbench_backup LOGIN NOINHERIT PASSWORD :'backup_password';

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO soldbench_migrator, soldbench_runtime, soldbench_collector, soldbench_backup', current_database()) \gexec
ALTER SCHEMA public OWNER TO soldbench_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO soldbench_runtime, soldbench_collector, soldbench_backup;

-- A legacy SoldBench database may have used an administrator as the application's
-- schema owner. Transfer only public-schema objects in this dedicated database.
SELECT format('ALTER %s %I.%I OWNER TO soldbench_migrator',
  CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
  n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
ORDER BY CASE c.relkind WHEN 'S' THEN 1 ELSE 0 END, c.relname \gexec

SELECT format('ALTER ROUTINE %s OWNER TO soldbench_migrator', p.oid::regprocedure)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' \gexec

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM PUBLIC;
COMMIT;
