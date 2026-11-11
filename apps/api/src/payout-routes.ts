// P07 HTTP surface (docs/08): payees, payout plans, approvals (decide /
// escalate), cases, holds, mandate changes, closure. Thin: parse, resolve the
// session, call PayoutService. Money is `{ minor: "string", ccy }` on the wire.
// Step-up actions read the `x-step-up-token` header.
import { AuthenticationError, type Actor, type CoreServices } from '@chema/core';
import {
  CASE_OUTCOMES,
  CLOSURE_REASONS,
  HOLD_REASONS,
  MANDATE_CHANGE_KINDS,
  MANDATE_VERIFY_REASONS,
  OPENABLE_CASE_TYPES,
  PAYOUT_PURPOSES,
  PAYOUT_RAILS,
  PAYOUT_SOURCES,
  SEVERITIES,
  type PayoutService,
} from '@chema/payouts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

const Uuid = z.uuid();
const Minor = z.string().regex(/^[1-9][0-9]{0,15}$/);
const Phone = z.string().regex(/^\+[1-9][0-9]{6,14}$/);
const Note = z.string().min(10).max(2000);
const Ccy = z.enum(['USD', 'ZWG']);

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

export function registerPayoutRoutes(app: FastifyInstance, core: CoreServices, payouts: PayoutService): void {
  async function requireActor(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
    const actor = token ? await core.auth.authenticate(token) : null;
    if (!actor) {
      await reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    req.actor = actor;
  }
  const actorOf = (req: FastifyRequest): Actor => {
    if (!req.actor) throw new AuthenticationError('NO_SESSION');
    return req.actor;
  };
  const stepUp = (req: FastifyRequest): string | undefined => {
    const v = req.headers['x-step-up-token'];
    return typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : undefined;
  };
  const idOf = (req: FastifyRequest, reply: FastifyReply) => parse(z.object({ id: Uuid }), req.params, reply)?.id;
  const pre = { preHandler: requireActor };

  // ── Payees ──────────────────────────────────────────────────────────────
  app.post('/wallets/:id/payees', pre, async (req, reply) => {
    const id = idOf(req, reply);
    const b = parse(
      z.object({
        label: z.string().min(1).max(80),
        holderName: z.string().min(1).max(120),
        rail: z.enum(PAYOUT_RAILS),
        destination: Phone,
        personId: Uuid.optional(),
        replacesPayeeId: Uuid.optional(),
      }).strict(),
      req.body,
      reply,
    );
    if (!id || !b) return reply;
    const { personId, replacesPayeeId, ...rest } = b;
    const input = { walletId: id, ...rest, ...(personId ? { personId } : {}), ...(replacesPayeeId ? { replacesPayeeId } : {}) };
    return reply.code(201).send(json(await payouts.addPayee(actorOf(req), input, stepUp(req))));
  });

  app.get('/wallets/:id/payees', pre, async (req, reply) => {
    const id = idOf(req, reply);
    if (!id) return reply;
    return json(await payouts.run(actorOf(req), payouts.payees.list, { walletId: id }));
  });

  // ── Payouts ─────────────────────────────────────────────────────────────
  app.post('/wallets/:id/payouts', pre, async (req, reply) => {
    const id = idOf(req, reply);
    const b = parse(
      z.object({
        source: z.object({ kind: z.enum(PAYOUT_SOURCES), groupId: Uuid.optional() }).strict(),
        currency: Ccy,
        parts: z.array(z.object({ payeeId: Uuid, amountMinor: Minor, purpose: z.enum(PAYOUT_PURPOSES), note: z.string().max(500).optional() }).strict()).min(1).max(10),
        idempotencyKey: z.string().min(8).max(200),
      }).strict(),
      req.body,
      reply,
    );
    if (!id || !b) return reply;
    const input = {
      walletId: id,
      source: { kind: b.source.kind, ...(b.source.groupId ? { groupId: b.source.groupId } : {}) },
      currency: b.currency,
      parts: b.parts.map((p) => ({ payeeId: p.payeeId, amountMinor: BigInt(p.amountMinor), purpose: p.purpose, ...(p.note ? { note: p.note } : {}) })),
      idempotencyKey: b.idempotencyKey,
    };
    const r = await payouts.requestPayout(actorOf(req), input, stepUp(req));
    return reply.code(r.replayed ? 200 : 201).send(json(r));
  });

  app.get('/wallets/:id/payouts', pre, async (req, reply) => {
    const id = idOf(req, reply);
    if (!id) return reply;
    return json(await payouts.run(actorOf(req), payouts.payouts.list, { walletId: id }));
  });

  app.get('/payouts/:id', pre, async (req, reply) => {
    const id = idOf(req, reply);
    if (!id) return reply;
    return json(await payouts.run(actorOf(req), payouts.payouts.view, { payoutId: id }));
  });

  app.post('/payouts/:id/cancel', pre, async (req, reply) => {
    const id = idOf(req, reply);
    const b = parse(z.object({ reason: z.string().min(3).max(200) }).strict(), req.body, reply);
    if (!id || !b) return reply;
    return json(await payouts.run(actorOf(req), payouts.payouts.cancel, { payoutId: id, reason: b.reason }));
  });

  app.post('/payouts/:id/override', pre, async (req, reply) => {
    const id = idOf(req, reply);
    const b = parse(z.object({ externalRef: z.string().min(3).max(128), documentId: Uuid, approvalId: Uuid.optional() }).strict(), req.body, reply);
    if (!id || !b) return reply;
    const { approvalId, ...rest } = b;
    return json(await payouts.run(actorOf(req), payouts.payouts.override, { payoutId: id, ...rest, ...(approvalId ? { approvalId } : {}) }));
  });

  // ── Approvals (checker) ─────────────────────────────────────────────────
  app.post('/approvals/:id/decision', pre, async (req, reply) => {
    const id = idOf(req, reply);
    const b = parse(z.object({ decision: z.enum(['APPROVED', 'REJECTED']), reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).optional() }).strict(), req.body, reply);
    if (!id || !b) return reply;
    return json(await payouts.decide(actorOf(req), id, b.decision, b.reasonCode));
  });

  app.post('/approvals/:id/escalate', pre, async (req, reply) => {
    const id = idOf(req, reply);
    const b = parse(z.object({ reason: z.string().min(10).max(500) }).strict(), req.body, reply);
    if (!id || !b) return reply;
    return json(await payouts.escalateApproval(actorOf(req), id, b.reason));
  });

  // ── Cases + holds ───────────────────────────────────────────────────────
  app.post('/wallets/:id/cases', pre, async (req, reply) => {
    const id = idOf(req, reply);
    const b = parse(
      z.object({
        type: z.enum(OPENABLE_CASE_TYPES),
        summary: Note,
        severity: z.enum(SEVERITIES).optional(),
        source: z.object({ kind: z.enum(PAYOUT_SOURCES), groupId: Uuid.optional() }).strict().optional(),
        amount: z.object({ minor: Minor, ccy: Ccy }).strict().optional(),
        payoutRequestId: Uuid.optional(),
        evidenceDocs: z.array(Uuid).max(10).optional(),
        alsoHoldOtherSources: z.object({ reasonCode: z.enum(HOLD_REASONS), note: Note }).strict().optional(),
      }).strict(),
      req.body,
      reply,
    );
    if (!id || !b) return reply;
    const { amount, source, severity, payoutRequestId, evidenceDocs, alsoHoldOtherSources, ...rest } = b;
    const input = {
      walletId: id,
      ...rest,
      ...(severity ? { severity } : {}),
      ...(source ? { source: { kind: source.kind, ...(source.groupId ? { groupId: source.groupId } : {}) } } : {}),
      ...(amount ? { amount: { minor: BigInt(amount.minor), ccy: amount.ccy } } : {}),
      ...(payoutRequestId ? { payoutRequestId } : {}),
      ...(evidenceDocs ? { evidenceDocs } : {}),
      ...(alsoHoldOtherSources ? { alsoHoldOtherSources } : {}),
    };
    return reply.code(201).send(json(await payouts.run(actorOf(req), payouts.governance.open, input)));
  });

  app.get('/wallets/:id/cases', pre, async (req, reply) => {
    const id = idOf(req, reply);
    if (!id) return reply;
    return json(await payouts.run(actorOf(req), payouts.governance.listForWallet, { walletId: id }));
  });

  app.get('/cases', pre, async (req) => json(await payouts.run(actorOf(req), payouts.governance.queue, {})));

  app.get('/cases/:id', pre, async (req, reply) => {
    const id = idOf(req, reply);
    if (!id) return reply;
    return json(await payouts.run(actorOf(req), payouts.governance.view, { caseId: id }));
  });

  app.post('/cases/:id/assign', pre, async (req, reply) => {
    const id = idOf(req, reply);
    const b = parse(z.object({ assigneePersonId: Uuid }).strict(), req.body, reply);
    if (!id || !b) return reply;
    return json(await payouts.run(actorOf(req), payouts.governance.assign, { caseId: id, assigneePersonId: b.assigneePersonId }));
  });

  app.post('/cases/:id/update', pre, async (req, reply) => {
    const id = idOf(req, reply);
    const b = parse(z.object({ note: z.string().min(3).max(2000).optional(), evidenceDocs: z.array(Uuid).max(10).optional(), escalate: z.boolean().optional() }).strict(), req.body, reply);
    if (!id || !b) return reply;
    const input = { caseId: id, ...(b.note ? { note: b.note } : {}), ...(b.evidenceDocs ? { evidenceDocs: b.evidenceDocs } : {}), ...(b.escalate ? { escalate: true } : {}) };
    return json(await payouts.run(actorOf(req), payouts.governance.update, input));
  });

  app.post('/cases/:id/resolve', pre, async (req, reply) => {
    const id = idOf(req, reply);
    const b = parse(z.object({ outcome: z.enum(CASE_OUTCOMES), note: Note }).strict(), req.body, reply);
    if (!id || !b) return reply;
    return json(await payouts.run(actorOf(req), payouts.governance.resolve, { caseId: id, ...b }));
  });

  app.post('/wallets/:id/holds', pre, async (req, reply) => {
    const id = idOf(req, reply);
    const b = parse(
      z.object({
        scope: z.enum(['SOURCE', 'WALLET']),
        source: z.object({ kind: z.enum(PAYOUT_SOURCES), groupId: Uuid.optional() }).strict().optional(),
        reasonCode: z.enum(HOLD_REASONS),
        note: Note,
        caseId: Uuid.optional(),
        reviewInDays: z.number().int().min(1).max(30).optional(),
      }).strict(),
      req.body,
      reply,
    );
    if (!id || !b) return reply;
    const { source, caseId, reviewInDays, ...rest } = b;
    const input = {
      walletId: id,
      ...rest,
      reviewAt: new Date(),
      ...(source ? { source: { kind: source.kind, ...(source.groupId ? { groupId: source.groupId } : {}) } } : {}),
      ...(caseId ? { caseId } : {}),
      ...(reviewInDays ? { reviewInDays } : {}),
    };
    return reply.code(201).send(json(await payouts.run(actorOf(req), payouts.governance.holdPlace, input)));
  });

  app.post('/holds/:id/release', pre, async (req, reply) => {
    const id = idOf(req, reply);
    const b = parse(z.object({ reason: Note, approvalId: Uuid.optional() }).strict(), req.body, reply);
    if (!id || !b) return reply;
    return json(await payouts.run(actorOf(req), payouts.governance.holdRelease, { holdId: id, reason: b.reason, ...(b.approvalId ? { approvalId: b.approvalId } : {}) }));
  });

  // ── Mandate changes ─────────────────────────────────────────────────────
  app.post('/wallets/:id/mandate-changes', pre, async (req, reply) => {
    const id = idOf(req, reply);
    const b = parse(
      z.object({
        kind: z.enum(MANDATE_CHANGE_KINDS),
        newAdminPhone: Phone.optional(),
        approverPhone: Phone.optional(),
        approverPersonId: Uuid.optional(),
        reason: Note,
        evidenceDocs: z.array(Uuid).min(1).max(10),
      }).strict(),
      req.body,
      reply,
    );
    if (!id || !b) return reply;
    const { newAdminPhone, approverPhone, approverPersonId, ...rest } = b;
    const input = {
      walletId: id,
      ...rest,
      ...(newAdminPhone ? { newAdminPhone } : {}),
      ...(approverPhone ? { approverPhone } : {}),
      ...(approverPersonId ? { approverPersonId } : {}),
    };
    return reply.code(201).send(json(await payouts.run(actorOf(req), payouts.mandate.request, input, stepUp(req))));
  });

  app.get('/mandate-changes/:id', pre, async (req, reply) => {
    const id = idOf(req, reply);
    if (!id) return reply;
    return json(await payouts.run(actorOf(req), payouts.mandate.get, { changeId: id }));
  });

  app.post('/mandate-changes/:id/verify', pre, async (req, reply) => {
    const id = idOf(req, reply);
    const b = parse(z.object({ outcome: z.enum(['APPROVED', 'REJECTED']), reasonCode: z.enum(MANDATE_VERIFY_REASONS), note: z.string().max(2000).optional() }).strict(), req.body, reply);
    if (!id || !b) return reply;
    return json(await payouts.run(actorOf(req), payouts.mandate.verify, { changeId: id, outcome: b.outcome, reasonCode: b.reasonCode, ...(b.note ? { note: b.note } : {}) }));
  });

  app.post('/mandate-changes/:id/execute', pre, async (req, reply) => {
    const id = idOf(req, reply);
    if (!id) return reply;
    return json(await payouts.run(actorOf(req), payouts.mandate.execute, { changeId: id }));
  });

  // ── Closure ─────────────────────────────────────────────────────────────
  app.post('/wallets/:id/close', pre, async (req, reply) => {
    const id = idOf(req, reply);
    const b = parse(z.object({ kind: z.enum(['CLOSE', 'CANCEL']), reasonCode: z.enum(CLOSURE_REASONS), note: z.string().max(2000).optional() }).strict(), req.body, reply);
    if (!id || !b) return reply;
    return json(await payouts.run(actorOf(req), payouts.closure.start, { walletId: id, kind: b.kind, reasonCode: b.reasonCode, ...(b.note ? { note: b.note } : {}) }));
  });

  app.get('/wallets/:id/closure', pre, async (req, reply) => {
    const id = idOf(req, reply);
    if (!id) return reply;
    return json(await payouts.run(actorOf(req), payouts.closure.check, { walletId: id }));
  });

  app.post('/wallets/:id/close/finalise', pre, async (req, reply) => {
    const id = idOf(req, reply);
    if (!id) return reply;
    return json(await payouts.run(actorOf(req), payouts.closure.finalise, { walletId: id }));
  });

  app.post('/wallets/:id/thank-contributors', pre, async (req, reply) => {
    const id = idOf(req, reply);
    if (!id) return reply;
    return reply.code(202).send(json(await payouts.run(actorOf(req), payouts.closure.thank, { walletId: id })));
  });

  app.get('/wallets/:id/statements', pre, async (req, reply) => {
    const id = idOf(req, reply);
    if (!id) return reply;
    return json(await payouts.run(actorOf(req), payouts.closure.statements, { walletId: id }));
  });
}
