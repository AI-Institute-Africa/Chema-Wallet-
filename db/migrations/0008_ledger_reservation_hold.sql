-- P02: reservations (funds set aside for a payout request) and holds, plus the
-- funds guard on ledger entries. See docs/04 §2 (buckets) and docs/03 (hold).
-- Wallet balance below is credit-normal: credits − debits = owed to the family.

-- Funds set aside for one payout request. Active while neither released nor
-- consumed; consumed by exactly one PAYOUT journal.
CREATE TABLE ledger_reservation (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id            uuid NOT NULL,
  account_id           uuid NOT NULL,
  currency             text NOT NULL,
  amount_minor         bigint NOT NULL CHECK (amount_minor > 0),
  ref_type             text NOT NULL,
  ref_id               text NOT NULL,
  idempotency_key      text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash         text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  created_by           text NOT NULL,
  released_at          timestamptz,
  released_by          text,
  release_reason       text,
  consumed_at          timestamptz,
  consumed_journal_id  uuid UNIQUE REFERENCES ledger_journal(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, currency) REFERENCES ledger_account (id, currency),
  CHECK ((released_at IS NULL) = (released_by IS NULL)),
  CHECK ((released_at IS NULL) = (release_reason IS NULL)),
  CHECK ((consumed_at IS NULL) = (consumed_journal_id IS NULL)),
  CHECK (released_at IS NULL OR consumed_at IS NULL)
);
CREATE INDEX ledger_reservation_active
  ON ledger_reservation (account_id) WHERE released_at IS NULL AND consumed_at IS NULL;
CREATE TRIGGER ledger_reservation_set_once
  BEFORE UPDATE OR DELETE ON ledger_reservation
  FOR EACH ROW EXECUTE FUNCTION allow_set_once(
    'released_at', 'released_by', 'release_reason', 'consumed_at', 'consumed_journal_id');

-- A reservation belongs to a wallet account and can never exceed its balance.
-- The row lock makes the check race-free whatever the caller did.
CREATE FUNCTION ledger_reservation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  acct_wallet uuid;
  bal         numeric;
  reserved    numeric;
BEGIN
  SELECT a.wallet_id INTO acct_wallet
    FROM ledger_account a WHERE a.id = NEW.account_id FOR NO KEY UPDATE;
  IF acct_wallet IS NULL OR acct_wallet <> NEW.wallet_id THEN
    RAISE EXCEPTION 'ledger: reservation % is not on an account of its wallet', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(CASE e.side WHEN 'C' THEN e.amount_minor ELSE -e.amount_minor END), 0)
    INTO bal FROM ledger_entry e WHERE e.account_id = NEW.account_id;
  SELECT COALESCE(sum(r.amount_minor), 0)
    INTO reserved FROM ledger_reservation r
   WHERE r.account_id = NEW.account_id AND r.released_at IS NULL AND r.consumed_at IS NULL;
  IF reserved > bal THEN
    RAISE EXCEPTION 'ledger: reservations on account % would exceed its balance', NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER ledger_reservation_guard
  AFTER INSERT ON ledger_reservation
  FOR EACH ROW EXECUTE FUNCTION ledger_reservation_guard();

-- Holds restrict spending without moving money (the `held` bucket).
--   TXN    : an amount of one journal's credit to one account (proportionate)
--   SOURCE : one whole sub-ledger of the wallet, in every currency
--   WALLET : every sub-ledger of the wallet
CREATE TABLE hold (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id         uuid NOT NULL,
  scope             text NOT NULL CHECK (scope IN ('TXN', 'SOURCE', 'WALLET')),
  source_kind       text CHECK (source_kind IN ('COMMUNITY', 'FIDELITY_BENEFIT', 'GROUP')),
  source_qualifier  text,
  account_id        uuid,
  currency          text,
  journal_id        uuid REFERENCES ledger_journal(id),
  amount_minor      bigint CHECK (amount_minor > 0),
  reason_code       text NOT NULL,
  owner_id          text NOT NULL,
  review_at         timestamptz NOT NULL,
  placed_by         text NOT NULL,
  released_at       timestamptz,
  released_by       text,
  release_reason    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, currency) REFERENCES ledger_account (id, currency),
  CHECK (CASE scope
    WHEN 'TXN' THEN account_id IS NOT NULL AND journal_id IS NOT NULL AND amount_minor IS NOT NULL
                    AND source_kind IS NULL AND source_qualifier IS NULL
    WHEN 'SOURCE' THEN source_kind IS NOT NULL AND (source_qualifier IS NOT NULL) = (source_kind = 'GROUP')
                    AND account_id IS NULL AND journal_id IS NULL AND amount_minor IS NULL
    ELSE source_kind IS NULL AND source_qualifier IS NULL
         AND account_id IS NULL AND journal_id IS NULL AND amount_minor IS NULL
  END),
  CHECK ((account_id IS NULL) = (currency IS NULL)),
  CHECK ((released_at IS NULL) = (released_by IS NULL)),
  CHECK ((released_at IS NULL) = (release_reason IS NULL))
);
CREATE INDEX hold_wallet_active ON hold (wallet_id) WHERE released_at IS NULL;
CREATE TRIGGER hold_set_once
  BEFORE UPDATE OR DELETE ON hold
  FOR EACH ROW EXECUTE FUNCTION allow_set_once('released_at', 'released_by', 'release_reason');

