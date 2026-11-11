// P08 WhatsApp channel (docs/09, docs/14 §S WhatsApp rows) on the simulator.
import { ForbiddenError, NotFoundError, AuthenticationError } from '@chema/core';
import { money } from '@chema/shared';
import { ALL_PASS } from '@chema/wallet/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { WA_PIPELINE } from './service';
import { bodyAad } from './store';
import { openText } from './util';
import { PORTAL_URL, createWhatsAppHarness, type WhatsAppHarness } from './test-support';

let phoneSeq = 8_000_000;
const phone = () => `+26378${String(phoneSeq++).padStart(7, '0')}`;

let t: WhatsAppHarness | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** Index (1-based) of `label` in a numbered list inside `reply`. */
function optionOf(reply: string, label: RegExp): string {
  const line = reply.split('\n').find((l) => /^\d+\. /.test(l) && label.test(l));
  if (!line) throw new Error(`no option ${label} in:\n${reply}`);
  return line.split('.')[0] ?? '';
}

async function providerRefOf(t: WhatsAppHarness, contributionId: string): Promise<string> {
  const { rows } = await t.h.db.query<{ provider_ref: string }>(
    'SELECT p.provider_ref FROM payment p JOIN contribution c ON c.payment_id = p.id WHERE c.id = $1',
    [contributionId],
  );
  return rows[0]?.provider_ref ?? '';
}

async function lastContributionId(t: WhatsAppHarness): Promise<string> {
  const { rows } = await t.h.db.query<{ id: string }>('SELECT id FROM contribution ORDER BY created_at DESC, id LIMIT 1');
  return rows[0]?.id ?? '';
}

/** Walk the contribute flow from MENU up to (not including) the final confirm. */
async function contributeUpToConfirm(t: WhatsAppHarness, from: string, slug: string, amount = '10'): Promise<string> {
  await t.say(from, 'hi');
  await t.say(from, '1');
  const amountPrompt = await t.say(from, `https://chema.test/w/${slug}`);
  expect(amountPrompt).toContain('How much would you like to give');
  const rails = await t.say(from, amount);
  await t.say(from, optionOf(rails, /ECOCASH/));
  await t.say(from, 'Rudo Moyo');
  await t.say(from, '1');
  const confirm = await t.say(from, 'Rest in peace');
  expect(confirm).toContain('You will be charged');
  expect(confirm).toContain('never ask for your PIN');
  return confirm;
}

async function paid(t: WhatsAppHarness, contributionId: string): Promise<void> {
  t.ecocash.succeed(await providerRefOf(t, contributionId));
  await t.deliver(t.ecocash);
  await t.pumpWa();
}

async function actorOf(t: WhatsAppHarness, p: string) {
  const conv = await t.wa.conversationFor(p);
  if (!conv?.authSessionId) throw new Error('not signed in');
  const actor = await t.h.auth.actorForSession(conv.authSessionId);
  if (!actor) throw new Error('session gone');
  return { actor, token: '', personId: actor.personId };
}

