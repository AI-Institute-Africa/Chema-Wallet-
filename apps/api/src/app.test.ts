import { Writable } from 'node:stream';
import { createLogger, type SqlClient } from '@chema/shared';
import { createPgliteClient } from '@chema/shared/testing';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

const lines: string[] = [];
const sink = new Writable({
  write(chunk: Buffer, _enc, cb) {
    lines.push(chunk.toString());
    cb();
  },
});
const logger = createLogger('info', sink) as FastifyBaseLogger;

let db: SqlClient;
beforeAll(async () => {
  db = await createPgliteClient();
});
afterAll(async () => {
  await db.close();
});

describe('api', () => {
  it('GET /health returns ok without needing a database', async () => {
    const app = buildApp({ logger, version: '1.2.3' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: 'chema-api', version: '1.2.3' });
  });

  it('GET /health/ready is 503 without a database and 200 with one', async () => {
    expect((await buildApp({ logger }).inject({ url: '/health/ready' })).statusCode).toBe(503);
    const res = await buildApp({ logger, db }).inject({ url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: 'up' });
  });

  it('echoes a safe x-request-id and replaces an unsafe one', async () => {
    const app = buildApp({ logger });
    const ok = await app.inject({ url: '/health', headers: { 'x-request-id': 'abc-123' } });
    expect(ok.headers['x-request-id']).toBe('abc-123');
    const bad = await app.inject({ url: '/health', headers: { 'x-request-id': 'x\r\ninjected: 1' } });
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const none = await app.inject({ url: '/health' });
    expect(none.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('request logs mask PII in URLs', async () => {
    lines.length = 0;
    await buildApp({ logger }).inject({ url: '/health?phone=%2B263771234567&to=0771234567' });
    const out = lines.join('');
    expect(out).toContain('"method":"GET"');
    expect(out).toContain('"url":"/health?phone=***567&to=***567"');
    expect(out).toContain('"statusCode":200');
    expect(out).not.toContain('771234567');
  });
});
