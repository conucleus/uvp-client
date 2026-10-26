/**
 * Exit-code adapter for chain scan results: benign per-log outcomes stay
 * success, while scan errors and failed/dead-letter jobs make the process
 * exit non-zero. The benign kinds mirror the error taxonomy's
 * benign_scan_outcome column.
 */
import type { ClassifiedExecutorKitError } from '../errors.js';

const BENIGN_SCAN_OUTCOME_ERROR_KINDS = new Set(['missing_handler', 'duplicate_signal']);

export function chainPollExecutionFailed(poll: {
  readonly results?: readonly {
    readonly error?: ClassifiedExecutorKitError;
    readonly job?: { readonly status?: string };
  }[];
}): boolean {
  return (poll.results ?? []).some((result) => {
    const failed = Boolean(result.error)
      || result.job?.status === 'failed'
      || result.job?.status === 'dead_letter';
    if (!failed) {
      return false;
    }
    return !BENIGN_SCAN_OUTCOME_ERROR_KINDS.has(result.error?.kind ?? '');
  });
}
