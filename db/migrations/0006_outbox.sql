-- P01: transactional outbox. Producers insert in the same transaction as the
-- state change; the relay moves rows to the queue (BullMQ, jobId = id).
-- Rows are never deleted and topic/payload never change; only delivery
-- bookkeeping moves, and DISPATCHED is terminal.

CREATE TABLE outbox_event (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic          text NOT NULL CHECK (topic ~ '^[a-z][a-z0-9_.]*$'),
  payload        jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DISPATCHED', 'FAILED')),
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  dispatched_at  timestamptz
);
CREATE INDEX outbox_event_pending ON outbox_event (created_at) WHERE status = 'PENDING';

CREATE FUNCTION outbox_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'outbox_event is append-only: DELETE denied' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.topic <> OLD.topic OR NEW.payload <> OLD.payload OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'outbox_event topic/payload are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'DISPATCHED' THEN
    RAISE EXCEPTION 'outbox_event % already dispatched', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbox_event_guard
  BEFORE UPDATE OR DELETE ON outbox_event
  FOR EACH ROW EXECUTE FUNCTION outbox_guard();

CREATE TRIGGER outbox_event_no_truncate
  BEFORE TRUNCATE ON outbox_event
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation();
