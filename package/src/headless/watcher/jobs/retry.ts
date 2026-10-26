import { classifyExecutorKitError } from '../../../core/errors.js';
import {
  ExecutorKitError,
  normalizeBytes32,
  parsePositiveInteger,
  ValidationError,
} from '../../../core/validation.js';
import type { Hex } from 'viem';
import { asNonEmptyString, asNumberOrString, parseNonNegativeSafeInteger } from '../../../core/internal.js';
import {
  appendManualAction,
  latestSubmissionTxHash,
  type StateMachineJobStatus,
} from './model.js';
import { isHeldRunClaim } from './claim.js';
import type { StateMachineLogProcessResult, StateMachineWatcher } from '../watcher.js';

export interface StateMachineRetryConfig {
  readonly maxAttempts?: number | string;
  readonly baseDelayMs?: number | string;
}

export interface StateMachineResendBackoffConfig {
  readonly baseDelayMs?: number | string;
  readonly maxDelayMs?: number | string;
}

export const DEFAULT_RESEND_BACKOFF_BASE_DELAY_MS = 30_000;
export const DEFAULT_RESEND_BACKOFF_MAX_DELAY_MS = 600_000;

export interface StateMachineJobRetryOptions {
  readonly operator: string;
  readonly reason?: string;
  readonly now?: () => string;
}

export async function retryStateMachineJob(
  watcher: StateMachineWatcher,
  jobId: Hex | string,
  options: StateMachineJobRetryOptions,
): Promise<StateMachineLogProcessResult> {
  const normalizedJobId = normalizeBytes32(jobId, 'jobId');
  const job = await watcher.config.jobStore.get(normalizedJobId);
  if (!job) {
    throw new ValidationError(`job ${normalizedJobId} not found`);
  }
  if (!isRetriableStateMachineJobStatus(job.status)) {
    throw new ValidationError(`job ${normalizedJobId} cannot be retried from status ${job.status}`);
  }
  if (isHeldRunClaim(job.claim)) {
    throw new ExecutorKitError(
      `job ${normalizedJobId} is being processed by executor pid ${job.claim?.pid}` +
        ` (claimed at ${job.claim?.at}); wait for that run to finish or stop its process, then retry`,
    );
  }
  if (!job.raw) {
    throw new ValidationError(`job ${normalizedJobId} cannot be retried because its raw HookReady log was not stored`);
  }

  const at = (options.now ?? watcher.config.now)();
  const manualActions = appendManualAction(job, {
    action: 'retry',
    operator: asNonEmptyString(options.operator, 'operator'),
    at,
    ...(options.reason ? { reason: options.reason } : {}),
  });

  if (job.attempts >= job.maxAttempts && job.status !== 'failed' && job.status !== 'confirmed' && job.status !== 'completed') {
    if (job.status === 'submitted') {
      const txHash = latestSubmissionTxHash(job.submissions);
      throw new ValidationError(
        `job ${normalizedJobId} was broadcast without a confirmed receipt (status submitted)`
        + `${txHash ? `: check the receipt for ${txHash}` : ''} before retrying`,
      );
    }
    const error = classifyExecutorKitError(
      new Error(`retry limit reached for job ${normalizedJobId}: ${job.attempts}/${job.maxAttempts}`),
    );
    const deadLetter = await watcher.config.jobStore.update(normalizedJobId, {
      status: 'dead_letter',
      updatedAt: at,
      manualActions,
      lastError: error,
      claim: null,
      expectStatus: job.status,
      expectClaimPid: job.claim?.pid ?? null,
    });
    if (!deadLetter) {
      throw await conflictRetryError(normalizedJobId, watcher);
    }
    return {
      status: 'ignored',
      submissions: [],
      job: deadLetter,
      error,
    };
  }

  const reopened = await watcher.config.jobStore.update(normalizedJobId, {
    status: 'detected',
    updatedAt: at,
    ...(job.status === 'failed' ? { attempts: 0 } : {}),
    manualActions,
    clearLastError: true,
    claim: null,
    expectStatus: job.status,
    expectClaimPid: job.claim?.pid ?? null,
  });
  if (!reopened) {
    throw await conflictRetryError(normalizedJobId, watcher);
  }
  return watcher.handleLog(job.raw, {
    resubmitDelivered: job.status === 'confirmed',
    bypassResendBackoff: true,
  });
}

async function conflictRetryError(
  jobId: Hex,
  watcher: StateMachineWatcher,
): Promise<ExecutorKitError> {
  const current = await watcher.config.jobStore.get(jobId);
  return new ExecutorKitError(
    `job ${jobId} changed state while the retry was being applied (now ${current?.status ?? 'missing'});` +
      ' re-check the job and run the retry again',
  );
}

export interface NormalizedStateMachineRetryConfig {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
}

export interface NormalizedStateMachineResendBackoffConfig {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export function normalizeRetryConfig(config: StateMachineRetryConfig | Record<string, unknown> | undefined): NormalizedStateMachineRetryConfig {
  const maxAttempts = config?.maxAttempts;
  const baseDelayMs = config?.baseDelayMs;
  return {
    maxAttempts: maxAttempts !== undefined
      ? parsePositiveInteger(asNumberOrString(maxAttempts, 'retry.maxAttempts'), 'retry.maxAttempts')
      : 3,
    baseDelayMs: baseDelayMs !== undefined
      ? parseNonNegativeSafeInteger(asNumberOrString(baseDelayMs, 'retry.baseDelayMs'), 'retry.baseDelayMs')
      : 0,
  };
}

function isRetriableStateMachineJobStatus(status: StateMachineJobStatus): boolean {
  return status === 'detected'
    || status === 'failed'
    || status === 'matched'
    || status === 'submitted'
    || status === 'completed'
    || status === 'confirmed';
}

export function resendBackoffDelayMs(
  config: NormalizedStateMachineResendBackoffConfig,
  priorUnconfirmedBroadcasts: number,
): number {
  const exponent = Math.min(Math.max(priorUnconfirmedBroadcasts - 1, 0), 16);
  return Math.min(config.baseDelayMs * 2 ** exponent, config.maxDelayMs);
}
