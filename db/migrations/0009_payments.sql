-- P03: payments (collection), raw provider events, refunds, case stub, receipts,
-- fee schedule. See docs/04 §3–§6, §8.
-- wallet_id columns get their FK to wallet(id) in P04 when the wallet table lands.

-- Fee schedule (docs/04 §6, D08). Empty by default ⇒ zero fee, no fee copy.
CREATE TABLE fee_schedule (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rail             text NOT NULL CHECK (rail ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  currency         text NOT NULL CHECK (currency IN ('USD', 'ZWG')),
  fee_payer        text NOT NULL CHECK (fee_payer IN ('CONTRIBUTOR', 'WALLET')),
  fixed_minor      bigint NOT NULL DEFAULT 0 CHECK (fixed_minor >= 0),
  -- basis points (1/100 of a percent) — integer maths only.
  rate_bps         integer NOT NULL DEFAULT 0 CHECK (rate_bps BETWEEN 0 AND 10000),
  effective_from   timestamptz NOT NULL,
  approval_ref     uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fee_schedule_append_only
  BEFORE UPDATE OR DELETE ON fee_schedule
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- One collection attempt. State machine per docs/04 §3, enforced by
-- payment_guard below (and by the service before it writes).
CREATE TABLE payment (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id            uuid NOT NULL,
  credit_account_id    uuid NOT NULL REFERENCES ledger_account(id),
  rail                 text NOT NULL CHECK (rail ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  idempotency_key      text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_hash         text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  payer_person_id      uuid REFERENCES person(id),
  currency             text NOT NULL CHECK (currency IN ('USD', 'ZWG')),
  -- Disclosed before payment (docs/04 §6).
  gross_minor          bigint NOT NULL CHECK (gross_minor > 0),
  fee_minor            bigint NOT NULL CHECK (fee_minor >= 0),
  fee_payer            text CHECK (fee_payer IN ('CONTRIBUTOR', 'WALLET')),
  net_minor            bigint NOT NULL CHECK (net_minor > 0),
  fx_rate              text,
  settlement_currency  text NOT NULL CHECK (settlement_currency IN ('USD', 'ZWG')),
  state                text NOT NULL DEFAULT 'INITIATED' CHECK (state IN
                         ('INITIATED', 'PENDING_UNKNOWN', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'REFUNDED', 'CHARGED_BACK')),
  provider_ref         text CHECK (length(provider_ref) BETWEEN 1 AND 128),
  next_action          jsonb,
  failure_reason       text,
  -- Confirmed by the provider (authoritative); set together with the credit.
  confirmed_minor      bigint CHECK (confirmed_minor > 0),
  provider_fee_minor   bigint CHECK (provider_fee_minor >= 0),
  credited_gross_minor bigint CHECK (credited_gross_minor > 0),
  credit_journal_id    uuid UNIQUE REFERENCES ledger_journal(id),
  receipt_id           uuid UNIQUE,
  poll_attempts        integer NOT NULL DEFAULT 0 CHECK (poll_attempts >= 0),
  next_poll_at         timestamptz,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  UNIQUE (rail, provider_ref),
  CHECK (fee_minor < gross_minor),
  -- gross = total charged to the payer; fee_payer only changes how gross was derived.
  CHECK (net_minor = gross_minor - fee_minor),
  CHECK ((fee_minor = 0) = (fee_payer IS NULL)),
  -- Credited ⇔ reached a success state; a credit exists only with its confirmation.
  CHECK ((credit_journal_id IS NOT NULL) = (state IN ('SUCCEEDED', 'REFUNDED', 'CHARGED_BACK'))),
  CHECK ((credit_journal_id IS NULL) = (confirmed_minor IS NULL)),
  CHECK ((credit_journal_id IS NULL) = (credited_gross_minor IS NULL)),
  CHECK ((credit_journal_id IS NULL) = (receipt_id IS NULL)),
  CHECK (credited_gross_minor IS NULL OR credited_gross_minor <= gross_minor)
);
CREATE INDEX payment_due_poll ON payment (next_poll_at) WHERE state IN ('INITIATED', 'PENDING_UNKNOWN') AND next_poll_at IS NOT NULL;
CREATE INDEX payment_pending_account ON payment (credit_account_id) WHERE state IN ('INITIATED', 'PENDING_UNKNOWN');

-- Legal transitions (docs/04 §3). FAILED/EXPIRED are final: a late success for
-- them is unmatched money and goes through reconciliation, never a credit.
CREATE FUNCTION payment_transition_ok(old_state text, new_state text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT old_state = new_state OR (old_state, new_state) IN (
    ('INITIATED', 'PENDING_UNKNOWN'), ('INITIATED', 'SUCCEEDED'), ('INITIATED', 'FAILED'), ('INITIATED', 'EXPIRED'),
    ('PENDING_UNKNOWN', 'SUCCEEDED'), ('PENDING_UNKNOWN', 'FAILED'), ('PENDING_UNKNOWN', 'EXPIRED'),
    ('SUCCEEDED', 'REFUNDED'), ('SUCCEEDED', 'CHARGED_BACK'))
$$;

CREATE FUNCTION payment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment rows are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.wallet_id, NEW.credit_account_id, NEW.rail, NEW.idempotency_key, NEW.request_hash,
      NEW.payer_person_id, NEW.currency, NEW.gross_minor, NEW.fee_minor, NEW.fee_payer, NEW.net_minor,
      NEW.fx_rate, NEW.settlement_currency, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.wallet_id, OLD.credit_account_id, OLD.rail, OLD.idempotency_key, OLD.request_hash,
      OLD.payer_person_id, OLD.currency, OLD.gross_minor, OLD.fee_minor, OLD.fee_payer, OLD.net_minor,
      OLD.fx_rate, OLD.settlement_currency, OLD.created_at) THEN
    RAISE EXCEPTION 'payment %: request and disclosure columns are immutable', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT payment_transition_ok(OLD.state, NEW.state) THEN
    RAISE EXCEPTION 'payment %: illegal transition % -> %', OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  -- Set-once columns: the credit can be written once and never moved.
  IF (OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref)
     OR (OLD.credit_journal_id IS NOT NULL AND NEW.credit_journal_id IS DISTINCT FROM OLD.credit_journal_id)
     OR (OLD.confirmed_minor IS NOT NULL AND NEW.confirmed_minor IS DISTINCT FROM OLD.confirmed_minor)
     OR (OLD.credited_gross_minor IS NOT NULL AND NEW.credited_gross_minor IS DISTINCT FROM OLD.credited_gross_minor)
     OR (OLD.provider_fee_minor IS NOT NULL AND NEW.provider_fee_minor IS DISTINCT FROM OLD.provider_fee_minor)
     OR (OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS DISTINCT FROM OLD.receipt_id) THEN
    RAISE EXCEPTION 'payment %: confirmation columns are set-once', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The credit journal must be this payment's CONTRIBUTION journal.
  IF NEW.credit_journal_id IS NOT NULL AND OLD.credit_journal_id IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM ledger_journal j
                    WHERE j.id = NEW.credit_journal_id AND j.kind = 'CONTRIBUTION'
                      AND j.idempotency_key = 'payment:' || NEW.id || ':credit') THEN
      RAISE EXCEPTION 'payment %: credit journal is not this payment''s contribution', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.updated_at := greatest(NEW.updated_at, OLD.updated_at);
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_guard
  BEFORE UPDATE OR DELETE ON payment
  FOR EACH ROW EXECUTE FUNCTION payment_guard();

-- Every state change, appended (who/why/source).
CREATE TABLE payment_state_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id   uuid NOT NULL REFERENCES payment(id),
  from_state   text,
  to_state     text NOT NULL,
  source       text NOT NULL CHECK (source IN ('INITIATE', 'PROVIDER_SYNC', 'WEBHOOK', 'POLL', 'REFUND', 'CHARGEBACK')),
  event_id     uuid,
  detail       text,
  at           timestamptz NOT NULL
);
CREATE TRIGGER payment_state_log_append_only
  BEFORE UPDATE OR DELETE ON payment_state_log
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- Raw provider callbacks, stored before processing (docs/04 §4). The unique
-- (rail, provider_event_id) is the durable replay cache.
CREATE TABLE provider_event (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rail               text NOT NULL CHECK (rail ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  provider_event_id  text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 128),
  event_type         text NOT NULL,
  provider_ref       text,
  -- Normalised event as verified (re-verifying later would fail the time window).
  event              jsonb NOT NULL,
  raw_body           text NOT NULL,
  signature_hash     text NOT NULL CHECK (signature_hash ~ '^[0-9a-f]{64}$'),
  received_at        timestamptz NOT NULL,
  UNIQUE (rail, provider_event_id)
);
CREATE TRIGGER provider_event_append_only
  BEFORE UPDATE OR DELETE ON provider_event
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- Processing result; one row per event ⇒ a second delivery is a no-op.
CREATE TABLE provider_event_outcome (
  event_id      uuid PRIMARY KEY REFERENCES provider_event(id),
  outcome       text NOT NULL,
  payment_id    uuid REFERENCES payment(id),
  processed_at  timestamptz NOT NULL
);
CREATE TRIGGER provider_event_outcome_append_only
  BEFORE UPDATE OR DELETE ON provider_event_outcome
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- Case stub (P07 extends with workflow): chargebacks, refunds, recon follow-up.
CREATE TABLE case_record (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_type        text NOT NULL CHECK (case_type IN ('CHARGEBACK', 'REFUND', 'RECON')),
  wallet_id        uuid,
  payment_id       uuid REFERENCES payment(id),
  external_ref     text,
  summary          text NOT NULL,
  opened_by        text NOT NULL,
  opened_at        timestamptz NOT NULL,
  closed_at        timestamptz,
  closed_by        text,
  close_reason     text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_type, external_ref),
  CHECK ((closed_at IS NULL) = (closed_by IS NULL)),
  CHECK ((closed_at IS NULL) = (close_reason IS NULL))
);
CREATE TRIGGER case_record_set_once
  BEFORE UPDATE OR DELETE ON case_record
  FOR EACH ROW EXECUTE FUNCTION allow_set_once('closed_at', 'closed_by', 'close_reason');

