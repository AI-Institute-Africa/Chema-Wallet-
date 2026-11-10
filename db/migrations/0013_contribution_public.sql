-- P05: public page + contribution journey (docs/06). Contributions, tributes,
-- groups, receipt (re)issue log, target milestones, notifications.
-- Money stays in payment / ledger: nothing here is a balance.

-- A memorial photo is a document of its own class (public content, consent-bound).
ALTER TABLE document DROP CONSTRAINT document_class_check;
ALTER TABLE document ADD CONSTRAINT document_class_check
  CHECK (class IN ('DEATH_EVIDENCE', 'ID', 'MANDATE', 'OTHER', 'PHOTO'));

-- Group contributions (feature.group_contributions, default OFF): a named group
-- with one authorised representative, credited to its own GROUP sub-ledger.
CREATE TABLE contribution_group (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id              uuid NOT NULL REFERENCES wallet(id),
  name                   text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  name_norm              text NOT NULL,
  representative_person  uuid NOT NULL REFERENCES person(id),
  created_at             timestamptz NOT NULL,
  UNIQUE (wallet_id, name_norm)
);
CREATE TRIGGER contribution_group_append_only BEFORE UPDATE OR DELETE ON contribution_group
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- One contribution per payment. Public display (name / anonymous) lives here;
-- the payer's KYC data (name + phone) is sealed with the data key and kept
-- even when the contribution is anonymous (docs/06: anonymous = display only).
CREATE TABLE contribution (
  id                  uuid PRIMARY KEY,
  wallet_id           uuid NOT NULL REFERENCES wallet(id),
  payment_id          uuid NOT NULL UNIQUE REFERENCES payment(id),
  group_id            uuid REFERENCES contribution_group(id),
  anonymous           boolean NOT NULL,
  display_name        text CHECK (display_name IS NULL OR length(btrim(display_name)) BETWEEN 1 AND 60),
  kyc_sealed          text NOT NULL,
  payer_phone_hash    text NOT NULL CHECK (payer_phone_hash ~ '^[0-9a-f]{64}$'),
  contact_kind        text CHECK (contact_kind IN ('PHONE', 'EMAIL')),
  contact_sealed      text,
  contributor_person  uuid REFERENCES person(id),
  channel             text NOT NULL CHECK (channel IN ('WEB', 'WHATSAPP', 'SMS', 'ADMIN')),
  -- sha256 of the canonical contribution request: a replayed key must carry the same content.
  request_hash        text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at          timestamptz NOT NULL,
  -- Final payment outcome, recorded once by contribution.settle.
  settled_state       text CHECK (settled_state IN ('SUCCEEDED', 'FAILED', 'EXPIRED')),
  settled_at          timestamptz,
  CHECK (anonymous = (display_name IS NULL)),
  CHECK ((contact_kind IS NULL) = (contact_sealed IS NULL)),
  CHECK ((settled_state IS NULL) = (settled_at IS NULL))
);
CREATE INDEX contribution_wallet ON contribution (wallet_id, created_at);
CREATE INDEX contribution_person ON contribution (contributor_person) WHERE contributor_person IS NOT NULL;
CREATE INDEX contribution_phone ON contribution (payer_phone_hash);
CREATE TRIGGER contribution_set_once BEFORE UPDATE OR DELETE ON contribution
  FOR EACH ROW EXECUTE FUNCTION allow_set_once('settled_state', 'settled_at');

-- Tribute wall. Public content only: removal erases the message (the
-- contribution and its money records stay). Status machine enforced below.
CREATE TABLE tribute (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_id  uuid NOT NULL UNIQUE REFERENCES contribution(id),
  wallet_id        uuid NOT NULL REFERENCES wallet(id),
  message          text CHECK (message IS NULL OR length(btrim(message)) BETWEEN 1 AND 500),
  status           text NOT NULL DEFAULT 'AWAITING_PAYMENT' CHECK (status IN
                     ('AWAITING_PAYMENT', 'VISIBLE', 'HIDDEN', 'REJECTED', 'REMOVED', 'VOID')),
  flag_reasons     text[] NOT NULL DEFAULT '{}',
  appealed         boolean NOT NULL DEFAULT false,
  published_at     timestamptz,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  CHECK ((status = 'REMOVED') = (message IS NULL))
);
CREATE INDEX tribute_wall ON tribute (wallet_id, published_at) WHERE status = 'VISIBLE';
CREATE INDEX tribute_review ON tribute (status, updated_at) WHERE status = 'HIDDEN';

