CREATE TABLE site_content_schedules (
 entry_id uuid PRIMARY KEY REFERENCES site_content_entries(id),
 id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 revision integer NOT NULL,
 entry_version integer NOT NULL CHECK(entry_version>0),
 scheduled_by uuid NOT NULL REFERENCES users(id),
 execute_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','cancelled','blocked','published')),
 finished_at timestamptz,
 failure_code text CHECK(failure_code IN ('entry_changed','operator_access_changed')),
 FOREIGN KEY(entry_id,revision) REFERENCES site_content_revisions(entry_id,revision),
 CHECK((status='pending')=(finished_at IS NULL)),
 CHECK((status='blocked')=(failure_code IS NOT NULL))
);

CREATE INDEX site_content_schedules_due ON site_content_schedules(execute_at,id) WHERE status='pending';
