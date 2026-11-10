-- P06: Fidelity policy & claims link (docs/07). Fidelity Claims is the system
-- of record for policies, claim decisions and benefit payments; Chema mirrors
-- what Fidelity reports and credits W:FIDELITY_BENEFIT only when the claim is
-- APPROVED, the recipient route is APPROVED and Fidelity records the benefit
-- payment as settled. Community money is never touched by anything here.

-- ── 1. Ledger: benefit clearing account + benefit source rules ─────────────
ALTER TABLE ledger_account DROP CONSTRAINT ledger_account_kind_check;
ALTER TABLE ledger_account ADD CONSTRAINT ledger_account_kind_check CHECK (kind IN
  ('COMMUNITY', 'FIDELITY_BENEFIT', 'GROUP',
   'PROVIDER_CLEARING', 'PAYOUT_CLEARING', 'FEES', 'REFUND_CLEARING', 'SUSPENSE_UNMATCHED', 'RECON_DIFF',
   'BENEFIT_CLEARING'));

-- Same rules as validateBenefitRules (packages/ledger/src/guards.ts):
--   1. a BENEFIT journal touches only FIDELITY_BENEFIT and BENEFIT_CLEARING;
--   2. FIDELITY_BENEFIT is credited only by BENEFIT/ADJUSTMENT journals (reversals exempt);
--   3. no journal with a FIDELITY_BENEFIT leg has a FEES leg (no fee on the benefit);
--   4. BENEFIT_CLEARING appears only in BENEFIT/SETTLEMENT/ADJUSTMENT journals.
CREATE FUNCTION ledger_benefit_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  j record;
BEGIN
  FOR j IN
    SELECT lj.id, lj.kind, lj.reverses_journal_id
      FROM ledger_journal lj
     WHERE lj.id IN (SELECT DISTINCT n.journal_id FROM new_rows n)
  LOOP
    IF j.kind = 'BENEFIT' AND EXISTS (
      SELECT 1 FROM new_rows n JOIN ledger_account a ON a.id = n.account_id
       WHERE n.journal_id = j.id AND a.kind NOT IN ('FIDELITY_BENEFIT', 'BENEFIT_CLEARING')
    ) THEN
      RAISE EXCEPTION 'ledger: BENEFIT journal % touches an account other than the benefit sub-ledger and its clearing', j.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF j.reverses_journal_id IS NULL AND j.kind NOT IN ('BENEFIT', 'ADJUSTMENT') AND EXISTS (
      SELECT 1 FROM new_rows n JOIN ledger_account a ON a.id = n.account_id
       WHERE n.journal_id = j.id AND a.kind = 'FIDELITY_BENEFIT'
       GROUP BY n.account_id
      HAVING sum(CASE n.side WHEN 'C' THEN n.amount_minor ELSE -n.amount_minor END) > 0
    ) THEN
      RAISE EXCEPTION 'ledger: journal % credits the Fidelity benefit without being a BENEFIT journal', j.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM new_rows n JOIN ledger_account a ON a.id = n.account_id
       WHERE n.journal_id = j.id AND a.kind = 'FIDELITY_BENEFIT'
    ) AND EXISTS (
      SELECT 1 FROM new_rows n JOIN ledger_account a ON a.id = n.account_id
       WHERE n.journal_id = j.id AND a.kind = 'FEES'
    ) THEN
      RAISE EXCEPTION 'ledger: journal % charges a fee on the Fidelity benefit', j.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF j.kind NOT IN ('BENEFIT', 'SETTLEMENT', 'ADJUSTMENT') AND EXISTS (
      SELECT 1 FROM new_rows n JOIN ledger_account a ON a.id = n.account_id
       WHERE n.journal_id = j.id AND a.kind = 'BENEFIT_CLEARING'
    ) THEN
      RAISE EXCEPTION 'ledger: journal % uses benefit clearing outside a benefit movement', j.id
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER ledger_entry_20_benefit_guard
  AFTER INSERT ON ledger_entry
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_benefit_guard();

-- ── 2. Cases + exceptions ───────────────────────────────────────────────────
ALTER TABLE case_record DROP CONSTRAINT case_record_case_type_check;
ALTER TABLE case_record ADD CONSTRAINT case_record_case_type_check
  CHECK (case_type IN ('CHARGEBACK', 'REFUND', 'RECON', 'FRAUD', 'BENEFICIARY_MISMATCH'));

