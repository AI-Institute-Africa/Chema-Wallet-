-- P07: payouts, governance, disputes, holds, refunds/cancellation, closure
-- (docs/08, docs/02 dual approval). Every rule is enforced twice: typed errors
-- in @chema/payouts before any write, and the triggers below.

-- ── 0. Generic row guard ────────────────────────────────────────────────────
-- state_guard(state_col, 'A>B,B>C', '=setonce_col', '~mutable_col', ...)
-- DELETE denied; the state column may only follow the listed transitions;
-- '=col' may be set once (null → value); '~col' may change freely; every
-- other column is frozen.
CREATE FUNCTION state_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o          jsonb;
  n          jsonb;
  state_col  text := TG_ARGV[0];
  allowed    text := ',' || TG_ARGV[1] || ',';
  arg        text;
  col        text;
  i          int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'table %: DELETE denied', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  o := to_jsonb(OLD) - 'updated_at';
  n := to_jsonb(NEW) - 'updated_at';
  IF (o ->> state_col) IS DISTINCT FROM (n ->> state_col) THEN
    IF position(',' || (o ->> state_col) || '>' || (n ->> state_col) || ',' IN allowed) = 0 THEN
      RAISE EXCEPTION '%: illegal transition % -> %', TG_TABLE_NAME, o ->> state_col, n ->> state_col
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  o := o - state_col;
  n := n - state_col;
  FOR i IN 2 .. TG_NARGS - 1 LOOP
    arg := TG_ARGV[i];
    col := substr(arg, 2);
    IF left(arg, 1) = '=' AND (o -> col) <> 'null'::jsonb AND (o -> col) IS DISTINCT FROM (n -> col) THEN
      RAISE EXCEPTION 'column %.% is set-once', TG_TABLE_NAME, col USING ERRCODE = 'insufficient_privilege';
    END IF;
    o := o - col;
    n := n - col;
  END LOOP;
  IF o IS DISTINCT FROM n THEN
    RAISE EXCEPTION 'table %: only listed columns may change', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- ── 1. Approval escalation (docs/02: unavailable approver ⇒ escalation, not bypass)
ALTER TABLE approval
  ADD COLUMN escalated_at       timestamptz,
  ADD COLUMN escalated_by       uuid REFERENCES person(id),
  ADD COLUMN escalated_to       text CHECK (escalated_to IN ('OPS_FINANCE', 'FIDELITY_ADMIN')),
  ADD COLUMN escalation_reason  text CHECK (escalation_reason IS NULL OR length(escalation_reason) <= 500);
ALTER TABLE approval ADD CONSTRAINT approval_escalation_pair CHECK (
  (escalated_at IS NULL) = (escalated_by IS NULL) AND (escalated_at IS NULL) = (escalated_to IS NULL)
  AND (escalated_at IS NULL) = (escalation_reason IS NULL));
-- Only an undecided approval can be escalated: enforced by the escalate
-- UPDATE (WHERE decision IS NULL); timestamps come from different clocks
-- (decided_at = db now(), escalated_at = service clock), so no CHECK on them.
DROP TRIGGER approval_set_once ON approval;
CREATE TRIGGER approval_set_once
  BEFORE UPDATE OR DELETE ON approval
  FOR EACH ROW EXECUTE FUNCTION allow_set_once('checker_id', 'checker_role', 'decision', 'reason_code', 'decided_at', 'consumed_at',
    'escalated_at', 'escalated_by', 'escalated_to', 'escalation_reason');

