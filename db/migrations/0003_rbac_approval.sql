-- P01: case-level roles, staff case assignment, maker-checker approvals. See docs/02.
-- wallet_id columns get their FK to wallet(id) in P04 when the wallet table lands.

CREATE TABLE wallet_role (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id   uuid NOT NULL,
  person_id   uuid NOT NULL REFERENCES person(id),
  role        text NOT NULL CHECK (role IN
                ('ADMIN', 'APPROVER', 'AGENT', 'POLICY_BENEFICIARY', 'CLAIMANT', 'PAYOUT_RECIPIENT')),
  granted_by  uuid NOT NULL REFERENCES person(id),
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES person(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX wallet_role_active
  ON wallet_role (wallet_id, person_id, role) WHERE revoked_at IS NULL;
CREATE INDEX wallet_role_person ON wallet_role (person_id) WHERE revoked_at IS NULL;
CREATE TRIGGER wallet_role_set_once
  BEFORE UPDATE OR DELETE ON wallet_role
  FOR EACH ROW EXECUTE FUNCTION allow_set_once('revoked_at', 'revoked_by');

-- Staff see only assigned cases unless their role is oversight (docs/02 Staff).
CREATE TABLE staff_assignment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_person_id  uuid NOT NULL REFERENCES person(id),
  wallet_id        uuid NOT NULL,
  assigned_by      uuid NOT NULL REFERENCES person(id),
  revoked_at       timestamptz,
  revoked_by       uuid REFERENCES person(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX staff_assignment_active
  ON staff_assignment (staff_person_id, wallet_id) WHERE revoked_at IS NULL;
CREATE TRIGGER staff_assignment_set_once
  BEFORE UPDATE OR DELETE ON staff_assignment
  FOR EACH ROW EXECUTE FUNCTION allow_set_once('revoked_at', 'revoked_by');

-- One row per maker-checker request. payload_hash pins exactly what the
-- checker approved; consumed_at makes an approval single-use.
CREATE TABLE approval (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action         text NOT NULL,
  subject_type   text NOT NULL,
  subject_id     text NOT NULL,
  wallet_id      uuid,
  payload_hash   text NOT NULL,
  amount_minor   bigint CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency       text CHECK (currency IS NULL OR currency IN ('USD', 'ZWG')),
  maker_id       uuid NOT NULL REFERENCES person(id),
  maker_role     text NOT NULL,
  checker_id     uuid REFERENCES person(id),
  checker_role   text,
  decision       text CHECK (decision IN ('APPROVED', 'REJECTED')),
  reason_code    text,
  decided_at     timestamptz,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (checker_id IS NULL OR checker_id <> maker_id),
  CHECK ((decision IS NULL) = (checker_id IS NULL)),
  CHECK (consumed_at IS NULL OR decision = 'APPROVED'),
  CHECK ((amount_minor IS NULL) = (currency IS NULL))
);
CREATE INDEX approval_subject ON approval (subject_type, subject_id);
CREATE TRIGGER approval_set_once
  BEFORE UPDATE OR DELETE ON approval
  FOR EACH ROW EXECUTE FUNCTION allow_set_once('checker_id', 'checker_role', 'decision', 'reason_code', 'decided_at', 'consumed_at');
