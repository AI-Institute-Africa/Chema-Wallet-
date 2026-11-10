// P05 public page + contribution journey (docs/06, docs/14 §S privacy rows, §A 10/11/13).
import { ConflictError, ForbiddenError, NotFoundError, RateLimitedError, SYSTEM_ACTOR, withdrawConsent } from '@chema/core';
import { getBalances } from '@chema/ledger';
import { money } from '@chema/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkToken } from './keys';
import { DeterministicModerationRules } from './moderation';
import { createContributionHarness, type ContributionHarness } from './test-support';

let t: ContributionHarness;

/** What the API would send (bigints as strings). */
const wire = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));
beforeEach(async () => {
  t = await createContributionHarness();
});
afterEach(async () => {
  await t.close();
});

async function providerRef(paymentId: string): Promise<string> {
  const { rows } = await t.h.db.query<{ provider_ref: string }>('SELECT provider_ref FROM payment WHERE id = $1', [paymentId]);
  return rows[0]!.provider_ref;
}

/** Guest contributes, provider confirms, worker runs. */
async function paid(slug: string, over: Parameters<ContributionHarness['input']>[1] = {}) {
  const r = await t.contributions.contribute(t.guest(), t.input(slug, over));
  t.ecocash.succeed(await providerRef(r.payment.id));
  await t.deliver(t.ecocash);
  await t.pump();
  return r;
}

async function auditRows(action: string) {
  const { rows } = await t.h.db.query<{ authz_result: string; reason_code: string | null; actor_role: string }>(
    'SELECT authz_result, reason_code, actor_role FROM audit_log WHERE action = $1 ORDER BY seq',
    [action],
  );
  return rows;
}

