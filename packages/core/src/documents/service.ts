// Sensitive documents (death evidence, ID, mandate) — docs/10.
// Envelope encryption: per-document AES-256-GCM data key, wrapped by the master
// key; ciphertext bound to the document id (AAD). Bytes are served only when
// the malware scan is CLEAN, only to authorised actors, and every read is
// audited. Deletion is soft + async purge, and blocked by a retention hold.
import { randomUUID } from 'node:crypto';
import type { Queryable } from '@chema/shared';
import type { Command, CommandTx } from '../command/bus';
import { newDataKey, open, seal, sha256Hex } from '../crypto';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { enqueueOutbox } from '../outbox/outbox';
import type { Secrets } from '../secrets';
import type { BlobStore, MalwareScanner } from './store';
import { one } from '../db';

export const DOCUMENT_CLASSES = ['DEATH_EVIDENCE', 'ID', 'MANDATE', 'OTHER', 'PHOTO'] as const;
export type DocumentClass = (typeof DOCUMENT_CLASSES)[number];
export type RetentionClass = 'SENSITIVE' | 'FINANCIAL' | 'PUBLIC_CONTENT';

export const DOCUMENT_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  contentTypes: ['application/pdf', 'image/jpeg', 'image/png'] as readonly string[],
};

/** Every evidence class is sensitive. A memorial PHOTO is public content (P05), shown only with consent. */
const RETENTION: Readonly<Record<DocumentClass, RetentionClass>> = {
  DEATH_EVIDENCE: 'SENSITIVE',
  ID: 'SENSITIVE',
  MANDATE: 'SENSITIVE',
  OTHER: 'SENSITIVE',
  PHOTO: 'PUBLIC_CONTENT',
};

/** A public photo is an image; never a PDF. */
export const PHOTO_CONTENT_TYPES: readonly string[] = ['image/jpeg', 'image/png'];

export function retentionClassFor(cls: DocumentClass): RetentionClass {
  return RETENTION[cls];
}

const keyAad = (id: string) => `doc_key:${id}`;
const blobAad = (id: string) => `doc:${id}`;

interface DocRow {
  id: string;
  storage_ref: string;
  class: DocumentClass;
  content_type: string;
  sha256: string;
  key_wrap: string;
  owner_person: string;
  linked_wallet: string | null;
  malware_scan: 'CLEAN' | 'INFECTED' | null;
  deleted_at: Date | null;
}

