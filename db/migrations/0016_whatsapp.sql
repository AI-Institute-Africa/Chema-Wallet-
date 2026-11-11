-- P08 WhatsApp channel (docs/09): raw inbound store (idempotent by provider
-- message id), conversation state, single-use secure hand-offs, human
-- escalations, delivery-status events, and WHATSAPP as a notification channel.
-- WhatsApp is never the system of record: nothing here holds money state.
-- Phone numbers, message bodies and hand-off context are sealed; lookups use a
-- keyed hash of the E.164 number.

-- Notifications may go over WhatsApp; the provider's message id is kept for
-- delivery-status tracking.
ALTER TABLE notification DROP CONSTRAINT notification_channel_check;
ALTER TABLE notification ADD CONSTRAINT notification_channel_check CHECK (channel IN ('WEB', 'EMAIL', 'SMS', 'WHATSAPP'));
ALTER TABLE notification ADD COLUMN provider_ref text CHECK (provider_ref IS NULL OR length(provider_ref) BETWEEN 1 AND 128);

CREATE OR REPLACE FUNCTION notification_guard() RETURNS trigger
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
  IF OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref THEN
    RAISE EXCEPTION 'notification: provider_ref is set once' USING ERRCODE = 'insufficient_privilege';
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
CREATE UNIQUE INDEX notification_provider_ref ON notification (channel, provider_ref) WHERE provider_ref IS NOT NULL;

-- Conversation: one per WhatsApp number. Bound to an identity only after an
-- OTP login completed on the secure web hand-off (auth_session channel WHATSAPP).
CREATE TABLE wa_conversation (
  id                uuid PRIMARY KEY,
  phone_hash        text NOT NULL UNIQUE CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  phone_sealed      text NOT NULL,
  auth_session_id   uuid REFERENCES auth_session(id),
  person_id         uuid REFERENCES person(id),
  locale            text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'sn', 'nd')),
  state             text NOT NULL DEFAULT 'MENU' CHECK (state ~ '^[A-Z][A-Z_]{1,39}$'),
  data_sealed       text,
  misunderstood     integer NOT NULL DEFAULT 0 CHECK (misunderstood >= 0),
  last_inbound_at   timestamptz,
  rate_window_start timestamptz,
  rate_count        integer NOT NULL DEFAULT 0 CHECK (rate_count >= 0),
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  CHECK ((auth_session_id IS NULL) = (person_id IS NULL))
);

CREATE FUNCTION wa_conversation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wa_conversation: DELETE denied' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.phone_hash <> OLD.phone_hash OR NEW.phone_sealed <> OLD.phone_sealed OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'wa_conversation: immutable column changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wa_conversation_guard BEFORE UPDATE OR DELETE ON wa_conversation
  FOR EACH ROW EXECUTE FUNCTION wa_conversation_guard();

