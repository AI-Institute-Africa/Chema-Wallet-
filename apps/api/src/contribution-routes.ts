// P05 HTTP surface (docs/06): public page extras (live total, tributes, photo),
// the no-account contribute flow, the signed contribution link (status,
// receipt, re-issue, tribute removal/appeal), family privacy + photo, tribute
// moderation, groups. Thin: parse, pick the actor, call ContributionService.
//
// The contribution link token travels in the `x-contribution-token` header
// (the web page reads it from the URL fragment), so it never reaches access
// logs. A bad or missing link is a 404, identical to an unknown contribution.
import {
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  publicActor,
  type Actor,
  type CoreServices,
} from '@chema/core';
import { CONTACT_KINDS, PRIVACY_KEYS, type ContributionService, type PrivacySettings } from '@chema/contributions';
import { CURRENCIES, money } from '@chema/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

const Uuid = z.uuid();
const Slug = z.string().regex(/^[a-z2-7]{26}$/);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/;
const PHOTO_MAX_BYTES = 2 * 1024 * 1024;

/** Money and other bigints leave the API as strings. */
function json<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new ValidationError('invalid request');
  return r.data;
}

const ContributeBody = z.object({
  rail: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/),
  amount: z.object({ minor: z.string().regex(/^[1-9][0-9]{0,15}$/), ccy: z.enum(CURRENCIES) }),
  payerName: z.string().max(120),
  payerPhone: z.string().max(20),
  anonymous: z.boolean(),
  displayName: z.string().max(60).optional(),
  tribute: z.string().max(500).optional(),
  contact: z.object({ kind: z.enum(CONTACT_KINDS), value: z.string().max(254) }).optional(),
  groupId: Uuid.optional(),
});

const PrivacyBody = z
  .object(Object.fromEntries(PRIVACY_KEYS.map((k) => [k, z.boolean().optional()])) as Record<(typeof PRIVACY_KEYS)[number], z.ZodOptional<z.ZodBoolean>>)
  .strict();

