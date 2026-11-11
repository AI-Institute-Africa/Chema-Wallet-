// OpsService: the admin portal's one entry point for P09. Like the other
// services it only sequences bus commands; nothing here bypasses the bus.
import { decideApproval, requestFlagChange, type Actor, type Command, type CoreServices } from '@chema/core';
import { walletTimeline, verifyAuditChain } from './audit-explorer';
import {
  flagApply,
  ledgerAdjust,
  reconAssign,
  reconResolve,
  staffAssign,
  staffEnroll,
  staffSetDisabled,
  staffUnassign,
  supportClose,
  type OpsDeps,
} from './commands';
import {
  accessReview,
  adjustmentAccounts,
  approvalQueue,
  claimQueue,
  configView,
  failures,
  fraudQueue,
  holdRegister,
  supportQueue,
} from './queues';
import { agentReport, familyReport, financeReport, managementReport, regulatorExport } from './reports';

export type OpsCore = Pick<CoreServices, 'bus' | 'flags' | 'staffAuth' | 'authorizer'>;

export class OpsService {
  readonly commands;
  readonly queues;
  readonly reports;
  readonly audit = { walletTimeline, verifyChain: verifyAuditChain };

  constructor(
    private readonly core: OpsCore,
    clock: () => Date = () => new Date(),
  ) {
    const deps: OpsDeps = { flags: core.flags, staffAuth: core.staffAuth, clock };
    this.commands = {
      ledgerAdjust: ledgerAdjust(),
      reconAssign,
      reconResolve: reconResolve(deps),
      staffEnroll: staffEnroll(deps),
      staffSetDisabled: staffSetDisabled(deps),
      staffAssign,
      staffUnassign,
      flagRequest: requestFlagChange(core.flags),
      flagApply: flagApply(deps),
      supportClose: supportClose(deps),
      decide: decideApproval,
    };
    const qd = { flags: core.flags, authorizer: core.authorizer, clock };
    this.queues = {
      approvals: approvalQueue(qd),
      claims: claimQueue,
      fraud: fraudQueue,
      holds: holdRegister(qd),
      config: configView(qd),
      accessReview,
      failures,
      support: supportQueue,
      adjustmentAccounts,
    };
    this.reports = {
      management: managementReport(clock),
      finance: financeReport(clock),
      agent: agentReport,
      family: familyReport,
      regulator: regulatorExport(clock),
    };
  }

  run<I, O>(actor: Actor, cmd: Command<I, O>, input: I): Promise<O> {
    return this.core.bus.execute(cmd, input, { actor });
  }
}