async function loadDoc(q: Queryable, id: string): Promise<DocRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError('document', id);
  const { rows } = await q.query<DocRow>(
    `SELECT id, storage_ref, class, content_type, sha256, key_wrap, owner_person, linked_wallet, malware_scan, deleted_at
       FROM document WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row || row.deleted_at) throw new NotFoundError('document', id);
  return row;
}

function subjectOf(row: DocRow) {
  return {
    type: 'document',
    id: row.id,
    ownerPersonId: row.owner_person,
    ...(row.linked_wallet ? { walletId: row.linked_wallet } : {}),
  };
}

export async function isHeld(q: Queryable, subjectType: string, subjectId: string): Promise<boolean> {
  const { rows } = await q.query(
    'SELECT 1 FROM retention_hold WHERE subject_type = $1 AND subject_id = $2 AND released_at IS NULL',
    [subjectType, subjectId],
  );
  return rows.length > 0;
}

export interface UploadInput {
  class: DocumentClass;
  contentType: string;
  data: Buffer;
  walletId?: string;
}

export interface DocumentMeta {
  id: string;
  class: DocumentClass;
  retentionClass: RetentionClass;
  contentType: string;
  sizeBytes: number;
  scan: 'PENDING' | 'CLEAN' | 'INFECTED';
}

export function documentCommands(deps: { blobs: BlobStore; scanner: MalwareScanner; secrets: Secrets }) {
  const unwrapKey = (row: DocRow) => open(deps.secrets.dataKey, Buffer.from(row.key_wrap, 'base64'), keyAad(row.id));

  const upload: Command<UploadInput, DocumentMeta> = {
    name: 'document.upload',
    async resolve(_q, input, actor) {
      if (!(DOCUMENT_CLASSES as readonly string[]).includes(input.class)) throw new ValidationError('unknown document class');
      if (!DOCUMENT_LIMITS.contentTypes.includes(input.contentType)) throw new ValidationError('unsupported content type');
      if (input.class === 'PHOTO' && !PHOTO_CONTENT_TYPES.includes(input.contentType)) throw new ValidationError('photo must be an image');
      if (input.data.length === 0 || input.data.length > DOCUMENT_LIMITS.maxBytes) throw new ValidationError('bad document size');
      return {
        action: 'document.upload',
        subject: {
          type: 'document',
          id: 'new',
          ownerPersonId: actor.personId,
          ...(input.walletId ? { walletId: input.walletId } : {}),
        },
      };
    },
    async run(tx, input, ctx) {
      const id = randomUUID();
      const storageRef = randomUUID();
      const dataKey = newDataKey();
      const keyWrap = seal(deps.secrets.dataKey, dataKey, keyAad(id)).toString('base64');
      // If this transaction rolls back, the blob is orphaned ciphertext whose key never committed.
      await deps.blobs.put(storageRef, seal(dataKey, input.data, blobAad(id)));
      const retention = retentionClassFor(input.class);
      await tx.query(
        `INSERT INTO document (id, storage_ref, class, retention_class, content_type, size_bytes, sha256, key_wrap, owner_person, linked_wallet)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, storageRef, input.class, retention, input.contentType, input.data.length, sha256Hex(input.data), keyWrap,
          ctx.actor.personId, input.walletId ?? null],
      );
      await enqueueOutbox(tx, 'document.scan', { documentId: id });
      return {
        result: { id, class: input.class, retentionClass: retention, contentType: input.contentType, sizeBytes: input.data.length, scan: 'PENDING' },
        audit: { subjectId: id, after: { class: input.class, sha256: sha256Hex(input.data) } },
      };
    },
  };

  const read: Command<{ documentId: string }, { contentType: string; data: Buffer }> = {
    name: 'document.read',
    async resolve(q, input) {
      return { action: 'document.read', subject: subjectOf(await loadDoc(q, input.documentId)) };
    },
    async run(tx, input) {
      const row = await loadDoc(tx, input.documentId);
      if (row.malware_scan !== 'CLEAN') throw new ConflictError('DOCUMENT_NOT_AVAILABLE');
      const data = open(unwrapKey(row), await deps.blobs.get(row.storage_ref), blobAad(row.id));
      if (sha256Hex(data) !== row.sha256) throw new ConflictError('DOCUMENT_INTEGRITY');
      return { result: { contentType: row.content_type, data } };
    },
  };

  /** Worker step (SYSTEM actor): scan plaintext, record the result once. */
  const applyScan: Command<{ documentId: string }, 'CLEAN' | 'INFECTED'> = {
    name: 'document.scan_result',
    async resolve(q, input) {
      return { action: 'document.scan_result', subject: subjectOf(await loadDoc(q, input.documentId)) };
    },
    async run(tx, input) {
      const row = await loadDoc(tx, input.documentId);
      if (row.malware_scan) return { result: row.malware_scan, audit: { reasonCode: 'ALREADY_SCANNED' } };
      const data = open(unwrapKey(row), await deps.blobs.get(row.storage_ref), blobAad(row.id));
      const result = await deps.scanner.scan(data);
      await tx.query('UPDATE document SET malware_scan = $2, scanned_at = now(), updated_at = now() WHERE id = $1', [row.id, result]);
      return { result, audit: { after: { scan: result } } };
    },
  };

  const remove: Command<{ documentId: string; reason: string }, { id: string }> = {
    name: 'document.delete',
    async resolve(q, input) {
      return { action: 'document.delete', subject: subjectOf(await loadDoc(q, input.documentId)) };
    },
    async run(tx, input, ctx) {
      if (await isHeld(tx, 'document', input.documentId)) throw new ConflictError('RETENTION_HOLD');
      const row = await loadDoc(tx, input.documentId);
      if (row.linked_wallet && (await isHeld(tx, 'wallet', row.linked_wallet))) throw new ConflictError('RETENTION_HOLD');
      await tx.query('UPDATE document SET deleted_at = now(), deleted_by = $2, updated_at = now() WHERE id = $1', [
        row.id,
        ctx.actor.personId,
      ]);
      await enqueueOutbox(tx, 'document.purge', { documentId: row.id, storageRef: row.storage_ref });
      return { result: { id: row.id }, audit: { reasonCode: input.reason } };
    },
  };

  /**
   * Bytes of a public PHOTO for the public page: no actor and no audit row
   * (it is public content, read on every page view). Callers must already
   * have checked consent + the family's privacy setting. CLEAN only.
   */
  async function openPublicPhoto(q: Queryable, documentId: string): Promise<{ contentType: string; data: Buffer }> {
    const row = await loadDoc(q, documentId);
    if (row.class !== 'PHOTO' || row.malware_scan !== 'CLEAN') throw new NotFoundError('document', documentId);
    const data = open(unwrapKey(row), await deps.blobs.get(row.storage_ref), blobAad(row.id));
    if (sha256Hex(data) !== row.sha256) throw new ConflictError('DOCUMENT_INTEGRITY');
    return { contentType: row.content_type, data };
  }

  return { upload, read, applyScan, remove, openPublicPhoto };
}

