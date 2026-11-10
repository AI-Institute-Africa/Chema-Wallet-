// Test-only harness for wallets: core harness + wallet commands + helpers that
// walk a wallet through the REAL commands (upload → scan → evidence → submit →
// assign → decide). Never import at runtime.
import { randomUUID } from 'node:crypto';
import { SYSTEM_ACTOR, envVarFor, type Actor, type DocumentClass, type FlagKey } from '@chema/core';
import { createHarness, type Harness } from '@chema/core/testing';
import type { SqlClient } from '@chema/shared';
import { walletCommands, type CreateDraftInput, type WalletCommands } from './commands';
import { CHECKLIST_ITEMS, EVIDENCE_DOCUMENT_CLASS, type Checklist, type EvidenceType } from './types';

export const PUBLIC_BASE = 'https://chema.test';

export const ALL_PASS: Checklist = Object.fromEntries(CHECKLIST_ITEMS.map((i) => [i, 'PASS'])) as Checklist;

export const draftInput = (over: Partial<CreateDraftInput> = {}): CreateDraftInput => ({
  deceasedName: `Tendai Moyo ${randomUUID().slice(0, 8)}`,
  dateOfDeath: '2026-11-05',
  funeralDate: '2026-11-12',
  funeralLocation: 'Warren Hills, Harare',
  currency: 'USD',
  ...over,
});

export interface Person {
  actor: Actor;
  token: string;
  personId: string;
}

export interface WalletHarness {
  h: Harness;
  w: WalletCommands;
  as(actor: Actor): { actor: Actor };
  /** Upload a document linked to the wallet and run the malware scan (CLEAN). Unique bytes per call. */
  upload(by: Actor, walletId: string, cls: DocumentClass, opts?: { scan?: boolean; bytes?: Buffer }): Promise<string>;
  addEvidence(by: Actor, walletId: string, type: EvidenceType, opts?: { certificateNumber?: string; bytes?: Buffer; scan?: boolean }): Promise<string>;
  /** Death evidence (default DEATH_CERTIFICATE) + ADMIN_ID + MANDATE, all scanned. */
  fullEvidence(by: Actor, walletId: string, death?: EvidenceType): Promise<void>;
  draft(by: Actor, over?: Partial<CreateDraftInput>): Promise<string>;
  verifier(): Promise<Person>;
  fidelityAdmin(): Promise<Person>;
  assignVerifier(walletId: string, verifierPersonId: string): Promise<void>;
  /** Draft → evidence → submit → assign → APPROVED. Returns ids + slug. */
  activeWallet(by?: Person): Promise<{ walletId: string; slug: string; admin: Person; verifier: Person }>;
  close(): Promise<void>;
}

export async function createWalletHarness(
  flags: Partial<Record<FlagKey, string>> = {},
  opts: { db?: SqlClient } = {},
): Promise<WalletHarness> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(flags)) if (v !== undefined) env[envVarFor(k as FlagKey)] = v;
  const h = await createHarness(env, opts);
  const w = walletCommands({ flags: h.flags, publicBaseUrl: PUBLIC_BASE, clock: h.now });
  let fadmin: Person | undefined;

  const t: WalletHarness = {
    h,
    w,
    as: (actor) => ({ actor }),
    async upload(by, walletId, cls, o = {}) {
      const data = o.bytes ?? Buffer.from(`%PDF-1.4 test ${randomUUID()}`);
      const meta = await h.bus.execute(h.documents.upload, { class: cls, contentType: 'application/pdf', data, walletId }, { actor: by });
      if (o.scan !== false) await h.bus.execute(h.documents.applyScan, { documentId: meta.id }, { actor: SYSTEM_ACTOR });
      return meta.id;
    },
    async addEvidence(by, walletId, type, o = {}) {
      const documentId = await t.upload(by, walletId, EVIDENCE_DOCUMENT_CLASS[type], {
        ...(o.bytes ? { bytes: o.bytes } : {}),
        ...(o.scan === false ? { scan: false } : {}),
      });
      await h.bus.execute(
        w.addEvidence,
        { walletId, documentId, evidenceType: type, ...(o.certificateNumber ? { certificateNumber: o.certificateNumber } : {}) },
        { actor: by },
      );
      return documentId;
    },
    async fullEvidence(by, walletId, death = 'DEATH_CERTIFICATE') {
      await t.addEvidence(by, walletId, death);
      await t.addEvidence(by, walletId, 'ADMIN_ID');
      await t.addEvidence(by, walletId, 'MANDATE');
    },
    async draft(by, over = {}) {
      return (await h.bus.execute(w.createDraft, draftInput(over), { actor: by })).id;
    },
    verifier: () => h.staff('COMMUNITY_VERIFIER'),
    async fidelityAdmin() {
      fadmin ??= await h.staff('FIDELITY_ADMIN');
      return fadmin;
    },
    async assignVerifier(walletId, verifierPersonId) {
      const fa = await t.fidelityAdmin();
      await h.bus.execute(w.assign, { walletId, verifierPersonId }, { actor: fa.actor });
    },
    async activeWallet(by) {
      const admin = by ?? (await h.customer());
      const walletId = await t.draft(admin.actor);
      await t.fullEvidence(admin.actor, walletId);
      const { caseId } = await h.bus.execute(w.submit, { walletId }, { actor: admin.actor });
      const verifier = await t.verifier();
      await t.assignVerifier(walletId, verifier.personId);
      const res = await h.bus.execute(
        w.decide,
        { caseId, outcome: 'APPROVED', reasonCode: 'EVIDENCE_SUFFICIENT', checklist: ALL_PASS },
        { actor: verifier.actor },
      );
      if (!res.publicSlug) throw new Error('not activated');
      return { walletId, slug: res.publicSlug, admin, verifier };
    },
    close: () => h.close(),
  };
  return t;
}