export function registerContributionRoutes(app: FastifyInstance, core: CoreServices, contributions: ContributionService): void {
  async function sessionActor(req: FastifyRequest): Promise<Actor | null> {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
    return token ? core.auth.authenticate(token) : null;
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
  const guestOf = (req: FastifyRequest): Actor => publicActor({ ip: req.ip, requestRef: String(req.id) });

  const slugParam = (req: FastifyRequest) => {
    const r = z.object({ slug: Slug }).safeParse(req.params);
    if (!r.success) throw new NotFoundError('wallet', 'public');
    return r.data.slug;
  };
  const idParam = (req: FastifyRequest) => {
    const r = z.object({ id: Uuid }).safeParse(req.params);
    if (!r.success) throw new NotFoundError('contribution', 'bad-id');
    return r.data.id;
  };
  const linkOf = (req: FastifyRequest) => {
    const h = req.headers['x-contribution-token'];
    const v = Array.isArray(h) ? h[0] : h;
    return v && v.length <= 100 ? v : undefined;
  };
  /** The link holder acts as PUBLIC (capability); without a link, the session owner. */
  async function linkActor(req: FastifyRequest): Promise<Actor> {
    if (linkOf(req)) return guestOf(req);
    return (await sessionActor(req)) ?? guestOf(req);
  }
  /** A bad link is indistinguishable from an unknown contribution. */
  async function viaLink<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ForbiddenError && (err.reason === 'BAD_LINK' || err.reason === 'NOT_OWNER')) throw new NotFoundError('contribution', 'link');
      throw err;
    }
  }

  // ── Public page extras ─────────────────────────────────────────────────────
  // Live total (short polling): derived from the ledger on every call.
  app.get('/public/wallets/:slug/total', async (req, reply) => {
    const totals = await contributions.total(slugParam(req));
    if (!totals) throw new NotFoundError('wallet', 'public');
    return reply.header('cache-control', 'no-store').send(json(totals));
  });

  app.get('/public/wallets/:slug/tributes', async (req, reply) => {
    const q = parse(z.object({ before: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(100).optional() }), req.query);
    const list = await contributions.tributes(slugParam(req), { ...(q.before ? { before: new Date(q.before) } : {}), ...(q.limit ? { limit: q.limit } : {}) });
    if (!list) throw new NotFoundError('wallet', 'public');
    return reply.header('cache-control', 'no-store').send(json({ tributes: list }));
  });

  app.get('/public/wallets/:slug/photo', async (req, reply) => {
    const docId = await contributions.photoDocument(slugParam(req));
    const photo = await core.documents.openPublicPhoto(core.db, docId);
    return reply
      .type(photo.contentType)
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'")
      .send(photo.data);
  });

  // ── Contribute (no account needed) ─────────────────────────────────────────
  // Disclosure before checkout: what will be charged, the fee and who pays it, FX, what the family receives.
  app.post('/public/wallets/:slug/quote', async (req, reply) => {
    const b = parse(z.object({ rail: ContributeBody.shape.rail, amount: ContributeBody.shape.amount }), req.body);
    const d = await contributions.quote(slugParam(req), b.rail, money(BigInt(b.amount.minor), b.amount.ccy));
    return reply.header('cache-control', 'no-store').send(json(d));
  });

  app.post('/public/wallets/:slug/contributions', async (req, reply) => {
    const slug = slugParam(req);
    const keyHeader = req.headers['idempotency-key'];
    const idempotencyKey = typeof keyHeader === 'string' ? keyHeader : '';
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return reply.code(400).send({ error: 'idempotency_key_required' });
    const b = parse(ContributeBody, req.body);
    const actor = (await sessionActor(req)) ?? guestOf(req);
    const out = await contributions.contribute(actor, {
      slug,
      rail: b.rail,
      amount: money(BigInt(b.amount.minor), b.amount.ccy),
      idempotencyKey,
      payerName: b.payerName,
      payerPhone: b.payerPhone,
      anonymous: b.anonymous,
      ...(b.displayName !== undefined ? { displayName: b.displayName } : {}),
      ...(b.tribute !== undefined ? { tribute: b.tribute } : {}),
      ...(b.contact ? { contact: b.contact } : {}),
      ...(b.groupId ? { groupId: b.groupId } : {}),
    });
    return reply.code(out.replayed ? 200 : 201).header('cache-control', 'no-store').send(json(out));
  });

  app.post('/public/wallets/:slug/groups', { preHandler: requireActor }, async (req, reply) => {
    const b = parse(z.object({ name: z.string().max(120) }), req.body);
    const g = await core.bus.execute(contributions.commands.createGroup, { slug: slugParam(req), name: b.name }, { actor: actorOf(req) });
    return reply.code(201).send(g);
  });

  // ── Signed contribution link ───────────────────────────────────────────────
  app.get('/public/contributions/:id', async (req, reply) => {
    const id = idParam(req);
    const actor = await linkActor(req);
    const v = await viaLink(() => contributions.view(actor, id, linkOf(req)));
    return reply.header('cache-control', 'no-store').send(json(v));
  });

  app.post('/public/contributions/:id/receipt/reissue', async (req, reply) => {
    const id = idParam(req);
    const actor = await linkActor(req);
    const r = await viaLink(() => contributions.reissueReceipt(actor, id, linkOf(req)));
    return reply.header('cache-control', 'no-store').send(json(r));
  });

  app.post('/public/contributions/:id/tribute/remove', async (req) => {
    const id = idParam(req);
    const actor = await linkActor(req);
    return viaLink(() => contributions.removeTribute(actor, id, linkOf(req)));
  });

  app.post('/public/contributions/:id/tribute/appeal', async (req) => {
    const id = idParam(req);
    const b = parse(z.object({ reason: z.string().max(1000).optional() }), req.body ?? {});
    const actor = await linkActor(req);
    return viaLink(() => contributions.appealTribute(actor, id, b.reason, linkOf(req)));
  });

  app.get('/contributions/mine', { preHandler: requireActor }, async (req, reply) => {
    const list = await core.bus.execute(contributions.commands.listMine, {}, { actor: actorOf(req) });
    return reply.header('cache-control', 'no-store').send(json({ contributions: list }));
  });

  // ── Family: privacy + photo ────────────────────────────────────────────────
  const walletId = (req: FastifyRequest) => parse(z.object({ id: Uuid }), req.params).id;

  app.get('/wallets/:id/privacy', { preHandler: requireActor }, async (req, reply) => {
    const v = await core.bus.execute(contributions.commands.viewPrivacy, { walletId: walletId(req) }, { actor: actorOf(req) });
    return reply.header('cache-control', 'no-store').send(v);
  });

  app.put('/wallets/:id/privacy', { preHandler: requireActor }, async (req) => {
    const settings = parse(PrivacyBody, req.body) as Partial<PrivacySettings>;
    return core.bus.execute(contributions.commands.updatePrivacy, { walletId: walletId(req), settings }, { actor: actorOf(req) });
  });

  const photoBodyLimit = Number((BigInt(PHOTO_MAX_BYTES) * 4n + 2n) / 3n) + 16 * 1024;
  app.post('/wallets/:id/photo', { preHandler: requireActor, bodyLimit: photoBodyLimit }, async (req, reply) => {
    const id = walletId(req);
    const b = parse(z.object({ contentType: z.enum(['image/jpeg', 'image/png']), dataBase64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/) }), req.body);
    const data = Buffer.from(b.dataBase64, 'base64');
    if (data.length === 0 || data.length > PHOTO_MAX_BYTES) throw new ValidationError('bad photo size');
    const actor = actorOf(req);
    // The photo is scanned by the worker; it is set on the wallet once CLEAN (POST .../photo/:docId).
    const meta = await core.bus.execute(core.documents.upload, { class: 'PHOTO', contentType: b.contentType, data, walletId: id }, { actor });
    return reply.code(201).send(meta);
  });

  app.put('/wallets/:id/photo', { preHandler: requireActor }, async (req) => {
    const b = parse(z.object({ documentId: Uuid.nullable() }), req.body);
    return core.bus.execute(contributions.commands.setPhoto, { walletId: walletId(req), documentId: b.documentId }, { actor: actorOf(req) });
  });

  // ── Staff: tribute moderation ──────────────────────────────────────────────
  app.get('/tributes/review-queue', { preHandler: requireActor }, async (req, reply) => {
    const items = await core.bus.execute(contributions.commands.moderationQueue, {}, { actor: actorOf(req) });
    return reply.header('cache-control', 'no-store').send({ items });
  });

  app.post('/tributes/:id/moderate', { preHandler: requireActor }, async (req) => {
    const id = parse(z.object({ id: Uuid }), req.params).id;
    const b = parse(z.object({ outcome: z.enum(['APPROVE', 'REJECT', 'HIDE']), note: z.string().max(1000).optional() }), req.body);
    return core.bus.execute(contributions.commands.moderate, { tributeId: id, outcome: b.outcome, ...(b.note ? { note: b.note } : {}) }, { actor: actorOf(req) });
  });
}
