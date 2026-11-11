// Which rails exist and which may collect. A rail collects only when its
// `rail.<code>` flag is on (D06/D07) and, for a LIVE adapter, when
// `live_funds.enabled` is on (D01) AND the pilot is switched on with both caps
// agreed (D19: `pilot.enabled`, `pilot.max_wallets`, `pilot.max_amount_minor`;
// any unset ⇒ no live traffic). Disabled rails are absent from every list.
//
// Polling and reconciliation of payments already in flight use the adapter
// even after its rail is switched off: switching a rail off stops NEW money,
// it must not strand money that is already moving.
import { isFlagKey, type FlagService } from '@chema/core';
import type { ProviderAdapter } from '@chema/providers';
import type { Queryable } from '@chema/shared';

export class LiveFundsDisabledError extends Error {
  constructor(readonly rail: string) {
    super(`live adapter for ${rail} refused: live_funds.enabled is off`);
    this.name = 'LiveFundsDisabledError';
  }
}

export function railFlagKey(rail: string): string {
  return `rail.${rail.toLowerCase()}`;
}

export class RailRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(private readonly flags: FlagService) {}

  /** Register an adapter. A LIVE adapter refuses to initialise while live funds are off. */
  async register(adapter: ProviderAdapter): Promise<void> {
    if (!/^[A-Z][A-Z0-9_]{1,31}$/.test(adapter.rail)) throw new Error(`bad rail code ${adapter.rail}`);
    if (adapter.mode === 'LIVE' && !(await this.flags.get('live_funds.enabled'))) {
      throw new LiveFundsDisabledError(adapter.rail);
    }
    this.adapters.set(adapter.rail, adapter);
  }

  /** Adapter for in-flight work (poll, recon, refunds), whatever the rail flag says. */
  adapter(rail: string): ProviderAdapter | undefined {
    return this.adapters.get(rail);
  }

  /** May this rail take NEW money right now? Reads through the caller's transaction. */
  async collectable(q: Queryable, rail: string): Promise<ProviderAdapter | undefined> {
    const adapter = this.adapters.get(rail);
    if (!adapter) return undefined;
    const key = railFlagKey(rail);
    if (!isFlagKey(key)) return undefined;
    if ((await this.flags.getIn(q, key)) !== true) return undefined;
    // Re-checked on every collection: flipping live funds (or the pilot) off stops live rails at once.
    if (adapter.mode === 'LIVE' && !(await this.liveAllowed(q))) return undefined;
    return adapter;
  }

  /** Live money needs the hard gate AND an agreed pilot envelope (D01/D19). */
  async liveAllowed(q: Queryable): Promise<boolean> {
    if ((await this.flags.getIn(q, 'live_funds.enabled')) !== true) return false;
    if ((await this.flags.getIn(q, 'pilot.enabled')) !== true) return false;
    return (await this.flags.getIn(q, 'pilot.max_wallets')) !== null && (await this.flags.getIn(q, 'pilot.max_amount_minor')) !== null;
  }

  /** Rails whose adapter moves real money. */
  liveRails(): string[] {
    return this.rails().filter((r) => this.adapters.get(r)?.mode === 'LIVE');
  }

  async listCollectable(q: Queryable): Promise<string[]> {
    const out: string[] = [];
    for (const rail of this.rails()) {
      if (await this.collectable(q, rail)) out.push(rail);
    }
    return out;
  }

  rails(): string[] {
    return [...this.adapters.keys()].sort();
  }
}
