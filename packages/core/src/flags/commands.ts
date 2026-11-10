// Maker side of a financial flag change: a FIDELITY_ADMIN (MFA) requests it,
// another FIDELITY_ADMIN decides it via decideApproval (config.change.approve),
// then the maker applies it with FlagService.set(..., { approvalId }).
import { createApproval } from '../approval/service';
import type { Command } from '../command/bus';
import { ValidationError } from '../errors';
import { isFlagKey, type FlagKey, type FlagValue } from './registry';
import { flagApprovalPayload, type FlagService } from './service';

export interface FlagChangeRequest<K extends FlagKey = FlagKey> {
  key: K;
  value: FlagValue<K>;
}

export function requestFlagChange(flags: FlagService): Command<FlagChangeRequest, { approvalId: string }> {
  return {
    name: 'config.change_request',
    async resolve(_q, input) {
      if (!isFlagKey(input.key)) throw new ValidationError('unknown flag');
      return { action: 'config.change', subject: { type: 'config_flag', id: input.key } };
    },
    async run(tx, input, ctx) {
      const encoded = flags.encode(input.key, input.value);
      const approvalId = await createApproval(tx, ctx.actor, {
        action: 'config.change',
        subjectType: 'config_flag',
        subjectId: input.key,
        payload: flagApprovalPayload(input.key, encoded),
      });
      return { result: { approvalId }, audit: { approvalRef: approvalId, after: encoded } };
    },
  };
}
