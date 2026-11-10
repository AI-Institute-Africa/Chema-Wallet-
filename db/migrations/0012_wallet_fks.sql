-- P04: the wallet table exists now; every wallet_id placeholder from P01-P03
-- gets its foreign key (PROGRESS.md handoff).
ALTER TABLE wallet_role        ADD CONSTRAINT wallet_role_wallet_fk        FOREIGN KEY (wallet_id)     REFERENCES wallet(id);
ALTER TABLE staff_assignment   ADD CONSTRAINT staff_assignment_wallet_fk   FOREIGN KEY (wallet_id)     REFERENCES wallet(id);
ALTER TABLE approval           ADD CONSTRAINT approval_wallet_fk           FOREIGN KEY (wallet_id)     REFERENCES wallet(id);
ALTER TABLE consent_record     ADD CONSTRAINT consent_record_wallet_fk     FOREIGN KEY (wallet_id)     REFERENCES wallet(id);
ALTER TABLE document           ADD CONSTRAINT document_wallet_fk           FOREIGN KEY (linked_wallet) REFERENCES wallet(id);
ALTER TABLE ledger_account     ADD CONSTRAINT ledger_account_wallet_fk     FOREIGN KEY (wallet_id)     REFERENCES wallet(id);
ALTER TABLE ledger_journal     ADD CONSTRAINT ledger_journal_wallet_fk     FOREIGN KEY (wallet_id)     REFERENCES wallet(id);
ALTER TABLE ledger_reservation ADD CONSTRAINT ledger_reservation_wallet_fk FOREIGN KEY (wallet_id)     REFERENCES wallet(id);
ALTER TABLE hold               ADD CONSTRAINT hold_wallet_fk               FOREIGN KEY (wallet_id)     REFERENCES wallet(id);
ALTER TABLE payment            ADD CONSTRAINT payment_wallet_fk            FOREIGN KEY (wallet_id)     REFERENCES wallet(id);
ALTER TABLE case_record        ADD CONSTRAINT case_record_wallet_fk        FOREIGN KEY (wallet_id)     REFERENCES wallet(id);
ALTER TABLE receipt            ADD CONSTRAINT receipt_wallet_fk            FOREIGN KEY (wallet_id)     REFERENCES wallet(id);
ALTER TABLE recon_exception    ADD CONSTRAINT recon_exception_wallet_fk    FOREIGN KEY (wallet_id)     REFERENCES wallet(id);
