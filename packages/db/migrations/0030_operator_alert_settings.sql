CREATE TABLE operator_alert_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 heartbeat_stale_seconds int NOT NULL DEFAULT 30 CHECK (heartbeat_stale_seconds BETWEEN 5 AND 1800),
 query_delay_seconds int NOT NULL DEFAULT 15 CHECK (query_delay_seconds BETWEEN 5 AND 600),
 collector_failure_percent int NOT NULL DEFAULT 10 CHECK (collector_failure_percent BETWEEN 1 AND 100),
 version int NOT NULL DEFAULT 1 CHECK (version>0),
 updated_at timestamptz
);
INSERT INTO operator_alert_settings(singleton) VALUES(true);