ALTER TABLE recon_exception DROP CONSTRAINT recon_exception_kind_check;
ALTER TABLE recon_exception ADD CONSTRAINT recon_exception_kind_check CHECK (kind IN
  ('UNMATCHED_INCOMING', 'MISSING_SETTLEMENT', 'AMOUNT_VARIANCE', 'FEE_VARIANCE',
   'WRONG_DESTINATION', 'CHARGEBACK_SHORTFALL', 'POLL_WINDOW_EXPIRED', 'CURRENCY_MISMATCH',
   -- P06 benefit reconciliation against the Fidelity record (docs/04 §7, docs/07 Resilience).
   'BENEFIT_UNCREDITED', 'BENEFIT_AMOUNT_VARIANCE', 'BENEFIT_NOT_IN_RECORD',
   'BENEFIT_CURRENCY_MISMATCH', 'BENEFIT_STATE_CONFLICT'));

-- ── 3. fidelity_link: the claim path of one wallet ─────────────────────────
ALTER TABLE fidelity_link
  -- Approved lookup (consent + role gated). Only the outcome is kept, never covered lives.
  ADD COLUMN lookup_outcome   text CHECK (lookup_outcome IN
                                ('ELIGIBLE', 'NO_POLICY', 'INACTIVE', 'COVERED_LIFE_MISMATCH', 'ARREARS')),
  ADD COLUMN lookup_at        timestamptz,
  ADD COLUMN lookup_policy_no text CHECK (lookup_policy_no IS NULL OR length(lookup_policy_no) BETWEEN 1 AND 64),
  -- Idempotency key of the claim = sha256(wallet | policy | deceased). Set once.
  ADD COLUMN claim_key        text UNIQUE CHECK (claim_key IS NULL OR claim_key ~ '^[0-9a-f]{64}$'),
  ADD COLUMN link_state       text NOT NULL DEFAULT 'NONE' CHECK (link_state IN
                                ('NONE', 'QUEUED', 'LINKED', 'DUPLICATE_CLAIM', 'REJECTED')),
  ADD COLUMN link_error       text CHECK (link_error IS NULL OR link_error ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  -- Mapped reason for DECLINED / MORE_INFO (a code, never Fidelity free text).
  ADD COLUMN claim_reason     text CHECK (claim_reason IS NULL OR claim_reason ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  -- Who the family proposes should receive the benefit (never inferred from the admin role).
  ADD COLUMN proposed_recipient          uuid REFERENCES person(id),
  ADD COLUMN proposed_recipient_id_hash  text CHECK (proposed_recipient_id_hash IS NULL OR proposed_recipient_id_hash ~ '^[0-9a-f]{64}$'),
  -- Fidelity's approved recipient/payment route.
  ADD COLUMN route_kind          text CHECK (route_kind IN ('WALLET', 'DIRECT')),
  ADD COLUMN route_ref           text CHECK (route_ref IS NULL OR length(route_ref) BETWEEN 1 AND 128),
  ADD COLUMN route_approved_by   text[],
  ADD COLUMN approved_recipient  uuid REFERENCES person(id),
  ADD COLUMN mismatch_case_id    uuid REFERENCES case_record(id),
  ADD COLUMN mismatch_hold_id    uuid REFERENCES hold(id),
  ADD COLUMN route_approval_ref  uuid REFERENCES approval(id),
  ADD COLUMN external_approval_ref text CHECK (external_approval_ref IS NULL OR length(external_approval_ref) BETWEEN 3 AND 128),
  -- Benefit payment as recorded by Fidelity (amount comes from Fidelity, never hard-coded).
  ADD COLUMN benefit_minor           bigint CHECK (benefit_minor IS NULL OR benefit_minor > 0),
  ADD COLUMN benefit_currency        text CHECK (benefit_currency IS NULL OR benefit_currency IN ('USD', 'ZWG')),
  ADD COLUMN benefit_payment_ref     text CHECK (benefit_payment_ref IS NULL OR length(benefit_payment_ref) BETWEEN 1 AND 128),
  ADD COLUMN benefit_payment_status  text NOT NULL DEFAULT 'NONE' CHECK (benefit_payment_status IN
                                       ('NONE', 'PENDING', 'SETTLED', 'FAILED')),
  ADD COLUMN benefit_settled_on      date,
  ADD COLUMN benefit_journal_id      uuid UNIQUE REFERENCES ledger_journal(id),
  ADD COLUMN last_synced_at          timestamptz,
  ADD CONSTRAINT fidelity_link_benefit_amount CHECK ((benefit_minor IS NULL) = (benefit_currency IS NULL)),
  ADD CONSTRAINT fidelity_link_blocked_has_case CHECK
    (route_status <> 'BLOCKED_MISMATCH' OR (mismatch_case_id IS NOT NULL AND mismatch_hold_id IS NOT NULL)),
  ADD CONSTRAINT fidelity_link_recipient_pair CHECK ((proposed_recipient IS NULL) = (proposed_recipient_id_hash IS NULL)),
  ADD CONSTRAINT fidelity_link_claim_ref_linked CHECK (claim_ref IS NULL OR link_state = 'LINKED');

CREATE UNIQUE INDEX fidelity_link_claim_ref ON fidelity_link (claim_ref) WHERE claim_ref IS NOT NULL;

-- State rules (docs/07 §4 §5): set-once references, legal route transitions,
-- unblocking only with an approval, credit only when every condition holds.
CREATE FUNCTION fidelity_link_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fidelity_link: DELETE denied' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.wallet_id <> OLD.wallet_id OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'fidelity_link: identity columns are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.claim_ref IS NOT NULL AND NEW.claim_ref IS DISTINCT FROM OLD.claim_ref)
     OR (OLD.claim_key IS NOT NULL AND NEW.claim_key IS DISTINCT FROM OLD.claim_key)
     OR (OLD.benefit_journal_id IS NOT NULL AND NEW.benefit_journal_id IS DISTINCT FROM OLD.benefit_journal_id)
     OR (OLD.mismatch_case_id IS NOT NULL AND NEW.mismatch_case_id IS DISTINCT FROM OLD.mismatch_case_id)
     OR (OLD.mismatch_hold_id IS NOT NULL AND NEW.mismatch_hold_id IS DISTINCT FROM OLD.mismatch_hold_id)
     OR (OLD.route_approval_ref IS NOT NULL AND NEW.route_approval_ref IS DISTINCT FROM OLD.route_approval_ref)
     OR (OLD.approved_recipient IS NOT NULL AND NEW.approved_recipient IS DISTINCT FROM OLD.approved_recipient) THEN
    RAISE EXCEPTION 'fidelity_link: % is set once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  -- Once a claim is lodged, its policy and identifiers are frozen.
  IF OLD.claim_key IS NOT NULL AND (NEW.policy_no IS DISTINCT FROM OLD.policy_no
       OR NEW.national_id IS DISTINCT FROM OLD.national_id OR NEW.lookup_policy_no IS DISTINCT FROM OLD.lookup_policy_no
       OR NEW.proposed_recipient IS DISTINCT FROM OLD.proposed_recipient
       OR NEW.proposed_recipient_id_hash IS DISTINCT FROM OLD.proposed_recipient_id_hash) THEN
    RAISE EXCEPTION 'fidelity_link: claim details are frozen after lodging' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.route_status <> OLD.route_status AND NOT (
       (OLD.route_status = 'UNSET' AND NEW.route_status = 'PENDING_APPROVAL')
    OR (OLD.route_status = 'PENDING_APPROVAL' AND NEW.route_status IN ('APPROVED', 'BLOCKED_MISMATCH'))
    OR (OLD.route_status = 'BLOCKED_MISMATCH' AND NEW.route_status = 'APPROVED' AND NEW.route_approval_ref IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'fidelity_link: route % -> % not allowed', OLD.route_status, NEW.route_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.route_approval_ref IS NOT NULL AND OLD.route_approval_ref IS NULL AND NOT EXISTS (
    SELECT 1 FROM approval a
     WHERE a.id = NEW.route_approval_ref AND a.action = 'claim.route.unblock'
       AND a.decision = 'APPROVED' AND a.consumed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'fidelity_link: route approval % is not a consumed, approved unblock', NEW.route_approval_ref
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.benefit_journal_id IS NOT NULL AND OLD.benefit_journal_id IS NULL AND NOT (
       NEW.claim_status_mirror = 'APPROVED' AND NEW.route_status = 'APPROVED' AND NEW.route_kind = 'WALLET'
       AND NEW.benefit_payment_status = 'SETTLED'
       AND EXISTS (SELECT 1 FROM ledger_journal lj WHERE lj.id = NEW.benefit_journal_id
                      AND lj.kind = 'BENEFIT' AND lj.wallet_id = NEW.wallet_id)
  ) THEN
    RAISE EXCEPTION 'fidelity_link: benefit credited before claim + route approval + settlement'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER fidelity_link_guard
  BEFORE UPDATE OR DELETE ON fidelity_link
  FOR EACH ROW EXECUTE FUNCTION fidelity_link_guard();

-- Every change of the claim mirror, with the Fidelity record it came from.
-- source is always FIDELITY: no AI/OCR/agent input ever changes a claim status.
CREATE TABLE claim_status_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id      uuid NOT NULL REFERENCES fidelity_link(id),
  wallet_id    uuid NOT NULL REFERENCES wallet(id),
  from_status  text NOT NULL,
  to_status    text NOT NULL CHECK (to_status IN ('NONE', 'SUBMITTED', 'IN_REVIEW', 'MORE_INFO', 'APPROVED', 'DECLINED')),
  reason_code  text,
  source       text NOT NULL CHECK (source = 'FIDELITY'),
  ts           timestamptz NOT NULL
);
CREATE TRIGGER claim_status_event_append_only
  BEFORE UPDATE OR DELETE ON claim_status_event
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- Evidence shared with the claim: references to scanned wallet documents only.
CREATE TABLE claim_evidence (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id      uuid NOT NULL REFERENCES fidelity_link(id),
  document_id  uuid NOT NULL REFERENCES document(id),
  added_by     uuid NOT NULL REFERENCES person(id),
  added_at     timestamptz NOT NULL,
  UNIQUE (link_id, document_id)
);
CREATE TRIGGER claim_evidence_append_only
  BEFORE UPDATE OR DELETE ON claim_evidence
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- ── 4. Fidelity callbacks (signed, replay-protected) ───────────────────────
CREATE TABLE fidelity_event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        text NOT NULL UNIQUE CHECK (length(event_id) BETWEEN 1 AND 128),
  event_type      text NOT NULL,
  claim_ref       text,
  raw_body        text NOT NULL,
  signature_hash  text NOT NULL,
  received_at     timestamptz NOT NULL,
  processed_at    timestamptz,
  outcome         text
);
CREATE TRIGGER fidelity_event_set_once
  BEFORE UPDATE OR DELETE ON fidelity_event
  FOR EACH ROW EXECUTE FUNCTION allow_set_once('processed_at', 'outcome');

-- ── 5. Outbound call queue (docs/07 Resilience) ────────────────────────────
-- Every call to Fidelity that changes or refreshes the claim goes through a
-- row here: claim (tx) → call (no tx) → record (tx). Outage ⇒ RETRY with
-- backoff; the family sees "status updating" while one is open.
CREATE TABLE fidelity_request (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id          uuid NOT NULL REFERENCES fidelity_link(id),
  wallet_id        uuid NOT NULL REFERENCES wallet(id),
  kind             text NOT NULL CHECK (kind IN ('LINK_CLAIM', 'SUBMIT_EVIDENCE', 'SYNC')),
  dedupe_key       text NOT NULL UNIQUE CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RETRY', 'DONE', 'DEAD')),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz,
  last_error       text CHECK (last_error IS NULL OR length(last_error) <= 200),
  created_at       timestamptz NOT NULL,
  done_at          timestamptz,
  updated_at       timestamptz NOT NULL,
  CHECK (status NOT IN ('QUEUED', 'RETRY') OR next_attempt_at IS NOT NULL),
  CHECK ((status = 'DONE') = (done_at IS NOT NULL))
);
CREATE INDEX fidelity_request_due ON fidelity_request (next_attempt_at) WHERE status IN ('QUEUED', 'RETRY');
-- At most one open LINK_CLAIM and one open SYNC per link: repeated requests,
-- webhooks and the poller collapse into the open one.
CREATE UNIQUE INDEX fidelity_request_open ON fidelity_request (link_id, kind)
  WHERE kind IN ('LINK_CLAIM', 'SYNC') AND status IN ('QUEUED', 'RETRY');

CREATE FUNCTION fidelity_request_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fidelity_request: DELETE denied' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.link_id <> OLD.link_id OR NEW.wallet_id <> OLD.wallet_id OR NEW.kind <> OLD.kind
     OR NEW.dedupe_key <> OLD.dedupe_key OR NEW.payload <> OLD.payload OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'fidelity_request: identity columns are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('DONE', 'DEAD') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'fidelity_request: % is final', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fidelity_request_guard
  BEFORE UPDATE OR DELETE ON fidelity_request
  FOR EACH ROW EXECUTE FUNCTION fidelity_request_guard();
