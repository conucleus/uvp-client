import type { Hex } from 'viem';
import {
  ExecutorKitError,
  normalizeBytes32,
  ValidationError,
} from '../../validation.js';
import { asNonEmptyString } from '../internal.js';
import {
  appendManualAction,
  type StateMachineJobStore,
  type StateMachineWatcherJob,
} from './model.js';
import { isHeldRunClaim } from './claim.js';

export interface StateMachineJobReviveOptions {
  readonly operator: string;
  readonly reason: string;
  readonly now?: () => string;
}

export async function reviveStateMachineJob(
  jobStore: StateMachineJobStore,
  jobId: Hex | string,
  options: StateMachineJobReviveOptions,
): Promise<StateMachineWatcherJob> {
  const normalizedJobId = normalizeBytes32(jobId, 'jobId');
  const job = await jobStore.get(normalizedJobId);
  if (!job) {
    throw new ValidationError(`job ${normalizedJobId} not found`);
  }
  if (job.status !== 'ignored') {
    throw new ValidationError(`job ${normalizedJobId} cannot be revived from status ${job.status}: only ignored jobs have a revival channel`);
  }
  if (!job.raw) {
    throw new ValidationError(`job ${normalizedJobId} cannot be revived because its raw HookReady log was not stored`);
  }
  if (isHeldRunClaim(job.claim)) {
    throw new ExecutorKitError(
      `job ${normalizedJobId} is being processed by executor pid ${job.claim?.pid}` +
        ` (claimed at ${job.claim?.at}); wait for that run to finish or stop its process, then revive`,
    );
  }

  const at = (options.now ?? (() => new Date().toISOString()))();
  const reason = asNonEmptyString(options.reason, 'reason');
  const revived = await jobStore.update(normalizedJobId, {
    status: 'detected',
    updatedAt: at,
    attempts: 0,
    clearLastError: true,
    manualActions: appendManualAction(job, {
      action: 'revive',
      operator: asNonEmptyString(options.operator, 'operator'),
      at,
      reason,
    }),
    claim: null,
    expectStatus: 'ignored',
    expectClaimPid: job.claim?.pid ?? null,
  });
  if (!revived) {
    throw new ExecutorKitError(
      `job ${normalizedJobId} changed state while the revival was being applied; re-check the job and retry`,
    );
  }
  return revived;
}