-- Refund of (part of) a credited payment. COMPLETED only on provider confirmation.
CREATE TABLE refund (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id           uuid NOT NULL REFERENCES payment(id),
  case_id              uuid NOT NULL REFERENCES case_record(id),
  amount_minor         bigint NOT NULL CHECK (amount_minor > 0),
  currency             text NOT NULL CHECK (currency IN ('USD', 'ZWG')),
  reason               text NOT NULL,
  approval_ref         uuid NOT NULL REFERENCES approval(id),
  requested_by         text NOT NULL,
  debit_journal_id     uuid NOT NULL UNIQUE REFERENCES ledger_journal(id),
  provider_ref         text,
  completed_at         timestamptz,
  completion_journal_id uuid UNIQUE REFERENCES ledger_journal(id),
  failed_at            timestamptz,
  failure_reason       text,
  reversal_journal_id  uuid UNIQUE REFERENCES ledger_journal(id),
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (approval_ref),
  CHECK (completed_at IS NULL OR failed_at IS NULL),
  CHECK ((completed_at IS NULL) = (completion_journal_id IS NULL)),
  CHECK ((failed_at IS NULL) = (reversal_journal_id IS NULL)),
  CHECK ((failed_at IS NULL) = (failure_reason IS NULL))
);
CREATE TRIGGER refund_set_once
  BEFORE UPDATE OR DELETE ON refund
  FOR EACH ROW EXECUTE FUNCTION allow_set_once(
    'provider_ref', 'completed_at', 'completion_journal_id', 'failed_at', 'failure_reason', 'reversal_journal_id');

