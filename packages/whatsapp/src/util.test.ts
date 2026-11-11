import { createHmac, randomBytes } from 'node:crypto';
import { MetaCloudProvider, SimulatorProvider } from '@chema/channels';
import { describe, expect, it } from 'vitest';
import { humanSignal, matchFaq } from './faq';
import { looksSensitive, maskPhone, parseAmount, parseDate, parseSlug } from './util';

describe('sensitive input', () => {
  it.each([
    ['482913', false, true],
    ['1234', false, true],
    ['12 34 56', false, true],
    ['4111 1111 1111 1111', false, true],
    ['4111-1111-1111-1111', true, true],
    ['my pin is 1234', false, true],
    ['OTP: 552211', false, true],
    ['password hunter2', false, true],
    ['1000', true, false],
    ['25.50', false, false],
    ['2026-11-05', false, false],
    ['hi', false, false],
    ['code abcdefghijk2345mnopqrstuv', false, false],
    ['4111 1111 1111 1112', false, false],
  ])('%s (amount expected: %s) ⇒ %s', (text, expectingAmount, sensitive) => {
    expect(looksSensitive(text, expectingAmount)).toBe(sensitive);
  });
});

describe('parsing', () => {
  it('amounts', () => {
    expect(parseAmount('10', 'USD')?.minor).toBe(1000n);
    expect(parseAmount('$12.5', 'USD')?.minor).toBe(1250n);
    expect(parseAmount('USD 1,250.05', 'USD')?.minor).toBe(125005n);
    for (const bad of ['0', '-5', '1.234', 'ten', '1e3', '']) expect(parseAmount(bad, 'USD')).toBeNull();
  });

  it('slugs from links or bare codes', () => {
    const slug = 'abcdefghijklmnopqrstuvwxyz';
    expect(parseSlug(`https://chema.test/w/${slug}`)).toBe(slug);
    expect(parseSlug(`please see https://x.test/w/${slug}?ref=wa`)).toBe(slug);
    expect(parseSlug(slug.toUpperCase())).toBe(slug);
    expect(parseSlug('abc')).toBeNull();
  });

  it('dates and masking', () => {
    expect(parseDate('2026-11-05')).toBe('2026-11-05');
    expect(parseDate('2026-02-30')).toBeNull();
    expect(maskPhone('+263771234567')).toBe('+263•••••4567');
  });

  it('FAQ + human signals are deterministic', () => {
    expect(matchFaq('what are the fees')?.id).toBe('fees');
    expect(matchFaq('lorem ipsum')).toBeNull();
    expect(humanSignal('this is a scam')).toBe('FRAUD');
    expect(humanSignal('I feel hopeless')).toBe('DISTRESS');
    expect(humanSignal('thank you')).toBeNull();
  });
});

describe('providers', () => {
  const now = new Date('2026-11-11T10:00:00Z');

  it('simulator: signature over timestamp + body, replay window', () => {
    const sim = new SimulatorProvider('sim-secret-0123456789', () => now);
    const hook = sim.say('+263771234567', 'hi', { messageId: 'm1' });
    expect(sim.verify(hook.headers, hook.body, now)).toEqual({ ok: true });
    expect(sim.verify(hook.headers, `${hook.body} `, now)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(sim.verify({ ...hook.headers, 'x-sim-timestamp': String(now.getTime() + 1) }, hook.body, now)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(sim.verify(hook.headers, hook.body, new Date(now.getTime() + 6 * 60_000))).toEqual({ ok: false, reason: 'STALE' });
    expect(sim.parse(hook.body).messages[0]).toMatchObject({ messageId: 'm1', from: '+263771234567', text: 'hi', kind: 'TEXT' });
  });

  it('Meta stub: X-Hub-Signature-256 + documented payload; sending is refused', async () => {
    const secret = randomBytes(16).toString('hex');
    const meta = new MetaCloudProvider(secret);
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ id: 'wamid.X', from: '263771234567', timestamp: '1762855200', type: 'text', text: { body: 'hello' } }],
                statuses: [{ id: 'wamid.Y', status: 'delivered', timestamp: '1762855201' }],
              },
            },
          ],
        },
      ],
    });
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(meta.verify({ 'x-hub-signature-256': sig }, body)).toEqual({ ok: true });
    expect(meta.verify({ 'x-hub-signature-256': 'sha256=00' }, body)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    const p = meta.parse(body);
    expect(p.messages[0]).toMatchObject({ messageId: 'wamid.X', from: '+263771234567', text: 'hello' });
    expect(p.statuses[0]).toMatchObject({ providerMessageId: 'wamid.Y', status: 'DELIVERED' });
    await expect(meta.send()).rejects.toThrow('META_NOT_CONFIGURED');
  });
});
