// Audit stub for P00. P01 replaces this with the hash-chained audit_log and a
// command-bus decorator; the event shape already follows docs/10 audit fields.

export type AuthzResult = 'ALLOWED' | 'DENIED';

export interface AuditEvent {
  action: string;
  actorId: string;
  actorRole: string;
  channel: string;
  subjectType: string;
  subjectId: string;
  authzResult: AuthzResult;
  reasonCode?: string;
  approvalRef?: string;
  before?: unknown;
  after?: unknown;
  ts: Date;
}

export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
}

export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

interface InfoLogger {
  info(obj: object, msg: string): void;
}

export class LoggerAuditSink implements AuditSink {
  constructor(private readonly log: InfoLogger) {}
  async record(event: AuditEvent): Promise<void> {
    this.log.info({ audit: event }, 'audit');
  }
}
