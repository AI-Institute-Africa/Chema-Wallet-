// OTP delivery. Real SMS/WhatsApp providers are D16 decisions and land behind
// channel.* flags; until then only the mock exists. Codes are never logged.
import { randomInt } from 'node:crypto';

export type OtpDelivery = 'SMS' | 'WHATSAPP';

export interface OtpProvider {
  /** Deliver a one-time code. Failure must not change any transaction state. */
  send(to: { phoneE164: string; via: OtpDelivery }, code: string): Promise<void>;
}

/** Test/dev provider: keeps codes in memory so tests can read them. */
export class MockOtpProvider implements OtpProvider {
  readonly sent: { phoneE164: string; via: OtpDelivery; code: string }[] = [];
  failNext = false;

  async send(to: { phoneE164: string; via: OtpDelivery }, code: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('mock OTP delivery failure');
    }
    this.sent.push({ ...to, code });
  }

  lastCodeFor(phoneE164: string): string | undefined {
    return this.sent.filter((s) => s.phoneE164 === phoneE164).at(-1)?.code;
  }
}

/**
 * LOCAL DEVELOPMENT ONLY: "delivers" each code by appending a line to a file
 * (mode 0600) so a developer can sign in to the web app before a real SMS /
 * WhatsApp provider exists (D16). Never the app log. The API refuses to use it
 * when NODE_ENV=production (see apps/api/src/otp.ts).
 */
export class DevFileOtpProvider implements OtpProvider {
  constructor(readonly path: string) {}

  async send(to: { phoneE164: string; via: OtpDelivery }, code: string): Promise<void> {
    const { appendFile } = await import('node:fs/promises');
    const line = JSON.stringify({ ts: new Date().toISOString(), phone: to.phoneE164, via: to.via, code });
    await appendFile(this.path, `${line}\n`, { mode: 0o600 });
  }
}

export function newOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}