-- A TXN hold sits on its own wallet's account and never exceeds what the
-- journal credited to that account.
CREATE FUNCTION hold_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  credited numeric;
BEGIN
  IF NEW.scope <> 'TXN' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ledger_account a WHERE a.id = NEW.account_id AND a.wallet_id = NEW.wallet_id) THEN
    RAISE EXCEPTION 'hold: account is not in the wallet of the hold'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(CASE e.side WHEN 'C' THEN e.amount_minor ELSE -e.amount_minor END), 0)
    INTO credited FROM ledger_entry e
   WHERE e.journal_id = NEW.journal_id AND e.account_id = NEW.account_id;
  IF NEW.amount_minor > credited THEN
    RAISE EXCEPTION 'hold: amount exceeds what the journal credited to the account'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hold_guard
  BEFORE INSERT ON hold
  FOR EACH ROW EXECUTE FUNCTION hold_guard();

-- ── Funds guard on ledger entries ──────────────────────────────────────────
-- Runs after the shape guard (trigger names fire in alphabetical order).
CREATE FUNCTION ledger_funds_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d        record;
  bal      numeric;
  reserved numeric;
BEGIN
  -- Every wallet account that this statement net-debits, in a stable order.
  FOR d IN
    SELECT n.journal_id, n.account_id, j.kind, j.reverses_journal_id,
           sum(CASE n.side WHEN 'D' THEN n.amount_minor ELSE -n.amount_minor END) AS debit
      FROM new_rows n
      JOIN ledger_account a ON a.id = n.account_id
      JOIN ledger_journal j ON j.id = n.journal_id
     WHERE a.wallet_id IS NOT NULL
     GROUP BY n.journal_id, n.account_id, j.kind, j.reverses_journal_id
    HAVING sum(CASE n.side WHEN 'D' THEN n.amount_minor ELSE -n.amount_minor END) > 0
     ORDER BY n.account_id, n.journal_id
  LOOP
    -- A payout pays exactly one reservation, which it consumes.
    IF d.kind = 'PAYOUT' AND d.reverses_journal_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM ledger_reservation r
       WHERE r.consumed_journal_id = d.journal_id
         AND r.account_id = d.account_id
         AND r.amount_minor = d.debit
    ) THEN
      RAISE EXCEPTION 'ledger: payout journal % does not consume a matching reservation', d.journal_id
        USING ERRCODE = 'check_violation';
    END IF;

    -- No overdraw: the balance must still cover every active reservation.
    PERFORM 1 FROM ledger_account a WHERE a.id = d.account_id FOR NO KEY UPDATE;
    SELECT COALESCE(sum(CASE e.side WHEN 'C' THEN e.amount_minor ELSE -e.amount_minor END), 0)
      INTO bal FROM ledger_entry e WHERE e.account_id = d.account_id;
    SELECT COALESCE(sum(r.amount_minor), 0)
      INTO reserved FROM ledger_reservation r
     WHERE r.account_id = d.account_id AND r.released_at IS NULL AND r.consumed_at IS NULL;
    IF bal < reserved THEN
      RAISE EXCEPTION 'ledger: account % would be overdrawn', d.account_id
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER ledger_entry_20_funds_guard
  AFTER INSERT ON ledger_entry
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_funds_guard();