describe('contribute → receipt on the mock rail (done-when)', () => {
  it('a guest contributes with no account, sees pending, then the receipt via the signed link', async () => {
    const { slug, walletId, admin } = await t.publicWallet();
    const started = Date.now();
    const r = await t.contributions.contribute(t.guest(), t.input(slug));
    expect(Date.now() - started).toBeLessThan(5_000); // §A 13: initiation < 5 s (excl. provider)
    expect(r.payment.state).toBe('INITIATED');
    expect(r.payment.next).toMatchObject({ type: 'PROMPT' });
    expect(r.payment.disclosure.totalCharged).toEqual(money(10_00n, 'USD'));

    const pending = await t.contributions.view(t.guest(), r.contributionId, r.accessToken);
    expect(pending.receipt).toBeNull();
    expect(pending.tribute?.status).toBe('AWAITING_PAYMENT');
    // Nothing public before the money is confirmed.
    expect((await t.contributions.page(slug)).tributes).toEqual([]);
    expect((await t.contributions.page(slug)).totals?.raised).toEqual(money(0n, 'USD'));

    t.ecocash.succeed(await providerRef(r.payment.id));
    await t.deliver(t.ecocash);
    await t.pump();

    const done = await t.contributions.view(t.guest(), r.contributionId, r.accessToken);
    expect(done.state).toBe('SUCCEEDED');
    expect(done.receipt).toMatchObject({
      funeralName: done.funeralName,
      amount: money(10_00n, 'USD'),
      net: money(10_00n, 'USD'),
      fee: money(0n, 'USD'),
      fxRate: null,
      rail: 'ECOCASH',
    });
    expect(done.receipt?.receiptNo).toMatch(/^CW-\d{8}$/);
    expect(done.receipt?.walletRef).toMatch(/^W-[0-9A-F]{10}$/);
    expect(done.tribute?.status).toBe('VISIBLE');

    const page = await t.contributions.page(slug);
    expect(page.totals?.raised).toEqual(money(10_00n, 'USD'));
    expect(page.tributes).toEqual([expect.objectContaining({ name: 'Tino', message: 'May she rest in peace.', amount: money(10_00n, 'USD') })]);

    // Receipt SMS to the contact given, family notice to the admin's phone.
    expect(t.sms.sent.find((m) => m.to === '+263772000111')?.text).toContain(done.receipt!.receiptNo);
    expect(t.sms.sent.find((m) => m.to === '+263772000111')?.text).toContain(`/c/${r.contributionId}#t=${r.accessToken}`);
    const { rows } = await t.h.db.query<{ phone_e164: string }>('SELECT phone_e164 FROM person WHERE id = $1', [admin.personId]);
    expect(t.sms.sent.find((m) => m.to === rows[0]!.phone_e164)?.text).toBe('Tino contributed 10.00 USD: May she rest in peace.');
    expect(t.events.map((e) => e.topic)).toEqual(expect.arrayContaining(['contribution.initiated', 'contribution.succeeded']));
    // The ledger holds the money in COMMUNITY.
    const bal = await getBalances(t.h.db, walletId);
    expect(bal.find((b) => b.code.endsWith('COMMUNITY'))?.settled).toEqual(money(10_00n, 'USD'));
    expect(await auditRows('contribution.create')).toEqual([expect.objectContaining({ authz_result: 'ALLOWED', actor_role: 'PUBLIC' })]);
  });

  it('a logged-in contributor finds their own contributions without the link', async () => {
    const { slug } = await t.publicWallet();
    const me = await t.h.customer();
    const r = await t.contributions.contribute(me.actor, t.input(slug));
    t.ecocash.succeed(await providerRef(r.payment.id));
    await t.deliver(t.ecocash);
    await t.pump();
    const mine = await t.h.bus.execute(t.contributions.commands.listMine, {}, { actor: me.actor });
    expect(mine.map((c) => c.id)).toEqual([r.contributionId]);
    expect(mine[0]?.receipt).not.toBeNull();
    expect((await t.contributions.view(me.actor, r.contributionId)).state).toBe('SUCCEEDED');
  });

  it('a failed payment publishes nothing, issues no receipt, voids the tribute', async () => {
    const { slug } = await t.publicWallet();
    const r = await t.contributions.contribute(t.guest(), t.input(slug));
    t.ecocash.fail(await providerRef(r.payment.id));
    await t.deliver(t.ecocash);
    await t.pump();
    const v = await t.contributions.view(t.guest(), r.contributionId, r.accessToken);
    expect(v.state).toBe('FAILED');
    expect(v.receipt).toBeNull();
    expect(v.tribute?.status).toBe('VOID');
    expect(t.sms.sent).toEqual([]);
    expect(t.events.map((e) => e.topic)).toContain('contribution.failed');
    await expect(t.contributions.reissueReceipt(t.guest(), r.contributionId, r.accessToken)).rejects.toBeInstanceOf(ConflictError);
  });

  it('a replayed submission is the same contribution; a reused key with other content is refused', async () => {
    const { slug } = await t.publicWallet();
    const input = t.input(slug);
    const a = await t.contributions.contribute(t.guest(), input);
    const b = await t.contributions.contribute(t.guest(), input);
    expect(b.replayed).toBe(true);
    expect(b.contributionId).toBe(a.contributionId);
    await expect(t.contributions.contribute(t.guest(), { ...input, tribute: 'another message' })).rejects.toThrow(/IDEMPOTENCY_KEY_REUSED/);
    const { rows } = await t.h.db.query<{ n: string }>('SELECT count(*)::text AS n FROM contribution');
    expect(rows[0]?.n).toBe('1');
  });

  it('a duplicated provider callback credits and settles once', async () => {
    const { slug } = await t.publicWallet();
    const r = await t.contributions.contribute(t.guest(), t.input(slug));
    const ref = await providerRef(r.payment.id);
    t.ecocash.succeed(ref);
    const hooks = t.ecocash.takeWebhooks(t.h.now());
    for (const hook of [...hooks, ...hooks]) {
      const ev = await t.payments.receiveWebhook('ECOCASH', hook.headers, hook.body);
      await t.payments.processEvent(ev.eventRowId);
    }
    await t.pump();
    await t.contributions.settle(r.payment.id);
    expect((await t.contributions.page(slug)).totals?.raised).toEqual(money(10_00n, 'USD'));
    const { rows } = await t.h.db.query<{ n: string }>("SELECT count(*)::text AS n FROM receipt_issue WHERE kind = 'ORIGINAL'");
    expect(rows[0]?.n).toBe('1');
  });
});

