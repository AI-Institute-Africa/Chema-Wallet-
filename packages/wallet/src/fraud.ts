// FraudRules (docs/11): deterministic duplicate / velocity rules. A finding is
// a review task (fraud_flag row) and NEVER changes wallet state: only a human
// blocks, suspends or rejects, with a written reason. Model-based scoring
// (`ai.fraud_model`) is out of MVP; this interface is where it would plug in.
import type { Queryable } from '@chema/shared';
import type { FraudRule } from './types';

export interface FraudFinding {
  rule: FraudRule;
  matchedWalletId: string | null;
  details: Record<string, unknown>;
  /** Stable per (rule, wallet, match): re-evaluation never duplicates a flag. */
  dedupeKey: string;
}

export interface FraudRules {
  evaluate(q: Queryable, walletId: string, ctx: { now: Date; velocityLimit: number }): Promise<FraudFinding[]>;
}

export const DEFAULT_VELOCITY_LIMIT = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export class DeterministicFraudRules implements FraudRules {
  async evaluate(q: Queryable, walletId: string, ctx: { now: Date; velocityLimit: number }): Promise<FraudFinding[]> {
    const out: FraudFinding[] = [];
    const { rows: me } = await q.query<{ created_by: string; admin_person: string }>(
      'SELECT created_by, admin_person FROM wallet WHERE id = $1',
      [walletId],
    );
    const self = me[0];
    if (!self) return out;

    // Same deceased: normalised name + date of death + normalised location.
    const { rows: dupes } = await q.query<{ id: string }>(
      `SELECT o.id FROM wallet w JOIN wallet o
          ON o.deceased_name_norm = w.deceased_name_norm AND o.date_of_death = w.date_of_death
         AND o.funeral_location_norm = w.funeral_location_norm AND o.id <> w.id
        WHERE w.id = $1 ORDER BY o.created_at`,
      [walletId],
    );
    for (const d of dupes) {
      out.push({ rule: 'DUPLICATE_DECEASED', matchedWalletId: d.id, details: {}, dedupeKey: `DUPLICATE_DECEASED:${walletId}:${d.id}` });
    }

    // Same certificate: by normalised-number hash, or the identical file.
    const { rows: certs } = await q.query<{ other: string; via: 'NUMBER' | 'FILE' }>(
      `SELECT DISTINCT o.wallet_id AS other, 'NUMBER' AS via
         FROM verification_evidence e JOIN verification_evidence o
           ON o.certificate_no_hash = e.certificate_no_hash AND o.wallet_id <> e.wallet_id
        WHERE e.wallet_id = $1 AND e.certificate_no_hash IS NOT NULL
       UNION
       SELECT DISTINCT od.linked_wallet AS other, 'FILE' AS via
         FROM verification_evidence e
         JOIN document d ON d.id = e.document_id
         JOIN document od ON od.sha256 = d.sha256 AND od.class = 'DEATH_EVIDENCE'
              AND od.linked_wallet IS NOT NULL AND od.linked_wallet <> e.wallet_id
        WHERE e.wallet_id = $1 AND d.class = 'DEATH_EVIDENCE'`,
      [walletId],
    );
    for (const c of certs) {
      out.push({
        rule: 'DUPLICATE_CERTIFICATE',
        matchedWalletId: c.other,
        details: { via: c.via },
        dedupeKey: `DUPLICATE_CERTIFICATE:${walletId}:${c.other}:${c.via}`,
      });
    }

    // Same admin across different deaths.
    const { rows: multi } = await q.query<{ id: string }>(
      `SELECT o.id FROM wallet w JOIN wallet o
          ON o.admin_person = w.admin_person AND o.id <> w.id
         AND (o.deceased_name_norm <> w.deceased_name_norm OR o.date_of_death <> w.date_of_death)
        WHERE w.id = $1 ORDER BY o.created_at`,
      [walletId],
    );
    for (const m of multi) {
      out.push({ rule: 'ADMIN_MULTI_DEATH', matchedWalletId: m.id, details: {}, dedupeKey: `ADMIN_MULTI_DEATH:${walletId}:${m.id}` });
    }

    // Velocity: drafts by the same creator in the last 24 h.
    const since = new Date(ctx.now.getTime() - DAY_MS);
    const { rows: vel } = await q.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM wallet WHERE created_by = $1 AND created_at > $2 AND created_at <= $3',
      [self.created_by, since, ctx.now],
    );
    const count = Number(vel[0]?.n ?? '0');
    if (count > ctx.velocityLimit) {
      out.push({
        rule: 'CREATOR_VELOCITY',
        matchedWalletId: null,
        details: { draftsIn24h: count, limit: ctx.velocityLimit },
        dedupeKey: `CREATOR_VELOCITY:${walletId}`,
      });
    }
    return out;
  }
}

/** Persist findings as open review flags. Returns the newly created flag count. */
export async function recordFindings(q: Queryable, walletId: string, findings: FraudFinding[], now: Date): Promise<number> {
  let created = 0;
  for (const f of findings) {
    const { rows } = await q.query(
      `INSERT INTO fraud_flag (wallet_id, rule, matched_wallet_id, details, dedupe_key, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [walletId, f.rule, f.matchedWalletId, JSON.stringify(f.details), f.dedupeKey, now],
    );
    created += rows.length;
  }
  return created;
}
