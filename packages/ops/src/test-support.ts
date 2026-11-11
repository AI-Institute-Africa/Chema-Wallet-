// Test-only harness for P09: the WhatsApp harness (everything up to P08) +
// OpsService. Never import at runtime.
import type { FlagKey } from '@chema/core';
import { createWhatsAppHarness, type WhatsAppHarness } from '@chema/whatsapp/testing';
import type { SqlClient } from '@chema/shared';
import { OpsService } from './service';

export interface OpsHarness extends WhatsAppHarness {
  ops: OpsService;
}

export async function createOpsHarness(flags: Partial<Record<FlagKey, string>> = {}, opts: { db?: SqlClient } = {}): Promise<OpsHarness> {
  const t = await createWhatsAppHarness(flags, opts);
  return { ...t, ops: new OpsService(t.h, t.h.now) };
}
