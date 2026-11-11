// Composition of the P08 WhatsApp channel for the API and the worker.
// Providers: the local simulator outside production (signed with
// CHEMA_WA_SIM_SECRET, random per process if unset); the Meta Cloud API stub
// only when `channel.whatsapp` is on AND CHEMA_META_APP_SECRET is set (D16) —
// and even then it refuses to send until the account is configured.
import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { MetaCloudProvider, SimulatorProvider, WhatsAppSender, type ChannelProvider, type ChannelSender } from '@chema/channels';
import type { CoreServices, Secrets } from '@chema/core';
import type { ContributionService } from '@chema/contributions';
import type { ClaimsService } from '@chema/fidelity';
import type { PayoutService } from '@chema/payouts';
import type { WalletCommands } from '@chema/wallet';
import { WhatsAppService } from '@chema/whatsapp';

export interface WhatsAppProviders {
  providers: ChannelProvider[];
  /** Sender for WHATSAPP notifications, if any provider can send. */
  sender: ChannelSender | null;
  warnings: string[];
}

export async function chooseWhatsAppProviders(core: CoreServices, env: Record<string, string | undefined>): Promise<WhatsAppProviders> {
  const providers: ChannelProvider[] = [];
  const warnings: string[] = [];
  let sender: ChannelSender | null = null;
  const production = env['NODE_ENV'] === 'production';

  if (!production) {
    const configured = env['CHEMA_WA_SIM_SECRET'];
    const secret = configured && configured.length >= 16 ? configured : randomBytes(24).toString('base64url');
    if (!configured) warnings.push('CHEMA_WA_SIM_SECRET unset: WhatsApp simulator webhook secret is per-process');
    const outbox = env['CHEMA_WA_SIM_OUTBOX'];
    const sim = new SimulatorProvider(secret, () => new Date(), outbox ? (m) => appendFileSync(outbox, `${JSON.stringify({ ...m, at: new Date().toISOString() })}\n`) : undefined);
    providers.push(sim);
    sender = new WhatsAppSender(sim);
    warnings.push('WhatsApp provider is the local SIMULATOR');
  }

  const metaSecret = env['CHEMA_META_APP_SECRET'];
  if ((await core.flags.get('channel.whatsapp')) && metaSecret && metaSecret.length >= 16) {
    const meta = new MetaCloudProvider(metaSecret);
    providers.push(meta);
    sender = new WhatsAppSender(meta);
    warnings.push('Meta WhatsApp adapter is a STUB (D16): inbound verified, sending refused');
  }
  return { providers, sender, warnings };
}

export function buildWhatsApp(
  core: CoreServices,
  deps: {
    secrets: Secrets;
    providers: ChannelProvider[];
    contributions: ContributionService;
    wallets: WalletCommands;
    payouts: PayoutService;
    claims?: ClaimsService;
    publicBaseUrl: string;
    portalUrl: string;
  },
): WhatsAppService {
  return new WhatsAppService({
    db: core.db,
    bus: core.bus,
    flags: core.flags,
    auth: core.auth,
    contributions: deps.contributions,
    wallets: deps.wallets,
    payouts: deps.payouts,
    ...(deps.claims ? { claims: deps.claims } : {}),
    secrets: deps.secrets,
    providers: deps.providers,
    publicBaseUrl: deps.publicBaseUrl,
    portalUrl: deps.portalUrl,
  });
}
