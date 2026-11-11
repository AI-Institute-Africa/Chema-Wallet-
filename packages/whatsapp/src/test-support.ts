// Test-only harness for P08: the payout harness (wallets, contributions,
// Fidelity, payouts, mock rails) + WhatsAppService on the simulator. `say`
// walks the REAL pipeline: signed webhook → raw store → outbox → process →
// reply notification → simulator. Never import at runtime.
import type { FlagKey } from '@chema/core';
import type { SimulatorProvider } from '@chema/channels';
import { PUBLIC_BASE } from '@chema/contributions/testing';
import { createPayoutHarness, type PayoutHarness } from '@chema/payouts/testing';
import type { SqlClient } from '@chema/shared';
import { WA_INBOUND_TOPIC, WhatsAppService } from './service';

export const PORTAL_URL = 'https://portal.chema.test';

export interface WhatsAppHarness extends PayoutHarness {
  wa: WhatsAppService;
  sim: SimulatorProvider;
  /** Send a text from `phone` through the whole pipeline; returns the reply (or '' if none). */
  say(phone: string, text: string, opts?: { messageId?: string; kind?: 'TEXT' | 'MEDIA' | 'OTHER' }): Promise<string>;
  /** Relay outbox, process queued WhatsApp messages, deliver notifications, until quiet. */
  pumpWa(): Promise<void>;
  /** Hand-off token in the last message to `phone`. */
  tokenFor(phone: string): string;
  /** Sign `phone` in on WhatsApp through the secure hand-off + WhatsApp OTP. */
  signIn(phone: string): Promise<void>;
}

export async function createWhatsAppHarness(flags: Partial<Record<FlagKey, string>> = {}, opts: { db?: SqlClient } = {}): Promise<WhatsAppHarness> {
  const t = await createPayoutHarness(flags, opts);
  const { h } = t;
  const sim = t.whatsapp;
  const wa = new WhatsAppService({
    db: h.db,
    bus: h.bus,
    flags: h.flags,
    auth: h.auth,
    contributions: t.contributions,
    wallets: t.w,
    payouts: t.payouts,
    claims: t.claims,
    publicBaseUrl: PUBLIC_BASE,
    portalUrl: PORTAL_URL,
    secrets: t.secrets,
    providers: [sim],
    clock: h.now,
  });
  const seen = new Set<unknown>();

  const x: WhatsAppHarness = {
    ...t,
    wa,
    sim,
    async pumpWa() {
      for (let round = 0; round < 10; round++) {
        await t.pump();
        const fresh = t.events.filter((e) => e.topic === WA_INBOUND_TOPIC && !seen.has(e));
        if (fresh.length === 0) return;
        for (const e of fresh) {
          seen.add(e);
          await wa.process(String(e.payload['inboundId']));
        }
      }
    },
    async say(phone, text, o = {}) {
      const before = sim.inbox(phone).length;
      const hook = sim.say(phone, text, o);
      await wa.receiveWebhook('SIMULATOR', hook.headers, hook.body);
      await x.pumpWa();
      const after = sim.inbox(phone);
      return after.length > before ? (after[after.length - 1] ?? '') : '';
    },
    tokenFor(phone) {
      const m = /\/h#([A-Za-z0-9_-]+)/.exec(sim.last(phone));
      if (!m?.[1]) throw new Error(`no hand-off link in: ${sim.last(phone)}`);
      return m[1];
    },
    async signIn(phone) {
      await x.say(phone, 'hi');
      await x.say(phone, '7'); // Family sign in
      const token = x.tokenFor(phone);
      h.advance(6 * 60_000); // stay under the OTP send limit
      const { challengeId } = await wa.startOtp(token);
      const code = h.otp.lastCodeFor(phone);
      if (!code) throw new Error('no OTP');
      await wa.confirm(token, challengeId, code);
      await x.pumpWa();
    },
  };
  return x;
}