-- ── 2. Mandate changes: admin replacement, approvers (dual + verifier re-check)
CREATE TABLE mandate_change (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id             uuid NOT NULL REFERENCES wallet(id),
  kind                  text NOT NULL CHECK (kind IN ('REPLACE_ADMIN', 'ADD_APPROVER', 'REMOVE_APPROVER')),
  old_admin_person      uuid REFERENCES person(id),
  new_admin_person      uuid REFERENCES person(id),
  approver_person       uuid REFERENCES person(id),
  reason                text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
  evidence_docs         uuid[] NOT NULL CHECK (cardinality(evidence_docs) > 0),
  requested_by          uuid NOT NULL REFERENCES person(id),
  requested_at          timestamptz NOT NULL,
  approval_id           uuid NOT NULL UNIQUE REFERENCES approval(id),
  status                text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'EXECUTED', 'REJECTED', 'CANCELLED')),
  verifier_id           uuid REFERENCES person(id),
  verifier_outcome      text CHECK (verifier_outcome IN ('APPROVED', 'REJECTED')),
  verifier_reason_code  text CHECK (verifier_reason_code IN
                          ('AUTHORITY_SHOWN', 'AUTHORITY_NOT_SHOWN', 'IDENTITY_MISMATCH', 'EVIDENCE_NOT_AUTHENTIC', 'DISPUTED', 'OTHER')),
  verifier_note         text CHECK (verifier_note IS NULL OR length(verifier_note) <= 2000),
  verified_at           timestamptz,
  closed_at             timestamptz,
  close_reason          text,
  executed_txid         bigint,
  new_mandate_id        uuid REFERENCES mandate(id),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'REPLACE_ADMIN' OR (old_admin_person IS NOT NULL AND new_admin_person IS NOT NULL
                                      AND old_admin_person <> new_admin_person AND approver_person IS NULL)),
  CHECK (kind = 'REPLACE_ADMIN' OR (approver_person IS NOT NULL AND old_admin_person IS NULL AND new_admin_person IS NULL)),
  CHECK ((verifier_outcome IS NULL) = (verifier_id IS NULL)),
  CHECK ((verifier_outcome IS NULL) = (verified_at IS NULL)),
  CHECK ((verifier_outcome IS NULL) = (verifier_reason_code IS NULL)),
  CHECK (verifier_outcome IS NULL OR (verifier_outcome = 'APPROVED') = (verifier_reason_code = 'AUTHORITY_SHOWN')),
  CHECK ((status = 'PENDING') = (closed_at IS NULL)),
  CHECK ((closed_at IS NULL) = (close_reason IS NULL)),
  CHECK (status <> 'EXECUTED' OR (verifier_outcome = 'APPROVED' AND executed_txid IS NOT NULL))
);
CREATE UNIQUE INDEX mandate_change_open ON mandate_change (wallet_id) WHERE status = 'PENDING';
CREATE TRIGGER mandate_change_guard BEFORE UPDATE OR DELETE ON mandate_change
  FOR EACH ROW EXECUTE FUNCTION state_guard('status', 'PENDING>EXECUTED,PENDING>REJECTED,PENDING>CANCELLED',
    '=verifier_id', '=verifier_outcome', '=verifier_reason_code', '=verifier_note', '=verified_at',
    '=closed_at', '=close_reason', '=executed_txid', '=new_mandate_id');

