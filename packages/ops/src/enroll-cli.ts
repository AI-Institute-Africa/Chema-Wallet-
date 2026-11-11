// Bootstrap a staff account from the command line:
//   DATABASE_URL=... CHEMA_AUTH_SECRET=... CHEMA_DATA_KEY=... \
//     pnpm staff:enroll --login admin.one --role FIDELITY_ADMIN [--name "A One"]
// Only for bootstrap: the first two FIDELITY_ADMINs cannot be dual-approved
// through a portal that has no admins yet. Everything after that goes through
// the portal (`staff.enroll`, privileged roles dual). The one-time password and
// TOTP secret are printed ONCE to stdout; the enrolment is audited as SYSTEM.
// Exit 0 = enrolled, 1 = refused, 2 = usage/connection error.
import { DbAuditSink, loadSecrets, randomToken, STAFF_ROLES, StaffAuthService, type StaffRole } from '@chema/core';
import { createPgClient } from '@chema/shared';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const login = arg('login');
const role = arg('role') as StaffRole | undefined;
const name = arg('name');
const url = process.env['DATABASE_URL'];
if (!url || !login || !role || !(STAFF_ROLES as readonly string[]).includes(role)) {
  console.error(`usage: staff:enroll --login <login> --role <${STAFF_ROLES.join('|')}> [--name <name>]  (DATABASE_URL required)`);
  process.exit(2);
}

const db = createPgClient(url, 1);
try {
  const staff = new StaffAuthService({ db, secrets: loadSecrets(), audit: new DbAuditSink(db) });
  const password = randomToken(15);
  const out = await staff.enroll({ login, role, password, ...(name ? { name } : {}), enrolledBy: 'bootstrap-cli' });
  console.log(`enrolled ${login} as ${role}`);
  console.log(`staff id:          ${out.staffId}`);
  console.log(`initial password:  ${password}`);
  console.log(`totp secret:       ${out.totpSecret}`);
  console.log(`otpauth uri:       ${out.otpauth}`);
  console.log('Shown once. Hand over privately; nothing above is stored in clear.');
  process.exitCode = 0;
} catch (err) {
  console.error(`refused: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
