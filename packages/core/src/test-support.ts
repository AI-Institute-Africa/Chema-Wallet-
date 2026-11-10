// Test-only harness: one PGlite db + mocks + a controllable clock, and helpers
// to create customers/staff through the REAL auth flows. Never import at runtime.
import { randomUUID } from 'node:crypto';
import type { SqlClient } from '@chema/shared';
import { migratedTestDb } from '@chema/shared/testing';
import type { Actor, StaffRole, WalletRoleName } from './authz/types';
import { MemoryBlobStore, MockMalwareScanner } from './documents/store';
import { MockOtpProvider } from './identity/otp';
import { base32Decode, totp } from './identity/totp';
import { ephemeralSecrets } from './secrets';
import { createCoreServices, type CoreServices } from './services';

export interface Harness extends CoreServices {
  db: SqlClient;
  otp: MockOtpProvider;
  blobs: MemoryBlobStore;
  now(): Date;
  advance(ms: number): void;
  customer(phone?: string, channel?: 'WEB' | 'WHATSAPP'): Promise<{ actor: Actor; token: string; personId: string }>;
  staff(role: StaffRole): Promise<{ actor: Actor; token: string; personId: string; login: string; password: string; secret: string }>;
  totpFor(secret: string): string;
  grantRole(walletId: string, personId: string, role: WalletRoleName): Promise<void>;
  assign(staffPersonId: string, walletId: string): Promise<void>;
  close(): Promise<void>;
}

let phoneSeq = 1_000_000;

export async function createHarness(env: Record<string, string | undefined> = {}): Promise<Harness> {
  const db = await migratedTestDb();
  let current = new Date('2026-11-10T08:00:00.000Z');
  const clock = () => new Date(current.getTime());
  const otp = new MockOtpProvider();
  const blobs = new MemoryBlobStore();
  const core = createCoreServices({
    db,
    secrets: ephemeralSecrets(),
    otp,
    blobs,
    scanner: new MockMalwareScanner(),
    env,
    clock,
  });
  // A system person to act as granted_by / assigned_by for fixture rows.
  const { rows } = await db.query<{ id: string }>("INSERT INTO person (name) VALUES ('fixture-system') RETURNING id");
  const systemPerson = rows[0]?.id ?? '';

  const h: Harness = {
    ...core,
    db,
    otp,
    blobs,
    now: clock,
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
    async customer(phone, channel = 'WEB') {
      const p = phone ?? `+26377${String(phoneSeq++).padStart(7, '0')}`;
      const { challengeId } = await core.auth.startLogin({ phone: p, channel });
      const code = otp.lastCodeFor(p);
      if (!code) throw new Error('no OTP sent');
      const s = await core.auth.verifyLogin({ challengeId, code });
      const actor = await core.auth.authenticate(s.token);
      if (!actor) throw new Error('session not usable');
      return { actor, token: s.token, personId: s.personId };
    },
    totpFor(secret) {
      // Each TOTP step is single-use per account: move to a fresh step first.
      current = new Date(current.getTime() + 31_000);
      return totp(base32Decode(secret), clock());
    },
    async staff(role) {
      const login = `${role.toLowerCase()}.${randomUUID().slice(0, 8)}`;
      const password = 'correct horse battery staple';
      const enrolled = await core.staffAuth.enroll({ login, role, password, enrolledBy: 'system' });
      const s = await core.staffAuth.login({ login, password, totp: h.totpFor(enrolled.totpSecret) });
      const actor = await core.auth.authenticate(s.token);
      if (!actor) throw new Error('staff session not usable');
      return { actor, token: s.token, personId: enrolled.personId, login, password, secret: enrolled.totpSecret };
    },
    async grantRole(walletId, personId, role) {
      await db.query('INSERT INTO wallet_role (wallet_id, person_id, role, granted_by) VALUES ($1, $2, $3, $4)', [
        walletId,
        personId,
        role,
        systemPerson,
      ]);
    },
    async assign(staffPersonId, walletId) {
      await db.query('INSERT INTO staff_assignment (staff_person_id, wallet_id, assigned_by) VALUES ($1, $2, $3)', [
        staffPersonId,
        walletId,
        systemPerson,
      ]);
    },
    close: () => db.close(),
  };
  return h;
}
