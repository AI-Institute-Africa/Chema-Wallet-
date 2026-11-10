// Which OTP provider the running API uses. Real SMS/WhatsApp delivery is D16;
// until then codes go nowhere (MockOtpProvider), unless a developer opts in to
// CHEMA_DEV_OTP_FILE on a non-production process.
import { DevFileOtpProvider, MockOtpProvider, type OtpProvider } from '@chema/core';

export interface OtpChoice {
  provider: OtpProvider;
  warning: string;
}

export function chooseOtpProvider(env: Record<string, string | undefined>): OtpChoice {
  const file = env['CHEMA_DEV_OTP_FILE'];
  if (file && env['NODE_ENV'] === 'production') {
    return { provider: new MockOtpProvider(), warning: 'CHEMA_DEV_OTP_FILE ignored: not allowed with NODE_ENV=production; OTP delivery is a MOCK' };
  }
  if (file) {
    return { provider: new DevFileOtpProvider(file), warning: `DEV ONLY: OTP codes are written to ${file}; never use this outside a developer machine` };
  }
  return { provider: new MockOtpProvider(), warning: 'OTP delivery is a MOCK (no real provider configured): codes are not delivered' };
}
