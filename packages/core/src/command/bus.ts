// Command bus: the only way to run a state-changing (or sensitive-read)
// operation. In ONE transaction it resolves the subject server-side,
// authorises (deny by default), checks step-up, runs the handler and writes the
// ALLOWED audit row. Denials roll back and are audited in their own
// transaction. Handlers receive a CommandTx, which only the bus hands out, so
// a mutating service cannot be called without going through here.
import type { Queryable, SqlClient } from '@chema/shared';
import type { AuditSink } from '../audit/sink';
import type { Authorizer, Decision } from '../authz/authorize';
import { STEP_UP_ACTIONS, type Action } from '../authz/matrix';
import { actorRoleLabel, type Actor, type Subject } from '../authz/types';
import { ForbiddenError, NotFoundError } from '../errors';

declare const COMMAND_TX: unique symbol;
/** A transaction opened by the CommandBus. Accept this (not Queryable) in mutating service code. */
export type CommandTx = Queryable & { readonly [COMMAND_TX]: true };

export interface AuditDetail {
  /** Override when the subject is created by the command (new id). */
  subjectId?: string;
  before?: unknown;
  after?: unknown;
  txnRef?: string;
  approvalRef?: string;
  reasonCode?: string;
}

export interface CommandOutcome<O> {
  result: O;
  audit?: AuditDetail;
}

export interface RunContext {
  actor: Actor;
  action: Action;
  subject: Subject;
  decision: Decision;
}

export interface Command<I, O> {
  /** Audit action name, e.g. 'consent.grant'. */
  readonly name: string;
  /** Load the subject from the database by id. Throw NotFoundError if absent. */
  resolve(q: Queryable, input: I, actor: Actor): Promise<{ action: Action; subject: Subject }>;
  run(tx: CommandTx, input: I, ctx: RunContext): Promise<CommandOutcome<O>>;
}

export interface ExecContext {
  actor: Actor;
  stepUpToken?: string;
}

export interface StepUpConsumer {
  /** Atomically consume a grant bound to this session + action + subject. */
  consume(tx: Queryable, actor: Actor, token: string, action: Action, subject: Subject): Promise<boolean>;
}

class Denied extends Error {
  constructor(
    readonly reason: string,
    readonly subjectType: string,
    readonly subjectId: string,
  ) {
    super(reason);
  }
}

export class CommandBus {
  constructor(
    private readonly db: SqlClient,
    private readonly authorizer: Authorizer,
    private readonly audit: AuditSink,
    private readonly stepUp: StepUpConsumer,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute<I, O>(cmd: Command<I, O>, input: I, ctx: ExecContext): Promise<O> {
    const { actor } = ctx;
    const base = {
      action: cmd.name,
      actorId: actor.personId,
      actorRole: actorRoleLabel(actor),
      channel: actor.channel,
      ...(actor.sessionId ? { sessionRef: actor.sessionId } : {}),
      ...(actor.ip ? { ip: actor.ip } : {}),
      ...(actor.device ? { device: actor.device } : {}),
    };
    try {
      return await this.db.transaction(async (tx) => {
        let resolved: { action: Action; subject: Subject };
        try {
          resolved = await cmd.resolve(tx, input, actor);
        } catch (err) {
          if (err instanceof NotFoundError) throw new Denied('NOT_FOUND', err.subjectType, err.subjectId);
          throw err;
        }
        const { action, subject } = resolved;
        const decision = await this.authorizer.authorize(tx, actor, action, subject);
        if (!decision.allowed) throw new Denied(decision.reason, subject.type, subject.id);

        if (STEP_UP_ACTIONS.has(action)) {
          const ok = ctx.stepUpToken !== undefined && (await this.stepUp.consume(tx, actor, ctx.stepUpToken, action, subject));
          if (!ok) throw new Denied('STEP_UP_REQUIRED', subject.type, subject.id);
        }

        const out = await cmd.run(tx as CommandTx, input, { actor, action, subject, decision });
        const a = out.audit ?? {};
        await this.audit.record(
          {
            ...base,
            subjectType: subject.type,
            subjectId: a.subjectId ?? subject.id,
            authzResult: 'ALLOWED',
            ...(a.reasonCode ? { reasonCode: a.reasonCode } : {}),
            ...(a.approvalRef ? { approvalRef: a.approvalRef } : {}),
            ...(a.txnRef ? { txnRef: a.txnRef } : {}),
            ...('before' in a ? { before: a.before } : {}),
            ...('after' in a ? { after: a.after } : {}),
            ts: this.clock(),
          },
          tx,
        );
        return out.result;
      });
    } catch (err) {
      if (!(err instanceof Denied)) throw err;
      await this.audit.record({
        ...base,
        subjectType: err.subjectType,
        subjectId: err.subjectId,
        authzResult: 'DENIED',
        reasonCode: err.reason,
        ts: this.clock(),
      });
      if (err.reason === 'NOT_FOUND') throw new NotFoundError(err.subjectType, err.subjectId);
      throw new ForbiddenError(err.reason);
    }
  }
}
