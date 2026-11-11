-- P09 admin portal (docs/12): support hand-off closure needs who/why.
-- wa_escalation_guard (0016) leaves these columns mutable while OPEN and
-- freezes the row once CLOSED, so they are written exactly once.
ALTER TABLE wa_escalation
  ADD COLUMN closed_by  uuid REFERENCES person(id),
  ADD COLUMN close_note text CHECK (close_note IS NULL OR length(btrim(close_note)) BETWEEN 10 AND 1000);
ALTER TABLE wa_escalation ADD CONSTRAINT wa_escalation_closed_by
  CHECK (close_note IS NULL OR closed_by IS NOT NULL);

-- Ledger adjustments are posted only from an approved maker-checker request;
-- the journal row already carries approval_ref. Enforce it at the database.
ALTER TABLE ledger_journal ADD CONSTRAINT ledger_journal_adjustment_approved
  CHECK (kind <> 'ADJUSTMENT' OR reverses_journal_id IS NOT NULL OR approval_ref IS NOT NULL);
