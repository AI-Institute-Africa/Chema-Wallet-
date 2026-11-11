// P09 HTTP surface for the admin portal (docs/12). Thin: parse, resolve the
// staff session, run an OpsService command through the bus. Approvals are
// decided on the shared checker route `POST /approvals/:id/decision`.
import {
  AuthenticationError,
  isFlagKey,
  MATRIX,
  NO_RELATIONS,
  principalsOf,
  STAFF_ROLES,
  type Action,
  type Actor,
  type CoreServices,
} from '@chema/core';
import type { OpsService } from '@chema/ops';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { deviceOf } from './session';

const Uuid = z.uuid();
const Note = z.string().min(10).max(1000);
const PeriodShape = z.object({ from: z.iso.datetime().optional(), to: z.iso.datetime().optional() });
const fromBeforeTo = (p: { from?: string | undefined; to?: string | undefined }) => !p.from || !p.to || Date.parse(p.from) < Date.parse(p.to);
const Period = PeriodShape.strict().refine(fromBeforeTo);

function json<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
}

function parse<T>(schema: z.ZodType<T>, value: unknown, reply: FastifyReply): T | undefined {
  const r = schema.safeParse(value);
  if (!r.success) {
    void reply.code(400).send({ error: 'invalid_request' });
    return undefined;
  }
  return r.data;
}

/** Portal sections and the action that gates each (nav is a hint; every call is re-authorised). */
export const PORTAL_SECTIONS: ReadonlyArray<{ id: string; action: Action }> = [
  { id: 'verification', action: 'verification.queue' },
  { id: 'claims', action: 'claim.queue' },
  { id: 'approvals', action: 'approval.queue' },
  { id: 'cases', action: 'case.assign' },
  { id: 'recon', action: 'recon.exception.view' },
  { id: 'moderation', action: 'tribute.moderate' },
  { id: 'fraud', action: 'fraud_flag.queue' },
  { id: 'holds', action: 'hold.register' },
  { id: 'mandates', action: 'mandate.queue' },
  { id: 'config', action: 'config.view' },
  { id: 'staff', action: 'role.review' },
  { id: 'ledger', action: 'ledger.adjust' },
  { id: 'reports', action: 'report.finance' },
  { id: 'management', action: 'report.management' },
  { id: 'agent', action: 'report.agent' },
  { id: 'audit', action: 'audit.explore' },
  { id: 'support', action: 'support.view' },
  { id: 'failures', action: 'ops.failures.view' },
];

export function sectionsFor(actor: Actor): string[] {
  const principals = principalsOf(actor, NO_RELATIONS);
  return PORTAL_SECTIONS.filter((s) => principals.some((p) => MATRIX[s.action][p] !== undefined)).map((s) => s.id);
}

