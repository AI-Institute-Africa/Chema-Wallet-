// @chema/providers — payment provider adapters (docs/04 §5). Interface + mock
// rails only; real adapters land behind flags once a rail is certified (D06).
// Depends on @chema/shared only.
export * from './adapter';
export * from './errors';
export * from './signature';
export * from './mock';
