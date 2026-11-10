// Provider outcomes the payments service must tell apart (docs/04 §3, §4).

/** The provider definitively refused the request (no money moved) ⇒ FAILED. */
export class ProviderRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`provider rejected: ${reason}`);
    this.name = 'ProviderRejectedError';
  }
}

/** The request certainly never reached the provider (connect refused, outage page) ⇒ FAILED, safe to retry. */
export class ProviderUnavailableError extends Error {
  constructor(readonly reason = 'unavailable') {
    super(`provider unavailable: ${reason}`);
    this.name = 'ProviderUnavailableError';
  }
}

/** No answer in time: the provider MAY have accepted it ⇒ PENDING_UNKNOWN, never FAILED. */
export class ProviderTimeoutError extends Error {
  constructor() {
    super('provider timeout');
    this.name = 'ProviderTimeoutError';
  }
}

export type WebhookRejection = 'MISSING_SIGNATURE' | 'BAD_SIGNATURE' | 'STALE_TIMESTAMP' | 'MALFORMED';

export class WebhookRejectedError extends Error {
  constructor(readonly reason: WebhookRejection) {
    super(`webhook rejected: ${reason}`);
    this.name = 'WebhookRejectedError';
  }
}
