import {
  ExecutorKitError,
  normalizeBytes32,
  ValidationError,
} from '../../validation.js';
import type { Hex } from 'viem';
import { asNonEmptyString } from '../internal.js';
import {
  appendManualAction,
  type StateMachineJobStore,
  type StateMachineWatcherJob,
} from './model.js';
import { isHeldRunClaim } from './claim.js';

export interface StateMachineJobDeadLetterOptions {
  readonly operator: string;
  readonly reason: string;
  /**
   * Override a run claim that reads alive. pid liveness alone cannot tell a
   * live holder from a crashed one whose pid the OS reused, and a reused-pid
   * claim blocks every recovery channel; forcing records the operator's
   * verified assertion that the holder is dead (operator + reason land in the
   * job's manual-action audit trail).
   */
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
  // Success states are not dead-letterable: `confirmed` (deliveries proven)
  // and `completed` (a void-handler run that finished with nothing to
  // broadcast) both ended in a terminal success, and `submitted` still has an
  // unresolved broadcast whose receipt must be verified first.
  if (job.status === 'confirmed' || job.status === 'completed' || job.status === 'submitted') {
    throw new ValidationError(`job ${normalizedJobId} cannot be dead-lettered from status ${job.status}`);
  }
  if (isHeldRunClaim(job.claim) && !options.force) {
    // dead_letter 附带 claim:null：在一个运行中的任务上落它会清掉执行者的
    // 活认领，等于把进行中的 handler 变成无主运行。与 retry 入口同一条闸；
    // --force 是 pid 复用死锁的人工出口——OS 把崩溃持有者的 pid 发给新进程
    // 后，该认领永远"读作存活"，retry/dead-letter/later-scan 全被它挡死。
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
      // 审计可区分性：--force 覆盖读作存活的认领是"操作员断言持有者已死"的
      // 更强声明，回看时必须能与常规 dead-letter 分开识别。
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
