-- P03: reconciliation core (docs/04 §7). Provider settlement rows are stored
-- as received; matching produces journals (within tolerance ⇒ RECON_DIFF,
-- unmatched ⇒ SUSPENSE_UNMATCHED) and exceptions, never silent write-offs.

-- Recorded differences within tolerance (docs/04 §7).
ALTER TABLE ledger_account DROP CONSTRAINT ledger_account_kind_check;
ALTER TABLE ledger_account ADD CONSTRAINT ledger_account_kind_check CHECK (kind IN
  ('COMMUNITY', 'FIDELITY_BENEFIT', 'GROUP',
   'PROVIDER_CLEARING', 'PAYOUT_CLEARING', 'FEES', 'REFUND_CLEARING', 'SUSPENSE_UNMATCHED', 'RECON_DIFF'));

CREATE TABLE recon_run (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rail             text NOT NULL CHECK (rail ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  settlement_date  date NOT NULL,
  started_by       text NOT NULL,
  started_at       timestamptz NOT NULL,
  rows_seen        integer NOT NULL CHECK (rows_seen >= 0),
  matched          integer NOT NULL CHECK (matched >= 0),
  within_tolerance integer NOT NULL CHECK (within_tolerance >= 0),
  exceptions       integer NOT NULL CHECK (exceptions >= 0)
);
CREATE TRIGGER recon_run_append_only
  BEFORE UPDATE OR DELETE ON recon_run
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TABLE provider_settlement_row (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rail             text NOT NULL CHECK (rail ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  settlement_date  date NOT NULL,
  provider_ref     text NOT NULL,
  currency         text NOT NULL CHECK (currency IN ('USD', 'ZWG')),
  gross_minor      bigint NOT NULL CHECK (gross_minor > 0),
  fee_minor        bigint NOT NULL CHECK (fee_minor >= 0),
  merchant_ref     text,
  -- Deferred: a run row is written once, at the end, with its final counts.
  first_run_id     uuid NOT NULL REFERENCES recon_run(id) DEFERRABLE INITIALLY DEFERRED,
  match_status     text CHECK (match_status IN ('MATCHED', 'WITHIN_TOLERANCE', 'VARIANCE', 'UNMATCHED')),
  payment_id       uuid REFERENCES payment(id),
  journal_id       uuid REFERENCES ledger_journal(id),
  matched_at       timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rail, provider_ref),
  CHECK ((match_status IS NULL) = (matched_at IS NULL))
);
CREATE TRIGGER provider_settlement_row_set_once
  BEFORE UPDATE OR DELETE ON provider_settlement_row
  FOR EACH ROW EXECUTE FUNCTION allow_set_once('match_status', 'payment_id', 'journal_id', 'matched_at');

-- Exceptions need an owner, age, severity, SLA and escalation (docs/04 §7).
-- dedup_key makes raising idempotent across re-runs and redeliveries.
CREATE TABLE recon_exception (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedup_key         text NOT NULL UNIQUE,
  kind              text NOT NULL CHECK (kind IN
                      ('UNMATCHED_INCOMING', 'MISSING_SETTLEMENT', 'AMOUNT_VARIANCE', 'FEE_VARIANCE',
                       'WRONG_DESTINATION', 'CHARGEBACK_SHORTFALL', 'POLL_WINDOW_EXPIRED', 'CURRENCY_MISMATCH')),
  severity          text NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
  rail              text NOT NULL,
  payment_id        uuid REFERENCES payment(id),
  wallet_id         uuid,
  provider_ref      text,
  currency          text CHECK (currency IN ('USD', 'ZWG')),
  variance_minor    bigint,
  detail            text NOT NULL,
  hold_id           uuid REFERENCES hold(id),
  journal_id        uuid REFERENCES ledger_journal(id),
  recon_run_id      uuid REFERENCES recon_run(id) DEFERRABLE INITIALLY DEFERRED,
  owner_role        text NOT NULL,
  owner_person_id   uuid REFERENCES person(id),
  opened_at         timestamptz NOT NULL,
  sla_due_at        timestamptz NOT NULL,
  escalation_level  integer NOT NULL DEFAULT 0 CHECK (escalation_level >= 0),
  resolved_at       timestamptz,
  resolved_by       text,
  resolution        text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (sla_due_at > opened_at),
  CHECK ((resolved_at IS NULL) = (resolved_by IS NULL)),
  CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);
CREATE INDEX recon_exception_open ON recon_exception (opened_at) WHERE resolved_at IS NULL;
CREATE TRIGGER recon_exception_set_once
  BEFORE UPDATE OR DELETE ON recon_exception
  FOR EACH ROW EXECUTE FUNCTION allow_set_once('owner_person_id', 'resolved_at', 'resolved_by', 'resolution');
