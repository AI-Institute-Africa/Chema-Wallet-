import type { SqlClient } from '@chema/shared';
import { migratedTestDb } from '@chema/shared/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryAuditSink } from '../audit/sink';
import { FLAGS, FLAG_KEYS, envVarFor, type FlagKey } from './registry';
import {
  DualApprovalRequiredError,
  FlagService,
  FlagValueError,
  LockedFlagError,
  UnknownFlagError,
} from './service';

let db: SqlClient;
let audit: MemoryAuditSink;
const admin = { id: 'staff-1', role: 'fidelity_admin' };

beforeAll(async () => {
  db = await migratedTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.exec('DELETE FROM config_flag');
  audit = new MemoryAuditSink();
});

const svc = (env: Record<string, string> = {}) => new FlagService(db, audit, env);

describe('flag registry safe defaults', () => {
  it('every boolean flag defaults to false (disabled)', () => {
    for (const key of FLAG_KEYS) {
      const d = FLAGS[key].default;
      if (typeof d === 'boolean') expect(d, key).toBe(false);
    }
  });

  it('every threshold/policy/limit defaults to unset (null ⇒ blocking behaviour)', () => {
    for (const key of FLAG_KEYS) {
      const d = FLAGS[key].default;
      if (typeof d !== 'boolean' && !Array.isArray(d)) expect(d, key).toBeNull();
    }
  });

  it('covers the docs/13 kill switches and decision keys', () => {
    const required: FlagKey[] = [
      'live_funds.enabled',
      'contributions.enabled',
      'payouts.enabled',
      'rail.ecocash',
      'rail.onemoney',
      'rail.card',
      'channel.whatsapp',
      'channel.sms',
      'marketing.enabled',
      'fees.enabled',
      'commissions.enabled',
      'fidelity.claims_link',
      'data.cross_border',
      'approvals.payout_high_value_minor',
      'verification.evidence_types',
      'verification.sla_hours',
      'fraud.velocity_max_drafts_24h',
      'claims.auto_approve_limit_minor',
      'closure.excess_funds_policy',
      'refund.policy',
      'retention.financial_years',
      'pilot.max_wallets',
      'pilot.max_amount_minor',
      'recon.tolerance.ecocash.usd',
    ];
    for (const key of required) expect(FLAG_KEYS).toContain(key);
  });

  it('only English is enabled by default', () => {
    expect(FLAGS['i18n.enabled_locales'].default).toEqual(['en']);
  });

  it('env var names are unique', () => {
    const names = FLAG_KEYS.map(envVarFor);
    expect(new Set(names).size).toBe(names.length);
  });

  it('a fresh database resolves every flag to its default', async () => {
    for (const flag of await svc().snapshot()) {
      expect(flag.source, flag.key).toBe('default');
    }
  });
});

describe('FlagService reads', () => {
  it('precedence: env > db > default', async () => {
    expect(await svc().get('channel.sms')).toBe(false);
    await svc().set('channel.sms', true, admin, 'test');
    expect(await svc().get('channel.sms')).toBe(true);
    expect(await svc({ CHEMA_FLAG_CHANNEL_SMS: 'false' }).get('channel.sms')).toBe(false);
  });

  it('parses minor-unit thresholds as bigint from env', async () => {
    const v = await svc({ CHEMA_FLAG_APPROVALS_PAYOUT_HIGH_VALUE_MINOR: '50000' }).get(
      'approvals.payout_high_value_minor',
    );
    expect(v).toBe(50000n);
  });

  it.each([
    ['CHEMA_FLAG_RAIL_ECOCASH', 'yes'],
    ['CHEMA_FLAG_APPROVALS_PAYOUT_HIGH_VALUE_MINOR', '12.5'],
    ['CHEMA_FLAG_VERIFICATION_EVIDENCE_TYPES', 'SELFIE'],
    ['CHEMA_FLAG_I18N_ENABLED_LOCALES', 'sn'],
  ])('fails loudly on invalid env %s=%s', async (name, value) => {
    const s = svc({ [name]: value });
    await expect(s.snapshot()).rejects.toThrow(FlagValueError);
  });

  it('fails loudly on an invalid db value', async () => {
    await db.query(`INSERT INTO config_flag (key, value) VALUES ('channel.sms', '"on"'::jsonb)`);
    await expect(svc().get('channel.sms')).rejects.toThrow(FlagValueError);
  });

  it('commissions.enabled cannot be turned on, even via env', async () => {
    await expect(svc({ CHEMA_FLAG_COMMISSIONS_ENABLED: 'true' }).get('commissions.enabled')).rejects.toThrow(
      LockedFlagError,
    );
  });

  it('unknown keys throw', async () => {
    await expect(svc().get('nope' as FlagKey)).rejects.toThrow(UnknownFlagError);
  });
});

describe('FlagService writes', () => {
  it('financial flags are refused (dual approval) and the denial is audited', async () => {
    await expect(svc().set('live_funds.enabled', true, admin, 'go live')).rejects.toThrow(
      DualApprovalRequiredError,
    );
    expect(await svc().get('live_funds.enabled')).toBe(false);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ authzResult: 'DENIED', reasonCode: 'DUAL_APPROVAL_REQUIRED' });
  });

  it('every financial flag is refused', async () => {
    for (const key of FLAG_KEYS.filter((k) => FLAGS[k].financial)) {
      await expect(svc().set(key, FLAGS[key].default as never, admin, 'x'), key).rejects.toThrow();
    }
  });

  it('non-financial change writes history and an audit event', async () => {
    await svc().set('verification.sla_hours', 48, admin, 'ops agreed SLA');
    const { rows } = await db.query<{ old_value: unknown; new_value: unknown; actor_id: string }>(
      `SELECT old_value, new_value, actor_id FROM config_flag_change WHERE key = 'verification.sla_hours' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]).toEqual({ old_value: null, new_value: 48, actor_id: 'staff-1' });
    expect(audit.events.at(-1)).toMatchObject({ authzResult: 'ALLOWED', subjectId: 'verification.sla_hours', after: 48 });
  });

  it('rejects invalid values on write', async () => {
    await expect(svc().set('verification.evidence_types', [] as never, admin, 'x')).rejects.toThrow(FlagValueError);
    await expect(svc().set('i18n.enabled_locales', ['sn'] as never, admin, 'x')).rejects.toThrow(FlagValueError);
  });

  it('change history is append-only', async () => {
    await svc().set('channel.sms', true, admin, 'test');
    await expect(db.exec(`UPDATE config_flag_change SET actor_id = 'someone-else'`)).rejects.toThrow(/append-only/);
    await expect(db.exec('DELETE FROM config_flag_change')).rejects.toThrow(/append-only/);
    await expect(db.exec('TRUNCATE config_flag_change')).rejects.toThrow(/append-only/);
  });
});
