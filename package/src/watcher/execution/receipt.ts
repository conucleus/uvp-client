import type { Hex } from 'viem';
import type { ClassifiedExecutorKitError } from '../../errors.js';
import type { StateMachineJobStatus, StateMachineJobSubmission } from '../jobs/model.js';
import { SubmitSignalReceiptError } from '../../signal/submit.js';
import type { SubmitStateMachineSignalResult } from '../../signal/submit.js';
import type { StateMachineSignal } from '../../signal/build.js';
import type { StateMachineHookReadyHandlerResult } from './handler.js';

export class ClassifiedStateMachineError extends Error {
  readonly classified: ClassifiedExecutorKitError;

  constructor(classified: ClassifiedExecutorKitError, options?: { readonly cause?: unknown }) {
    super(classified.message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ClassifiedStateMachineError';
    this.classified = classified;
  }
}

export function normalizeHandlerResult(result: StateMachineHookReadyHandlerResult): readonly StateMachineSignal[] {
  if (!result) {
    return [];
  }
  return Array.isArray(result) ? result as readonly StateMachineSignal[] : [result as StateMachineSignal];
}

export function toJobSubmission(
  signalIndex: number,
  attempt: number,
  result: SubmitStateMachineSignalResult,
): StateMachineJobSubmission {
  return {
    signalIndex,
    attempt,
    dryRun: result.dryRun,
    request: result.request,
    ...(!result.dryRun ? { txHash: result.txHash } : {}),
    ...(!result.dryRun && result.confirmed ? { confirmed: true } : {}),
  };
}

export function broadcastTxHashFromError(error: unknown): Hex | undefined {
  for (const current of walkSubmissionErrorChain(error)) {
    const txHash = (current as { readonly txHash?: unknown }).txHash;
    if (typeof txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return txHash as Hex;
    }
  }
  return undefined;
}

function* walkSubmissionErrorChain(error: unknown): Generator<Error> {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    yield current;
    current = current.cause;
  }
}

export function statusForCompletedRun(input: {
  readonly dryRun: boolean;
  readonly identityDatas: readonly string[];
  readonly jobSubmissions: readonly StateMachineJobSubmission[];
}): StateMachineJobStatus {
  if (input.dryRun) {
    return 'matched';
  }
  const provenDelivered = deliveredRequestDatasFromSubmissions(input.jobSubmissions);
  const contextPending = input.jobSubmissions.some(
    (submission) => submission.signalIndex < 0
      && submission.dryRun !== true
      && submission.txHash !== undefined
      && submission.request?.data !== undefined
      && !provenDelivered.has(submission.request.data),
  );
  const returnedComplete = input.identityDatas.every((data) => provenDelivered.has(data));
  const unprovenBroadcasts = unresolvedBroadcasts(input.jobSubmissions).length;
  if (returnedComplete && !contextPending && unprovenBroadcasts === 0) {
    return provenDelivered.size > 0 ? 'confirmed' : 'completed';
  }
  return 'submitted';
}

export function isDeliveredSubmission(submission: StateMachineJobSubmission): boolean {
  return submission.error?.kind === 'duplicate_signal'
    || (!submission.error && submission.dryRun === false && submission.confirmed === true);
}

export function deliveredRequestDatasFromSubmissions(
  submissions: readonly StateMachineJobSubmission[],
): Set<string> {
  const delivered = new Set<string>();
  for (const submission of submissions) {
    if (submission.request?.data !== undefined && isDeliveredSubmission(submission)) {
      delivered.add(submission.request.data);
    }
  }
  return delivered;
}

export function isUnconfirmedBroadcast(submission: StateMachineJobSubmission): boolean {
  return submission.dryRun !== true
    && submission.txHash !== undefined
    && submission.confirmed !== true
    && submission.error?.kind !== 'duplicate_signal';
}

export function unresolvedBroadcasts(
  submissions: readonly StateMachineJobSubmission[],
): readonly (StateMachineJobSubmission & { readonly txHash: Hex })[] {
  const provenDelivered = deliveredRequestDatasFromSubmissions(submissions);
  const confirmedTxHashes = new Set(
    submissions
      .filter((submission) => submission.confirmed === true && submission.txHash !== undefined)
      .map((submission) => submission.txHash),
  );
  return submissions.filter((submission): submission is StateMachineJobSubmission & { readonly txHash: Hex } =>
    submission.txHash !== undefined
    && isUnconfirmedBroadcast(submission)
    && !confirmedTxHashes.has(submission.txHash)
    && !(submission.request?.data !== undefined && provenDelivered.has(submission.request.data)));
}

export function appendJobSubmission(
  submissions: StateMachineJobSubmission[],
  candidate: StateMachineJobSubmission,
): void {
  if (candidate.dryRun === true) {
    const duplicate = submissions.some((submission) =>
      submission.dryRun === true
      && (candidate.request?.data !== undefined
        ? submission.request?.data === candidate.request.data
        : submission.signalIndex === candidate.signalIndex));
    if (duplicate) {
      return;
    }
  }
  submissions.push(candidate);
}

export function nextSubmissionAttempt(
  submissions: readonly StateMachineJobSubmission[],
  signalIndex: number,
): number {
  return submissions.filter((submission) => submission.signalIndex === signalIndex).length + 1;
}

export function jobStatusForError(error: ClassifiedExecutorKitError): StateMachineJobStatus {
  if (error.kind === 'missing_handler' || error.kind === 'duplicate_signal') {
    return 'ignored';
  }
  return error.retryable ? 'failed' : 'dead_letter';
}

export function statusForTerminalError(
  error: unknown,
  classified: ClassifiedExecutorKitError,
  jobSubmissions: readonly StateMachineJobSubmission[],
): StateMachineJobStatus {
  if (!carriesKnownRevert(error) && unresolvedBroadcasts(jobSubmissions).length > 0) {
    return 'submitted';
  }
  return jobStatusForError(classified);
}

export function carriesKnownRevert(error: unknown): boolean {
  return [...walkSubmissionErrorChain(error)].some(
    (current) => current instanceof SubmitSignalReceiptError && current.reverted,
  );
}
