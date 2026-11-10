// Flag reads: env override (CHEMA_FLAG_*) > config_flag row > registry default.
// Invalid values from any source fail loudly — never silently fall back.
// Writes: change history + audit row in the same transaction. Financial flags
// need an APPROVED, unconsumed `config.change` approval (maker-checker, see
// flags/commands.ts) whose payload matches key + value exactly; the caller
// must be its maker. Locked flags never leave their default.
import type { Queryable, SqlClient } from '@chema/shared';
import { consumeApprovalFor } from '../approval/service';
import type { AuditSink } from '../audit/sink';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors';
import { FLAGS, FLAG_KEYS, envVarFor, isFlagKey, type FlagDef, type FlagKey, type FlagSource, type FlagValue } from './registry';

export interface FlagActor {
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
    super(`flag ${key} is financial: changes require an approved config.change approval`);
    this.name = 'DualApprovalRequiredError';
  }
}

/** What a config.change approval pins: the key and the encoded value. */
export function flagApprovalPayload(key: FlagKey, encoded: unknown): { key: FlagKey; value: unknown } {
  return { key, value: encoded };
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

  /** Read through an open transaction (consistent with it; no second connection). */
  async getIn<K extends FlagKey>(q: Queryable, key: K): Promise<FlagValue<K>> {
    return (await this.resolve(key, q)).value as FlagValue<K>;
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

  /** Encode a value through the flag codec (validates it). */
  encode<K extends FlagKey>(key: K, value: FlagValue<K>): unknown {
    if (!isFlagKey(key)) throw new UnknownFlagError(key);
    const d = def(key);
    const encoded = d.encode(value);
    try {
      d.decode(encoded, 'db');
    } catch (err) {
      throw new FlagValueError(key, 'db', err);
    }
    return encoded;
  }

  async set<K extends FlagKey>(
    key: K,
    value: FlagValue<K>,
    actor: FlagActor,
    reason: string,
    opts: { approvalId?: string } = {},
  ): Promise<void> {
    if (!isFlagKey(key)) throw new UnknownFlagError(key);
    const d = def(key);
    const base = {
      action: 'config_flag.set',
      actorId: actor.id,
      actorRole: actor.role,
      channel: actor.channel ?? 'ADMIN',
      subjectType: 'config_flag',
      subjectId: key,
    };
    const denyAudit = (reasonCode: string) =>
      this.audit.record({ ...base, authzResult: 'DENIED', reasonCode, ts: new Date() });

    if (d.locked) {
      await denyAudit('FLAG_LOCKED');
      throw new LockedFlagError(key);
    }
    if (d.financial && !opts.approvalId) {
      await denyAudit('DUAL_APPROVAL_REQUIRED');
      throw new DualApprovalRequiredError(key);
    }

    // Round-trip through the codec so callers cannot persist an invalid value.
    const encoded = this.encode(key, value);

    try {
      await this.db.transaction(async (tx) => {
        if (d.financial && opts.approvalId) {
          await consumeApprovalFor(tx, actor.id, opts.approvalId, {
            action: 'config.change',
            subjectType: 'config_flag',
            subjectId: key,
            payload: flagApprovalPayload(key, encoded),
          });
        }
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
          `INSERT INTO config_flag_change (key, old_value, new_value, actor_id, actor_role, approval_ref, reason)
           VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7)`,
          [key, JSON.stringify(old), JSON.stringify(encoded), actor.id, actor.role, opts.approvalId ?? null, reason],
        );
        await this.audit.record(
          {
            ...base,
            authzResult: 'ALLOWED',
            before: old,
            after: encoded,
            reasonCode: reason,
            ...(opts.approvalId ? { approvalRef: opts.approvalId } : {}),
            ts: new Date(),
          },
          tx,
        );
      });
    } catch (err) {
      if (err instanceof ForbiddenError || err instanceof ConflictError || err instanceof NotFoundError) {
        await denyAudit(err instanceof NotFoundError ? 'APPROVAL_NOT_FOUND' : err.reason);
        throw new DualApprovalRequiredError(key);
      }
      throw err;
    }
  }
}
