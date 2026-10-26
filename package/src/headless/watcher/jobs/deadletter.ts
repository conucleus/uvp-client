import {
  ExecutorKitError,
  normalizeBytes32,
  ValidationError,
} from '../../../core/validation.js';
import type { Hex } from 'viem';
import { asNonEmptyString } from '../../../core/internal.js';
import {
  appendManualAction,
  type StateMachineJobStore,
  type StateMachineWatcherJob,
} from './model.js';
import { isHeldRunClaim } from './claim.js';

export interface StateMachineJobDeadLetterOptions {
  readonly operator: string;
  readonly reason: string;
  readonly force?: boolean;
  readonly now?: () => string;
}

export async function deadLetterStateMachineJob(
  jobStore: StateMachineJobStore,
  jobId: Hex | string,
  options: StateMachineJobDeadLetterOptions,
): Promise<StateMachineWatcherJob> {
  const normalizedJobId = normalizeBytes32(jobId, 'jobId');
  const job = await jobStore.get(normalizedJobId);
  if (!job) {
    throw new ValidationError(`job ${normalizedJobId} not found`);
  }
  if (job.status === 'confirmed' || job.status === 'completed' || job.status === 'submitted') {
    throw new ValidationError(`job ${normalizedJobId} cannot be dead-lettered from status ${job.status}`);
  }
  if (isHeldRunClaim(job.claim) && !options.force) {
    throw new ExecutorKitError(
      `job ${normalizedJobId} is being processed by executor pid ${job.claim?.pid}` +
        ` (claimed at ${job.claim?.at}); wait for that run to finish or stop its process, then dead-letter` +
        ' — pass --force only after verifying the pid is not the executor (a crashed holder\'s pid can be reused by the OS and then reads alive forever)',
    );
  }

  const at = (options.now ?? (() => new Date().toISOString()))();
  const reason = asNonEmptyString(options.reason, 'reason');
  const updated = await jobStore.update(normalizedJobId, {
    status: 'dead_letter',
    updatedAt: at,
    lastError: {
      kind: 'unknown',
      message: reason,
      retryable: false,
    },
    manualActions: appendManualAction(job, {
      action: 'dead_letter',
      operator: asNonEmptyString(options.operator, 'operator'),
      at,
      reason,
      ...(options.force ? { forced: true } : {}),
    }),
    claim: null,
    expectStatus: job.status,
    expectClaimPid: job.claim?.pid ?? null,
  });
  if (!updated) {
    throw new ExecutorKitError(
      `job ${normalizedJobId} changed state while dead-lettering was being applied; re-check the job and retry`,
    );
  }
  return updated;
}
