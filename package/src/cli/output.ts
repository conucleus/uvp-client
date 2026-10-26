/**
 * CLI output adapters: bigint-safe JSON serialization for command output and
 * the scan-result exit-code rule (benign per-log outcomes stay success, while
 * scan errors and failed/dead-letter jobs make the process exit non-zero).
 */
import type { ClassifiedExecutorKitError } from '../core/errors.js';

export function stringifyForTransport(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') {
      return item.toString();
    }
    return item;
  });
}

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
