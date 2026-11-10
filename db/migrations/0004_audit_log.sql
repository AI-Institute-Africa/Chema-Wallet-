-- P01: append-only, hash-chained audit log. See docs/10 (Audit log).
-- hash = sha256(prev_hash || canonical JSON of the row's fields), computed by
-- the application under an advisory lock; verified by `pnpm audit:verify`.
-- seq is contiguous from 1 (gaps = deleted rows); prev_hash UNIQUE blocks forks.

CREATE TABLE audit_log (
  seq           bigint PRIMARY KEY CHECK (seq > 0),
  id            uuid NOT NULL UNIQUE,
  ts            timestamptz NOT NULL,
  actor_id      text NOT NULL,
  actor_role    text NOT NULL,
  channel       text NOT NULL,
  session_ref   text,
  action        text NOT NULL,
  subject_type  text NOT NULL,
  subject_id    text NOT NULL,
  authz_result  text NOT NULL CHECK (authz_result IN ('ALLOWED', 'DENIED')),
  approval_ref  text,
  txn_ref       text,
  before_hash   text,
  after_hash    text,
  ip            text,
  device        text,
  reason_code   text,
  prev_hash     text NOT NULL UNIQUE CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash          text NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX audit_log_subject ON audit_log (subject_type, subject_id);
CREATE INDEX audit_log_actor ON audit_log (actor_id, ts);

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation();
