// Audit event shape (docs/10 Audit log fields) and sinks. The durable sink is
// DbAuditSink → hash-chained audit_log (./chain). Pass `tx` so the audit row
// commits atomically with the state change it describes.
import type { Queryable, SqlClient } from '@chema/shared';
import { appendAudit } from './chain';

export type AuthzResult = 'ALLOWED' | 'DENIED';

export interface AuditEvent {
  action: string;
  actorId: string;
  actorRole: string;
  channel: string;
  sessionRef?: string;
  subjectType: string;
  subjectId: string;
  authzResult: AuthzResult;
  reasonCode?: string;
  approvalRef?: string;
  txnRef?: string;
  /** Stored as a hash only — raw values never enter the audit log. */
  before?: unknown;
  /** Stored as a hash only — raw values never enter the audit log. */
  after?: unknown;
  ip?: string;
  device?: string;
  ts: Date;
}

export interface AuditSink {
  record(event: AuditEvent, tx?: Queryable): Promise<void>;
}

export class DbAuditSink implements AuditSink {
  constructor(private readonly db: SqlClient) {}
  async record(event: AuditEvent, tx?: Queryable): Promise<void> {
    if (tx) {
      await appendAudit(tx, event);
      return;
    }
    await this.db.transaction((t) => appendAudit(t, event));
  }
}

/** Unit-test sink. Never used at runtime. */
export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}
