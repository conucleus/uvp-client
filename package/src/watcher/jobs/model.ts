import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import type { ClassifiedExecutorKitError } from '../../errors.js';
import type { StateMachineRawLog, StateMachineHookReady } from '../../signal/decode.js';
import type { SubmitStateMachineSignalCall } from '../../signal/build.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export type StateMachineJobStatus =
  | 'detected'
  | 'matched'
  | 'submitted'
  | 'confirmed'
  | 'completed'
  | 'failed'
  | 'ignored'
  | 'dead_letter';

export interface StateMachineJobSubmission {
  readonly signalIndex: number;
  readonly attempt: number;
  readonly dryRun?: boolean;
  readonly txHash?: Hex;
  /**
   * Persisted receipt outcome of a real broadcast. Absent means the outcome
   * was never observed (waitForReceipt:false, or the receipt wait failed) —
   * not "delivered": later scans resolve it by re-checking the receipt.
   */
  readonly confirmed?: boolean;
  readonly request?: SubmitStateMachineSignalCall;
  readonly error?: ClassifiedExecutorKitError;
}

export interface StateMachineWatcherJob {
  readonly id: Hex;
  readonly eventId: Hex;
  readonly stateMachineAddress?: Address;
  readonly orderId: Hex;
  readonly planId?: Hex;
  readonly hookId: Hex;
  readonly stageId: Hex;
  readonly stageIdentifier?: string;
  readonly hookName?: string;
  readonly supplierId?: string;
  readonly status: StateMachineJobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly detectedAt: string;
  readonly updatedAt: string;
  readonly matchedKey?: string;
  readonly submissions: readonly StateMachineJobSubmission[];
  readonly lastError?: ClassifiedExecutorKitError;
  /**
   * Wall-clock time the last dry-run pass concluded (kept the job in the
   * non-terminal `matched` state). A concluded dry-run pass and a crashed one
   * are otherwise field-identical (matched, claim released, and a void pass
   * records no submissions), yet they demand opposite treatment — the first
   * must be skipped on rescan, the second re-run — so the conclusive write
   * records this and the rescan guard requires it. Cleared whenever a new run
   * claims the job.
   */
  readonly dryRunConcludedAt?: string;
  /**
   * Wall-clock time of the last real signal attempt (broadcast outcome
   * known or not). The resend backoff anchors here — updatedAt also moves on
   * unrelated bookkeeping, which would restart the throttle every round.
   */
  readonly lastSignalAttemptAt?: string;
  readonly manualActions?: readonly StateMachineJobManualAction[];
  /**
   * Run claim: the pid currently executing this job (set on the `matched`
   * transition, released on every conclusive status write). A live foreign
   * claim is what separates "matched because a watcher died mid-run" (claim
   * holder is gone, manual retry is the recovery channel) from "matched
   * because a run is in flight right now" (retrying would run the handler a
   * second time concurrently — chain idempotency cannot protect handler-side
   * external effects).
   */
  readonly claim?: { readonly pid: number; readonly at: string };
  readonly raw?: StateMachineRawLog;
}

export interface StateMachineJobManualAction {
  readonly action: 'retry' | 'dead_letter';
  readonly operator: string;
  readonly at: string;
  readonly reason?: string;
}

export interface StateMachineJobStore {
  /** Storage-mode label for diagnostics (`memory`, `file`, ...); optional so custom stores stay compatible. */
  readonly kind?: string;
  upsertDetected(event: StateMachineHookReady, options: {
    readonly now: string;
    readonly maxAttempts: number;
    readonly supplierId?: string;
  }): Promise<StateMachineWatcherJob>;
  update(jobId: Hex, patch: StateMachineJobPatch): Promise<StateMachineWatcherJob | undefined>;
  get(jobId: Hex): Promise<StateMachineWatcherJob | undefined>;
  list(): Promise<readonly StateMachineWatcherJob[]>;
}

export interface StateMachineJobPatch {
  readonly status?: StateMachineJobStatus;
  readonly updatedAt: string;
  readonly attempts?: number;
  readonly matchedKey?: string;
  /** Records the order planId once it is known so retries can resubmit. */
  readonly planId?: Hex;
  readonly submissions?: readonly StateMachineJobSubmission[];
  readonly lastError?: ClassifiedExecutorKitError;
  readonly clearLastError?: boolean;
  readonly lastSignalAttemptAt?: string;
  readonly manualActions?: readonly StateMachineJobManualAction[];
  /**
   * CAS guards: the update applies only while the job still matches them,
   * otherwise the store returns undefined without writing. Read-validate-write
   * sequences (manual retry reopening a job, a watcher claiming a run) must
   * hold both so a concurrent writer cannot interleave between the read and
   * the write.
   */
  readonly expectStatus?: StateMachineJobStatus;
  readonly expectClaimPid?: number | null;
  /** Takes or releases the run claim; omitted patches leave the claim as is. */
  readonly claim?: { readonly pid: number; readonly at: string } | null;
  /**
   * Records (string) or clears (null) the dry-run conclusion marker; omitted
   * patches leave it as is. Same resolution shape as `claim`: a claim write
   * clears it, the dry-run conclusive write sets it.
   */
  readonly dryRunConcludedAt?: string | null;
}