-- The re-checking verifier is not a party: not the requester, not the wallet
-- creator, not the old/new admin, no role on the wallet.
CREATE FUNCTION mandate_change_verifier_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.verifier_id IS NOT NULL AND OLD.verifier_id IS NULL THEN
    IF NEW.verifier_id = NEW.requested_by
       OR NEW.verifier_id IN (COALESCE(NEW.old_admin_person, NEW.requested_by), COALESCE(NEW.new_admin_person, NEW.requested_by),
                              COALESCE(NEW.approver_person, NEW.requested_by))
       OR EXISTS (SELECT 1 FROM wallet w WHERE w.id = NEW.wallet_id AND (w.created_by = NEW.verifier_id OR w.admin_person = NEW.verifier_id))
       OR EXISTS (SELECT 1 FROM wallet_role r WHERE r.wallet_id = NEW.wallet_id AND r.person_id = NEW.verifier_id AND r.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'mandate_change: verifier is party to the change' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mandate_change_verifier_guard BEFORE UPDATE ON mandate_change
  FOR EACH ROW EXECUTE FUNCTION mandate_change_verifier_guard();

-- ── 3. wallet_guard: admin_person may change only inside the transaction that
-- executes an approved, re-checked REPLACE_ADMIN; SUSPENDED → CLOSING (cancel).
CREATE OR REPLACE FUNCTION wallet_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wallet: DELETE denied' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.created_by <> OLD.created_by OR NEW.created_by_kind <> OLD.created_by_kind
     OR NEW.created_at <> OLD.created_at OR NEW.source_channel <> OLD.source_channel OR NEW.currency <> OLD.currency THEN
    RAISE EXCEPTION 'wallet: immutable column changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.admin_person <> OLD.admin_person AND NOT EXISTS (
       SELECT 1 FROM mandate_change mc
        WHERE mc.wallet_id = NEW.id AND mc.kind = 'REPLACE_ADMIN' AND mc.status = 'EXECUTED'
          AND mc.old_admin_person = OLD.admin_person AND mc.new_admin_person = NEW.admin_person
          AND mc.verifier_outcome = 'APPROVED' AND mc.executed_txid = txid_current()
          AND EXISTS (SELECT 1 FROM approval a WHERE a.id = mc.approval_id AND a.decision = 'APPROVED' AND a.consumed_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'wallet: admin_person changes only through an executed admin replacement'
      USING ERRCODE = 'insufficient_privilege';
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
    OR (OLD.status = 'SUSPENDED' AND NEW.status IN ('ACTIVE', 'CLOSING'))
    OR (OLD.status = 'CLOSING' AND NEW.status = 'CLOSED')) THEN
    RAISE EXCEPTION 'wallet: illegal transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  -- Closing needs a closure record (preconditions are checked in the same tx).
  IF NEW.status = 'CLOSED' AND OLD.status <> 'CLOSED' AND NOT EXISTS (
       SELECT 1 FROM wallet_closure c WHERE c.wallet_id = NEW.id AND c.closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'wallet: CLOSED needs a completed wallet_closure' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ── 4. Payees (manual entry + provider name check + dual approval) ─────────
CREATE TABLE payee (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id           uuid NOT NULL REFERENCES wallet(id),
  label               text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  holder_name         text NOT NULL CHECK (length(btrim(holder_name)) BETWEEN 1 AND 120),
  -- The person the payee belongs to, when it is a person (benefit recipient rule).
  person_id           uuid REFERENCES person(id),
  rail                text NOT NULL CHECK (rail IN ('ECOCASH', 'ONEMONEY')),
  destination_sealed  text NOT NULL,
  destination_hash    text NOT NULL CHECK (destination_hash ~ '^[0-9a-f]{64}$'),
  destination_masked  text NOT NULL CHECK (length(destination_masked) BETWEEN 4 AND 20),
  status              text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'REJECTED', 'RETIRED')),
  verification        text CHECK (verification IN ('MATCH', 'MISMATCH', 'UNAVAILABLE')),
  verified_at         timestamptz,
  approval_id         uuid NOT NULL UNIQUE REFERENCES approval(id),
  replaces_payee      uuid REFERENCES payee(id),
  created_by          uuid NOT NULL REFERENCES person(id),
  created_at          timestamptz NOT NULL,
  activated_at        timestamptz,
  closed_at           timestamptz,
  close_reason        text,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((verification IS NULL) = (verified_at IS NULL)),
  CHECK (status <> 'ACTIVE' OR (verification = 'MATCH' AND activated_at IS NOT NULL)),
  CHECK ((status IN ('REJECTED', 'RETIRED')) = (closed_at IS NOT NULL)),
  CHECK ((closed_at IS NULL) = (close_reason IS NULL))
);
CREATE UNIQUE INDEX payee_live_destination ON payee (wallet_id, destination_hash) WHERE status IN ('PENDING', 'ACTIVE');
CREATE TRIGGER payee_guard BEFORE UPDATE OR DELETE ON payee
  FOR EACH ROW EXECUTE FUNCTION state_guard('status', 'PENDING>ACTIVE,PENDING>REJECTED,ACTIVE>RETIRED',
    '~verification', '~verified_at', '=activated_at', '=closed_at', '=close_reason');

