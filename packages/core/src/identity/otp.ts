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

export function newOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}
