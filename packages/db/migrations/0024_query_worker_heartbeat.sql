CREATE TABLE worker_heartbeats (
 worker_kind text PRIMARY KEY CHECK(worker_kind='query'),
 last_cycle_at timestamptz NOT NULL
);