-- ── 5. Payout plans + requests ──────────────────────────────────────────────
CREATE TABLE payout_plan (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id         uuid NOT NULL REFERENCES wallet(id),
  source_kind       text NOT NULL CHECK (source_kind IN ('COMMUNITY', 'FIDELITY_BENEFIT', 'GROUP')),
  source_qualifier  text,
  currency          text NOT NULL CHECK (currency IN ('USD', 'ZWG')),
  total_minor       bigint NOT NULL CHECK (total_minor > 0),
  parts             integer NOT NULL CHECK (parts BETWEEN 1 AND 10),
  idempotency_key   text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash      text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_by        uuid NOT NULL REFERENCES person(id),
  created_at        timestamptz NOT NULL,
  CHECK ((source_kind = 'GROUP') = (source_qualifier IS NOT NULL))
);
CREATE TRIGGER payout_plan_append_only BEFORE UPDATE OR DELETE ON payout_plan
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TABLE payout_request (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id             uuid NOT NULL REFERENCES wallet(id),
  plan_id               uuid NOT NULL REFERENCES payout_plan(id),
  part_no               integer NOT NULL CHECK (part_no BETWEEN 1 AND 10),
  payee_id              uuid NOT NULL REFERENCES payee(id),
  purpose               text NOT NULL CHECK (purpose IN ('PARLOUR', 'TRANSPORT', 'FOOD', 'CHURCH', 'FAMILY_BENEFICIARY', 'OTHER_APPROVED')),
  purpose_note          text CHECK (purpose_note IS NULL OR length(purpose_note) <= 500),
  source_kind           text NOT NULL CHECK (source_kind IN ('COMMUNITY', 'FIDELITY_BENEFIT', 'GROUP')),
  source_qualifier      text,
  account_id            uuid NOT NULL REFERENCES ledger_account(id),
  currency              text NOT NULL CHECK (currency IN ('USD', 'ZWG')),
  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),
  rail                  text NOT NULL,
  requested_by          uuid NOT NULL REFERENCES person(id),
  requested_at          timestamptz NOT NULL,
  reservation_id        uuid NOT NULL UNIQUE REFERENCES ledger_reservation(id),
  -- One approval per plan (shared by its parts); null when no checker was
  -- needed (plan total ≤ approvals.payout_high_value_minor).
  approval_id           uuid REFERENCES approval(id),
  status                text NOT NULL CHECK (status IN
                          ('AWAITING_APPROVAL', 'APPROVED', 'SUBMITTING', 'SUBMITTED', 'RETRY', 'RAIL_DOWN',
                           'OVERRIDE_PENDING', 'CONFIRMED', 'FAILED', 'REJECTED', 'CANCELLED', 'REVERSED')),
  attempts              integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at       timestamptz,
  lease_until           timestamptz,
  provider_ref          text CHECK (provider_ref IS NULL OR length(provider_ref) BETWEEN 1 AND 128),
  submitted_at          timestamptz,
  last_error            text,
  confirmed_at          timestamptz,
  payout_journal_id     uuid UNIQUE REFERENCES ledger_journal(id),
  override_approval_id  uuid UNIQUE REFERENCES approval(id),
  override_ref          text CHECK (override_ref IS NULL OR length(override_ref) BETWEEN 3 AND 128),
  override_doc          uuid REFERENCES document(id),
  reversal_journal_id   uuid UNIQUE REFERENCES ledger_journal(id),
  closed_at             timestamptz,
  close_reason          text,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, part_no),
  CHECK ((source_kind = 'GROUP') = (source_qualifier IS NOT NULL)),
  CHECK ((status IN ('CONFIRMED', 'REVERSED')) = (payout_journal_id IS NOT NULL)),
  CHECK ((status = 'REVERSED') = (reversal_journal_id IS NOT NULL)),
  CHECK ((payout_journal_id IS NULL) = (confirmed_at IS NULL)),
  CHECK ((status IN ('CONFIRMED', 'FAILED', 'REJECTED', 'CANCELLED', 'REVERSED')) = (closed_at IS NOT NULL)),
  CHECK ((closed_at IS NULL) = (close_reason IS NULL)),
  CHECK ((override_ref IS NULL) = (override_approval_id IS NULL))
);
CREATE INDEX payout_request_due ON payout_request (next_attempt_at) WHERE status IN ('APPROVED', 'RETRY', 'SUBMITTED', 'SUBMITTING');
CREATE INDEX payout_request_wallet ON payout_request (wallet_id, requested_at);
CREATE INDEX payout_request_approval ON payout_request (approval_id) WHERE approval_id IS NOT NULL;
CREATE TRIGGER payout_request_10_guard BEFORE UPDATE OR DELETE ON payout_request
  FOR EACH ROW EXECUTE FUNCTION state_guard('status',
    'AWAITING_APPROVAL>APPROVED,AWAITING_APPROVAL>REJECTED,AWAITING_APPROVAL>CANCELLED,APPROVED>SUBMITTING,APPROVED>CANCELLED,SUBMITTING>SUBMITTED,SUBMITTING>RETRY,SUBMITTING>FAILED,SUBMITTED>CONFIRMED,SUBMITTED>FAILED,SUBMITTED>RETRY,RETRY>SUBMITTING,RETRY>RAIL_DOWN,RETRY>CANCELLED,RAIL_DOWN>SUBMITTING,RAIL_DOWN>OVERRIDE_PENDING,RAIL_DOWN>CANCELLED,OVERRIDE_PENDING>CONFIRMED,OVERRIDE_PENDING>RAIL_DOWN,CONFIRMED>REVERSED',
    '~attempts', '~next_attempt_at', '~lease_until', '~provider_ref', '~submitted_at', '~last_error',
    '=confirmed_at', '=payout_journal_id', '~override_approval_id', '~override_ref', '~override_doc',
    '=reversal_journal_id', '=closed_at', '=close_reason');