-- Raw inbound store. (provider, message_id) is unique: a duplicate webhook
-- stores nothing and queues nothing. Bodies that look like a PIN / OTP / card
-- number are never stored (redacted = true, body is a marker).
CREATE TABLE wa_inbound (
  id               uuid PRIMARY KEY,
  provider         text NOT NULL CHECK (provider IN ('SIMULATOR', 'META')),
  message_id       text NOT NULL CHECK (length(message_id) BETWEEN 1 AND 128),
  conversation_id  uuid NOT NULL REFERENCES wa_conversation(id),
  body_sealed      text NOT NULL,
  redacted         boolean NOT NULL DEFAULT false,
  sent_at          timestamptz NOT NULL,
  received_at      timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  outcome          text CHECK (outcome IS NULL OR outcome ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  processed_at     timestamptz,
  UNIQUE (provider, message_id),
  CHECK ((status = 'RECEIVED') = (processed_at IS NULL))
);
CREATE INDEX wa_inbound_pending ON wa_inbound (received_at) WHERE status = 'RECEIVED';

CREATE FUNCTION wa_inbound_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wa_inbound: DELETE denied' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.provider <> OLD.provider OR NEW.message_id <> OLD.message_id
     OR NEW.conversation_id <> OLD.conversation_id OR NEW.body_sealed <> OLD.body_sealed OR NEW.redacted <> OLD.redacted
     OR NEW.sent_at <> OLD.sent_at OR NEW.received_at <> OLD.received_at THEN
    RAISE EXCEPTION 'wa_inbound: immutable column changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'RECEIVED' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'wa_inbound: % is final', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'wa_inbound: attempts cannot go down' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wa_inbound_guard BEFORE UPDATE OR DELETE ON wa_inbound
  FOR EACH ROW EXECUTE FUNCTION wa_inbound_guard();

-- Secure web hand-off: short-lived, single-use. Only the sha256 of the token is
-- stored; the context (what the user was doing) is sealed.
CREATE TABLE wa_handoff (
  id               uuid PRIMARY KEY,
  token_hash       text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  conversation_id  uuid NOT NULL REFERENCES wa_conversation(id),
  purpose          text NOT NULL CHECK (purpose IN ('LOGIN', 'PAYOUT_REQUEST', 'EVIDENCE', 'PORTAL')),
  context_sealed   text NOT NULL,
  auth_session_id  uuid REFERENCES auth_session(id),
  expires_at       timestamptz NOT NULL,
  consumed_at      timestamptz,
  created_at       timestamptz NOT NULL,
  CHECK (purpose = 'LOGIN' OR purpose = 'PORTAL' OR auth_session_id IS NOT NULL)
);

CREATE FUNCTION wa_handoff_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wa_handoff: DELETE denied' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.token_hash <> OLD.token_hash OR NEW.conversation_id <> OLD.conversation_id
     OR NEW.purpose <> OLD.purpose OR NEW.context_sealed <> OLD.context_sealed
     OR NEW.auth_session_id IS DISTINCT FROM OLD.auth_session_id OR NEW.expires_at <> OLD.expires_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'wa_handoff: immutable column changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'wa_handoff: already used' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wa_handoff_guard BEFORE UPDATE OR DELETE ON wa_handoff
  FOR EACH ROW EXECUTE FUNCTION wa_handoff_guard();

-- Human escalation (docs/09 fallbacks): the conversation reference is preserved
-- so a person can pick it up. The queue screen is P09.
CREATE TABLE wa_escalation (
  id               uuid PRIMARY KEY,
  ref              text NOT NULL UNIQUE CHECK (ref ~ '^WA-[A-Z2-7]{8}$'),
  conversation_id  uuid NOT NULL REFERENCES wa_conversation(id),
  inbound_id       uuid REFERENCES wa_inbound(id),
  reason           text NOT NULL CHECK (reason IN ('USER', 'DISTRESS', 'COMPLAINT', 'FRAUD', 'MISUNDERSTOOD', 'INTEGRATION_DOWN')),
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  created_at       timestamptz NOT NULL,
  closed_at        timestamptz,
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX wa_escalation_open ON wa_escalation (conversation_id) WHERE status = 'OPEN';

CREATE FUNCTION wa_escalation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wa_escalation: DELETE denied' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.ref <> OLD.ref OR NEW.conversation_id <> OLD.conversation_id
     OR NEW.inbound_id IS DISTINCT FROM OLD.inbound_id OR NEW.reason <> OLD.reason OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'wa_escalation: immutable column changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'wa_escalation: closed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wa_escalation_guard BEFORE UPDATE OR DELETE ON wa_escalation
  FOR EACH ROW EXECUTE FUNCTION wa_escalation_guard();

-- Provider delivery statuses (sent / delivered / read / failed), append-only.
-- Reconciled against notification.provider_ref; never touches transaction state.
CREATE TABLE wa_delivery_event (
  id                   uuid PRIMARY KEY,
  provider             text NOT NULL CHECK (provider IN ('SIMULATOR', 'META')),
  provider_message_id  text NOT NULL CHECK (length(provider_message_id) BETWEEN 1 AND 128),
  status               text NOT NULL CHECK (status IN ('SENT', 'DELIVERED', 'READ', 'FAILED')),
  error                text CHECK (error IS NULL OR length(error) <= 200),
  occurred_at          timestamptz NOT NULL,
  received_at          timestamptz NOT NULL,
  UNIQUE (provider, provider_message_id, status)
);

CREATE FUNCTION wa_delivery_event_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wa_delivery_event: append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER wa_delivery_event_guard BEFORE UPDATE OR DELETE ON wa_delivery_event
  FOR EACH ROW EXECUTE FUNCTION wa_delivery_event_guard();