-- Chargeback / dispute on a credited payment (card mostly).
CREATE TABLE payment_dispute (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id           uuid NOT NULL REFERENCES payment(id),
  rail                 text NOT NULL,
  dispute_ref          text NOT NULL,
  case_id              uuid NOT NULL REFERENCES case_record(id),
  amount_minor         bigint NOT NULL CHECK (amount_minor > 0),
  hold_id              uuid REFERENCES hold(id),
  opened_at            timestamptz NOT NULL,
  outcome              text CHECK (outcome IN ('WON', 'CHARGED_BACK')),
  recovered_minor      bigint CHECK (recovered_minor >= 0),
  shortfall_minor      bigint CHECK (shortfall_minor >= 0),
  decided_at           timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rail, dispute_ref),
  CHECK ((outcome IS NULL) = (decided_at IS NULL))
);
CREATE TRIGGER payment_dispute_set_once
  BEFORE UPDATE OR DELETE ON payment_dispute
  FOR EACH ROW EXECUTE FUNCTION allow_set_once('outcome', 'recovered_minor', 'shortfall_minor', 'decided_at');

-- Receipt: written only in the transaction that credits the payment.
CREATE SEQUENCE receipt_no_seq;
CREATE TABLE receipt (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no       text NOT NULL UNIQUE,
  payment_id       uuid NOT NULL UNIQUE REFERENCES payment(id),
  payer_person_id  uuid REFERENCES person(id),
  wallet_id        uuid NOT NULL,
  rail             text NOT NULL,
  currency         text NOT NULL,
  gross_minor      bigint NOT NULL CHECK (gross_minor > 0),
  fee_minor        bigint NOT NULL CHECK (fee_minor >= 0),
  net_minor        bigint NOT NULL CHECK (net_minor > 0),
  provider_ref     text NOT NULL,
  issued_at        timestamptz NOT NULL
);
CREATE TRIGGER receipt_append_only
  BEFORE UPDATE OR DELETE ON receipt
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

ALTER TABLE payment ADD CONSTRAINT payment_receipt_fk FOREIGN KEY (receipt_id) REFERENCES receipt(id) DEFERRABLE INITIALLY DEFERRED;
