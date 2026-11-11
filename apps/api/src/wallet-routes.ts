// P04 HTTP surface: wallet drafts, evidence, verification, suspension, fraud
// flags, and the public (no-login) wallet page / QR / report. Thin: parse,
// resolve the session, run a command through core.bus. Public endpoints answer
// 404 for every wallet that is not ACTIVE (docs/05), identical to an unknown slug.
import { createHmac, randomBytes } from 'node:crypto';
import { AuthenticationError, DOCUMENT_LIMITS, NotFoundError, SYSTEM_ACTOR, ValidationError, type Actor, type CoreServices } from '@chema/core';
import {
  CHECKLIST_ITEMS,
  EVIDENCE_DOCUMENT_CLASS,
  EVIDENCE_TYPES,
  REPORT_CATEGORIES,
  SUSPEND_REASON_CODES,
  VERIFICATION_OUTCOMES,
  VERIFICATION_REASON_CODES,
  publicWalletQr,
  publicWalletView,
  type Checklist,
  type WalletCommands,
} from '@chema/wallet';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { deviceOf } from './session';

export interface WalletWiring {
  commands: WalletCommands;
  /** Base URL of the public web app (share links + QR). */
  publicBaseUrl: string;
  /** HMAC key for reporter IP hashes (abuse brake without storing IPs). Random per process if unset. */
  ipHashKey?: Buffer;
  /** P05: the full public page (privacy-filtered). Without it, the P04 minimal view is served. */
  publicPage?: (slug: string) => Promise<unknown>;
}

/** Money and other bigints leave the API as strings. */
function json<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
}

const Uuid = z.uuid();
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Slug = z.string().regex(/^[a-z2-7]{26}$/);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new ValidationError('invalid request');
  return r.data;
}

const DraftBody = z.object({
  deceasedName: z.string().min(1).max(200),
  dateOfDeath: IsoDate,
  funeralDate: IsoDate.optional(),
  funeralLocation: z.string().min(1).max(200),
  familyContactPhone: z.string().max(20).optional(),
  targetMinor: z.string().regex(/^[1-9]\d{0,14}$/).optional(),
  currency: z.enum(['USD', 'ZWG']),
  adminPhone: z.string().max(20).optional(),
  fidelity: z.object({ policyNo: z.string().max(64).optional(), nationalId: z.string().max(64).optional() }).optional(),
});

const EvidenceBody = z.union([
  z.object({
    documentId: Uuid,
    evidenceType: z.enum(EVIDENCE_TYPES),
    certificateNumber: z.string().min(3).max(64).optional(),
  }),
  // Upload + attach in one call (web form): bytes go through document.upload first.
  z.object({
    evidenceType: z.enum(EVIDENCE_TYPES),
    contentType: z.string().max(100),
    dataBase64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
    certificateNumber: z.string().min(3).max(64).optional(),
  }),
]);

const ChecklistBody = z.object(Object.fromEntries(CHECKLIST_ITEMS.map((i) => [i, z.enum(['PASS', 'FAIL'])])) as Record<
  (typeof CHECKLIST_ITEMS)[number],
  z.ZodEnum<{ PASS: 'PASS'; FAIL: 'FAIL' }>
>).strict();