-- Money facts the row may claim: a confirmed payout is the PAYOUT journal that
-- consumed this request's reservation; a closed, unpaid request has released it.
CREATE FUNCTION payout_request_money_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payout_journal_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.payout_journal_id IS NULL) THEN
    IF NOT EXISTS (SELECT 1 FROM ledger_reservation r JOIN ledger_journal j ON j.id = r.consumed_journal_id
                    WHERE r.id = NEW.reservation_id AND r.consumed_journal_id = NEW.payout_journal_id AND j.kind = 'PAYOUT') THEN
      RAISE EXCEPTION 'payout_request: journal does not pay this reservation' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.status IN ('FAILED', 'REJECTED', 'CANCELLED') AND NOT EXISTS (
       SELECT 1 FROM ledger_reservation r WHERE r.id = NEW.reservation_id AND r.released_at IS NOT NULL) THEN
    RAISE EXCEPTION 'payout_request: % needs the reservation released', NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reversal_journal_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.reversal_journal_id IS NULL) THEN
    IF NOT EXISTS (SELECT 1 FROM ledger_journal j WHERE j.id = NEW.reversal_journal_id AND j.reverses_journal_id = NEW.payout_journal_id) THEN
      RAISE EXCEPTION 'payout_request: reversal does not reverse the payout journal' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payout_request_20_money_guard BEFORE INSERT OR UPDATE ON payout_request
  FOR EACH ROW EXECUTE FUNCTION payout_request_money_guard();

