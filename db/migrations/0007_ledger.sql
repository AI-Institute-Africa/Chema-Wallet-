-- P02: append-only double-entry ledger. See docs/04 §1 §2 and docs/03 (invariants).
-- Money is integer minor units. A journal balances to zero per currency, is
-- written once, and is corrected only by a linked reversing journal.
-- wallet_id gets its FK to wallet(id) in P04 when the wallet table lands.

-- One account = one sub-ledger in one currency.
--   wallet accounts:  COMMUNITY, FIDELITY_BENEFIT, GROUP (qualifier = group id)
--   system accounts:  PROVIDER_CLEARING / PAYOUT_CLEARING (qualifier = rail),
--                     FEES, REFUND_CLEARING, SUSPENSE_UNMATCHED
CREATE TABLE ledger_account (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id   uuid,
  kind        text NOT NULL CHECK (kind IN
                ('COMMUNITY', 'FIDELITY_BENEFIT', 'GROUP',
                 'PROVIDER_CLEARING', 'PAYOUT_CLEARING', 'FEES', 'REFUND_CLEARING', 'SUSPENSE_UNMATCHED')),
  qualifier   text CHECK (qualifier ~ '^[A-Za-z0-9_-]{1,64}$'),
  currency    text NOT NULL CHECK (currency IN ('USD', 'ZWG')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((wallet_id IS NOT NULL) = (kind IN ('COMMUNITY', 'FIDELITY_BENEFIT', 'GROUP'))),
  CHECK ((qualifier IS NOT NULL) = (kind IN ('GROUP', 'PROVIDER_CLEARING', 'PAYOUT_CLEARING'))),
  -- Rails are upper-case codes; no rail name is hard-coded here.
  CHECK (kind = 'GROUP' OR qualifier IS NULL OR qualifier ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  UNIQUE NULLS NOT DISTINCT (wallet_id, kind, qualifier, currency),
  UNIQUE (id, currency)
);

CREATE TABLE ledger_journal (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Insertion order (gaps are normal: sequences do not roll back).
  seq                  bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  idempotency_key      text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  -- sha256 of the canonical journal: a replayed key must carry the same content.
  payload_hash         text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  kind                 text NOT NULL CHECK (kind IN
                         ('CONTRIBUTION', 'BENEFIT', 'PAYOUT', 'REFUND', 'CHARGEBACK',
                          'FEE', 'SETTLEMENT', 'SUSPENSE', 'ADJUSTMENT')),
  -- The single wallet this journal touches (NULL = system accounts only).
  wallet_id            uuid,
  -- A journal can be reversed at most once; the reversal keeps the original's kind.
  reverses_journal_id  uuid UNIQUE REFERENCES ledger_journal(id),
  reason               text,
  actor_id             text NOT NULL,
  actor_role           text NOT NULL,
  approval_ref         text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (reverses_journal_id IS NULL OR reverses_journal_id <> id),
  CHECK (reason IS NOT NULL OR (reverses_journal_id IS NULL AND kind <> 'ADJUSTMENT'))
);
CREATE INDEX ledger_journal_wallet ON ledger_journal (wallet_id, seq) WHERE wallet_id IS NOT NULL;

CREATE TABLE ledger_entry (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id    uuid NOT NULL REFERENCES ledger_journal(id),
  line_no       integer NOT NULL CHECK (line_no > 0),
  account_id    uuid NOT NULL,
  currency      text NOT NULL,
  side          text NOT NULL CHECK (side IN ('D', 'C')),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  txn_ref       text,
  provider_ref  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (journal_id, line_no),
  -- An entry is always in its account's currency.
  FOREIGN KEY (account_id, currency) REFERENCES ledger_account (id, currency)
);
CREATE INDEX ledger_entry_account ON ledger_entry (account_id);
CREATE INDEX ledger_entry_txn_ref ON ledger_entry (txn_ref) WHERE txn_ref IS NOT NULL;
CREATE INDEX ledger_entry_provider_ref ON ledger_entry (provider_ref) WHERE provider_ref IS NOT NULL;

-- ── Append-only ────────────────────────────────────────────────────────────
CREATE TRIGGER ledger_account_no_update_delete
  BEFORE UPDATE OR DELETE ON ledger_account
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER ledger_account_no_truncate
  BEFORE TRUNCATE ON ledger_account
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation();

CREATE TRIGGER ledger_journal_no_update_delete
  BEFORE UPDATE OR DELETE ON ledger_journal
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER ledger_journal_no_truncate
  BEFORE TRUNCATE ON ledger_journal
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation();

CREATE TRIGGER ledger_entry_no_update_delete
  BEFORE UPDATE OR DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER ledger_entry_no_truncate
  BEFORE TRUNCATE ON ledger_entry
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation();

-- ── Journal shape guard ────────────────────────────────────────────────────
-- Runs once per INSERT statement on ledger_entry, so a journal's entries must
-- arrive together and are checked as a whole before the statement returns.
-- Signed amount below: debit positive, credit negative.
CREATE FUNCTION ledger_journal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  j           record;
  orig        record;
  n_sub       bigint;
  entry_wallet text;
BEGIN
  FOR j IN
    SELECT lj.id, lj.wallet_id, lj.kind, lj.reverses_journal_id
      FROM ledger_journal lj
     WHERE lj.id IN (SELECT DISTINCT n.journal_id FROM new_rows n)
  LOOP
    -- 1. Written once: no entry may be added to an existing journal.
    IF (SELECT count(*) FROM ledger_entry e WHERE e.journal_id = j.id)
       <> (SELECT count(*) FROM new_rows n WHERE n.journal_id = j.id) THEN
      RAISE EXCEPTION 'ledger: journal % is sealed; entries are written once', j.id
        USING ERRCODE = 'check_violation';
    END IF;

    -- 2. Balanced per currency.
    IF EXISTS (
      SELECT 1 FROM new_rows n
       WHERE n.journal_id = j.id
       GROUP BY n.currency
      HAVING sum(CASE n.side WHEN 'D' THEN n.amount_minor ELSE -n.amount_minor END) <> 0
    ) THEN
      RAISE EXCEPTION 'ledger: journal % does not balance per currency', j.id
        USING ERRCODE = 'check_violation';
    END IF;

    -- 3. At most one wallet sub-ledger: no value moves across wallets, nor
    --    between the community / benefit / group sub-ledgers of one wallet.
    SELECT count(DISTINCT a.wallet_id::text || '|' || a.kind || '|' || COALESCE(a.qualifier, '')),
           min(a.wallet_id::text)
      INTO n_sub, entry_wallet
      FROM new_rows n
      JOIN ledger_account a ON a.id = n.account_id
     WHERE n.journal_id = j.id AND a.wallet_id IS NOT NULL;
    IF n_sub > 1 THEN
      RAISE EXCEPTION 'ledger: journal % touches more than one wallet sub-ledger', j.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF j.wallet_id::text IS DISTINCT FROM entry_wallet THEN
      RAISE EXCEPTION 'ledger: journal % wallet_id does not match its entries', j.id
        USING ERRCODE = 'check_violation';
    END IF;

    IF j.reverses_journal_id IS NOT NULL THEN
      -- 5. A reversal mirrors its original exactly, and only once.
      SELECT o.kind, o.reverses_journal_id INTO orig
        FROM ledger_journal o WHERE o.id = j.reverses_journal_id;
      IF orig.reverses_journal_id IS NOT NULL THEN
        RAISE EXCEPTION 'ledger: journal % reverses a reversal', j.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF orig.kind <> j.kind THEN
        RAISE EXCEPTION 'ledger: reversal % must keep the kind of its original', j.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (
        SELECT 1 FROM ledger_entry e
         WHERE e.journal_id IN (j.id, j.reverses_journal_id)
         GROUP BY e.account_id
        HAVING sum(CASE e.side WHEN 'D' THEN e.amount_minor ELSE -e.amount_minor END) <> 0
      ) THEN
        RAISE EXCEPTION 'ledger: reversal % does not net its original to zero', j.id
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF EXISTS (
      -- 4. Value leaving a wallet sub-ledger may only go to fees, refund
      --    clearing or payout clearing (docs/04 §2).
      SELECT 1 FROM new_rows n
        JOIN ledger_account a ON a.id = n.account_id
       WHERE n.journal_id = j.id AND a.wallet_id IS NOT NULL
       GROUP BY n.account_id
      HAVING sum(CASE n.side WHEN 'D' THEN n.amount_minor ELSE -n.amount_minor END) > 0
    ) AND EXISTS (
      SELECT 1 FROM new_rows n
        JOIN ledger_account a ON a.id = n.account_id
       WHERE n.journal_id = j.id AND a.wallet_id IS NULL
         AND a.kind NOT IN ('FEES', 'REFUND_CLEARING', 'PAYOUT_CLEARING')
    ) THEN
      RAISE EXCEPTION 'ledger: journal % moves wallet funds to a system account that is not allowed', j.id
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER ledger_entry_10_journal_guard
  AFTER INSERT ON ledger_entry
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_journal_guard();

-- A journal header without entries cannot be committed.
CREATE FUNCTION ledger_journal_nonempty() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM ledger_entry e WHERE e.journal_id = NEW.id) < 2 THEN
    RAISE EXCEPTION 'ledger: journal % has no entries', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_journal_nonempty
  AFTER INSERT ON ledger_journal
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_journal_nonempty();