export function registerWalletRoutes(app: FastifyInstance, core: CoreServices, wiring: WalletWiring): void {
  const w = wiring.commands;
  const ipKey = wiring.ipHashKey ?? randomBytes(32);

  async function sessionActor(req: FastifyRequest): Promise<Actor | null> {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
    return token ? core.auth.authenticate(token, { device: deviceOf(req) }) : null;
  }
  async function requireActor(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const actor = await sessionActor(req);
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
  const idParam = (req: FastifyRequest) => parse(z.object({ id: Uuid }), req.params).id;

  // ── Family / agent ─────────────────────────────────────────────────────────
  app.post('/wallets', { preHandler: requireActor }, async (req, reply) => {
    const b = parse(DraftBody, req.body);
    const view = await core.bus.execute(
      w.createDraft,
      {
        deceasedName: b.deceasedName,
        dateOfDeath: b.dateOfDeath,
        funeralLocation: b.funeralLocation,
        currency: b.currency,
        ...(b.funeralDate ? { funeralDate: b.funeralDate } : {}),
        ...(b.familyContactPhone ? { familyContactPhone: b.familyContactPhone } : {}),
        ...(b.targetMinor ? { targetMinor: BigInt(b.targetMinor) } : {}),
        ...(b.adminPhone ? { adminPhone: b.adminPhone } : {}),
        ...(b.fidelity
          ? { fidelity: { ...(b.fidelity.policyNo ? { policyNo: b.fidelity.policyNo } : {}), ...(b.fidelity.nationalId ? { nationalId: b.fidelity.nationalId } : {}) } }
          : {}),
      },
      { actor: actorOf(req) },
    );
    return reply.code(201).send(view);
  });

  app.get('/wallets/:id', { preHandler: requireActor }, async (req, reply) => {
    const view = await core.bus.execute(w.view, { walletId: idParam(req) }, { actor: actorOf(req) });
    return reply.header('cache-control', 'no-store').send(view);
  });

  // People on the wallet (admin / approver): ids to nominate a claim recipient or bind a payee.
  app.get('/wallets/:id/people', { preHandler: requireActor }, async (req, reply) => {
    const people = await core.bus.execute(w.people, { walletId: idParam(req) }, { actor: actorOf(req) });
    return reply.header('cache-control', 'no-store').send({ people });
  });

  // base64 inflates 4/3 (integer maths) + JSON envelope slack.
  const maxBody = Number((BigInt(DOCUMENT_LIMITS.maxBytes) * 4n + 2n) / 3n) + 64 * 1024;

  app.post('/wallets/:id/evidence', { preHandler: requireActor, bodyLimit: maxBody }, async (req, reply) => {
    const walletId = idParam(req);
    const b = parse(EvidenceBody, req.body);
    const actor = actorOf(req);
    let documentId: string;
    if ('documentId' in b) {
      documentId = b.documentId;
    } else {
      const meta = await core.bus.execute(
        core.documents.upload,
        { class: EVIDENCE_DOCUMENT_CLASS[b.evidenceType], contentType: b.contentType, data: Buffer.from(b.dataBase64, 'base64'), walletId },
        { actor },
      );
      documentId = meta.id;
    }
    const ev = await core.bus.execute(
      w.addEvidence,
      { walletId, documentId, evidenceType: b.evidenceType, ...(b.certificateNumber ? { certificateNumber: b.certificateNumber } : {}) },
      { actor },
    );
    return reply.code(201).send(ev);
  });

  app.post('/wallets/:id/submit', { preHandler: requireActor }, async (req) =>
    core.bus.execute(w.submit, { walletId: idParam(req) }, { actor: actorOf(req) }),
  );

  app.post('/wallets/:id/appeal', { preHandler: requireActor }, async (req) => {
    const b = parse(z.object({ reason: z.string().max(2000) }), req.body);
    return core.bus.execute(w.appeal, { walletId: idParam(req), reason: b.reason }, { actor: actorOf(req) });
  });

  // ── Staff ──────────────────────────────────────────────────────────────────
  app.post('/wallets/:id/assign-verifier', { preHandler: requireActor }, async (req) => {
    const b = parse(z.object({ verifierPersonId: Uuid }), req.body);
    return core.bus.execute(w.assign, { walletId: idParam(req), verifierPersonId: b.verifierPersonId }, { actor: actorOf(req) });
  });

  app.get('/verification/queue', { preHandler: requireActor }, async (req) => ({
    cases: await core.bus.execute(w.queue, {}, { actor: actorOf(req) }),
  }));

  app.post('/verification/cases/:id/decide', { preHandler: requireActor }, async (req) => {
    const b = parse(
      z.object({
        outcome: z.enum(VERIFICATION_OUTCOMES),
        reasonCode: z.enum(VERIFICATION_REASON_CODES),
        checklist: ChecklistBody,
        notes: z.string().max(2000).optional(),
      }),
      req.body,
    );
    return core.bus.execute(
      w.decide,
      { caseId: idParam(req), outcome: b.outcome, reasonCode: b.reasonCode, checklist: b.checklist as Checklist, ...(b.notes ? { notes: b.notes } : {}) },
      { actor: actorOf(req) },
    );
  });

  app.post('/wallets/:id/suspend', { preHandler: requireActor }, async (req) => {
    const b = parse(z.object({ reasonCode: z.enum(SUSPEND_REASON_CODES), note: z.string().max(2000) }), req.body);
    return core.bus.execute(w.suspend, { walletId: idParam(req), reasonCode: b.reasonCode, note: b.note }, { actor: actorOf(req) });
  });

  app.post('/wallets/:id/unsuspend', { preHandler: requireActor }, async (req) => {
    const b = parse(z.object({ note: z.string().max(2000) }), req.body);
    return core.bus.execute(w.unsuspend, { walletId: idParam(req), note: b.note }, { actor: actorOf(req) });
  });

  app.post('/fraud-flags/:id/review', { preHandler: requireActor }, async (req) => {
    const b = parse(z.object({ outcome: z.enum(['DISMISSED', 'CONFIRMED']), note: z.string().max(2000) }), req.body);
    return core.bus.execute(w.reviewFlag, { flagId: idParam(req), outcome: b.outcome, note: b.note }, { actor: actorOf(req) });
  });

  // ── Public (no login). Non-ACTIVE ⇒ 404, same as an unknown slug. ──────────
  // A malformed slug is the same 404 as an unknown or unverified one.
  const slugParam = (req: FastifyRequest) => {
    const r = z.object({ slug: Slug }).safeParse(req.params);
    if (!r.success) throw new NotFoundError('wallet', 'public');
    return r.data.slug;
  };

  app.get('/public/wallets/:slug', async (req, reply) => {
    const slug = slugParam(req);
    const view = wiring.publicPage ? await wiring.publicPage(slug) : await publicWalletView(core.db, slug, wiring.publicBaseUrl);
    return reply.header('cache-control', 'no-store').send(json(view));
  });

  app.get('/public/wallets/:slug/qr.svg', async (req, reply) => {
    const svg = await publicWalletQr(core.db, slugParam(req), wiring.publicBaseUrl);
    return reply.type('image/svg+xml').header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').send(svg);
  });

  app.post('/public/wallets/:slug/report', async (req, reply) => {
    const slug = slugParam(req);
    const b = parse(z.object({ category: z.enum(REPORT_CATEGORIES), details: z.string().max(1000).optional() }), req.body);
    // Logged-in reporters act as themselves; anonymous ones as SYSTEM with a keyed IP hash.
    const actor = (await sessionActor(req)) ?? { ...SYSTEM_ACTOR, channel: 'WEB' as const, ip: req.ip };
    const reporterIpHash = createHmac('sha256', ipKey).update(req.ip).digest('hex');
    const out = await core.bus.execute(
      w.report,
      { slug, category: b.category, reporterIpHash, ...(b.details ? { details: b.details } : {}) },
      { actor },
    );
    return reply.code(202).send({ received: true, reportId: out.reportId });
  });
}