-- Source restrictions (docs/08 checks): the payee is ACTIVE on the same wallet,
-- the reserved account is that source of that wallet, and a Fidelity benefit
-- goes only to the approved recipient on an approved WALLET route.
CREATE FUNCTION payout_request_source_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p  payee%ROWTYPE;
BEGIN
  SELECT * INTO p FROM payee WHERE id = NEW.payee_id;
  IF p.wallet_id IS DISTINCT FROM NEW.wallet_id OR p.status <> 'ACTIVE' OR p.rail <> NEW.rail THEN
    RAISE EXCEPTION 'payout_request: payee not active on this wallet/rail' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ledger_account a WHERE a.id = NEW.account_id AND a.wallet_id = NEW.wallet_id
                   AND a.kind = NEW.source_kind AND a.currency = NEW.currency
                   AND a.qualifier IS NOT DISTINCT FROM NEW.source_qualifier) THEN
    RAISE EXCEPTION 'payout_request: account is not the stated source' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ledger_reservation r WHERE r.id = NEW.reservation_id AND r.account_id = NEW.account_id
                   AND r.amount_minor = NEW.amount_minor AND r.ref_type = 'payout_request' AND r.ref_id = NEW.id::text) THEN
    RAISE EXCEPTION 'payout_request: reservation does not match' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.source_kind = 'FIDELITY_BENEFIT' AND NOT EXISTS (
       SELECT 1 FROM fidelity_link l WHERE l.wallet_id = NEW.wallet_id AND l.route_status = 'APPROVED'
          AND l.route_kind = 'WALLET' AND l.approved_recipient IS NOT NULL AND l.approved_recipient = p.person_id) THEN
    RAISE EXCEPTION 'payout_request: benefit only to the approved recipient' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payout_request_30_source_guard BEFORE INSERT ON payout_request
  FOR EACH ROW EXECUTE FUNCTION payout_request_source_guard();

CREATE TABLE payout_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id    uuid NOT NULL REFERENCES payout_request(id),
  from_status  text,
  to_status    text NOT NULL,
  actor_id     text NOT NULL,
  actor_role   text NOT NULL,
  reason_code  text,
  detail       text CHECK (detail IS NULL OR length(detail) <= 1000),
  ts           timestamptz NOT NULL
);
CREATE INDEX payout_event_payout ON payout_event (payout_id, ts);
CREATE TRIGGER payout_event_append_only BEFORE UPDATE OR DELETE ON payout_event
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- ── 6. Case workflow on case_record ────────────────────────────────────────
DROP TRIGGER case_record_set_once ON case_record;
ALTER TABLE case_record DROP CONSTRAINT case_record_case_type_check;
ALTER TABLE case_record ADD CONSTRAINT case_record_case_type_check CHECK (case_type IN
  ('CHARGEBACK', 'REFUND', 'RECON', 'FRAUD', 'BENEFICIARY_MISMATCH', 'AUTHORITY_DISPUTE', 'PAYMENT_DISPUTE', 'PROVIDER_DISPUTE'));
ALTER TABLE case_record
  ADD COLUMN status             text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ASSIGNED', 'ESCALATED', 'RESOLVED')),
  ADD COLUMN severity           text NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
  ADD COLUMN assignee_id        uuid REFERENCES person(id),
  ADD COLUMN sla_due_at         timestamptz,
  ADD COLUMN escalation_level   integer NOT NULL DEFAULT 0 CHECK (escalation_level >= 0),
  ADD COLUMN source_kind        text CHECK (source_kind IN ('COMMUNITY', 'FIDELITY_BENEFIT', 'GROUP')),
  ADD COLUMN source_qualifier   text,
  ADD COLUMN amount_minor       bigint CHECK (amount_minor IS NULL OR amount_minor > 0),
  ADD COLUMN currency           text CHECK (currency IN ('USD', 'ZWG')),
  ADD COLUMN payout_request_id  uuid REFERENCES payout_request(id),
  ADD COLUMN evidence_docs      uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN outcome            text CHECK (outcome IN
                                  ('UPHELD', 'NOT_UPHELD', 'WITHDRAWN', 'SETTLED_BY_AGREEMENT', 'REFERRED_LEGAL', 'DUPLICATE', 'OTHER')),
  ADD COLUMN outcome_note       text CHECK (outcome_note IS NULL OR length(outcome_note) <= 2000);
