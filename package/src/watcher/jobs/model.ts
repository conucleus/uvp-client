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
  readonly dryRunConcludedAt?: string;
  readonly lastSignalAttemptAt?: string;
  readonly manualActions?: readonly StateMachineJobManualAction[];
  readonly claim?: { readonly pid: number; readonly at: string };
  readonly raw?: StateMachineRawLog;
}

export interface StateMachineJobManualAction {
  readonly action: 'retry' | 'dead_letter' | 'revive';
  readonly operator: string;
  readonly at: string;
  readonly reason?: string;
  readonly forced?: boolean;
}

export interface StateMachineJobStore {
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
  readonly planId?: Hex;
  readonly submissions?: readonly StateMachineJobSubmission[];
  readonly lastError?: ClassifiedExecutorKitError;
  readonly clearLastError?: boolean;
  readonly lastSignalAttemptAt?: string;
  readonly manualActions?: readonly StateMachineJobManualAction[];
  readonly expectStatus?: StateMachineJobStatus;
  readonly expectClaimPid?: number | null;
  readonly claim?: { readonly pid: number; readonly at: string } | null;
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
  const resolvedClaim = patch.claim !== undefined ? patch.claim : currentClaim;
  const withClaim = resolvedClaim !== undefined && resolvedClaim !== null
    ? { ...next, claim: resolvedClaim } as StateMachineWatcherJob
    : next;
  const resolvedDryRunConcludedAt = patch.dryRunConcludedAt !== undefined
    ? patch.dryRunConcludedAt
    : currentDryRunConcludedAt;
  return resolvedDryRunConcludedAt !== undefined && resolvedDryRunConcludedAt !== null
    ? { ...withClaim, dryRunConcludedAt: resolvedDryRunConcludedAt }
    : withClaim;
}