export function registerAdminRoutes(app: FastifyInstance, core: CoreServices, ops: OpsService): void {
  async function requireStaff(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
    const actor = token ? await core.auth.authenticate(token, { device: deviceOf(req) }) : null;
    if (!actor) {
      await reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    // The portal is staff-only; customers use the web app and WhatsApp.
    if (actor.kind !== 'STAFF' || !actor.mfa) {
      await reply.code(403).send({ error: 'forbidden' });
      return;
    }
    req.actor = actor;
  }
  const actorOf = (req: FastifyRequest): Actor => {
    if (!req.actor) throw new AuthenticationError('NO_SESSION');
    return req.actor;
  };
  const pre = { preHandler: requireStaff };
  const idOf = (req: FastifyRequest, reply: FastifyReply) => parse(z.object({ id: Uuid }), req.params, reply)?.id;

  app.get('/admin/me', pre, async (req) => {
    const a = actorOf(req);
    return { personId: a.personId, role: a.staffRole, sections: sectionsFor(a) };
  });

  // ── Queues ───────────────────────────────────────────────────────────────
  const Q = ops.queues;
  app.get('/admin/queues/approvals', pre, async (req) => json(await ops.run(actorOf(req), Q.approvals, {})));
  app.get('/admin/queues/claims', pre, async (req) => json(await ops.run(actorOf(req), Q.claims, {})));
  app.get('/admin/queues/fraud', pre, async (req) => json(await ops.run(actorOf(req), Q.fraud, {})));
  app.get('/admin/queues/holds', pre, async (req, reply) => {
    const q = parse(z.object({ all: z.enum(['1', '0']).optional() }).strict(), req.query, reply);
    if (!q) return reply;
    return json(await ops.run(actorOf(req), Q.holds, { includeReleased: q.all === '1' }));
  });
  app.get('/admin/queues/mandate-changes', pre, async (req) => json(await ops.run(actorOf(req), Q.mandateChanges, {})));
  app.get('/admin/queues/config', pre, async (req) => json(await ops.run(actorOf(req), Q.config, {})));
  app.get('/admin/queues/failures', pre, async (req) => json(await ops.run(actorOf(req), Q.failures, {})));
  app.get('/admin/queues/support', pre, async (req, reply) => {
    const q = parse(z.object({ all: z.enum(['1', '0']).optional() }).strict(), req.query, reply);
    if (!q) return reply;
    return json(await ops.run(actorOf(req), Q.support, { includeClosed: q.all === '1' }));
  });
  app.get('/admin/staff', pre, async (req, reply) => {
    const q = parse(z.object({ format: z.enum(['json', 'csv']).optional() }).strict(), req.query, reply);
    if (!q) return reply;
    const r = await ops.run(actorOf(req), Q.accessReview, {});
    if (q.format === 'csv') return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="access-review.csv"').send(r.csv);
    return json(r.rows);
  });

  // The same export with what a sign-off attests to (sha256 + row count of the CSV) and past sign-offs.
  app.get('/admin/access-review', pre, async (req) => json(await ops.run(actorOf(req), Q.accessReview, {})));
  // Sign-off of the export above: the reviewer attests to its row count + sha256.
  app.post('/admin/access-review/signoffs', pre, async (req, reply) => {
    const b = parse(
      z.object({
        periodFrom: z.iso.datetime(),
        periodTo: z.iso.datetime(),
        rowCount: z.number().int().nonnegative(),
        csvSha256: z.string().regex(/^[0-9a-f]{64}$/),
        notes: z.string().min(10).max(2000),
      }).strict().refine((p) => Date.parse(p.periodFrom) < Date.parse(p.periodTo)),
      req.body,
      reply,
    );
    if (!b) return reply;
    return reply.code(201).send(json(await ops.run(actorOf(req), ops.commands.accessReviewSignoff, b)));
  });

  // Suspected compromise: end every customer session of one person (MFA, written reason).
  app.post('/admin/people/:id/sessions/revoke', pre, async (req, reply) => {
    const id = idOf(req, reply);
    const b = parse(z.object({ reason: Note }).strict(), req.body, reply);
    if (!id || !b) return reply;
    return json(await ops.run(actorOf(req), ops.commands.revokePersonSessions, { personId: id, reason: b.reason }));
  });

  // ── Ledger adjustment (maker-checker) ────────────────────────────────────
  app.get('/admin/ledger/accounts', pre, async (req, reply) => {
    const q = parse(z.object({ walletId: Uuid.optional() }).strict(), req.query, reply);
    if (!q) return reply;
    return json(await ops.run(actorOf(req), Q.adjustmentAccounts, q.walletId ? { walletId: q.walletId } : {}));
  });
  app.post('/admin/ledger/adjustments', pre, async (req, reply) => {
    const b = parse(
      z.object({
        entries: z
          .array(z.object({ accountId: Uuid, side: z.enum(['D', 'C']), minor: z.string().regex(/^[1-9][0-9]{0,15}$/), ccy: z.enum(['USD', 'ZWG']) }).strict())
          .min(2)
          .max(10),
        reason: Note,
        approvalId: Uuid.optional(),
      }).strict(),
      req.body,
      reply,
    );
    if (!b) return reply;
    const { approvalId, ...rest } = b;
    const out = await ops.run(actorOf(req), ops.commands.ledgerAdjust, { ...rest, ...(approvalId ? { approvalId } : {}) });
    return reply.code(out.status === 'POSTED' ? 201 : 202).send(json(out));
  });

  // ── Reconciliation exceptions ────────────────────────────────────────────
  app.post('/admin/recon/exceptions/:id/assign', pre, async (req, reply) => {
    const id = idOf(req, reply);
    if (!id) return reply;
    return json(await ops.run(actorOf(req), ops.commands.reconAssign, { exceptionId: id }));
  });
  app.post('/admin/recon/exceptions/:id/resolve', pre, async (req, reply) => {
    const id = idOf(req, reply);
    const b = parse(z.object({ resolution: Note }).strict(), req.body, reply);
    if (!id || !b) return reply;
    return json(await ops.run(actorOf(req), ops.commands.reconResolve, { exceptionId: id, resolution: b.resolution }));
  });

  // ── Staff / roles ────────────────────────────────────────────────────────
  app.post('/admin/staff', pre, async (req, reply) => {
    const b = parse(
      z.object({ login: z.string().regex(/^[a-z0-9._@-]{3,64}$/), role: z.enum(STAFF_ROLES), name: z.string().min(1).max(120).optional(), approvalId: Uuid.optional() }).strict(),
      req.body,
      reply,
    );
    if (!b) return reply;
    const { name, approvalId, ...rest } = b;
    const out = await ops.run(actorOf(req), ops.commands.staffEnroll, { ...rest, ...(name ? { name } : {}), ...(approvalId ? { approvalId } : {}) });
    // Secrets go to the enrolling admin once; never cached.
    return reply.header('cache-control', 'no-store').code(out.status === 'ENROLLED' ? 201 : 202).send(json(out));
  });
  app.post('/admin/staff/:id/disabled', pre, async (req, reply) => {
    const id = idOf(req, reply);
    const b = parse(z.object({ disabled: z.boolean(), reason: Note, approvalId: Uuid.optional() }).strict(), req.body, reply);
    if (!id || !b) return reply;
    const { approvalId, ...rest } = b;
    return json(await ops.run(actorOf(req), ops.commands.staffSetDisabled, { staffId: id, ...rest, ...(approvalId ? { approvalId } : {}) }));
  });
  app.post('/admin/assignments', pre, async (req, reply) => {
    const b = parse(z.object({ staffPersonId: Uuid, walletId: Uuid }).strict(), req.body, reply);
    if (!b) return reply;
    return reply.code(201).send(json(await ops.run(actorOf(req), ops.commands.staffAssign, b)));
  });
  app.post('/admin/assignments/:id/revoke', pre, async (req, reply) => {
    const id = idOf(req, reply);
    if (!id) return reply;
    return json(await ops.run(actorOf(req), ops.commands.staffUnassign, { assignmentId: id }));
  });

  // ── Config flags ─────────────────────────────────────────────────────────
  const FlagKeyParam = z.object({ key: z.string().regex(/^[a-z0-9_.]{3,80}$/) });
  const FlagValue = z.union([z.boolean(), z.number(), z.string().max(500), z.null(), z.array(z.string().max(20)).max(20)]);
  app.post('/admin/flags/:key/request', pre, async (req, reply) => {
    const p = parse(FlagKeyParam, req.params, reply);
    const b = parse(z.object({ value: FlagValue }).strict(), req.body, reply);
    if (!p || !b) return reply;
    if (!isFlagKey(p.key)) return reply.code(404).send({ error: 'not_found' });
    let value: unknown;
    try {
      value = core.flags.decodeStored(p.key, b.value);
    } catch {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    return reply.code(202).send(json(await ops.run(actorOf(req), ops.commands.flagRequest, { key: p.key, value: value as never })));
  });
  app.post('/admin/flags/:key', pre, async (req, reply) => {
    const p = parse(FlagKeyParam, req.params, reply);
    const b = parse(z.object({ value: FlagValue, reason: Note, approvalId: Uuid.optional() }).strict(), req.body, reply);
    if (!p || !b) return reply;
    const { approvalId, ...rest } = b;
    return json(await ops.run(actorOf(req), ops.commands.flagApply, { key: p.key, ...rest, ...(approvalId ? { approvalId } : {}) }));
  });

  // ── Support hand-off ─────────────────────────────────────────────────────
  app.post('/admin/support/:id/close', pre, async (req, reply) => {
    const id = idOf(req, reply);
    const b = parse(z.object({ note: Note }).strict(), req.body, reply);
    if (!id || !b) return reply;
    return json(await ops.run(actorOf(req), ops.commands.supportClose, { escalationId: id, note: b.note }));
  });

  // ── Reports ──────────────────────────────────────────────────────────────
  const period = (p: { from?: string | undefined; to?: string | undefined }) => ({ ...(p.from ? { from: p.from } : {}), ...(p.to ? { to: p.to } : {}) });
  app.get('/admin/reports/management', pre, async (req, reply) => {
    const q = parse(Period, req.query, reply);
    if (!q) return reply;
    return json(await ops.run(actorOf(req), ops.reports.management, period(q)));
  });
  app.get('/admin/reports/finance', pre, async (req, reply) => {
    const q = parse(Period, req.query, reply);
    if (!q) return reply;
    return json(await ops.run(actorOf(req), ops.reports.finance, period(q)));
  });
  app.get('/admin/reports/agent', pre, async (req) => json(await ops.run(actorOf(req), ops.reports.agent, {})));
  app.get('/admin/reports/family/:id', pre, async (req, reply) => {
    const id = idOf(req, reply);
    if (!id) return reply;
    return json(await ops.run(actorOf(req), ops.reports.family, { walletId: id }));
  });
  app.get('/admin/reports/regulator', pre, async (req, reply) => {
    const q = parse(PeriodShape.extend({ format: z.enum(['json', 'csv']).optional() }).strict().refine(fromBeforeTo), req.query, reply);
    if (!q) return reply;
    const r = await ops.run(actorOf(req), ops.reports.regulator, period(q));
    if (q.format === 'csv') return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="regulator-export.csv"').send(r.csv);
    return json(r);
  });

  // ── Audit explorer ───────────────────────────────────────────────────────
  app.get('/admin/audit/wallets/:id', pre, async (req, reply) => {
    const id = idOf(req, reply);
    if (!id) return reply;
    return json(await ops.run(actorOf(req), ops.audit.walletTimeline, { walletId: id }));
  });
  app.post('/admin/audit/verify', pre, async (req) => json(await ops.run(actorOf(req), ops.audit.verifyChain, {})));

}
