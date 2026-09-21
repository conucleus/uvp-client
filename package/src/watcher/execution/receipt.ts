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
    // Persist the receipt outcome so a later scan can tell an observed success
    // from a broadcast whose outcome was never known.
    ...(!result.dryRun && result.confirmed ? { confirmed: true } : {}),
  };
}

/**
 * Recovers the hash of an already-broadcast transaction from a submission
 * failure. Mirrors the classified-code walk in errors.ts: any Error along the
 * cause chain may carry a `txHash` hex property (e.g. SubmitSignalReceiptError
 * thrown after a successful broadcast whose receipt never confirmed).
 */
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

/**
 * Terminal status for a run that processed (or resumed) its signals. Both
 * signal lanes are reconciled BY CONTENT IDENTITY (the deterministic
 * submitSignal calldata of each signal), never by position: a re-run may
 * return a different subset than the failed run (e.g. only the pending
 * signals), and a surviving signal must never inherit a delivered sibling's
 * slot evidence — or the reverse, a pending signal being credited with a
 * delivered sibling's proof.
 *
 * - `confirmed`: every signal — returned this run, and ever really broadcast
 *   through the handler-context lane — is delivered by evidence (an observed
 *   success receipt, or the chain's own `SignalAlreadyExists` verdict on the
 *   four-tuple), and no recorded broadcast is left without such evidence —
 *   an unobserved receipt never counts, not even from this run. The
 *   incremental empty return (README-blessed: the handler returns only its
 *   pending signals, which is exactly the empty set once everything is
 *   delivered) lands here — the delivery history, not the return-set size,
 *   carries the payload;
 * - `submitted`: anything is still pending — a returned signal without
 *   delivery evidence, a context-channel signal identity without delivery
 *   evidence, or any broadcast whose outcome is unresolved (including a
 *   handler that stopped emitting signals an earlier run had broadcast: an
 *   unresolved broadcast keeps the job in the revisit lane whatever the
 *   handler now returns);
 * - `completed`: a real-mode run that finished with nothing delivered and
 *   nothing pending — a void handler is a finished execution, not a job
 *   waiting for a recheck; a void return after attempts that never reached
 *   the chain ends the same way, because no broadcast is outstanding;
 * - `matched`: dry-run passes (they converge non-terminal until a real pass
 *   or a manual retry runs).
 */
export function statusForCompletedRun(input: {
  readonly dryRun: boolean;
  /** Content identities (submitSignal calldata) of the signals the handler returned this run. */
  readonly identityDatas: readonly string[];
  readonly jobSubmissions: readonly StateMachineJobSubmission[];
}): StateMachineJobStatus {
  if (input.dryRun) {
    return 'matched';
  }
  // Delivery evidence is recomputed from the records, not taken from the
  // in-run set: that set also marks merely-sent signals (a
  // waitForReceipt:false broadcast) which are not evidence of anything.
  const provenDelivered = deliveredRequestDatasFromSubmissions(input.jobSubmissions);
  // The context lane reconciles by the same content identity as
  // unresolvedBroadcasts. One logical context signal may occupy several
  // indexes across runs — its first broadcast's receipt can stay unknown
  // forever, so a later scan rebroadcasts under a fresh index — and index
  // counting then mistakes "the old slot's receipt is never coming" for "a
  // signal is still pending". Monotonic index allocation prevents index
  // REUSE, not one signal accumulating indexes; indexes stay in the records
  // for presentation, delivery is a property of the calldata identity.
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
    // Terminal. Which terminal depends on whether any signal was actually
    // delivered: a delivery history means the complete-and-evidenced shape is
    // `confirmed`; zero delivery with nothing pending is the void `completed`
    // — there is no receipt left to wait for in either case.
    return provenDelivered.size > 0 ? 'confirmed' : 'completed';
  }
  return 'submitted';
}

/**
 * A record whose delivery is evidenced: a duplicate_signal response proving
 * the chain already carries the signal, or a real broadcast whose receipt was
 * observed as success. A broadcast without an observed receipt
 * (waitForReceipt:false) and a reverted receipt do NOT count: they are exactly
 * the facts later scans must re-check instead of trusting. Dry-run records
 * never count — flipping dry-run off must still broadcast everything.
 */
export function isDeliveredSubmission(submission: StateMachineJobSubmission): boolean {
  return submission.error?.kind === 'duplicate_signal'
    || (!submission.error && submission.dryRun === false && submission.confirmed === true);
}

/**
 * Content identities (submitSignal calldata) with delivery evidence, from the
 * records. A record without a stored request cannot attribute its evidence to
 * a content identity and does not contribute: the signal it belonged to is
 * resubmitted and the chain's SignalAlreadyExists dedupe answers it — with
 * the request recorded that time.
 */
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

/** A real broadcast whose own outcome is still unknown. */
export function isUnconfirmedBroadcast(submission: StateMachineJobSubmission): boolean {
  return submission.dryRun !== true
    && submission.txHash !== undefined
    && submission.confirmed !== true
    && submission.error?.kind !== 'duplicate_signal';
}

/**
 * Broadcasts whose outcome is still unresolved: not confirmed by their own
 * receipt, not answered by the chain's duplicate verdict, with no later
 * record confirming the same transaction hash and no delivery evidence for
 * their content identity. These are the recheck/resend candidates: resolved
 * by the receipt first, rebroadcast under backoff second.
 */
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

/**
 * Append a submission record to the audit trail. Dry-run records are
 * simulations of one deterministic request per signal, so a replayed dry-run
 * is deduped BY CONTENT IDENTITY (the request calldata) across runs and lanes:
 * the context lane allocates a fresh monotonically decreasing index on every
 * run, and an index-scoped key let one replayed signal append one record per
 * re-run forever. The index stays on records for presentation only. Real
 * broadcasts are never deduped — each is a distinct on-chain fact.
 */
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

/** Next per-signal attempt ordinal for a recovered/replayed record. */
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
  // Transient failures keep the retry channel open: after the in-run retries are
  // exhausted the job lands in `failed`, which `jobs retry` accepts. Deterministic
  // non-retryable failures dead-letter for human triage instead of parking in the
  // retryable lane where automatic or manual retries would pointlessly re-run them.
  return error.retryable ? 'failed' : 'dead_letter';
}

/**
 * Terminal status for a run that failed. A failure recorded together with a
 * broadcast whose outcome is unknown must not terminalize the job — `failed`
 * and `dead_letter` both end the automatic receipt rechecks, and the tx may
 * still mine. The job stays in the open `submitted` lane instead, and later
 * scans settle it by receipt (a mined revert then dead-letters with a known
 * outcome). A receipt actually observed as reverted is a known outcome and
 * still terminalizes normally.
 */
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

/** True when the error chain proves a receipt was observed as 'reverted'. */
export function carriesKnownRevert(error: unknown): boolean {
  return [...walkSubmissionErrorChain(error)].some(
    (current) => current instanceof SubmitSignalReceiptError && current.reverted,
  );
}
