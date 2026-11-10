// phases/P02 Done-when: the ledger depends on nothing channel-, provider- or
// Fidelity-specific. Checked on the manifest and on every import.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));
const ALLOWED_WORKSPACE = new Set(['@chema/shared', '@chema/core']);
const FORBIDDEN = /channels|providers|fidelity|apps\/|whatsapp|ecocash|onemoney/i;

describe('ledger package boundary', () => {
  it('declares only shared + core as workspace dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const workspace = Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith('@chema/'));
    expect(workspace.sort()).toEqual([...ALLOWED_WORKSPACE].sort());
  });

  it('imports nothing from channels, providers, Fidelity or apps', () => {
    const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(join(SRC, file), 'utf8');
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
        const spec = m[1] as string;
        expect(FORBIDDEN.test(spec), `${file} imports ${spec}`).toBe(false);
        if (spec.startsWith('@chema/')) {
          expect(ALLOWED_WORKSPACE.has(spec.split('/').slice(0, 2).join('/')), `${file} imports ${spec}`).toBe(true);
        }
        if (spec.startsWith('.')) expect(spec.startsWith('./'), `${file} reaches outside the package: ${spec}`).toBe(true);
      }
    }
  });
});
