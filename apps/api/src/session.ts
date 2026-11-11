// Request → session credentials. The device id is a client-chosen opaque
// label sent as `x-device-id`; a session that recorded one at login is bound
// to it (core AuthService.authenticate). Malformed values count as absent.
import type { FastifyRequest } from 'fastify';

const SAFE_DEVICE = /^[A-Za-z0-9._:-]{1,64}$/;

export function deviceOf(req: FastifyRequest): string | undefined {
  const h = req.headers['x-device-id'];
  const v = Array.isArray(h) ? h[0] : h;
  return v && SAFE_DEVICE.test(v) ? v : undefined;
}
