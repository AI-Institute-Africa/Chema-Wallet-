import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { maskDeep, maskString } from './mask';

interface ReqLike {
  id?: unknown;
  method?: unknown;
  url?: unknown;
}

interface ResLike {
  statusCode?: unknown;
}

interface ErrLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  stack?: unknown;
}

/** Decode %-escapes first so encoded PII (%2B263...) is masked too. */
function maskUrl(url: string): string {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url.replace(/\+/g, ' '));
  } catch {
    // malformed escape: mask the raw form
  }
  return maskString(decoded);
}

const str = (v: unknown) => (typeof v === 'string' ? maskString(v) : undefined);

export function loggerOptions(level = 'info'): LoggerOptions {
  return {
    level,
    base: { service: 'chema' },
    // Belt and braces: pino redaction for well-known paths, then deep masking.
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[REDACTED]',
    },
    serializers: {
      // Never log query strings, bodies or headers raw.
      req: (req: ReqLike) => ({
        id: req.id,
        method: req.method,
        url: typeof req.url === 'string' ? maskUrl(req.url) : undefined,
      }),
      res: (res: ResLike) => ({ statusCode: res.statusCode }),
      err: (err: ErrLike) => ({
        type: typeof err.name === 'string' ? err.name : 'Error',
        message: str(err.message),
        code: err.code,
        stack: str(err.stack),
      }),
    },
    formatters: {
      log: (obj) => maskDeep(obj) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        const masked = args.map((a: unknown) => (typeof a === 'string' ? maskString(a) : a));
        method.apply(this, masked as Parameters<typeof method>);
      },
    },
  };
}

export function createLogger(level?: string, destination?: DestinationStream): Logger {
  return destination ? pino(loggerOptions(level), destination) : pino(loggerOptions(level));
}
