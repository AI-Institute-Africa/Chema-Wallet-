-- Gaps after P10 (PROGRESS.md "Known gaps"): family roles granted by the
-- flows that establish them, the claimant on the claim link, and a signed-off
-- access review.

-- ── 1. wallet_role: who/what granted a role ─────────────────────────────────
-- POLICY_BENEFICIARY / PAYOUT_RECIPIENT can be established by Fidelity's
-- approved route (a SYSTEM flow, no Chema person granted them). Every row
-- names either the granting person or the flow (grant_source), never neither.
ALTER TABLE wallet_role ALTER COLUMN granted_by DROP NOT NULL;
ALTER TABLE wallet_role
  ADD COLUMN grant_source text CHECK (grant_source IS NULL OR grant_source ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  ADD CONSTRAINT wallet_role_granted_by_or_source CHECK (granted_by IS NOT NULL OR grant_source IS NOT NULL);

-- ── 2. fidelity_link: the claimant (the family member who lodged the claim) ─
ALTER TABLE fidelity_link ADD COLUMN claimant_person uuid REFERENCES person(id);

CREATE FUNCTION fidelity_link_claimant_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.claimant_person IS NOT NULL AND NEW.claimant_person IS DISTINCT FROM OLD.claimant_person THEN
    RAISE EXCEPTION 'fidelity_link: claimant_person is set once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fidelity_link_claimant_once
  BEFORE UPDATE ON fidelity_link
  FOR EACH ROW EXECUTE FUNCTION fidelity_link_claimant_once();

-- ── 3. Access review sign-off (docs/12 queue 10) ─────────────────────────────
-- Who reviewed which export (row count + sha256 of the exact CSV), for which
-- period, when, with what notes. Append-only.
CREATE TABLE access_review_signoff (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_person uuid NOT NULL REFERENCES person(id),
  reviewer_role   text NOT NULL CHECK (reviewer_role IN ('FIDELITY_ADMIN', 'AUDITOR')),
  period_from     timestamptz NOT NULL,
  period_to       timestamptz NOT NULL,
  row_count       integer NOT NULL CHECK (row_count >= 0),
  csv_sha256      text NOT NULL CHECK (csv_sha256 ~ '^[0-9a-f]{64}$'),
  notes           text NOT NULL CHECK (length(notes) BETWEEN 10 AND 2000),
  reviewed_at     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (period_from < period_to),
  CHECK (period_to <= reviewed_at)
);
CREATE INDEX access_review_signoff_period ON access_review_signoff (period_to DESC);
CREATE TRIGGER access_review_signoff_append_only
  BEFORE UPDATE OR DELETE ON access_review_signoff
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER access_review_signoff_no_truncate
  BEFORE TRUNCATE ON access_review_signoff
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation();

-- ── 4. Override evidence documents (payout.override, rail down) ──────────────
ALTER TABLE document DROP CONSTRAINT document_class_check;
ALTER TABLE document ADD CONSTRAINT document_class_check
  CHECK (class IN ('DEATH_EVIDENCE', 'ID', 'MANDATE', 'OTHER', 'PHOTO', 'OVERRIDE_EVIDENCE'));
