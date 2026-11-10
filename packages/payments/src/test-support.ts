// Test-only harness for payments: core harness + three mock rails on the
// harness clock + a gate that accepts the wallets a test opens. Never import
// at runtime.
import { randomUUID } from 'node:crypto';
import { envVarFor, type FlagKey } from '@chema/core';
import { createHarness, type Harness } from '@chema/core/testing';
import { MockCard, MockEcoCash, MockOneMoney, type MockRail } from '@chema/providers';
import { money, type Currency, type SqlClient } from '@chema/shared';
import type { ContributionGate } from './gate';
import { RailRegistry } from './rails';
import { PaymentService } from './service';

export const WEBHOOK_SECRET = 'test-webhook-secret';

export interface PaymentsHarness {
  h: Harness;
  rails: RailRegistry;
  service: PaymentService;
  ecocash: MockRail;
  onemoney: MockRail;
  card: MockRail;
  /** Wallets the gate accepts. */
  open: Set<string>;
  newWallet(): string;
  /** Deliver every due callback of a rail through receive + process (as webhook + worker would). */
  deliver(rail: MockRail): Promise<{ outcome: string; duplicate: boolean }[]>;
  close(): Promise<void>;
}

/** Flags on by default for payment tests; override with `{ 'rail.card': 'false' }` etc. */
export async function createPaymentsHarness(
  flags: Partial<Record<FlagKey, string>> = {},
  opts: { db?: SqlClient } = {},
): Promise<PaymentsHarness> {
  const defaults: Partial<Record<FlagKey, string>> = {
    'contributions.enabled': 'true',
    'rail.ecocash': 'true',
    'rail.onemoney': 'true',
    'rail.card': 'true',
  };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...defaults, ...flags })) if (v !== undefined) env[envVarFor(k as FlagKey)] = v;
  const h = await createHarness(env, opts);
  const rails = new RailRegistry(h.flags);
  const railOpts = { webhookSecret: WEBHOOK_SECRET, clock: h.now };
  const ecocash = new MockEcoCash(railOpts);
  const onemoney = new MockOneMoney(railOpts);
  const card = new MockCard(railOpts);
  for (const r of [ecocash, onemoney, card]) await rails.register(r);
  const open = new Set<string>();
  const gate: ContributionGate = { canAccept: async (_q, walletId) => open.has(walletId) };
  const service = new PaymentService({ db: h.db, bus: h.bus, flags: h.flags, rails, gate, clock: h.now });
  return {
    h,
    rails,
    service,
    ecocash,
    onemoney,
    card,
    open,
    newWallet() {
      const id = randomUUID();
      open.add(id);
      return id;
    },
    async deliver(rail) {
      const out: { outcome: string; duplicate: boolean }[] = [];
      for (const w of rail.takeWebhooks(h.now())) {
        const r = await service.receiveWebhook(rail.rail, w.headers, w.body);
        const p = await service.processEvent(r.eventRowId);
        out.push({ outcome: p.outcome, duplicate: r.duplicate });
      }
      return out;
    },
    close: () => h.close(),
  };
}

export const usd = (minor: bigint) => money(minor, 'USD');
export const amountIn = (minor: bigint, ccy: Currency) => money(minor, ccy);
