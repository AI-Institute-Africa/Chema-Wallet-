// Flag reads: env override (CHEMA_FLAG_*) > config_flag row > registry default.
// Invalid values from any source fail loudly — never silently fall back.
// Writes: non-financial flags only, with change history + audit. Financial
// flags require dual approval, which does not exist until P01/P09, so they are
// refused (safest). Locked flags never leave their default.
import type { Queryable, SqlClient } from '@chema/shared';
import type { AuditSink } from '../audit/sink';
import { FLAGS, FLAG_KEYS, envVarFor, isFlagKey, type FlagDef, type FlagKey, type FlagSource, type FlagValue } from './registry';

export interface Actor {
  id: string;
  role: string;
  channel?: string;
}

export class UnknownFlagError extends Error {
  constructor(key: string) {
    super(`unknown flag: ${key}`);
    this.name = 'UnknownFlagError';
  }
}

export class FlagValueError extends Error {
  constructor(key: string, source: FlagSource, cause: unknown) {
    super(`invalid value for ${key} from ${source}`, { cause });
    this.name = 'FlagValueError';
  }
}

export class LockedFlagError extends Error {
  constructor(key: string) {
    super(`flag ${key} is locked to its default`);
    this.name = 'LockedFlagError';
  }
}

export class DualApprovalRequiredError extends Error {
  constructor(key: string) {
    super(`flag ${key} is financial: changes require dual approval (approval service not yet available)`);
    this.name = 'DualApprovalRequiredError';
  }
}

export interface ResolvedFlag {
  key: FlagKey;
  value: unknown;
  source: FlagSource;
}

type Env = Record<string, string | undefined>;

function def(key: FlagKey): FlagDef<unknown> {
  return FLAGS[key] as FlagDef<unknown>;
}

function sameValue(d: FlagDef<unknown>, a: unknown, b: unknown): boolean {
  return JSON.stringify(d.encode(a)) === JSON.stringify(d.encode(b));
}

export class FlagService {
  private readonly env: Env;

  constructor(
    private readonly db: SqlClient,
    private readonly audit: AuditSink,
    env: Env = process.env,
  ) {
    this.env = env;
  }

  async get<K extends FlagKey>(key: K): Promise<FlagValue<K>> {
    return (await this.resolve(key, this.db)).value as FlagValue<K>;
  }

  async isEnabled(key: { [K in FlagKey]: FlagValue<K> extends boolean ? K : never }[FlagKey]): Promise<boolean> {
    return (await this.get(key)) === true;
  }

  async snapshot(): Promise<ResolvedFlag[]> {
    const out: ResolvedFlag[] = [];
    for (const key of FLAG_KEYS) out.push(await this.resolve(key, this.db));
    return out;
  }

  private async resolve(key: FlagKey, q: Queryable): Promise<ResolvedFlag> {
    if (!isFlagKey(key)) throw new UnknownFlagError(key);
    const d = def(key);

    const envRaw = this.env[envVarFor(key)];
    if (envRaw !== undefined) return { key, value: this.decode(key, d, envRaw, 'env'), source: 'env' };

    const { rows } = await q.query<{ value: unknown }>('SELECT value FROM config_flag WHERE key = $1', [key]);
    const row = rows[0];
    if (row) return { key, value: this.decode(key, d, row.value, 'db'), source: 'db' };

    return { key, value: d.default, source: 'default' };
  }

  private decode(key: FlagKey, d: FlagDef<unknown>, raw: unknown, source: 'env' | 'db'): unknown {
    let value: unknown;
    try {
      value = d.decode(raw, source);
    } catch (err) {
      throw new FlagValueError(key, source, err);
    }
    if (d.locked && !sameValue(d, value, d.default)) throw new LockedFlagError(key);
    return value;
  }

  async set<K extends FlagKey>(key: K, value: FlagValue<K>, actor: Actor, reason: string): Promise<void> {
    if (!isFlagKey(key)) throw new UnknownFlagError(key);
    const d = def(key);
    const base = {
      action: 'config_flag.set',
      actorId: actor.id,
      actorRole: actor.role,
      channel: actor.channel ?? 'admin',
      subjectType: 'config_flag',
      subjectId: key,
      ts: new Date(),
    };

    if (d.locked) {
      await this.audit.record({ ...base, authzResult: 'DENIED', reasonCode: 'FLAG_LOCKED' });
      throw new LockedFlagError(key);
    }
    if (d.financial) {
      await this.audit.record({ ...base, authzResult: 'DENIED', reasonCode: 'DUAL_APPROVAL_REQUIRED' });
      throw new DualApprovalRequiredError(key);
    }

    // Round-trip through the codec so callers cannot persist an invalid value.
    const encoded = d.encode(value);
    try {
      d.decode(encoded, 'db');
    } catch (err) {
      throw new FlagValueError(key, 'db', err);
    }

    const before = await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ value: unknown }>(
        'SELECT value FROM config_flag WHERE key = $1 FOR UPDATE',
        [key],
      );
      const old = rows[0]?.value ?? null;
      await tx.query(
        `INSERT INTO config_flag (key, value, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(encoded)],
      );
      await tx.query(
        `INSERT INTO config_flag_change (key, old_value, new_value, actor_id, actor_role, reason)
         VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6)`,
        [key, JSON.stringify(old), JSON.stringify(encoded), actor.id, actor.role, reason],
      );
      return old;
    });

    await this.audit.record({ ...base, authzResult: 'ALLOWED', before, after: encoded, reasonCode: reason });
  }
}
