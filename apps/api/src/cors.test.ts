import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { parseOrigins } from './cors';

const WEB = 'http://localhost:3000';
let app: FastifyInstance;
beforeAll(() => {
  app = buildApp({ corsOrigins: [WEB] });
});
afterAll(() => app.close());

describe('CORS', () => {
  it('parses an origin list, dropping junk and paths', () => {
    expect(parseOrigins(' http://localhost:3000/ , https://chema.example/x, javascript:alert(1), nope')).toEqual([
      'http://localhost:3000',
      'https://chema.example',
    ]);
    expect(parseOrigins(undefined)).toEqual([]);
  });

  it('answers the web origin preflight and tags its responses', async () => {
    const pre = await app.inject({ method: 'OPTIONS', url: '/wallets', headers: { origin: WEB, 'access-control-request-method': 'POST' } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe(WEB);
    expect(String(pre.headers['access-control-allow-headers'])).toContain('authorization');
    expect(pre.headers['access-control-allow-credentials']).toBeUndefined();
    const get = await app.inject({ method: 'GET', url: '/health', headers: { origin: WEB } });
    expect(get.headers['access-control-allow-origin']).toBe(WEB);
  });

  it('gives other origins nothing', async () => {
    const evil = await app.inject({ method: 'OPTIONS', url: '/wallets', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const get = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.example' } });
    expect(get.headers['access-control-allow-origin']).toBeUndefined();
  });
});
