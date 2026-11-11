// Local WhatsApp simulator (P08 Do 1): the whole stack in-process on PGlite with
// mock rails, mock OTP and the simulator provider. Dev tool only — never part
// of the API or worker (imports test harnesses). `pnpm wa:sim` or `pnpm wa:sim --demo`.
//
// Interactive commands:
//   /as <+E164>   switch the phone you are typing from
//   /wallet       create a verified public wallet (prints its link)
//   /code         complete the last hand-off link sent to this phone (OTP shown here, never typed in chat)
//   /pay          the provider confirms every pending payment
//   /quit
// Anything else is sent as a WhatsApp text from the current phone.
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createWhatsAppHarness, type WhatsAppHarness } from '@chema/whatsapp/testing';

const show = (from: string, reply: string) => {
  stdout.write(`\n[${from}] <- Chema\n${reply || '(no reply)'}\n`);
};

async function say(t: WhatsAppHarness, from: string, text: string): Promise<string> {
  stdout.write(`\n[${from}] -> ${text}\n`);
  const r = await t.say(from, text);
  show(from, r);
  return r;
}

async function completeHandoff(t: WhatsAppHarness, phone: string): Promise<void> {
  const token = t.tokenFor(phone);
  const d = await t.wa.describe(token);
  stdout.write(`\n[secure page] ${d.purpose} ${JSON.stringify(d.summary)}\n`);
  if (d.purpose === 'EVIDENCE' || d.purpose === 'PORTAL') {
    stdout.write('[secure page] context-only link: upload documents in the web app\n');
    return;
  }
  t.h.advance(6 * 60_000);
  const { challengeId } = await t.wa.startOtp(token);
  const code = t.h.otp.lastCodeFor(phone) ?? '';
  stdout.write(`[secure page] one-time code sent to ${phone} (entered on the page)\n`);
  const r = await t.wa.confirm(token, challengeId, code);
  stdout.write(`[secure page] done: ${JSON.stringify(r)}\n`);
  await t.pumpWa();
  show(phone, t.sim.last(phone));
}

async function payAll(t: WhatsAppHarness): Promise<void> {
  const { rows } = await t.h.db.query<{ provider_ref: string; rail: string }>(
    "SELECT provider_ref, rail FROM payment WHERE state IN ('INITIATED', 'PENDING_UNKNOWN') AND provider_ref IS NOT NULL",
  );
  for (const r of rows) if (r.rail === 'ECOCASH') t.ecocash.succeed(r.provider_ref);
  await t.deliver(t.ecocash);
  await t.pumpWa();
  stdout.write(`\n[provider] confirmed ${rows.length} payment(s)\n`);
}

async function demo(t: WhatsAppHarness): Promise<void> {
  const family = '+263771000001';
  const friend = '+263772000002';
  await say(t, family, 'hi');
  await say(t, family, '7');
  await completeHandoff(t, family);
  await say(t, family, '8');
  await say(t, family, 'Tendai Chiwenga');
  await say(t, family, '2026-11-05');
  await say(t, family, 'skip');
  await say(t, family, 'Warren Hills, Harare');
  await say(t, family, '1');
  // Verification is a portal job: run it with the real commands.
  const conv = await t.wa.conversationFor(family);
  const actor = conv?.authSessionId ? await t.h.auth.actorForSession(conv.authSessionId) : null;
  if (!actor) throw new Error('family not signed in');
  const admin = { actor, token: '', personId: actor.personId };
  const { rows } = await t.h.db.query<{ id: string }>("SELECT id FROM wallet WHERE deceased_name = 'Tendai Chiwenga'");
  const walletId = rows[0]?.id ?? '';
  await t.fullEvidence(actor, walletId);
  const { caseId } = await t.h.bus.execute(t.w.submit, { walletId }, { actor });
  const verifier = await t.verifier();
  await t.assignVerifier(walletId, verifier.personId);
  const { ALL_PASS } = await import('@chema/wallet/testing');
  const d = await t.h.bus.execute(t.w.decide, { caseId, outcome: 'APPROVED', reasonCode: 'EVIDENCE_SUFFICIENT', checklist: ALL_PASS }, { actor: verifier.actor });
  stdout.write(`\n[portal] wallet verified: https://chema.test/w/${d.publicSlug}\n`);

  await say(t, friend, `https://chema.test/w/${d.publicSlug}`);
  const rails = await say(t, friend, '20');
  const eco = rails.split('\n').find((l) => l.includes('ECOCASH'))?.split('.')[0] ?? '1';
  await say(t, friend, eco);
  await say(t, friend, 'Rudo Moyo');
  await say(t, friend, '1');
  await say(t, friend, 'Lala ngoxolo');
  await say(t, friend, '1');
  await payAll(t);
  show(friend, t.sim.last(friend));
  await say(t, friend, 'menu');
  await say(t, friend, '2');

  const approver = await t.approver(walletId);
  await t.activePayee(admin, approver, walletId, { holder: 'Doves Funeral Services' });
  await say(t, family, 'menu');
  await say(t, family, '9');
  await say(t, family, '1');
  await say(t, family, '15');
  await say(t, family, '1');
  await say(t, family, '1');
  await completeHandoff(t, family);
  await say(t, family, 'menu');
  await say(t, family, '10');
}

async function main(): Promise<void> {
  const t = await createWhatsAppHarness();
  try {
    if (process.argv.includes('--demo')) {
      await demo(t);
      return;
    }
    let phone = '+263771000001';
    const rl = createInterface({ input: stdin, output: stdout });
    stdout.write(`WhatsApp simulator. You are ${phone}. Type "hi" to start, /quit to leave.\n`);
    for (;;) {
      const line = (await rl.question(`${phone}> `)).trim();
      if (!line) continue;
      try {
        if (line === '/quit') break;
        else if (line.startsWith('/as ')) phone = line.slice(4).trim();
        else if (line === '/wallet') {
          const { slug } = await t.publicWallet();
          stdout.write(`verified wallet: https://chema.test/w/${slug}\n`);
        } else if (line === '/code') await completeHandoff(t, phone);
        else if (line === '/pay') await payAll(t);
        else show(phone, await t.say(phone, line));
      } catch (err) {
        stdout.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    rl.close();
  } finally {
    await t.close();
  }
}

await main();
