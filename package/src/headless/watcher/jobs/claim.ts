import { isProcessAlive } from '../../../core/internal.js';
import type { StateMachineJobPatch } from './model.js';

export function withConclusiveClaimRelease(patch: StateMachineJobPatch): StateMachineJobPatch {
  return patch.status !== undefined && patch.status !== 'matched' && patch.claim === undefined
    ? { ...patch, claim: null }
    : patch;
}

export function isHeldRunClaim(
  claim: { readonly pid: number; readonly at: string } | undefined,
): boolean {
  if (claim === undefined) {
    return false;
  }
  return claim.pid === process.pid || isProcessAlive(claim.pid);
}
