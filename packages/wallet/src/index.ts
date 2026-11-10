// @chema/wallet — wallet lifecycle, community verification, activation, fraud
// rules and reports (P04, docs/05). Depends on core + ledger; channels call
// these commands through core.bus and hold no wallet logic themselves.
export * from './types';
export * from './activation';
export * from './normalise';
export * from './fraud';
export * from './commands';
export * from './public';
export * from './gate';
