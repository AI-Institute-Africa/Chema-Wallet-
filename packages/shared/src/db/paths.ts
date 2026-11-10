import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo-root db/migrations, resolved from this file's location. */
export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../db/migrations');