UPDATE case_record SET status = 'RESOLVED' WHERE closed_at IS NOT NULL;
UPDATE case_record SET sla_due_at = opened_at + interval '72 hours' WHERE sla_due_at IS NULL;
ALTER TABLE case_record ADD CONSTRAINT case_record_resolved_closed CHECK ((status = 'RESOLVED') = (closed_at IS NOT NULL));
ALTER TABLE case_record ADD CONSTRAINT case_record_amount_pair CHECK ((amount_minor IS NULL) = (currency IS NULL));
ALTER TABLE case_record ADD CONSTRAINT case_record_assigned CHECK (status <> 'ASSIGNED' OR assignee_id IS NOT NULL);

-- SLA per case type (D09 unresolved: code defaults, see PROGRESS Assumptions).
CREATE FUNCTION case_sla_hours(t text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE t
    WHEN 'FRAUD' THEN 24
    WHEN 'AUTHORITY_DISPUTE' THEN 72
    WHEN 'PAYMENT_DISPUTE' THEN 72
    WHEN 'RECON' THEN 72
    WHEN 'REFUND' THEN 120
    ELSE 168 END
$$;
CREATE FUNCTION case_record_defaults() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.sla_due_at IS NULL THEN
      NEW.sla_due_at := NEW.opened_at + make_interval(hours => case_sla_hours(NEW.case_type));
    END IF;
  ELSIF NEW.closed_at IS NOT NULL AND OLD.closed_at IS NULL THEN
    -- Older callers (payments/fidelity closeCase) close by setting closed_at only.
    NEW.status := 'RESOLVED';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER case_record_10_defaults BEFORE INSERT OR UPDATE ON case_record
  FOR EACH ROW EXECUTE FUNCTION case_record_defaults();
ALTER TABLE case_record ALTER COLUMN sla_due_at SET NOT NULL;
CREATE TRIGGER case_record_20_guard BEFORE UPDATE OR DELETE ON case_record
  FOR EACH ROW EXECUTE FUNCTION state_guard('status',
    'OPEN>ASSIGNED,OPEN>ESCALATED,OPEN>RESOLVED,ASSIGNED>ESCALATED,ASSIGNED>RESOLVED,ESCALATED>ASSIGNED,ESCALATED>RESOLVED',
    '~assignee_id', '~sla_due_at', '~escalation_level', '~severity', '~evidence_docs',
    '=closed_at', '=closed_by', '=close_reason', '=outcome', '=outcome_note');
CREATE INDEX case_record_open ON case_record (sla_due_at) WHERE closed_at IS NULL;
CREATE INDEX case_record_wallet ON case_record (wallet_id) WHERE closed_at IS NULL;

CREATE TABLE case_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      uuid NOT NULL REFERENCES case_record(id),
  kind         text NOT NULL CHECK (kind IN ('OPENED', 'ASSIGNED', 'ESCALATED', 'NOTE', 'EVIDENCE', 'HOLD_PLACED',
                                             'HOLD_RELEASED', 'RESOLVED')),
  actor_id     text NOT NULL,
  actor_role   text NOT NULL,
  reason_code  text,
  note         text CHECK (note IS NULL OR length(note) <= 2000),
  ref_id       text,
  ts           timestamptz NOT NULL
);
CREATE INDEX case_event_case ON case_event (case_id, ts);
CREATE TRIGGER case_event_append_only BEFORE UPDATE OR DELETE ON case_event
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- ── 7. Holds: case link + dual-approved release ─────────────────────────────
ALTER TABLE hold
  ADD COLUMN case_id              uuid REFERENCES case_record(id),
  ADD COLUMN note                 text CHECK (note IS NULL OR length(note) <= 2000),
  ADD COLUMN release_approval_id  uuid UNIQUE REFERENCES approval(id);
