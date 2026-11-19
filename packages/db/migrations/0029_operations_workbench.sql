CREATE TABLE operator_account_approvals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 subject_user_id uuid NOT NULL REFERENCES users,
 action text NOT NULL CHECK (action IN ('suspend','restore')),
 subject_credential_version int NOT NULL,
 state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','approved','rejected','executed','cancelled')),
 request_reason text,
 requested_by uuid NOT NULL REFERENCES users,
 requested_at timestamptz NOT NULL,
 reviewed_by uuid REFERENCES users,
 reviewed_at timestamptz,
 executed_by uuid REFERENCES users,
 executed_at timestamptz,
 updated_at timestamptz NOT NULL,
 version int NOT NULL DEFAULT 1 CHECK (version>0),
 CHECK (requested_by<>subject_user_id),
 CHECK ((reviewed_by IS NULL)=(reviewed_at IS NULL)),
 CHECK (reviewed_by IS NULL OR reviewed_by<>requested_by),
 CHECK ((executed_by IS NULL)=(executed_at IS NULL)),
 CHECK (state NOT IN ('approved','rejected','executed') OR reviewed_by IS NOT NULL),
 CHECK ((state='executed')=(executed_by IS NOT NULL))
);
CREATE UNIQUE INDEX operator_one_open_account_approval ON operator_account_approvals(subject_user_id)
 WHERE state IN ('requested','approved');
CREATE INDEX operator_account_approvals_recent ON operator_account_approvals(updated_at DESC,id DESC);

CREATE TABLE operator_account_notes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 subject_user_id uuid NOT NULL REFERENCES users,
 author_id uuid NOT NULL REFERENCES users,
 content text NOT NULL CHECK(length(content) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL
);
CREATE INDEX operator_account_notes_recent ON operator_account_notes(subject_user_id,created_at DESC,id DESC);

CREATE TABLE operator_incidents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 component text NOT NULL CHECK(component IN ('api','collector','query','payments','support')),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 140),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','monitoring','resolved')),
 opened_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 resolved_at timestamptz,
 version int NOT NULL DEFAULT 1 CHECK(version>0),
 CHECK((state='resolved')=(resolved_at IS NOT NULL))
);
CREATE INDEX operator_incidents_recent ON operator_incidents(updated_at DESC,id DESC);
