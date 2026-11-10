// Blob storage + malware scanning interfaces. The store only ever sees
// ciphertext (DocumentService encrypts before put). Real object storage and a
// real scanner replace these behind the same interfaces.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export interface BlobStore {
  put(ref: string, data: Buffer): Promise<void>;
  get(ref: string): Promise<Buffer>;
  delete(ref: string): Promise<void>;
}

const REF = /^[a-z0-9-]{8,64}$/;

/** Local filesystem store. Refs are server-generated ids; no path from user input. */
export class LocalFsBlobStore implements BlobStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathOf(ref: string): string {
    if (!REF.test(ref)) throw new Error('invalid blob ref');
    const p = resolve(join(this.root, ref.slice(0, 2), ref));
    if (!p.startsWith(this.root + sep)) throw new Error('invalid blob ref');
    return p;
  }

  async put(ref: string, data: Buffer): Promise<void> {
    const p = this.pathOf(ref);
    await mkdir(resolve(p, '..'), { recursive: true });
    await writeFile(p, data, { flag: 'wx' });
  }

  async get(ref: string): Promise<Buffer> {
    return readFile(this.pathOf(ref));
  }

  async delete(ref: string): Promise<void> {
    await rm(this.pathOf(ref), { force: true });
  }
}

export class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, Buffer>();
  async put(ref: string, data: Buffer): Promise<void> {
    if (this.blobs.has(ref)) throw new Error('blob exists');
    this.blobs.set(ref, Buffer.from(data));
  }
  async get(ref: string): Promise<Buffer> {
    const b = this.blobs.get(ref);
    if (!b) throw new Error('blob not found');
    return Buffer.from(b);
  }
  async delete(ref: string): Promise<void> {
    this.blobs.delete(ref);
  }
}

export type ScanResult = 'CLEAN' | 'INFECTED';

export interface MalwareScanner {
  scan(plaintext: Buffer): Promise<ScanResult>;
}

/** Mock: flags the EICAR test signature, everything else is CLEAN. */
export class MockMalwareScanner implements MalwareScanner {
  async scan(plaintext: Buffer): Promise<ScanResult> {
    return plaintext.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'INFECTED' : 'CLEAN';
  }
}