export function documentMeta(row: { id: string; class: DocumentClass; retention_class: RetentionClass; content_type: string; size_bytes: number; malware_scan: 'CLEAN' | 'INFECTED' | null }): DocumentMeta {
  return {
    id: row.id,
    class: row.class,
    retentionClass: row.retention_class,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    scan: row.malware_scan ?? 'PENDING',
  };
}

// ── Retention holds ────────────────────────────────────────────────────────

export const placeHold: Command<{ subjectType: string; subjectId: string; reason: string }, { holdId: string }> = {
  name: 'retention.hold_place',
  async resolve(_q, input) {
    if (!input.reason.trim()) throw new ValidationError('reason required');
    return { action: 'retention.hold', subject: { type: input.subjectType, id: input.subjectId } };
  },
  async run(tx: CommandTx, input, ctx) {
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO retention_hold (subject_type, subject_id, reason, placed_by) VALUES ($1, $2, $3, $4) RETURNING id',
      [input.subjectType, input.subjectId, input.reason, ctx.actor.personId],
    );
    return { result: { holdId: one(rows, 'hold insert').id }, audit: { reasonCode: input.reason } };
  },
};

export const releaseHold: Command<{ holdId: string; reason: string }, { holdId: string }> = {
  name: 'retention.hold_release',
  async resolve(q, input) {
    if (!/^[0-9a-f-]{36}$/i.test(input.holdId)) throw new NotFoundError('retention_hold', input.holdId);
    const { rows } = await q.query<{ subject_type: string; subject_id: string }>(
      'SELECT subject_type, subject_id FROM retention_hold WHERE id = $1',
      [input.holdId],
    );
    if (!rows[0]) throw new NotFoundError('retention_hold', input.holdId);
    return { action: 'retention.hold', subject: { type: 'retention_hold', id: input.holdId } };
  },
  async run(tx, input, ctx) {
    const { rows } = await tx.query(
      'UPDATE retention_hold SET released_at = now(), released_by = $2 WHERE id = $1 AND released_at IS NULL RETURNING id',
      [input.holdId, ctx.actor.personId],
    );
    if (rows.length !== 1) throw new ConflictError('ALREADY_RELEASED');
    return { result: { holdId: input.holdId }, audit: { reasonCode: input.reason } };
  },
};