export function stateMachineJobId(event: Pick<StateMachineHookReady, 'orderId' | 'hookId' | 'eventId' | 'stateMachineAddress'>): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'bytes32' },
    ],
    [event.stateMachineAddress ?? ZERO_ADDRESS, event.orderId, event.hookId, event.eventId],
  ));
}

export function isTerminalJobStatus(status: StateMachineJobStatus): boolean {
  // 'submitted' means a transaction was broadcast but no receipt confirmed it.
  // That is deliberately NON-terminal: until the chain confirms success the job
  // stays open so a later scan or manual retry can observe the real outcome
  // instead of trusting the broadcast (a reverted tx must never freeze as done).
  // 'matched' is also non-terminal by design: it is either the in-flight run
  // placeholder (claim held) or a converged dry-run pass waiting for a real
  // pass. 'completed' IS terminal: a real-mode handler finished successfully
  // with zero signals — a void execution is done, and re-running it on every
  // later scan would replay the handler's external side effects forever.
  return status === 'confirmed'
    || status === 'completed'
    || status === 'failed'
    || status === 'ignored'
    || status === 'dead_letter';
}

export function latestSubmissionTxHash(submissions: readonly StateMachineJobSubmission[]): Hex | undefined {
  for (let index = submissions.length - 1; index >= 0; index -= 1) {
    const txHash = submissions[index]?.txHash;
    if (txHash) {
      return txHash;
    }
  }
  return undefined;
}

export function appendManualAction(
  job: StateMachineWatcherJob,
  action: StateMachineJobManualAction,
): readonly StateMachineJobManualAction[] {
  return [...(job.manualActions ?? []), action];
}

export function cloneJob(job: StateMachineWatcherJob): StateMachineWatcherJob {
  return structuredClone(job) as StateMachineWatcherJob;
}

export function patchCasMatches(
  job: StateMachineWatcherJob,
  patch: StateMachineJobPatch,
): boolean {
  if (patch.expectStatus !== undefined && job.status !== patch.expectStatus) {
    return false;
  }
  if (patch.expectClaimPid !== undefined && (job.claim?.pid ?? null) !== patch.expectClaimPid) {
    return false;
  }
  return true;
}

export function applyJobPatch(
  current: StateMachineWatcherJob,
  patch: StateMachineJobPatch,
): StateMachineWatcherJob {
  const {
    lastError: currentLastError,
    claim: currentClaim,
    dryRunConcludedAt: currentDryRunConcludedAt,
    ...currentWithoutOptional
  } = current;
  const next: StateMachineWatcherJob = {
    ...currentWithoutOptional,
    ...(patch.status ? { status: patch.status } : {}),
    updatedAt: patch.updatedAt,
    ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
    ...(patch.matchedKey !== undefined ? { matchedKey: patch.matchedKey } : {}),
    ...(patch.planId !== undefined ? { planId: patch.planId } : {}),
    ...(patch.submissions ? { submissions: patch.submissions } : {}),
    ...(patch.clearLastError ? {} : currentLastError ? { lastError: currentLastError } : {}),
    ...(patch.lastError ? { lastError: patch.lastError } : {}),
    ...(patch.lastSignalAttemptAt !== undefined ? { lastSignalAttemptAt: patch.lastSignalAttemptAt } : {}),
    ...(patch.manualActions ? { manualActions: patch.manualActions } : {}),
  };
  // claim 解析：显式写入优先（对象=认领，null=释放），未声明则保持现状。
  const resolvedClaim = patch.claim !== undefined ? patch.claim : currentClaim;
  const withClaim = resolvedClaim !== undefined && resolvedClaim !== null
    ? { ...next, claim: resolvedClaim } as StateMachineWatcherJob
    : next;
  // dryRunConcludedAt 同形解析：显式写入优先（字符串=记录，null=清除），
  // 未声明则保持现状。
  const resolvedDryRunConcludedAt = patch.dryRunConcludedAt !== undefined
    ? patch.dryRunConcludedAt
    : currentDryRunConcludedAt;
  return resolvedDryRunConcludedAt !== undefined && resolvedDryRunConcludedAt !== null
    ? { ...withClaim, dryRunConcludedAt: resolvedDryRunConcludedAt }
    : withClaim;
}
