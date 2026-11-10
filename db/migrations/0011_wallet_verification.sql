-- P04: wallet lifecycle + community verification (docs/03, docs/05).
-- Every rule is enforced twice: typed errors in @chema/wallet before any write,
-- and the triggers below, proven by raw-SQL tests that bypass the library.

CREATE TABLE wallet (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status                 text NOT NULL DEFAULT 'DRAFT' CHECK (status IN
                           ('DRAFT', 'PENDING_VERIFICATION', 'ACTIVE', 'VERIFICATION_REJECTED',
                            'SUSPENDED', 'CLOSING', 'CLOSED')),
  deceased_name          text NOT NULL CHECK (length(btrim(deceased_name)) BETWEEN 1 AND 200),
  deceased_name_norm     text NOT NULL,
  date_of_death          date NOT NULL,
  funeral_date           date,
  funeral_location       text NOT NULL CHECK (length(btrim(funeral_location)) BETWEEN 1 AND 200),
  funeral_location_norm  text NOT NULL,
  family_contact_phone   text CHECK (family_contact_phone ~ '^\+[1-9][0-9]{6,14}$'),
  target_minor           bigint CHECK (target_minor IS NULL OR target_minor > 0),
  currency               text NOT NULL CHECK (currency IN ('USD', 'ZWG')),
  photo_doc              uuid REFERENCES document(id),
  photo_consent_id       uuid REFERENCES consent_record(id),
  public_slug            text UNIQUE CHECK (public_slug ~ '^[a-z2-7]{26}$'),
  verified_at            timestamptz,
  admin_person           uuid NOT NULL REFERENCES person(id),
  privacy                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by             uuid NOT NULL REFERENCES person(id),
  created_by_kind        text NOT NULL CHECK (created_by_kind IN ('CUSTOMER', 'AGENT')),
  source_channel         text NOT NULL CHECK (source_channel IN ('WEB', 'WHATSAPP', 'SMS', 'ADMIN')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- docs/03: no public slug before activation; an ACTIVE wallet always has one.
  CHECK (public_slug IS NULL OR status IN ('ACTIVE', 'SUSPENDED', 'CLOSING', 'CLOSED')),
  CHECK (status NOT IN ('ACTIVE', 'SUSPENDED', 'CLOSING', 'CLOSED') OR (public_slug IS NOT NULL AND verified_at IS NOT NULL)),
  CHECK ((photo_doc IS NULL) = (photo_consent_id IS NULL))
);
CREATE INDEX wallet_dedupe ON wallet (deceased_name_norm, date_of_death);
CREATE INDEX wallet_admin ON wallet (admin_person);
CREATE INDEX wallet_creator ON wallet (created_by, created_at);

-- State machine (docs/03) + immutable identity columns. The draft's details
-- may change only while it is DRAFT; slug and verified_at are set once.
CREATE FUNCTION wallet_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wallet: DELETE denied' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.created_by <> OLD.created_by OR NEW.created_by_kind <> OLD.created_by_kind
     OR NEW.created_at <> OLD.created_at OR NEW.source_channel <> OLD.source_channel OR NEW.currency <> OLD.currency
     OR NEW.admin_person <> OLD.admin_person THEN
    RAISE EXCEPTION 'wallet: immutable column changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.public_slug IS NOT NULL AND NEW.public_slug IS DISTINCT FROM OLD.public_slug THEN
    RAISE EXCEPTION 'wallet: public_slug is set-once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.verified_at IS NOT NULL AND NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
    RAISE EXCEPTION 'wallet: verified_at is set-once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'DRAFT' AND (
       NEW.deceased_name <> OLD.deceased_name OR NEW.date_of_death <> OLD.date_of_death
       OR NEW.funeral_location <> OLD.funeral_location
       OR NEW.deceased_name_norm <> OLD.deceased_name_norm OR NEW.funeral_location_norm <> OLD.funeral_location_norm) THEN
    RAISE EXCEPTION 'wallet: deceased details are frozen after submission' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status = 'PENDING_VERIFICATION')
    OR (OLD.status = 'PENDING_VERIFICATION' AND NEW.status IN ('ACTIVE', 'VERIFICATION_REJECTED', 'DRAFT'))
    OR (OLD.status = 'VERIFICATION_REJECTED' AND NEW.status = 'PENDING_VERIFICATION')
    OR (OLD.status = 'ACTIVE' AND NEW.status IN ('SUSPENDED', 'CLOSING'))
    OR (OLD.status = 'SUSPENDED' AND NEW.status = 'ACTIVE')
    OR (OLD.status = 'CLOSING' AND NEW.status = 'CLOSED')) THEN
    RAISE EXCEPTION 'wallet: illegal transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wallet_guard BEFORE UPDATE OR DELETE ON wallet
  FOR EACH ROW EXECUTE FUNCTION wallet_guard();