describe('P08 done-when: create-draft → contribute → receipt → payout request with secure hand-off', () => {
  it('runs end to end on the simulator', async () => {
    t = await createWhatsAppHarness();
    const family = phone();
    const friend = phone();

    // Family admin signs in over WhatsApp (OTP entered on the secure page, never in chat).
    await t.signIn(family);
    expect(t.sim.last(family)).toContain('signed in on WhatsApp');
    const admin = await actorOf(t, family);
    expect(admin.actor.channel).toBe('WHATSAPP');

    // 1. Create draft in chat → same wallet.create_draft command as the web.
    const menu = await t.say(family, 'menu');
    await t.say(family, optionOf(menu, /Start a funeral wallet/));
    await t.say(family, 'Tendai Chiwenga');
    await t.say(family, '2026-11-05');
    await t.say(family, 'skip');
    await t.say(family, 'Warren Hills, Harare');
    const created = await t.say(family, '1');
    expect(created).toContain('Draft created for Tendai Chiwenga');
    expect(created).toMatch(/https:\/\/chema\.test\/h#[A-Za-z0-9_-]{20,}/);
    const { rows: w } = await t.h.db.query<{ id: string; status: string; admin_person: string }>(
      "SELECT id, status, admin_person FROM wallet WHERE deceased_name = 'Tendai Chiwenga'",
    );
    expect(w[0]).toMatchObject({ status: 'DRAFT', admin_person: admin.personId });
    const walletId = w[0]?.id ?? '';

    // Evidence + verification happen on web/portal (unchanged P04 commands).
    const evidence = await t.wa.open(t.tokenFor(family), admin.actor);
    expect(evidence).toEqual({ purpose: 'EVIDENCE', walletId });
    await t.fullEvidence(admin.actor, walletId);
    const { caseId } = await t.h.bus.execute(t.w.submit, { walletId }, { actor: admin.actor });
    const verifier = await t.verifier();
    await t.assignVerifier(walletId, verifier.personId);
    const decided = await t.h.bus.execute(
      t.w.decide,
      { caseId, outcome: 'APPROVED', reasonCode: 'EVIDENCE_SUFFICIENT', checklist: ALL_PASS },
      { actor: verifier.actor },
    );
    const slug = decided.publicSlug ?? '';
    expect(slug).toMatch(/^[a-z2-7]{26}$/);

    // 2. A friend (no account) contributes in chat → provider prompt, no PIN asked.
    await contributeUpToConfirm(t, friend, slug);
    const started = await t.say(friend, '1');
    expect(started).toMatch(/prompt on your phone|Complete your payment/);
    expect(started).toContain('https://chema.test/c/');
    const contributionId = await lastContributionId(t);
    const { rows: cr } = await t.h.db.query<{ channel: string }>('SELECT channel FROM contribution WHERE id = $1', [contributionId]);
    expect(cr[0]?.channel).toBe('WHATSAPP');
    await paid(t, contributionId);

    // 3. Receipt: pushed over WhatsApp after settlement, and retrievable in chat.
    expect(t.sim.inbox(friend).some((m) => m.startsWith('Chema Wallet receipt'))).toBe(true);
    await t.say(friend, 'menu');
    const receipts = await t.say(friend, '2');
    expect(receipts).toContain('10.00 USD for Tendai Chiwenga: received');
    expect(receipts).toMatch(/Receipt \S+/);

    // 4. Payout request: chosen in chat, confirmed with step-up on the secure page.
    const approver = await t.approver(walletId);
    await t.activePayee(admin, approver, walletId, { holder: 'Doves Funeral Services' });
    const m2 = await t.say(family, 'menu');
    const payees = await t.say(family, optionOf(m2, /Request a payout/));
    expect(payees).toMatch(/Doves Funeral Services \(\+\d+•+\d{4}\)/);
    await t.say(family, '1');
    await t.say(family, '5');
    await t.say(family, '1');
    const confirm = await t.say(family, '1');
    expect(confirm).toContain('Confirm this payout request on the secure page');
    const { rows: before } = await t.h.db.query('SELECT id FROM payout_request WHERE wallet_id = $1', [walletId]);
    expect(before).toHaveLength(0); // nothing requested from chat

    const token = t.tokenFor(family);
    expect(await t.wa.describe(token)).toMatchObject({ purpose: 'PAYOUT_REQUEST', summary: { amount: '5.00 USD', payee: 'Doves Funeral Services', purpose: 'PARLOUR' } });
    t.h.advance(6 * 60_000);
    const { challengeId } = await t.wa.startOtp(token);
    const code = t.h.otp.lastCodeFor(family) ?? '';
    const r = await t.wa.confirm(token, challengeId, code);
    expect(r.purpose).toBe('PAYOUT_REQUEST');
    if (r.purpose !== 'PAYOUT_REQUEST') return;
    expect(r.approvalId).not.toBeNull(); // threshold unset ⇒ every payout needs the family approver
    await t.pumpWa();
    expect(t.sim.last(family)).toContain('your payout request of 5.00 USD was received');
    const { rows: after } = await t.h.db.query<{ amount_minor: string; requested_by: string }>('SELECT amount_minor::text, requested_by FROM payout_request WHERE wallet_id = $1', [walletId]);
    expect(after).toEqual([{ amount_minor: '500', requested_by: admin.personId }]);

    // Single use: the link is dead now.
    await expect(t.wa.describe(token)).rejects.toBeInstanceOf(NotFoundError);
    await expect(t.wa.confirm(token, challengeId, code)).rejects.toBeInstanceOf(NotFoundError);

    // Payout status in chat (same payouts.list command).
    const m3 = await t.say(family, 'menu');
    expect(await t.say(family, optionOf(m3, /Payout status/))).toContain('5.00 USD to Doves Funeral Services');
  });
});

describe('§S WhatsApp security', () => {
  it('duplicate webhook ⇒ one stored message, one action', async () => {
    t = await createWhatsAppHarness();
    const { slug } = await t.publicWallet();
    const friend = phone();
    await contributeUpToConfirm(t, friend, slug);
    const hook = t.sim.say(friend, '1', { messageId: 'wamid.dup.1' });
    await t.wa.receiveWebhook('SIMULATOR', hook.headers, hook.body);
    const again = await t.wa.receiveWebhook('SIMULATOR', hook.headers, hook.body);
    expect(again).toMatchObject({ duplicates: 1, stored: [] });
    await t.pumpWa();
    await t.pumpWa();
    const { rows: inbound } = await t.h.db.query("SELECT id FROM wa_inbound WHERE message_id = 'wamid.dup.1'");
    expect(inbound).toHaveLength(1);
    const { rows: contribs } = await t.h.db.query('SELECT id FROM contribution');
    expect(contribs).toHaveLength(1);
    // Re-processing the same inbound id is a no-op.
    const id = (inbound[0] as { id: string }).id;
    expect(await t.wa.process(id)).toMatchObject({ replayed: true });
  });

  it('forged or stale webhooks are refused and store nothing', async () => {
    t = await createWhatsAppHarness();
    const p = phone();
    const hook = t.sim.say(p, 'hi');
    await expect(t.wa.receiveWebhook('SIMULATOR', { ...hook.headers, 'x-sim-signature': 'f'.repeat(64) }, hook.body)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(t.wa.receiveWebhook('SIMULATOR', hook.headers, hook.body.replace('hi', 'yo'))).rejects.toBeInstanceOf(ForbiddenError);
    t.h.advance(10 * 60_000);
    await expect(t.wa.receiveWebhook('SIMULATOR', hook.headers, hook.body)).rejects.toThrow('WEBHOOK_STALE');
    await expect(t.wa.receiveWebhook('META', hook.headers, hook.body)).rejects.toBeInstanceOf(NotFoundError);
    const { rows } = await t.h.db.query('SELECT id FROM wa_inbound');
    expect(rows).toHaveLength(0);
  });

  it('never stores a PIN, OTP or card number typed in chat', async () => {
    t = await createWhatsAppHarness();
    const p = phone();
    await t.say(p, 'hi');
    expect(await t.say(p, '482913')).toContain('never send PINs');
    expect(await t.say(p, '4111 1111 1111 1111')).toContain('never send PINs');
    expect(await t.say(p, 'my pin is 1234')).toContain('never send PINs');
    const { rows } = await t.h.db.query<{ id: string; redacted: boolean; body_sealed: string }>('SELECT id, redacted, body_sealed FROM wa_inbound ORDER BY received_at');
    const bodies = rows.map((r) => openText(t!.wa.keys, r.body_sealed, bodyAad(r.id)));
    expect(rows.map((r) => r.redacted)).toEqual([false, true, true, true]);
    for (const secret of ['482913', '4111', '1234']) {
      expect(bodies.join('|')).not.toContain(secret);
      const { rows: audit } = await t.h.db.query(`SELECT seq FROM audit_log WHERE (audit_log.*)::text LIKE $1`, [`%${secret}%`]);
      expect(audit).toHaveLength(0);
      const { rows: notes } = await t.h.db.query(`SELECT id FROM notification WHERE (notification.*)::text LIKE $1`, [`%${secret}%`]);
      expect(notes).toHaveLength(0);
    }
    // An amount is not mistaken for a code while an amount is expected.
    const { slug } = await t.publicWallet();
    await t.say(p, 'menu');
    await t.say(p, '1');
    await t.say(p, slug);
    expect(await t.say(p, '1000')).toContain('How will you pay');
  });

  it('a phone cannot take over another conversation with a forwarded sign-in link', async () => {
    t = await createWhatsAppHarness();
    const victim = phone();
    const attacker = phone();
    await t.say(victim, 'hi');
    await t.say(victim, '7');
    const token = t.tokenFor(victim);
    // The code for the victim's link goes to the victim's number only.
    t.h.advance(6 * 60_000);
    await t.wa.startOtp(token);
    expect(t.h.otp.lastCodeFor(attacker)).toBeUndefined();
    // The attacker logs in with their own number and offers that challenge instead.
    const { challengeId } = await t.h.auth.startLogin({ phone: attacker, channel: 'WHATSAPP' });
    await expect(t.wa.confirm(token, challengeId, t.h.otp.lastCodeFor(attacker) ?? '')).rejects.toThrow('HANDOFF_PHONE_MISMATCH');
    expect((await t.wa.conversationFor(victim))?.authSessionId).toBeNull();
    // Unbound: family actions stay unavailable.
    const menu = await t.say(victim, 'menu');
    expect(menu).not.toContain('Request a payout');
  });

  it('a payout hand-off only completes with a step-up of the bound session', async () => {
    t = await createWhatsAppHarness();
    const family = phone();
    await t.signIn(family);
    const admin = await actorOf(t, family);
    const { walletId } = await t.activeWallet(admin);
    await t.contributePaid((await t.h.db.query<{ public_slug: string }>('SELECT public_slug FROM wallet WHERE id = $1', [walletId])).rows[0]?.public_slug ?? '', 50_00n);
    const approver = await t.approver(walletId);
    await t.activePayee(admin, approver, walletId);
    const m = await t.say(family, 'menu');
    await t.say(family, optionOf(m, /Request a payout/));
    await t.say(family, '1');
    await t.say(family, '20');
    await t.say(family, '1');
    await t.say(family, '1');
    const token = t.tokenFor(family);
    // Someone else's step-up (their own session) cannot complete it.
    const other = await t.h.customer();
    t.h.advance(6 * 60_000);
    const { challengeId } = await t.h.auth.startStepUp(other.actor, { action: 'payout.request', subjectType: 'wallet', subjectId: walletId });
    const { rows: ph } = await t.h.db.query<{ phone_e164: string }>('SELECT phone_e164 FROM person WHERE id = $1', [other.personId]);
    await expect(t.wa.confirm(token, challengeId, t.h.otp.lastCodeFor(ph[0]?.phone_e164 ?? '') ?? '')).rejects.toBeInstanceOf(AuthenticationError);
    // A wrong code does not either.
    const own = await t.wa.startOtp(token);
    await expect(t.wa.confirm(token, own.challengeId, '000000')).rejects.toBeInstanceOf(AuthenticationError);
    const { rows } = await t.h.db.query('SELECT id FROM payout_request WHERE wallet_id = $1', [walletId]);
    expect(rows).toHaveLength(0);
  });

  it('receipts in chat are limited to the conversation’s own contributions', async () => {
    t = await createWhatsAppHarness();
    const { slug } = await t.publicWallet();
    const a = phone();
    const b = phone();
    await contributeUpToConfirm(t, a, slug);
    await t.say(a, '1');
    await paid(t, await lastContributionId(t));
    await t.say(b, 'hi');
    expect(await t.say(b, '2')).toContain('no contributions from this conversation');
    // Typing someone else's contribution id or link gets nothing back.
    const id = await lastContributionId(t);
    const reply = await t.say(b, id);
    expect(reply).not.toContain('Receipt');
    expect(reply).not.toContain(id);
  });

  it('an ended session or changed number drops the binding', async () => {
    t = await createWhatsAppHarness();
    const family = phone();
    await t.signIn(family);
    const conv = await t.wa.conversationFor(family);
    await t.h.db.query('UPDATE auth_session SET revoked_at = now() WHERE id = $1', [conv?.authSessionId]);
    const reply = await t.say(family, 'menu');
    expect(reply).toContain('Your sign-in has ended');
    expect(reply).not.toContain('Request a payout');
    expect((await t.wa.conversationFor(family))?.authSessionId).toBeNull();
  });
});

describe('notifications never touch transaction state', () => {
  it('WhatsApp delivery failure leaves the ledger unchanged (and falls back to SMS when allowed)', async () => {
    t = await createWhatsAppHarness({ 'channel.sms': 'true' });
    const { slug, walletId } = await t.publicWallet();
    const friend = phone();
    await contributeUpToConfirm(t, friend, slug);
    await t.say(friend, '1');
    const id = await lastContributionId(t);
    t.sim.failNext(1_000);
    await paid(t, id);
    for (let i = 0; i < 8; i++) {
      t.h.advance(2 * 60 * 60_000);
      await t.notifications.deliverDue();
      await t.pumpWa();
    }
    const { rows } = await t.h.db.query<{ status: string; template: string }>("SELECT status, template FROM notification WHERE channel = 'WHATSAPP' AND template = 'notify.receipt'");
    expect(rows).toEqual([{ status: 'DEAD', template: 'notify.receipt' }]);
    expect(t.sms.sent.some((m) => m.to === friend && m.text.startsWith('Chema Wallet receipt'))).toBe(true);
    const v = await t.contributions.view(t.guest(), id, (await import('@chema/contributions')).linkToken(t.contributions.keys, id));
    expect(v.state).toBe('SUCCEEDED');
    const { rows: bal } = await t.h.db.query<{ n: string }>(
      `SELECT COALESCE(sum(CASE WHEN e.side = 'C' THEN e.amount_minor ELSE -e.amount_minor END), 0)::text AS n
         FROM ledger_entry e JOIN ledger_account a ON a.id = e.account_id WHERE a.wallet_id = $1 AND a.kind = 'COMMUNITY'`,
      [walletId],
    );
    expect(bal[0]?.n).toBe('1000');
  });

  it('WhatsApp-initiated and web-initiated contributions produce identical ledger entries', async () => {
    t = await createWhatsAppHarness();
    const { slug } = await t.publicWallet();
    const friend = phone();
    await contributeUpToConfirm(t, friend, slug, '10');
    await t.say(friend, '1');
    const viaWa = await lastContributionId(t);
    await paid(t, viaWa);
    const web = await t.contributions.contribute(t.guest(), t.input(slug, { amount: money(10_00n, 'USD') }));
    await paid(t, web.contributionId);
    const shape = async (contributionId: string) => {
      const { rows } = await t!.h.db.query<{ kind: string; acct: string; qualifier: string | null; side: string; amount: string }>(
        `SELECT j.kind, a.kind AS acct, a.qualifier, e.side, e.amount_minor::text AS amount
           FROM contribution c JOIN payment p ON p.id = c.payment_id
           JOIN ledger_journal j ON j.id = p.credit_journal_id
           JOIN ledger_entry e ON e.journal_id = j.id JOIN ledger_account a ON a.id = e.account_id
          WHERE c.id = $1 ORDER BY e.line_no`,
        [contributionId],
      );
      return rows;
    };
    const a = await shape(viaWa);
    expect(a.length).toBeGreaterThan(1);
    expect(a).toEqual(await shape(web.contributionId));
  });
});

describe('orchestrator fallbacks', () => {
  it('offers a person after repeated misunderstandings, and escalates with a reference', async () => {
    t = await createWhatsAppHarness();
    const p = phone();
    await t.say(p, 'hi');
    await t.say(p, 'blah');
    await t.say(p, 'blah blah');
    expect(await t.say(p, 'zzz')).toContain('Would you like to talk to a person');
    const r = await t.say(p, '1');
    expect(r).toMatch(/Your reference is WA-[A-Z2-7]{8}/);
    expect(await t.say(p, 'human')).toContain('You are already waiting');
    const { rows } = await t.h.db.query("SELECT reason FROM wa_escalation WHERE status = 'OPEN'");
    expect(rows).toEqual([{ reason: 'MISUNDERSTOOD' }]);
  });

  it('detects distress / fraud and offers a person', async () => {
    t = await createWhatsAppHarness();
    const p = phone();
    expect(await t.say(p, 'I think this wallet is a scam')).toContain('talk to a person');
    expect(await t.say(p, '1')).toMatch(/WA-[A-Z2-7]{8}/);
    const { rows } = await t.h.db.query('SELECT reason FROM wa_escalation');
    expect(rows).toEqual([{ reason: 'FRAUD' }]);
  });

  it('portal-only actions get the staff portal link, not an action', async () => {
    t = await createWhatsAppHarness();
    expect(await t.say(phone(), 'please approve claim 123')).toContain(PORTAL_URL);
  });

  it('answers FAQs from approved content and switches language', async () => {
    t = await createWhatsAppHarness();
    const p = phone();
    expect(await t.say(p, 'are there fees?')).toContain('Any fee is shown before you pay');
    await t.say(p, 'language');
    expect(await t.say(p, '2')).toContain('Language updated');
    expect((await t.wa.conversationFor(p))?.locale).toBe('sn');
  });

  it('an idle half-filled form expires', async () => {
    t = await createWhatsAppHarness();
    const p = phone();
    await t.say(p, 'hi');
    await t.say(p, '1');
    t.h.advance(31 * 60_000);
    expect(await t.say(p, 'abc')).toContain('timed out');
  });

  it('integration down ⇒ a fallback message, nothing half-done', async () => {
    t = await createWhatsAppHarness();
    const { slug } = await t.publicWallet();
    const p = phone();
    // Provider outage: the payment stays pending (never spendable); the person is told so.
    await contributeUpToConfirm(t, p, slug);
    t.ecocash.scenario.outage = true;
    expect(await t.say(p, '1')).toMatch(/Waiting for your provider to confirm|did not go through/);
    // A core dependency failing: fallback text with the web link, form dropped.
    await t.say(p, 'menu');
    await t.say(p, '1');
    const page = t.contributions.page.bind(t.contributions);
    t.contributions.page = async () => {
      throw new Error('connection refused');
    };
    const r = await t.say(p, slug);
    t.contributions.page = page;
    expect(r).toContain('This service is not available right now');
    expect((await t.wa.conversationFor(p))?.state).toBe('MENU');
    const { rows } = await t.h.db.query("SELECT outcome FROM wa_inbound WHERE outcome = 'INTEGRATION_DOWN'");
    expect(rows).toEqual([{ outcome: 'INTEGRATION_DOWN' }]);
  });

  it('rate-limits a flood from one number', async () => {
    t = await createWhatsAppHarness();
    const p = phone();
    for (let i = 0; i < WA_PIPELINE.rateMax; i++) {
      const hook = t.sim.say(p, 'hi');
      await t.wa.receiveWebhook('SIMULATOR', hook.headers, hook.body);
    }
    const hook = t.sim.say(p, 'hi');
    const r = await t.wa.receiveWebhook('SIMULATOR', hook.headers, hook.body);
    expect(r.stored).toHaveLength(0);
    const { rows } = await t.h.db.query("SELECT outcome FROM wa_inbound WHERE status = 'IGNORED'");
    expect(rows).toEqual([{ outcome: 'RATE_LIMITED' }]);
  });
});

describe('delivery status tracking', () => {
  it('records provider statuses against the sent notification', async () => {
    t = await createWhatsAppHarness();
    const p = phone();
    await t.say(p, 'hi');
    const sent = t.sim.sent.find((m) => m.to === p);
    const s = t.sim.status(sent?.providerRef ?? '', 'FAILED', 'undeliverable');
    await t.wa.receiveWebhook('SIMULATOR', s.headers, s.body);
    await t.wa.receiveWebhook('SIMULATOR', s.headers, s.body); // duplicate status: one row
    const failed = await t.wa.failedDeliveries();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ template: 'wa.reply', error: 'undeliverable' });
  });
});
