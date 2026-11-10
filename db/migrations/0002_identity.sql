-- P01: identity, sessions, step-up, staff accounts. See docs/02, docs/03, docs/10.
-- Secrets are never stored in clear: OTP codes are HMACed, tokens are sha256
-- hashed, TOTP seeds are AES-GCM encrypted by the application.

-- Guard for "mostly immutable" rows: DELETE is denied; UPDATE may only set the
-- columns named in TG_ARGV, and only from NULL to a value (set once).
-- updated_at may always move.
CREATE FUNCTION allow_set_once() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o   jsonb;
  n   jsonb;
  col text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'table % is append-only: DELETE denied', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  o := to_jsonb(OLD) - 'updated_at';
  n := to_jsonb(NEW) - 'updated_at';
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF (o -> col) <> 'null'::jsonb AND (o -> col) IS DISTINCT FROM (n -> col) THEN
      RAISE EXCEPTION 'column %.% is set-once', TG_TABLE_NAME, col
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    o := o - col;
    n := n - col;
  END LOOP;
  IF o IS DISTINCT FROM n THEN
    RAISE EXCEPTION 'table %: only set-once columns may change', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE person (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164            text UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  name                  text,
  fidelity_customer_id  text,
  language              text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'sn', 'nd')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity_binding (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id    uuid NOT NULL REFERENCES person(id),
  channel      text NOT NULL CHECK (channel IN ('WEB', 'WHATSAPP', 'SMS', 'ADMIN')),
  handle       text NOT NULL,
  method       text NOT NULL CHECK (method IN ('OTP_SMS', 'OTP_WHATSAPP', 'PASSWORD_TOTP')),
  verified_at  timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX identity_binding_active_handle
  ON identity_binding (channel, handle) WHERE revoked_at IS NULL;
CREATE TRIGGER identity_binding_set_once
  BEFORE UPDATE OR DELETE ON identity_binding
  FOR EACH ROW EXECUTE FUNCTION allow_set_once('verified_at', 'revoked_at');

-- One role per staff account (separation of duties; a person needing two
-- roles gets two reviewed accounts). AGENT is the global "is a Fidelity agent"
-- capability; per-case assignment is wallet_role AGENT.
CREATE TABLE staff_account (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id        uuid NOT NULL REFERENCES person(id),
  login            text NOT NULL UNIQUE,
  staff_role       text NOT NULL CHECK (staff_role IN
                     ('AGENT', 'CLAIMS_OFFICER', 'OPS_FINANCE', 'COMMUNITY_VERIFIER', 'FIDELITY_ADMIN', 'AUDITOR')),
  password_hash    text NOT NULL,
  totp_secret_enc  text NOT NULL,
  totp_last_step   bigint,
  failed_attempts  integer NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  mfa_enrolled_at  timestamptz NOT NULL DEFAULT now(),
  disabled_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_session (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text NOT NULL UNIQUE,
  person_id     uuid NOT NULL REFERENCES person(id),
  staff_id      uuid REFERENCES staff_account(id),
  kind          text NOT NULL CHECK (kind IN ('CUSTOMER', 'STAFF')),
  channel       text NOT NULL CHECK (channel IN ('WEB', 'WHATSAPP', 'SMS', 'ADMIN')),
  device_ref    text,
  ip            text,
  mfa_at        timestamptz,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'CUSTOMER' OR (staff_id IS NOT NULL AND mfa_at IS NOT NULL))
);

CREATE TABLE otp_challenge (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose      text NOT NULL CHECK (purpose IN ('LOGIN', 'STEP_UP')),
  phone_e164   text NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('WEB', 'WHATSAPP', 'SMS', 'ADMIN')),
  code_hash    text NOT NULL,
  session_id   uuid REFERENCES auth_session(id),
  action       text,
  subject_type text,
  subject_id   text,
  attempts     integer NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (purpose = 'LOGIN' OR (session_id IS NOT NULL AND action IS NOT NULL))
);
CREATE INDEX otp_challenge_phone_recent ON otp_challenge (phone_e164, created_at);

-- Step-up grant: short-lived, bound to one session + action + subject, single use.
CREATE TABLE step_up_grant (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text NOT NULL UNIQUE,
  session_id    uuid NOT NULL REFERENCES auth_session(id),
  action        text NOT NULL,
  subject_type  text NOT NULL,
  subject_id    text NOT NULL,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER step_up_grant_set_once
  BEFORE UPDATE OR DELETE ON step_up_grant
  FOR EACH ROW EXECUTE FUNCTION allow_set_once('consumed_at');
