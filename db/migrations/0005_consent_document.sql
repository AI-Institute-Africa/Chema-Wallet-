-- P01: consent, encrypted documents, retention holds. See docs/10.

-- Withdrawal sets withdrawn_at once; the record itself is kept (required records).
CREATE TABLE consent_record (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_person   uuid NOT NULL REFERENCES person(id),
  purpose          text NOT NULL CHECK (purpose IN ('PHOTO', 'NAME', 'TRIBUTE', 'NOTIFY', 'MARKETING', 'DISCLOSURE')),
  wallet_id        uuid,
  given_by         uuid NOT NULL REFERENCES person(id),
  channel          text NOT NULL,
  ts               timestamptz NOT NULL DEFAULT now(),
  withdrawn_at     timestamptz,
  withdrawn_by     uuid REFERENCES person(id),
  CHECK ((withdrawn_at IS NULL) = (withdrawn_by IS NULL))
);
-- At most one live consent per (person, purpose, wallet scope).
CREATE UNIQUE INDEX consent_record_live
  ON consent_record (subject_person, purpose, COALESCE(wallet_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE withdrawn_at IS NULL;
CREATE TRIGGER consent_record_set_once
  BEFORE UPDATE OR DELETE ON consent_record
  FOR EACH ROW EXECUTE FUNCTION allow_set_once('withdrawn_at', 'withdrawn_by');

-- Bytes live in a blob store, AES-256-GCM encrypted with a per-document data
-- key; key_wrap is that data key encrypted under the master key.
-- malware_scan NULL = pending: never served until CLEAN.
CREATE TABLE document (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_ref      text NOT NULL UNIQUE,
  class            text NOT NULL CHECK (class IN ('DEATH_EVIDENCE', 'ID', 'MANDATE', 'OTHER')),
  retention_class  text NOT NULL CHECK (retention_class IN ('SENSITIVE', 'FINANCIAL', 'PUBLIC_CONTENT')),
  content_type     text NOT NULL,
  size_bytes       integer NOT NULL CHECK (size_bytes > 0),
  sha256           text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  key_wrap         text NOT NULL,
  owner_person     uuid NOT NULL REFERENCES person(id),
  linked_wallet    uuid,
  malware_scan     text CHECK (malware_scan IN ('CLEAN', 'INFECTED')),
  scanned_at       timestamptz,
  deleted_at       timestamptz,
  deleted_by       uuid REFERENCES person(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((malware_scan IS NULL) = (scanned_at IS NULL))
);
CREATE INDEX document_wallet ON document (linked_wallet);
CREATE TRIGGER document_set_once
  BEFORE UPDATE OR DELETE ON document
  FOR EACH ROW EXECUTE FUNCTION allow_set_once('malware_scan', 'scanned_at', 'deleted_at', 'deleted_by');

CREATE TABLE retention_hold (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type  text NOT NULL,
  subject_id    text NOT NULL,
  reason        text NOT NULL,
  placed_by     uuid NOT NULL REFERENCES person(id),
  released_at   timestamptz,
  released_by   uuid REFERENCES person(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((released_at IS NULL) = (released_by IS NULL))
);
CREATE INDEX retention_hold_subject ON retention_hold (subject_type, subject_id) WHERE released_at IS NULL;
CREATE TRIGGER retention_hold_set_once
  BEFORE UPDATE OR DELETE ON retention_hold
  FOR EACH ROW EXECUTE FUNCTION allow_set_once('released_at', 'released_by');
