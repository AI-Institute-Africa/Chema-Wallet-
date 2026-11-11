// WhatsApp provider boundary (docs/09 Platform). Everything WhatsApp-specific
// sits behind `ChannelProvider`: signature + replay checks, payload parsing and
// sending. The local `SimulatorProvider` drives dev + tests; `MetaCloudProvider`
// is a stub for the official WhatsApp Business Platform (D16) and stays off
// until `channel.whatsapp` is approved. Current Meta rules (opt-in, templates,
// 24 h service window) must be verified at go-live, not assumed here.
import { createHmac } from 'node:crypto';
import { safeEqual } from '@chema/core';
import type { ChannelSender } from '../notify/service';

export const WA_PROVIDERS = ['SIMULATOR', 'META'] as const;
export type WaProviderName = (typeof WA_PROVIDERS)[number];

export interface InboundMessage {
  /** Provider message id: the idempotency key of the raw store. */
  messageId: string;
  /** E.164, as the provider authenticated it. */
  from: string;
  /** Text body. Non-text messages arrive as '' with `kind` set. */
  text: string;
  kind: 'TEXT' | 'MEDIA' | 'OTHER';
  sentAt: Date;
}

export const DELIVERY_STATUSES = ['SENT', 'DELIVERED', 'READ', 'FAILED'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface StatusEvent {
  providerMessageId: string;
  status: DeliveryStatus;
  at: Date;
  error?: string;
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'BAD_SIGNATURE' | 'STALE' | 'MALFORMED' };

export interface ChannelProvider {
  readonly name: WaProviderName;
  /** Signature + replay window over the exact raw bytes. */
  verify(headers: Record<string, string | undefined>, rawBody: string, now: Date): VerifyResult;
  /** Parse a verified body. Throws on malformed input. */
  parse(rawBody: string): { messages: InboundMessage[]; statuses: StatusEvent[] };
  /** Send a text. `template` = registered template key (needed outside the service window, D16). */
  send(to: string, text: string, meta?: { template: string }): Promise<{ providerRef: string }>;
}

/** Signed webhooks older than this are stale (replay protection). Not in spec: safest short default. */
export const WA_REPLAY_WINDOW_MS = 5 * 60_000;

const E164 = /^\+[1-9]\d{6,14}$/;
const hmac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('hex');

// ── Simulator ────────────────────────────────────────────────────────────────

interface SimBody {
  messages?: { id: string; from: string; text?: string; kind?: InboundMessage['kind']; timestamp: number }[];
  statuses?: { id: string; status: DeliveryStatus; timestamp: number; error?: string }[];
}

/**
 * Local simulator: plays the provider for dev and tests. `say` builds a signed
 * inbound webhook; everything the platform sends lands in `sent`.
 * Signature = HMAC-SHA256(secret, `${timestamp}.${body}`) in `x-sim-signature`.
 */
export class SimulatorProvider implements ChannelProvider {
  readonly name = 'SIMULATOR' as const;
  readonly sent: { to: string; text: string; template: string | null; providerRef: string; at: Date }[] = [];
  private seq = 0;
  private failures = 0;

  constructor(
    private readonly secret: string,
    private readonly clock: () => Date = () => new Date(),
    /** Dev only: also hand every sent message to this sink (e.g. a local log file). */
    private readonly sink?: (m: { to: string; text: string; providerRef: string }) => void,
  ) {
    if (secret.length < 16) throw new Error('simulator webhook secret must be at least 16 characters');
  }

  /** Next `n` sends fail (provider down). */
  failNext(n = 1): void {
    this.failures += n;
  }

  /** Messages sent to `phone`, oldest first. */
  inbox(phone: string): string[] {
    return this.sent.filter((m) => m.to === phone).map((m) => m.text);
  }

  /** The last message sent to `phone`. */
  last(phone: string): string {
    const all = this.inbox(phone);
    return all[all.length - 1] ?? '';
  }

  private signed(body: SimBody, at = this.clock()): { headers: Record<string, string>; body: string } {
    const raw = JSON.stringify(body);
    const ts = String(at.getTime());
    return { headers: { 'content-type': 'application/json', 'x-sim-timestamp': ts, 'x-sim-signature': hmac(this.secret, `${ts}.${raw}`) }, body: raw };
  }

  /** A signed inbound text from `from`. Pass `messageId` to replay the same message. */
  say(from: string, text: string, opts: { messageId?: string; kind?: InboundMessage['kind'] } = {}) {
    const id = opts.messageId ?? `wamid.sim.${Date.now().toString(36)}.${++this.seq}`;
    return { messageId: id, ...this.signed({ messages: [{ id, from, text, kind: opts.kind ?? 'TEXT', timestamp: this.clock().getTime() }] }) };
  }

  /** A signed delivery-status callback for a message the platform sent. */
  status(providerRef: string, status: DeliveryStatus, error?: string) {
    return this.signed({ statuses: [{ id: providerRef, status, timestamp: this.clock().getTime(), ...(error ? { error } : {}) }] });
  }

  verify(headers: Record<string, string | undefined>, rawBody: string, now: Date): VerifyResult {
    const ts = headers['x-sim-timestamp'];
    const sig = headers['x-sim-signature'];
    if (!ts || !sig || !/^\d{1,16}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: 'BAD_SIGNATURE' };
    if (!safeEqual(hmac(this.secret, `${ts}.${rawBody}`), sig)) return { ok: false, reason: 'BAD_SIGNATURE' };
    if (Math.abs(now.getTime() - Number(ts)) > WA_REPLAY_WINDOW_MS) return { ok: false, reason: 'STALE' };
    return { ok: true };
  }

  parse(rawBody: string): { messages: InboundMessage[]; statuses: StatusEvent[] } {
    const b = JSON.parse(rawBody) as SimBody;
    const messages = (b.messages ?? []).map((m) => {
      if (typeof m.id !== 'string' || !E164.test(m.from) || typeof m.timestamp !== 'number') throw new Error('malformed message');
      return { messageId: m.id, from: m.from, text: typeof m.text === 'string' ? m.text : '', kind: m.kind ?? 'TEXT', sentAt: new Date(m.timestamp) };
    });
    const statuses = (b.statuses ?? []).map((s) => {
      if (typeof s.id !== 'string' || !(DELIVERY_STATUSES as readonly string[]).includes(s.status)) throw new Error('malformed status');
      return { providerMessageId: s.id, status: s.status, at: new Date(s.timestamp), ...(s.error ? { error: String(s.error).slice(0, 200) } : {}) };
    });
    return { messages, statuses };
  }

  async send(to: string, text: string, meta?: { template: string }): Promise<{ providerRef: string }> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('WhatsApp provider unavailable');
    }
    const providerRef = `sim-out-${++this.seq}`;
    this.sent.push({ to, text, template: meta?.template ?? null, providerRef, at: this.clock() });
    this.sink?.({ to, text, providerRef });
    return { providerRef };
  }
}

