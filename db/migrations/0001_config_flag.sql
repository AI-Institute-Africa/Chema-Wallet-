-- P00: feature flags / config. Current values + append-only change history.
-- Keys and SAFE defaults live in code (packages/core/src/flags/registry.ts);
-- a missing row means "use the default".

CREATE TABLE config_flag (
  key         text PRIMARY KEY,
  value       jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE config_flag_change (
  id            bigserial PRIMARY KEY,
  key           text        NOT NULL,
  old_value     jsonb,
  new_value     jsonb       NOT NULL,
  actor_id      text        NOT NULL,
  actor_role    text        NOT NULL,
  approval_ref  text,
  reason        text,
  changed_at    timestamptz NOT NULL DEFAULT now()
);

-- Shared guard for append-only tables (reused by ledger/audit in later phases).
CREATE FUNCTION deny_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only: % denied', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER config_flag_change_no_update_delete
  BEFORE UPDATE OR DELETE ON config_flag_change
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TRIGGER config_flag_change_no_truncate
  BEFORE TRUNCATE ON config_flag_change
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation();
