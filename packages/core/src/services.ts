// Composition root shared by the API and the worker.
import type { SqlClient } from '@chema/shared';
import { DbAuditSink, type AuditSink } from './audit/sink';
import { Authorizer } from './authz/authorize';
import { CommandBus } from './command/bus';
import { documentCommands } from './documents/service';
import type { BlobStore, MalwareScanner } from './documents/store';
import { FlagService } from './flags/service';
import { AuthService } from './identity/auth';
import type { OtpProvider } from './identity/otp';
import { StepUpGrants, type Clock } from './identity/sessions';
import { StaffAuthService } from './identity/staff';
import type { Secrets } from './secrets';

export interface CoreDeps {
  db: SqlClient;
  secrets: Secrets;
  otp: OtpProvider;
  blobs: BlobStore;
  scanner: MalwareScanner;
  env?: Record<string, string | undefined>;
  clock?: Clock;
}

export function createCoreServices(deps: CoreDeps) {
  const clock = deps.clock ?? (() => new Date());
  const audit: AuditSink = new DbAuditSink(deps.db);
  const flags = new FlagService(deps.db, audit, deps.env ?? process.env);
  const authorizer = new Authorizer({ payoutHighValueMinor: (q) => flags.getIn(q, 'approvals.payout_high_value_minor') });
  const bus = new CommandBus(deps.db, authorizer, audit, new StepUpGrants(clock), clock);
  const auth = new AuthService({ db: deps.db, otp: deps.otp, secrets: deps.secrets, audit, clock });
  const staffAuth = new StaffAuthService({ db: deps.db, secrets: deps.secrets, audit, clock });
  const documents = documentCommands({ blobs: deps.blobs, scanner: deps.scanner, secrets: deps.secrets });
  return { db: deps.db, audit, flags, authorizer, bus, auth, staffAuth, documents };
}

export type CoreServices = ReturnType<typeof createCoreServices>;