// ── Meta Cloud API (stub, not enabled) ───────────────────────────────────────

interface MetaBody {
  entry?: {
    changes?: {
      value?: {
        messages?: { id: string; from: string; timestamp: string; type: string; text?: { body?: string } }[];
        statuses?: { id: string; status: string; timestamp: string; errors?: { title?: string }[] }[];
      };
    }[];
  }[];
}

/**
 * Official WhatsApp Business Platform adapter. Inbound verification and parsing
 * follow the documented webhook shape (X-Hub-Signature-256 over the raw body);
 * `send` is NOT implemented: credentials, phone number id, approved templates
 * and the account owner are decision D16. It refuses rather than guessing.
 */
export class MetaCloudProvider implements ChannelProvider {
  readonly name = 'META' as const;

  constructor(private readonly appSecret: string) {
    if (appSecret.length < 16) throw new Error('Meta app secret missing');
  }

  verify(headers: Record<string, string | undefined>, rawBody: string): VerifyResult {
    const sig = headers['x-hub-signature-256'];
    if (!sig?.startsWith('sha256=')) return { ok: false, reason: 'BAD_SIGNATURE' };
    if (!safeEqual(hmac(this.appSecret, rawBody), sig.slice(7))) return { ok: false, reason: 'BAD_SIGNATURE' };
    // No signed timestamp on this platform: replay is caught by message-id
    // idempotency and the message timestamp window in the gateway.
    return { ok: true };
  }

  parse(rawBody: string): { messages: InboundMessage[]; statuses: StatusEvent[] } {
    const b = JSON.parse(rawBody) as MetaBody;
    const messages: InboundMessage[] = [];
    const statuses: StatusEvent[] = [];
    for (const e of b.entry ?? []) {
      for (const c of e.changes ?? []) {
        for (const m of c.value?.messages ?? []) {
          const from = `+${m.from}`;
          if (!E164.test(from)) throw new Error('malformed sender');
          const kind = m.type === 'text' ? 'TEXT' : ['image', 'document', 'audio', 'video'].includes(m.type) ? 'MEDIA' : 'OTHER';
          messages.push({ messageId: m.id, from, text: m.text?.body ?? '', kind, sentAt: new Date(Number(m.timestamp) * 1000) });
        }
        for (const s of c.value?.statuses ?? []) {
          const status = s.status.toUpperCase();
          if (!(DELIVERY_STATUSES as readonly string[]).includes(status)) continue;
          const error = s.errors?.[0]?.title;
          statuses.push({ providerMessageId: s.id, status: status as DeliveryStatus, at: new Date(Number(s.timestamp) * 1000), ...(error ? { error: error.slice(0, 200) } : {}) });
        }
      }
    }
    return { messages, statuses };
  }

  async send(): Promise<{ providerRef: string }> {
    throw new Error('META_NOT_CONFIGURED: WhatsApp Business account, number and templates are pending (D16)');
  }
}

/** Notification sender over a WhatsApp provider. */
export class WhatsAppSender implements ChannelSender {
  readonly channel = 'WHATSAPP' as const;
  constructor(private readonly provider: ChannelProvider) {}
  send(to: string, text: string, meta?: { template: string }): Promise<{ providerRef: string }> {
    return this.provider.send(to, text, meta);
  }
}