CREATE FUNCTION tribute_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tribute: DELETE denied' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.contribution_id <> OLD.contribution_id OR NEW.wallet_id <> OLD.wallet_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'tribute: immutable column changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The text is never edited: it is kept as written, or erased on removal.
  IF NEW.message IS NOT NULL AND NEW.message IS DISTINCT FROM OLD.message THEN
    RAISE EXCEPTION 'tribute: message cannot be edited' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'tribute: published_at is set-once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.appealed AND NOT NEW.appealed THEN
    RAISE EXCEPTION 'tribute: appealed is set-once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'AWAITING_PAYMENT' AND NEW.status IN ('VISIBLE', 'HIDDEN', 'VOID', 'REMOVED'))
    OR (OLD.status = 'VISIBLE' AND NEW.status IN ('HIDDEN', 'REMOVED'))
    OR (OLD.status = 'HIDDEN' AND NEW.status IN ('VISIBLE', 'REJECTED', 'REMOVED'))
    OR (OLD.status = 'REJECTED' AND NEW.status IN ('HIDDEN', 'REMOVED'))) THEN
    RAISE EXCEPTION 'tribute: illegal transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  -- Only a tribute that was ever shown carries a publish time.
  IF NEW.status = 'VISIBLE' AND NEW.published_at IS NULL THEN
    RAISE EXCEPTION 'tribute: VISIBLE needs published_at' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tribute_guard BEFORE UPDATE OR DELETE ON tribute
  FOR EACH ROW EXECUTE FUNCTION tribute_guard();

-- Every tribute status change: who, why (moderation is transparent + appealable).
CREATE TABLE tribute_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tribute_id   uuid NOT NULL REFERENCES tribute(id),
  from_status  text,
  to_status    text NOT NULL,
  actor_id     text NOT NULL,
  actor_role   text NOT NULL,
  reason_code  text NOT NULL,
  note         text CHECK (note IS NULL OR length(note) <= 1000),
  ts           timestamptz NOT NULL
);
CREATE INDEX tribute_event_tribute ON tribute_event (tribute_id, ts);
CREATE TRIGGER tribute_event_append_only BEFORE UPDATE OR DELETE ON tribute_event
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER tribute_event_no_truncate BEFORE TRUNCATE ON tribute_event
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation();

-- Receipt issue log: the original issue and every re-issue (same content).
CREATE TABLE receipt_issue (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id       uuid NOT NULL REFERENCES receipt(id),
  contribution_id  uuid NOT NULL REFERENCES contribution(id),
  kind             text NOT NULL CHECK (kind IN ('ORIGINAL', 'REISSUE')),
  actor_id         text NOT NULL,
  channel          text NOT NULL,
  ts               timestamptz NOT NULL
);
CREATE UNIQUE INDEX receipt_issue_original ON receipt_issue (receipt_id) WHERE kind = 'ORIGINAL';
CREATE TRIGGER receipt_issue_append_only BEFORE UPDATE OR DELETE ON receipt_issue
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- target.reached fires once per wallet.
CREATE TABLE wallet_milestone (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id   uuid NOT NULL REFERENCES wallet(id),
  kind        text NOT NULL CHECK (kind IN ('TARGET_REACHED')),
  reached_at  timestamptz NOT NULL,
  UNIQUE (wallet_id, kind)
);
CREATE TRIGGER wallet_milestone_append_only BEFORE UPDATE OR DELETE ON wallet_milestone
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- Notification skeleton: template + queue + retry + status. Delivery never
-- touches transaction state. Addresses and params are sealed (they can hold
-- names, phone numbers and tribute text); a person recipient is resolved at
-- send time.
CREATE TABLE notification (
  id                uuid PRIMARY KEY,
  template          text NOT NULL CHECK (template ~ '^[a-z][a-z0-9_.]{2,63}$'),
  channel           text NOT NULL CHECK (channel IN ('WEB', 'EMAIL', 'SMS')),
  recipient_person  uuid REFERENCES person(id),
  recipient_sealed  text,
  locale            text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'sn', 'nd')),
  params_sealed     text NOT NULL,
  dedupe_key        text NOT NULL UNIQUE CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  wallet_id         uuid REFERENCES wallet(id),
  status            text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RETRY', 'SENT', 'DEAD', 'SUPPRESSED')),
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at   timestamptz,
  last_error        text CHECK (last_error IS NULL OR length(last_error) <= 200),
  sent_at           timestamptz,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  CHECK ((recipient_person IS NULL) <> (recipient_sealed IS NULL)),
  CHECK ((status = 'SENT') = (sent_at IS NOT NULL)),
  CHECK (status NOT IN ('QUEUED', 'RETRY') OR next_attempt_at IS NOT NULL)
);
CREATE INDEX notification_due ON notification (next_attempt_at) WHERE status IN ('QUEUED', 'RETRY');

CREATE FUNCTION notification_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'notification: DELETE denied' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.template <> OLD.template OR NEW.channel <> OLD.channel
     OR NEW.recipient_person IS DISTINCT FROM OLD.recipient_person OR NEW.recipient_sealed IS DISTINCT FROM OLD.recipient_sealed
     OR NEW.params_sealed <> OLD.params_sealed OR NEW.dedupe_key <> OLD.dedupe_key OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'notification: immutable column changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('SENT', 'DEAD', 'SUPPRESSED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'notification: % is final', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'notification: attempts cannot go down' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notification_guard BEFORE UPDATE OR DELETE ON notification
  FOR EACH ROW EXECUTE FUNCTION notification_guard();
