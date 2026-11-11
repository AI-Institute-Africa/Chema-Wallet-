// Domain errors. The API maps them to HTTP statuses; messages never carry PII.

export class ForbiddenError extends Error {
  constructor(readonly reason: string) {
    super(`forbidden: ${reason}`);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends Error {
  constructor(
    readonly subjectType: string,
    readonly subjectId: string,
  ) {
    super(`${subjectType} not found`);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(readonly reason: string) {
    super(`conflict: ${reason}`);
    this.name = 'ConflictError';
  }
}

/**
 * A conflict that is also a refusal of the actor's request (e.g. re-linking a
 * claim to a different recipient). Thrown from a command handler, the bus
 * rolls the transaction back, audits it as DENIED with `reason`, and rethrows
 * it (HTTP 409).
 */
export class RefusedError extends ConflictError {
  constructor(reason: string) {
    super(reason);
    this.name = 'RefusedError';
  }
}

/** Authentication failed (bad/expired code or credentials). Deliberately vague. */
export class AuthenticationError extends Error {
  constructor(readonly reason: string) {
    super('authentication failed');
    this.name = 'AuthenticationError';
  }
}

export class RateLimitedError extends Error {
  constructor() {
    super('too many attempts; try again later');
    this.name = 'RateLimitedError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
