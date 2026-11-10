import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ACTOR } from '../authz/types';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { createHarness, type Harness } from '../test-support';
import { placeHold, releaseHold } from './service';
import { LocalFsBlobStore } from './store';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const PDF = Buffer.from('%PDF-1.7 death certificate for Tendai Moyo, serial 0012345');
const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');

async function walletWithAdmin() {
  const walletId = randomUUID();
  const admin = await h.customer();
  await h.grantRole(walletId, admin.personId, 'ADMIN');
  return { walletId, admin };
}

async function upload(data = PDF) {
  const w = await walletWithAdmin();
  const meta = await h.bus.execute(
    h.documents.upload,
    { class: 'DEATH_EVIDENCE', contentType: 'application/pdf', data, walletId: w.walletId },
    { actor: w.admin.actor },
  );
  return { ...w, meta };
}

const read = (documentId: string, actor: Awaited<ReturnType<Harness['customer']>>['actor']) =>
  h.bus.execute(h.documents.read, { documentId }, { actor });

describe('documents', () => {
  it('upload stores only ciphertext, sensitive retention class, scan pending', async () => {
    const { meta } = await upload();
    expect(meta).toMatchObject({ class: 'DEATH_EVIDENCE', retentionClass: 'SENSITIVE', scan: 'PENDING' });
    const blobs = [...h.blobs.blobs.values()];
    expect(blobs.some((b) => b.includes(PDF))).toBe(false);
    expect(blobs.some((b) => b.includes(Buffer.from('Tendai')))).toBe(false);
    const { rows } = await h.db.query<{ topic: string; payload: { documentId: string } }>(
      "SELECT topic, payload FROM outbox_event WHERE topic = 'document.scan' AND payload->>'documentId' = $1",
      [meta.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('not served until the scan is CLEAN; then served intact and the read is audited', async () => {
    const { meta, admin } = await upload();
    await expect(read(meta.id, admin.actor)).rejects.toMatchObject({ reason: 'DOCUMENT_NOT_AVAILABLE' });
    expect(await h.bus.execute(h.documents.applyScan, { documentId: meta.id }, { actor: SYSTEM_ACTOR })).toBe('CLEAN');
    const got = await read(meta.id, admin.actor);
    expect(got).toEqual({ contentType: 'application/pdf', data: PDF });
    const { rows } = await h.db.query("SELECT 1 FROM audit_log WHERE action = 'document.read' AND subject_id = $1 AND authz_result = 'ALLOWED'", [
      meta.id,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('INFECTED documents are never served', async () => {
    const { meta, admin } = await upload(EICAR);
    expect(await h.bus.execute(h.documents.applyScan, { documentId: meta.id }, { actor: SYSTEM_ACTOR })).toBe('INFECTED');
    await expect(read(meta.id, admin.actor)).rejects.toBeInstanceOf(ConflictError);
    await expect(h.db.query("UPDATE document SET malware_scan = 'CLEAN' WHERE id = $1", [meta.id])).rejects.toThrow(/set-once/);
  });

  it('only SYSTEM records scan results', async () => {
    const { meta, admin } = await upload();
    await expect(h.bus.execute(h.documents.applyScan, { documentId: meta.id }, { actor: admin.actor })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('IDOR: other customers, approvers, unassigned staff cannot read; assigned verifier and auditor can', async () => {
    const { meta, walletId } = await upload();
    await h.bus.execute(h.documents.applyScan, { documentId: meta.id }, { actor: SYSTEM_ACTOR });
    const stranger = await h.customer();
    const approver = await h.customer();
    await h.grantRole(walletId, approver.personId, 'APPROVER');
    const verifier = await h.staff('COMMUNITY_VERIFIER');
    const auditor = await h.staff('AUDITOR');
    const opsfin = await h.staff('OPS_FINANCE');

    for (const a of [stranger.actor, approver.actor, verifier.actor, opsfin.actor]) {
      await expect(read(meta.id, a)).rejects.toBeInstanceOf(ForbiddenError);
    }
    await h.assign(verifier.personId, walletId);
    await expect(read(meta.id, verifier.actor)).resolves.toHaveProperty('data');
    await expect(read(meta.id, auditor.actor)).resolves.toHaveProperty('data');

    const { rows } = await h.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'document.read' AND subject_id = $1 AND authz_result = 'DENIED'",
      [meta.id],
    );
    expect(rows[0]!.n).toBe(4);
  });

  it('unknown document ⇒ NotFound (audited), never a different error', async () => {
    const c = await h.customer();
    await expect(read(randomUUID(), c.actor)).rejects.toBeInstanceOf(NotFoundError);
    await expect(read('../../etc/passwd', c.actor)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects bad types/sizes and wallet attachment by non-members', async () => {
    const w = await walletWithAdmin();
    const outsider = await h.customer();
    await expect(
      h.bus.execute(h.documents.upload, { class: 'ID', contentType: 'text/html', data: PDF, walletId: w.walletId }, { actor: w.admin.actor }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      h.bus.execute(h.documents.upload, { class: 'ID', contentType: 'application/pdf', data: Buffer.alloc(0) }, { actor: w.admin.actor }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      h.bus.execute(h.documents.upload, { class: 'ID', contentType: 'application/pdf', data: PDF, walletId: w.walletId }, { actor: outsider.actor }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('a swapped ciphertext (other document’s blob) fails authentication', async () => {
    const a = await upload();
    const b = await upload(Buffer.from('%PDF other'));
    for (const id of [a.meta.id, b.meta.id]) await h.bus.execute(h.documents.applyScan, { documentId: id }, { actor: SYSTEM_ACTOR });
    const { rows } = await h.db.query<{ id: string; storage_ref: string }>('SELECT id, storage_ref FROM document WHERE id = ANY($1::uuid[])', [
      [a.meta.id, b.meta.id],
    ]);
    const refA = rows.find((r) => r.id === a.meta.id)!.storage_ref;
    const refB = rows.find((r) => r.id === b.meta.id)!.storage_ref;
    h.blobs.blobs.set(refA, h.blobs.blobs.get(refB)!);
    await expect(read(a.meta.id, a.admin.actor)).rejects.toThrow();
  });
});

describe('retention holds', () => {
  it('a hold blocks deletion until released; delete is soft + purge queued', async () => {
    const { meta } = await upload();
    const fadmin = await h.staff('FIDELITY_ADMIN');
    const { holdId } = await h.bus.execute(placeHold, { subjectType: 'document', subjectId: meta.id, reason: 'DISPUTE_OPEN' }, { actor: fadmin.actor });

    await expect(h.bus.execute(h.documents.remove, { documentId: meta.id, reason: 'RETENTION_EXPIRED' }, { actor: fadmin.actor })).rejects.toMatchObject({
      reason: 'RETENTION_HOLD',
    });
    await h.bus.execute(releaseHold, { holdId, reason: 'DISPUTE_CLOSED' }, { actor: fadmin.actor });
    await h.bus.execute(h.documents.remove, { documentId: meta.id, reason: 'RETENTION_EXPIRED' }, { actor: fadmin.actor });

    const { rows } = await h.db.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM document WHERE id = $1', [meta.id]);
    expect(rows[0]!.deleted_at).toBeInstanceOf(Date);
    const purge = await h.db.query("SELECT 1 FROM outbox_event WHERE topic = 'document.purge' AND payload->>'documentId' = $1", [meta.id]);
    expect(purge.rows).toHaveLength(1);
  });

  it('a wallet-level hold also blocks deleting its documents', async () => {
    const { meta, walletId } = await upload();
    const fadmin = await h.staff('FIDELITY_ADMIN');
    await h.bus.execute(placeHold, { subjectType: 'wallet', subjectId: walletId, reason: 'AML_REVIEW' }, { actor: fadmin.actor });
    await expect(h.bus.execute(h.documents.remove, { documentId: meta.id, reason: 'x' }, { actor: fadmin.actor })).rejects.toMatchObject({
      reason: 'RETENTION_HOLD',
    });
  });

  it('only FIDELITY_ADMIN places holds or deletes; uploader cannot delete', async () => {
    const { meta, admin } = await upload();
    const auditor = await h.staff('AUDITOR');
    await expect(h.bus.execute(placeHold, { subjectType: 'document', subjectId: meta.id, reason: 'x' }, { actor: auditor.actor })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(h.bus.execute(h.documents.remove, { documentId: meta.id, reason: 'x' }, { actor: admin.actor })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('LocalFsBlobStore', () => {
  it('round-trips, refuses overwrite and path traversal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chema-blobs-'));
    try {
      const store = new LocalFsBlobStore(dir);
      const ref = randomUUID();
      await store.put(ref, Buffer.from('cipher'));
      expect((await store.get(ref)).toString()).toBe('cipher');
      await expect(store.put(ref, Buffer.from('again'))).rejects.toThrow();
      await expect(store.get('../../etc/passwd')).rejects.toThrow(/invalid blob ref/);
      await store.delete(ref);
      expect((await readdir(join(dir, ref.slice(0, 2))))).toEqual([]);
      await expect(readFile(join(dir, ref.slice(0, 2), ref))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