DROP TRIGGER hold_set_once ON hold;
CREATE TRIGGER hold_set_once
  BEFORE UPDATE OR DELETE ON hold
  FOR EACH ROW EXECUTE FUNCTION allow_set_once('released_at', 'released_by', 'release_reason', 'release_approval_id', 'case_id', 'note');

-- ── 8. Recon exceptions: ageing/escalation (monotonic) ─────────────────────
DROP TRIGGER recon_exception_set_once ON recon_exception;
CREATE FUNCTION recon_exception_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' AND NEW.escalation_level < OLD.escalation_level THEN
    RAISE EXCEPTION 'recon_exception: escalation_level only rises' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.sla_due_at IS DISTINCT FROM OLD.sla_due_at AND NEW.escalation_level = OLD.escalation_level THEN
    RAISE EXCEPTION 'recon_exception: sla changes only with an escalation' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER recon_exception_10_escalation BEFORE UPDATE ON recon_exception
  FOR EACH ROW EXECUTE FUNCTION recon_exception_guard();
CREATE TRIGGER recon_exception_20_set_once
  BEFORE UPDATE OR DELETE ON recon_exception
  FOR EACH ROW EXECUTE FUNCTION state_guard('kind', '',
    '=owner_person_id', '=resolved_at', '=resolved_by', '=resolution', '~escalation_level', '~sla_due_at');

-- ── 9. Closure / cancellation + statements ─────────────────────────────────
CREATE TABLE wallet_closure (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id        uuid NOT NULL UNIQUE REFERENCES wallet(id),
  kind             text NOT NULL CHECK (kind IN ('CLOSE', 'CANCEL')),
  reason_code      text NOT NULL CHECK (reason_code IN
                     ('FUNERAL_COMPLETED', 'FAMILY_REQUEST', 'FRAUD_CONFIRMED', 'CREATED_IN_ERROR', 'DUPLICATE', 'OTHER')),
  note             text CHECK (note IS NULL OR length(note) <= 2000),
  requested_by     uuid NOT NULL REFERENCES person(id),
  requested_at     timestamptz NOT NULL,
  refund_case_id   uuid REFERENCES case_record(id),
  closed_at        timestamptz,
  closed_by        uuid REFERENCES person(id),
  thanked_at       timestamptz,
  thanked_by       uuid REFERENCES person(id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((closed_at IS NULL) = (closed_by IS NULL)),
  CHECK ((thanked_at IS NULL) = (thanked_by IS NULL)),
  CHECK (kind <> 'CANCEL' OR refund_case_id IS NOT NULL)
);
CREATE TRIGGER wallet_closure_set_once BEFORE UPDATE OR DELETE ON wallet_closure
  FOR EACH ROW EXECUTE FUNCTION allow_set_once('closed_at', 'closed_by', 'thanked_at', 'thanked_by');

CREATE TABLE wallet_statement (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id     uuid NOT NULL REFERENCES wallet(id),
  kind          text NOT NULL CHECK (kind IN ('FAMILY', 'AUDIT_PACK')),
  content       jsonb NOT NULL,
  content_hash  text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  generated_by  text NOT NULL,
  generated_at  timestamptz NOT NULL,
  UNIQUE (wallet_id, kind)
);
CREATE TRIGGER wallet_statement_append_only BEFORE UPDATE OR DELETE ON wallet_statement
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();