-- History of every status change, with who and why (suspend reasons live here).
CREATE TABLE wallet_status_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id    uuid NOT NULL REFERENCES wallet(id),
  from_status  text,
  to_status    text NOT NULL,
  actor_id     text NOT NULL,
  actor_role   text NOT NULL,
  reason_code  text,
  note         text CHECK (note IS NULL OR length(note) <= 2000),
  case_id      uuid,
  ts           timestamptz NOT NULL
);
CREATE INDEX wallet_status_event_wallet ON wallet_status_event (wallet_id, ts);
CREATE TRIGGER wallet_status_event_no_update_delete BEFORE UPDATE OR DELETE ON wallet_status_event
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER wallet_status_event_no_truncate BEFORE TRUNCATE ON wallet_status_event
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation();

-- Fidelity link captured at create time (docs/05 edge). Stub only: P06 owns
-- the claim path; verification never reads this table.
CREATE TABLE fidelity_link (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id            uuid NOT NULL UNIQUE REFERENCES wallet(id),
  policy_no            text CHECK (policy_no IS NULL OR length(policy_no) BETWEEN 1 AND 64),
  national_id          text CHECK (national_id IS NULL OR length(national_id) BETWEEN 1 AND 64),
  claim_ref            text,
  claim_status_mirror  text NOT NULL DEFAULT 'NONE' CHECK (claim_status_mirror IN
                         ('NONE', 'SUBMITTED', 'IN_REVIEW', 'MORE_INFO', 'APPROVED', 'DECLINED')),
  route_status         text NOT NULL DEFAULT 'UNSET' CHECK (route_status IN
                         ('UNSET', 'PENDING_APPROVAL', 'APPROVED', 'BLOCKED_MISMATCH')),
  created_by           uuid NOT NULL REFERENCES person(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (policy_no IS NOT NULL OR national_id IS NOT NULL)
);

-- Evidence offered for verification: a scanned document + what it claims to be.
-- certificate_no_hash = sha256 of the normalised certificate number (no plaintext).
CREATE TABLE verification_evidence (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id            uuid NOT NULL REFERENCES wallet(id),
  document_id          uuid NOT NULL REFERENCES document(id),
  evidence_type        text NOT NULL CHECK (evidence_type IN
                         ('DEATH_CERTIFICATE', 'PARLOUR_CONFIRMATION', 'BURIAL_ORDER', 'ADMIN_ID', 'MANDATE', 'OTHER')),
  certificate_no_hash  text CHECK (certificate_no_hash IS NULL OR certificate_no_hash ~ '^[0-9a-f]{64}$'),
  added_by             uuid NOT NULL REFERENCES person(id),
  created_at           timestamptz NOT NULL,
  UNIQUE (wallet_id, document_id),
  CHECK (certificate_no_hash IS NULL OR evidence_type = 'DEATH_CERTIFICATE')
);
CREATE INDEX verification_evidence_cert ON verification_evidence (certificate_no_hash) WHERE certificate_no_hash IS NOT NULL;
CREATE TRIGGER verification_evidence_no_update_delete BEFORE UPDATE OR DELETE ON verification_evidence
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- Documented authority of the wallet admin (docs/02 Wallet mandate). Approved
-- by the verifier together with the case; no mandate ⇒ no payouts (P07).
CREATE TABLE mandate (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id       uuid NOT NULL REFERENCES wallet(id),
  admin_person    uuid NOT NULL REFERENCES person(id),
  evidence_docs   uuid[] NOT NULL CHECK (cardinality(evidence_docs) > 0),
  thresholds      jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_by     uuid REFERENCES person(id),
  approved_at     timestamptz,
  superseded_at   timestamptz,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);
CREATE UNIQUE INDEX mandate_live ON mandate (wallet_id) WHERE superseded_at IS NULL;
CREATE TRIGGER mandate_set_once BEFORE UPDATE OR DELETE ON mandate
  FOR EACH ROW EXECUTE FUNCTION allow_set_once('approved_by', 'approved_at', 'superseded_at');

-- One review of one submission. An appeal is a NEW case pointing at the
-- rejected one. Decision columns are set once.
CREATE TABLE verification_case (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id        uuid NOT NULL REFERENCES wallet(id),
  evidence         uuid[] NOT NULL CHECK (cardinality(evidence) > 0),
  submitted_by     uuid NOT NULL REFERENCES person(id),
  submitted_at     timestamptz NOT NULL,
  appeal_of        uuid UNIQUE REFERENCES verification_case(id),
  appeal_reason    text CHECK (appeal_reason IS NULL OR length(appeal_reason) <= 2000),
  reviewer         uuid REFERENCES person(id),
  checklist        jsonb,
  outcome          text CHECK (outcome IN ('APPROVED', 'REJECTED', 'MORE_INFO')),
  reason_code      text CHECK (reason_code IN
                     ('EVIDENCE_SUFFICIENT', 'MISSING_EVIDENCE', 'IDENTITY_MISMATCH', 'AUTHORITY_NOT_SHOWN',
                      'EVIDENCE_NOT_AUTHENTIC', 'DETAILS_INCONSISTENT', 'DUPLICATE_WALLET', 'OTHER')),
  notes            text CHECK (notes IS NULL OR length(notes) <= 2000),
  decided_at       timestamptz,
  escalated_at     timestamptz,
  escalation_note  text,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((appeal_of IS NULL) = (appeal_reason IS NULL)),
  CHECK ((outcome IS NULL) = (decided_at IS NULL)),
  CHECK ((outcome IS NULL) = (reviewer IS NULL)),
  CHECK ((outcome IS NULL) = (reason_code IS NULL)),
  CHECK ((outcome IS NULL) = (checklist IS NULL)),
  CHECK (outcome IS NULL OR (outcome = 'APPROVED') = (reason_code = 'EVIDENCE_SUFFICIENT'))
);
CREATE UNIQUE INDEX verification_case_open ON verification_case (wallet_id) WHERE outcome IS NULL;
CREATE TRIGGER verification_case_set_once BEFORE UPDATE OR DELETE ON verification_case
  FOR EACH ROW EXECUTE FUNCTION allow_set_once(
    'reviewer', 'checklist', 'outcome', 'reason_code', 'notes', 'decided_at', 'escalated_at', 'escalation_note');

-- Reviewer ≠ submitter ≠ wallet creator, and holds no role on the wallet
-- (docs/05; agents cannot approve their own verification).
CREATE FUNCTION verification_case_reviewer_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reviewer IS NOT NULL AND OLD.reviewer IS NULL THEN
    IF NEW.reviewer = NEW.submitted_by
       OR EXISTS (SELECT 1 FROM wallet w WHERE w.id = NEW.wallet_id AND (w.created_by = NEW.reviewer OR w.admin_person = NEW.reviewer))
       OR EXISTS (SELECT 1 FROM wallet_role r WHERE r.wallet_id = NEW.wallet_id AND r.person_id = NEW.reviewer) THEN
      RAISE EXCEPTION 'verification_case: reviewer is party to the case' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER verification_case_reviewer_guard BEFORE UPDATE ON verification_case
  FOR EACH ROW EXECUTE FUNCTION verification_case_reviewer_guard();

-- Deterministic fraud findings (docs/11 FraudRules). A flag is a review task:
-- it never changes wallet status. dedupe_key makes re-evaluation idempotent.
CREATE TABLE fraud_flag (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id         uuid NOT NULL REFERENCES wallet(id),
  rule              text NOT NULL CHECK (rule IN
                      ('DUPLICATE_DECEASED', 'DUPLICATE_CERTIFICATE', 'ADMIN_MULTI_DEATH', 'CREATOR_VELOCITY')),
  matched_wallet_id uuid REFERENCES wallet(id),
  details           jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key        text NOT NULL UNIQUE,
  reviewed_by       uuid REFERENCES person(id),
  reviewed_at       timestamptz,
  review_outcome    text CHECK (review_outcome IN ('DISMISSED', 'CONFIRMED')),
  review_note       text,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL)),
  CHECK ((reviewed_by IS NULL) = (review_outcome IS NULL)),
  CHECK (review_outcome IS NULL OR length(btrim(coalesce(review_note, ''))) > 0)
);
CREATE INDEX fraud_flag_open ON fraud_flag (wallet_id) WHERE reviewed_at IS NULL;
CREATE TRIGGER fraud_flag_set_once BEFORE UPDATE OR DELETE ON fraud_flag
  FOR EACH ROW EXECUTE FUNCTION allow_set_once('reviewed_by', 'reviewed_at', 'review_outcome', 'review_note');

-- Fraud reports open a case (docs/05 Report-suspicious-wallet).
ALTER TABLE case_record DROP CONSTRAINT case_record_case_type_check;
ALTER TABLE case_record ADD CONSTRAINT case_record_case_type_check
  CHECK (case_type IN ('CHARGEBACK', 'REFUND', 'RECON', 'FRAUD'));

CREATE TABLE wallet_report (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id         uuid NOT NULL REFERENCES wallet(id),
  category          text NOT NULL CHECK (category IN ('FAKE_DEATH', 'NOT_FAMILY', 'DUPLICATE', 'SCAM', 'OTHER')),
  details           text CHECK (details IS NULL OR length(details) <= 1000),
  reporter_person   uuid REFERENCES person(id),
  reporter_ip_hash  text,
  case_id           uuid NOT NULL REFERENCES case_record(id),
  created_at        timestamptz NOT NULL
);
CREATE INDEX wallet_report_ip ON wallet_report (reporter_ip_hash, created_at);
CREATE TRIGGER wallet_report_no_update_delete BEFORE UPDATE OR DELETE ON wallet_report
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();
