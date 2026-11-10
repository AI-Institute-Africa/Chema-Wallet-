// Races on the verification workflow. Runs on PGlite always and on real
// Postgres 16 when CHEMA_TEST_DATABASE_URL is set; only the real-Postgres run
// proves anything (PGlite has one connection, so transactions never overlap).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlClient } from '@chema/shared';
import { realPgTestDb } from '@chema/shared/testing';
import { ALL_PASS, createWalletHarness, type WalletHarness } from './test-support';

const REAL_PG = process.env.CHEMA_TEST_DATABASE_URL;
const backends: Array<[string, (() => Promise<SqlClient>) | undefined]> = [['pglite', undefined]];
if (REAL_PG) backends.push(['postgres', () => realPgTestDb(REAL_PG, 12)]);

describe.each(backends)('wallet concurrency on %s', (_name, open) => {
  let t: WalletHarness;
  beforeAll(async () => {
    t = await createWalletHarness({}, open ? { db: await open() } : {});
  });
  afterAll(async () => {
    await t?.close();
  });

  it('parallel submissions open exactly one case', async () => {
    const admin = await t.h.customer();
    const walletId = await t.draft(admin.actor);
    await t.fullEvidence(admin.actor, walletId);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => t.h.bus.execute(t.w.submit, { walletId }, { actor: admin.actor })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const { rows } = await t.h.db.query('SELECT 1 FROM verification_case WHERE wallet_id = $1', [walletId]);
    expect(rows).toHaveLength(1);
  });

  it('two verifiers deciding the same case at once: one decision, one slug', async () => {
    const admin = await t.h.customer();
    const walletId = await t.draft(admin.actor);
    await t.fullEvidence(admin.actor, walletId);
    const { caseId } = await t.h.bus.execute(t.w.submit, { walletId }, { actor: admin.actor });
    const v1 = await t.verifier();
    const v2 = await t.verifier();
    await t.assignVerifier(walletId, v1.personId);
    await t.assignVerifier(walletId, v2.personId);
    const results = await Promise.allSettled([
      t.h.bus.execute(t.w.decide, { caseId, outcome: 'APPROVED', reasonCode: 'EVIDENCE_SUFFICIENT', checklist: ALL_PASS }, { actor: v1.actor }),
      t.h.bus.execute(
        t.w.decide,
        { caseId, outcome: 'REJECTED', reasonCode: 'OTHER', checklist: { ...ALL_PASS, DETAILS_CONSISTENT: 'FAIL' }, notes: 'Name differs on ID.' },
        { actor: v2.actor },
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const { rows } = await t.h.db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM wallet_status_event WHERE wallet_id = $1 AND from_status = $2',
      [walletId, 'PENDING_VERIFICATION'],
    );
    expect(rows[0]?.n).toBe('1');
  });
});