describe('§A 10 — receipt retrievable when delivery fails', () => {
  it('SMS down: notification retries then DEAD; the receipt is still there and can be re-issued with the same content', async () => {
    const { slug } = await t.publicWallet();
    t.sms.failNext(100);
    const r = await paid(slug);
    const { rows } = await t.h.db.query<{ id: string }>("SELECT id FROM notification WHERE template = 'notify.receipt'");
    const id = rows[0]!.id;
    expect((await t.notifications.status(id)).status).toBe('RETRY');
    for (let i = 0; i < 6; i++) {
      t.h.advance(60 * 60_000);
      await t.notifications.deliverDue();
    }
    const n = await t.notifications.status(id);
    expect(n).toMatchObject({ status: 'DEAD', attempts: 5, lastError: 'SMS provider unavailable' });

    const v = await t.contributions.view(t.guest(), r.contributionId, r.accessToken);
    expect(v.state).toBe('SUCCEEDED');
    const again = await t.contributions.reissueReceipt(t.guest(), r.contributionId, r.accessToken);
    expect(again).toEqual(v.receipt);
  });

  it('a transient failure is retried and then sent', async () => {
    const { slug } = await t.publicWallet();
    t.sms.failNext(1);
    await paid(slug);
    const statuses = async () =>
      (await t.h.db.query<{ status: string }>("SELECT status FROM notification WHERE channel = 'SMS' ORDER BY created_at, id")).rows.map((r) => r.status);
    expect((await statuses()).sort()).toEqual(['RETRY', 'SENT']);
    t.h.advance(2 * 60_000);
    await t.notifications.deliverDue();
    expect(await statuses()).toEqual(['SENT', 'SENT']);
  });

  it('re-issue is rate limited per contribution', async () => {
    const { slug } = await t.publicWallet();
    const r = await paid(slug);
    for (let i = 0; i < 5; i++) await t.contributions.reissueReceipt(t.guest(), r.contributionId, r.accessToken);
    await expect(t.contributions.reissueReceipt(t.guest(), r.contributionId, r.accessToken)).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('§S — IDOR on contribution / receipt / tribute', () => {
  it('no link, a wrong link or another contribution’s link is denied and audited', async () => {
    const { slug } = await t.publicWallet();
    const a = await paid(slug);
    const b = await paid(slug, { payerPhone: '+263772000222', contact: { kind: 'PHONE', value: '+263772000222' } });
    for (const token of [undefined, 'x'.repeat(43), b.accessToken]) {
      await expect(t.contributions.view(t.guest(), a.contributionId, token)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(t.contributions.reissueReceipt(t.guest(), a.contributionId, token)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(t.contributions.removeTribute(t.guest(), a.contributionId, token)).rejects.toBeInstanceOf(ForbiddenError);
    }
    const denied = (await auditRows('contribution.view')).filter((r) => r.authz_result === 'DENIED');
    expect(denied).toHaveLength(3);
    expect(denied.every((r) => r.reason_code === 'BAD_LINK')).toBe(true);
    // Unknown id: NOT_FOUND, never someone else's data.
    await expect(t.contributions.view(t.guest(), '00000000-0000-4000-8000-000000000000', a.accessToken)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a customer cannot read another customer’s contribution, even with a session', async () => {
    const { slug } = await t.publicWallet();
    const owner = await t.h.customer();
    const r = await t.contributions.contribute(owner.actor, t.input(slug));
    const other = await t.h.customer();
    await expect(t.contributions.view(other.actor, r.contributionId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(t.contributions.view(other.actor, r.contributionId, r.accessToken)).rejects.toBeInstanceOf(ForbiddenError);
    // The wallet's own admin does not see contributors' private records either.
    await expect(t.contributions.view((await t.publicWallet()).admin.actor, r.contributionId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('the link is an HMAC of the id under the platform key, not stored anywhere', async () => {
    const { slug } = await t.publicWallet();
    const r = await t.contributions.contribute(t.guest(), t.input(slug));
    expect(r.accessToken).toBe(linkToken(t.contributions.keys, r.contributionId));
    const { rows } = await t.h.db.query<{ row: string }>('SELECT row_to_json(c)::text AS row FROM contribution c');
    expect(rows[0]?.row).not.toContain(r.accessToken);
  });
});

describe('§S / §A 11 — anonymity and privacy are consistent', () => {
  it('anonymous: public + family see "Sympathetic Friend"; KYC and audit are kept', async () => {
    const { slug, admin } = await t.publicWallet();
    const r = await paid(slug, { anonymous: true, payerName: 'Rufaro Mlambo' });
    const page = await t.contributions.page(slug);
    expect(page.tributes?.[0]?.name).toBe('Sympathetic Friend');
    expect(wire(page)).not.toContain('Rufaro');
    const { rows: p } = await t.h.db.query<{ phone_e164: string }>('SELECT phone_e164 FROM person WHERE id = $1', [admin.personId]);
    const family = t.sms.sent.filter((m) => m.to === p[0]!.phone_e164);
    expect(family[0]?.text).toMatch(/^Sympathetic Friend contributed/);
    expect(family.map((m) => m.text).join()).not.toContain('Rufaro');
    // KYC kept (sealed), phone hashed; nothing in plaintext.
    const { rows } = await t.h.db.query<{ row: string; kyc_sealed: string; payer_phone_hash: string }>(
      'SELECT row_to_json(c)::text AS row, kyc_sealed, payer_phone_hash FROM contribution c WHERE id = $1',
      [r.contributionId],
    );
    expect(rows[0]?.kyc_sealed.length).toBeGreaterThan(40);
    expect(rows[0]?.payer_phone_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.row).not.toContain('Rufaro');
    expect(rows[0]?.row).not.toContain('+263772000111');
    expect(await auditRows('contribution.create')).toHaveLength(1);
  });

  it('defaults hide everything optional; hidden data is never sent', async () => {
    const admin = await t.h.customer();
    const { slug } = await t.activeWallet(admin);
    const r = await t.contributions.contribute(t.guest(), t.input(slug, { tribute: 'Rest well, Sekuru.' }));
    t.ecocash.succeed(await providerRef(r.payment.id));
    await t.deliver(t.ecocash);
    await t.pump();
    const page = await t.contributions.page(slug);
    expect(page).toMatchObject({ totals: null, usage: null, tributes: null, photoPath: null });
    const json = wire(page);
    expect(json).not.toContain('Rest well');
    expect(json).not.toContain('Tino');
    expect(json).not.toContain('"minor":"1000"');
    expect(await t.contributions.total(slug)).toBeNull();
    expect(await t.contributions.tributes(slug)).toBeNull();
  });

  it('names and amounts toggles apply per field', async () => {
    const { slug, walletId, admin } = await t.publicWallet({ showContributorNames: false, showAmounts: false });
    await paid(slug);
    let tr = (await t.contributions.page(slug)).tributes?.[0];
    expect(tr).toMatchObject({ name: 'Sympathetic Friend', amount: null, message: 'May she rest in peace.' });
    await t.h.bus.execute(t.contributions.commands.updatePrivacy, { walletId, settings: { showContributorNames: true } }, { actor: admin.actor });
    tr = (await t.contributions.page(slug)).tributes?.[0];
    expect(tr).toMatchObject({ name: 'Tino', amount: null });
  });

  it('only the wallet admin changes privacy; unknown keys are refused', async () => {
    const { walletId, admin } = await t.publicWallet();
    const stranger = await t.h.customer();
    await expect(
      t.h.bus.execute(t.contributions.commands.updatePrivacy, { walletId, settings: { showTotal: false } }, { actor: stranger.actor }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      t.h.bus.execute(t.contributions.commands.updatePrivacy, { walletId, settings: { showEverything: true } as never }, { actor: admin.actor }),
    ).rejects.toThrow(/privacy/);
  });

  it('photo: needs consent + toggle; withdrawing consent hides it at once', async () => {
    const { slug, walletId, admin } = await t.publicWallet();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(String(Date.now()))]);
    const doc = await t.h.bus.execute(t.h.documents.upload, { class: 'PHOTO', contentType: 'image/png', data: png, walletId }, { actor: admin.actor });
    await t.h.bus.execute(t.h.documents.applyScan, { documentId: doc.id }, { actor: SYSTEM_ACTOR });
    // A PDF is never a public photo.
    await expect(
      t.h.bus.execute(t.h.documents.upload, { class: 'PHOTO', contentType: 'application/pdf', data: png, walletId }, { actor: admin.actor }),
    ).rejects.toThrow(/image/);
    await t.h.bus.execute(t.contributions.commands.setPhoto, { walletId, documentId: doc.id }, { actor: admin.actor });
    expect((await t.contributions.page(slug)).photoPath).toBe(`/public/wallets/${slug}/photo`);
    const docId = await t.contributions.photoDocument(slug);
    expect((await t.h.documents.openPublicPhoto(t.h.db, docId)).data.equals(png)).toBe(true);

    const { rows } = await t.h.db.query<{ photo_consent_id: string }>('SELECT photo_consent_id FROM wallet WHERE id = $1', [walletId]);
    await t.h.bus.execute(withdrawConsent, { consentId: rows[0]!.photo_consent_id }, { actor: admin.actor });
    expect((await t.contributions.page(slug)).photoPath).toBeNull();
    await expect(t.contributions.photoDocument(slug)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('tribute wall: moderation, removal, appeal', () => {
  it('rules flag → HIDDEN pending review; a human approves; the wall is newest-first', async () => {
    const { slug } = await t.publicWallet();
    await paid(slug, { tribute: 'Rest in peace, Mbuya.' });
    const flagged = await paid(slug, { tribute: 'Send money to my ecocash number 0772 123 456', payerPhone: '+263772000333' });
    let wall = (await t.contributions.page(slug)).tributes ?? [];
    expect(wall.map((x) => x.message)).toEqual(['Rest in peace, Mbuya.']);
    expect(t.events.find((e) => e.topic === 'tribute.flagged')).toBeDefined();
    const v = await t.contributions.view(t.guest(), flagged.contributionId, flagged.accessToken);
    expect(v.tribute).toMatchObject({ status: 'HIDDEN', flagReasons: expect.arrayContaining(['CONTACT_DETAILS', 'MONEY_REQUEST']) });
    // The family notice does not forward a flagged message.
    expect(t.sms.sent.some((m) => m.text.includes('ecocash number'))).toBe(false);

    const mod = await t.verifier();
    const queue = await t.h.bus.execute(t.contributions.commands.moderationQueue, {}, { actor: mod.actor });
    expect(queue).toHaveLength(1);
    // A family member cannot moderate.
    const outsider = await t.h.customer();
    await expect(t.h.bus.execute(t.contributions.commands.moderationQueue, {}, { actor: outsider.actor })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      t.h.bus.execute(t.contributions.commands.moderate, { tributeId: queue[0]!.tributeId, outcome: 'REJECT' }, { actor: mod.actor }),
    ).rejects.toThrow(/note/);
    t.h.advance(1000);
    await t.h.bus.execute(t.contributions.commands.moderate, { tributeId: queue[0]!.tributeId, outcome: 'APPROVE' }, { actor: mod.actor });
    wall = (await t.contributions.page(slug)).tributes ?? [];
    expect(wall.map((x) => x.message)).toEqual(['Send money to my ecocash number 0772 123 456', 'Rest in peace, Mbuya.']);
  });

  it('rejected tribute can be appealed once by its contributor', async () => {
    const { slug } = await t.publicWallet();
    const r = await paid(slug, { tribute: 'You are all liars and thieves' });
    const mod = await t.verifier();
    const [item] = await t.h.bus.execute(t.contributions.commands.moderationQueue, {}, { actor: mod.actor });
    await t.h.bus.execute(t.contributions.commands.moderate, { tributeId: item!.tributeId, outcome: 'REJECT', note: 'abusive towards the family' }, { actor: mod.actor });
    expect((await t.contributions.appealTribute(t.guest(), r.contributionId, 'please review', r.accessToken)).status).toBe('HIDDEN');
    await t.h.bus.execute(t.contributions.commands.moderate, { tributeId: item!.tributeId, outcome: 'REJECT', note: 'still abusive after appeal' }, { actor: mod.actor });
    await expect(t.contributions.appealTribute(t.guest(), r.contributionId, undefined, r.accessToken)).rejects.toThrow(/ALREADY_APPEALED/);
  });

  it('removal erases the message only: payment, receipt and total stay', async () => {
    const { slug } = await t.publicWallet();
    const r = await paid(slug);
    expect((await t.contributions.removeTribute(t.guest(), r.contributionId, r.accessToken)).status).toBe('REMOVED');
    const page = await t.contributions.page(slug);
    expect(page.tributes).toEqual([]);
    expect(page.totals?.raised).toEqual(money(10_00n, 'USD'));
    const v = await t.contributions.view(t.guest(), r.contributionId, r.accessToken);
    expect(v.tribute).toMatchObject({ status: 'REMOVED', message: null });
    expect(v.receipt).not.toBeNull();
    // The DB refuses to bring the text back or delete the row.
    await expect(t.h.db.query("UPDATE tribute SET message = 'back' WHERE contribution_id = $1", [r.contributionId])).rejects.toThrow();
    await expect(t.h.db.query('DELETE FROM tribute WHERE contribution_id = $1', [r.contributionId])).rejects.toThrow();
  });

  it('moderation rules are transparent and deterministic', () => {
    const rules = new DeterministicModerationRules();
    expect(rules.evaluate('May her soul rest in eternal peace. Hamba kahle.')).toEqual([]);
    expect(rules.evaluate('visit www.example.com')).toContain('LINK');
    expect(rules.evaluate('WE WILL MISS YOU SO MUCH FOREVER')).toContain('SHOUTING');
    expect(rules.evaluate('scam scam')).toContain('ABUSIVE_LANGUAGE');
  });
});

describe('gates and limits', () => {
  it('an unverified (draft) or suspended wallet takes no contribution', async () => {
    const admin = await t.h.customer();
    await t.draft(admin.actor);
    await expect(t.contributions.contribute(t.guest(), t.input('a'.repeat(26)))).rejects.toBeInstanceOf(NotFoundError);
    const { slug, walletId } = await t.publicWallet();
    const fa = await t.fidelityAdmin();
    await t.h.bus.execute(t.w.suspend, { walletId, reasonCode: 'FRAUD_SUSPECTED', note: 'reported by several people' }, { actor: fa.actor });
    await expect(t.contributions.contribute(t.guest(), t.input(slug))).rejects.toBeInstanceOf(NotFoundError);
    await expect(t.contributions.page(slug)).rejects.toBeInstanceOf(NotFoundError);
    expect((await auditRows('contribution.create')).every((r) => r.authz_result === 'DENIED' && r.reason_code === 'NOT_FOUND')).toBe(true);
  });

  it('amount limits come from config; an unset maximum closes contributions', async () => {
    const { slug } = await t.publicWallet();
    await expect(t.contributions.contribute(t.guest(), t.input(slug, { amount: money(100_001n, 'USD') }))).rejects.toThrow(/AMOUNT_ABOVE_MAXIMUM/);
    await expect(t.contributions.contribute(t.guest(), t.input(slug, { amount: money(1n, 'ZWG') }))).rejects.toThrow(/CURRENCY_NOT_ACCEPTED/);
    // Every amount is honoured: 1 cent works when no minimum is set.
    expect((await t.contributions.contribute(t.guest(), t.input(slug, { amount: money(1n, 'USD') }))).payment.state).toBe('INITIATED');
    await t.close();

    t = await createContributionHarness({ 'contribution.max_minor.usd': '', 'contribution.min_minor.usd': '500' });
    const w2 = await t.publicWallet();
    expect((await t.contributions.page(w2.slug)).contribute).toMatchObject({ rails: [], max: null, min: money(500n, 'USD') });
    await expect(t.contributions.contribute(t.guest(), t.input(w2.slug))).rejects.toThrow(/CONTRIBUTION_LIMITS_NOT_CONFIGURED/);
  });

  it('light KYC: name + phone always required; above the light ceiling it is refused', async () => {
    await t.close();
    t = await createContributionHarness({ 'kyc.contributor_light_max_minor': '5000' });
    const { slug } = await t.publicWallet();
    await expect(t.contributions.contribute(t.guest(), t.input(slug, { payerName: ' ' }))).rejects.toThrow(/payer name/);
    await expect(t.contributions.contribute(t.guest(), t.input(slug, { payerPhone: '0772000111' }))).rejects.toThrow(/payer phone/);
    await expect(t.contributions.contribute(t.guest(), t.input(slug, { amount: money(5001n, 'USD') }))).rejects.toThrow(/FULL_KYC_REQUIRED/);
  });

  it('only enabled rails; the page offers no suggested or ranked amounts', async () => {
    const { slug } = await t.publicWallet();
    const page = await t.contributions.page(slug);
    expect(page.contribute.rails).toEqual(['CARD', 'ECOCASH']);
    await expect(t.contributions.contribute(t.guest(), t.input(slug, { rail: 'ONEMONEY' }))).rejects.toBeInstanceOf(NotFoundError);
    const keys: string[] = [];
    JSON.parse(wire(page), (k, v: unknown) => {
      keys.push(k);
      return v;
    });
    expect(keys.filter((k) => /^(suggested\w*|presets?|top\w*|rank\w*|leader\w*|countdown)$/i.test(k))).toEqual([]);
    expect(Object.keys(page.contribute).sort()).toEqual(['currency', 'groupsEnabled', 'max', 'min', 'rails']);
  });
});

describe('totals, target, groups', () => {
  it('raised is derived from the ledger and target.reached fires once', async () => {
    const { slug } = await t.publicWallet({}, 15_00n);
    await paid(slug);
    expect(t.events.filter((e) => e.topic === 'target.reached')).toHaveLength(0);
    await paid(slug, { payerPhone: '+263772000444' });
    await paid(slug, { payerPhone: '+263772000555' });
    expect(t.events.filter((e) => e.topic === 'target.reached')).toHaveLength(1);
    expect(await t.contributions.total(slug)).toEqual({ raised: money(30_00n, 'USD'), target: money(15_00n, 'USD') });
  });

  it('group contributions are off by default', async () => {
    const { slug } = await t.publicWallet();
    const rep = await t.h.customer();
    await expect(t.h.bus.execute(t.contributions.commands.createGroup, { slug, name: 'St Mary’s Choir' }, { actor: rep.actor })).rejects.toThrow(
      /GROUP_CONTRIBUTIONS_DISABLED/,
    );
  });

  it('with the flag on, the representative pays into the GROUP sub-ledger under the group name', async () => {
    await t.close();
    t = await createContributionHarness({ 'feature.group_contributions': 'true' });
    const { slug, walletId } = await t.publicWallet();
    const rep = await t.h.customer();
    const g = await t.h.bus.execute(t.contributions.commands.createGroup, { slug, name: 'Burial Society  Mbare' }, { actor: rep.actor });
    // Not the representative ⇒ denied (audited), guest included.
    await expect(t.contributions.contribute(t.guest(), t.input(slug, { groupId: g.groupId }))).rejects.toBeInstanceOf(ForbiddenError);
    const r = await t.contributions.contribute(rep.actor, t.input(slug, { groupId: g.groupId }));
    t.ecocash.succeed(await providerRef(r.payment.id));
    await t.deliver(t.ecocash);
    await t.pump();
    const bal = await getBalances(t.h.db, walletId);
    expect(bal.find((b) => b.account.kind === 'GROUP')?.settled).toEqual(money(10_00n, 'USD'));
    expect(bal.find((b) => b.account.kind === 'COMMUNITY')?.settled).toEqual(money(0n, 'USD'));
    expect((await t.contributions.page(slug)).tributes?.[0]?.name).toBe('Burial Society Mbare');
    expect((await t.contributions.page(slug)).totals?.raised).toEqual(money(10_00n, 'USD'));
  });
});
