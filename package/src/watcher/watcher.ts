import type { Address, Hex } from 'viem';
import {
  ExecutorKitError,
  ValidationError,
  normalizeAddress,
  normalizeAddressChecksummed,
  normalizeBytes32,
  parseBigNumberish,
  parsePositiveInteger,
} from '../validation.js';
import { ZERO_BYTES32 } from '../constants.js';
import { classifyExecutorKitError, type ClassifiedExecutorKitError } from '../errors.js';
import {
  HOOK_READY_TOPIC,
  decodeHookReadyLog,
  tryHookReadyEventId,
  tryNormalizeStateMachineAddress,
  type StateMachineArtifactIndex,
  type StateMachineHookReady,
  type StateMachineRawLog,
} from '../signal/decode.js';
import {
  buildSubmitStateMachineSignalCall,
  capabilityTablesOf,
  normalizeSubmitConfig,
  withCapabilityProofs,
  type NormalizedSubmitConfig,
  type StateMachineCapabilityTables,
  type StateMachinePublicClient,
  type StateMachineSignal,
  type SubmitStateMachineSignalCall,
  type SubmitStateMachineSignalConfig,
} from '../signal/build.js';
import {
  ensureChainId,
  getPublicClient,
  submitStateMachineSignal,
  SubmitSignalReceiptError,
  type SubmitStateMachineSignalResult,
} from '../signal/submit.js';
import {
  normalizeArtifactIndex,
  resolveStateMachineHandler,
  type DeferredBroadcastOutcome,
  type StateMachineHookReadyHandler,
  type StateMachineHookReadyHandlerContext,
  type StateMachineHookReadyHandlerResult,
} from './execution/handler.js';
import {
  ClassifiedStateMachineError,
  appendJobSubmission,
  broadcastTxHashFromError,
  carriesKnownRevert,
  deliveredRequestDatasFromSubmissions,
  isDeliveredSubmission,
  isUnconfirmedBroadcast,
  jobStatusForError,
  nextSubmissionAttempt,
  normalizeHandlerResult,
  statusForCompletedRun,
  statusForTerminalError,
  toJobSubmission,
  unresolvedBroadcasts,
} from './execution/receipt.js';
import {
  DEFAULT_RESEND_BACKOFF_BASE_DELAY_MS,
  DEFAULT_RESEND_BACKOFF_MAX_DELAY_MS,
  normalizeRetryConfig,
  resendBackoffDelayMs,
  type NormalizedStateMachineResendBackoffConfig,
  type NormalizedStateMachineRetryConfig,
  type StateMachineResendBackoffConfig,
  type StateMachineRetryConfig,
} from './jobs/retry.js';
import { isHeldRunClaim, withConclusiveClaimRelease } from './jobs/claim.js';
import {
  isTerminalJobStatus,
  type StateMachineJobPatch,
  type StateMachineJobStore,
  type StateMachineJobSubmission,
  type StateMachineWatcherJob,
} from './jobs/model.js';
import { InMemoryStateMachineJobStore } from './storage/memory.js';
import type {
  StateMachineCursorCheckpoint,
  StateMachineCursorContext,
  StateMachineCursorStore,
} from './storage/cursor.js';
import {
  DEFAULT_GET_LOGS_BLOCK_SPAN,
  DEFAULT_GET_LOGS_CONCURRENCY,
  blockRanges,
  compareRawLogs,
  mapWithConcurrency,
} from './scan/logs.js';
import {
  DEFAULT_FINALITY_CONFIRMATIONS,
  DEFAULT_REORG_WINDOW_BLOCKS,
  checkpointAnchorHeights,
  recordCheckpoint,
  sameBlockHash,
  tryGetBlockHash,
} from './scan/reorg.js';
import {
  asNonEmptyString,
  asNumberOrString,
  delay,
  describeError,
  parseNonNegativeSafeInteger,
} from './internal.js';

export const DEFAULT_STATE_MACHINE_POLL_INTERVAL_MS = 4_000;
export const POLL_FAILURE_BACKOFF_MULTIPLIER_CAP = 8;
export const HELD_FOREIGN_CLAIM_ALERT_ROUNDS = 3;

export type StateMachineRuntimeEnvironment = 'local' | 'testnet' | 'staging' | 'production';

export interface StateMachineWatchHandle {
  stop(): Promise<void> | void;
  readonly done: Promise<void>;
}

export interface StateMachineWatcherConfig extends SubmitStateMachineSignalConfig {
  readonly supplierId?: string;
  readonly stateMachines?: readonly StateMachineDeploymentWatcherConfig[];
  readonly handlers: Readonly<Record<string, StateMachineHookReadyHandler>>;
  readonly artifact?: StateMachineArtifactIndex;
  readonly fromBlock?: bigint | number | string;
  readonly pollIntervalMs?: number | string;
  readonly retry?: StateMachineRetryConfig;
  readonly resendBackoff?: StateMachineResendBackoffConfig;
  readonly nowMs?: () => number;
  readonly confirmations?: number | string;
  readonly runtimeEnvironment?: StateMachineRuntimeEnvironment;
  readonly reorgWindow?: number | string;
  readonly getLogsBlockSpan?: number | string;
  readonly jobStore?: StateMachineJobStore;
  readonly cursorStore?: StateMachineCursorStore;
  readonly now?: () => string;
  readonly onPoll?: (result: StateMachinePollResult) => void;
  readonly onError?: (error: unknown) => void;
}

export interface StateMachineDeploymentWatcherConfig {
  readonly stateMachineAddress: Address | string;
  readonly deploymentId?: Hex | string;
  readonly status?: 'active' | 'deprecated' | 'canary' | 'candidate' | 'retired';
}

export interface StateMachineLogProcessResult {
  readonly status: 'skipped' | 'ignored' | 'handled';
  readonly event?: StateMachineHookReady;
  readonly matchedKey?: string;
  readonly submissions: readonly SubmitStateMachineSignalResult[];
  readonly job?: StateMachineWatcherJob;
  readonly error?: ClassifiedExecutorKitError;
  readonly decodeFailure?: boolean;
}

export interface StateMachinePollResult {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly scannedLogs: number;
  readonly results: readonly StateMachineLogProcessResult[];
  readonly decodeFailures: number;
}

export class StateMachineWatcher {
  readonly config: NormalizedStateMachineWatcherConfig;
  private nextBlock: bigint | undefined;
  private decodeFailuresTotal = 0;
  private cursorRestored = false;
  private adoptedStoredCursor = false;
  private genesisHash: string | undefined;
  private genesisIdentityUnknownRounds = 0;
  private cursorBlockHash: string | undefined;
  private checkpoints: StateMachineCursorCheckpoint[] = [];
  private pendingClaimReleases = new Set<Hex>();
  private heldForeignClaimRounds = new Map<Hex, number>();
  private alertedHeldForeignClaims = new Set<Hex>();

  constructor(config: StateMachineWatcherConfig) {
    this.config = normalizeStateMachineWatcherConfig(config);
    this.nextBlock = this.config.fromBlock;
  }

  describe(): Record<string, unknown> {
    return {
      rpcUrl: this.config.rpcUrl,
      stateMachineAddress: this.config.stateMachineAddress,
      stateMachines: this.config.stateMachines,
      chainId: this.config.chainId,
      supplierId: this.config.supplierId,
      walletAddress: this.config.walletAddress,
      privateKeyEnv: this.config.privateKeyEnv,
      fromBlock: this.config.fromBlock?.toString(),
      nextBlock: this.nextBlock?.toString(),
      pollIntervalMs: this.config.pollIntervalMs,
      confirmations: this.config.confirmations,
      ...(this.config.runtimeEnvironment ? { runtimeEnvironment: this.config.runtimeEnvironment } : {}),
      reorgWindow: this.config.reorgWindow,
      getLogsBlockSpan: this.config.getLogsBlockSpan,
      handlerKeys: Object.keys(this.config.handlers),
      dryRun: this.config.dryRun,
      retry: this.config.retry,
      decodeFailures: this.decodeFailuresTotal,
      jobStore: this.config.jobStore.kind ?? 'custom',
      cursorStore: this.config.cursorStore?.kind ?? 'memory',
      ...(this.config.cursorStore
        ? {
          genesisIdentity: this.genesisHash !== undefined ? 'bound' : 'unknown',
          genesisIdentityUnknownRounds: this.genesisIdentityUnknownRounds,
        }
        : {}),
    };
  }

  async restoreCursor(client?: StateMachinePublicClient): Promise<void> {
    if (this.cursorRestored) {
      return;
    }
    const store = this.config.cursorStore;
    if (!store) {
      this.cursorRestored = true;
      return;
    }
    if (client) {
      await this.observeGenesisIdentity(client);
    }
    const result = await store.load(this.cursorContext());
    this.cursorRestored = true;
    if (result.status === 'foreign') {
      const cause = result.reason === 'genesis'
        ? 'the chain genesis hash changed (chain reset or replacement chain at the same chain id)'
        : 'the chain id or state-machine set changed';
      this.config.onError?.(new ExecutorKitError(
        `discarding the persisted scan cursor: ${cause}`
        + `; rescanning from ${this.config.fromBlock !== undefined ? `fromBlock ${this.config.fromBlock}` : 'the current finalized head'}`
        + ` (stored cursor file: ${store.kind === 'file' && 'filePath' in store ? String((store as { readonly filePath: string }).filePath) : store.kind ?? 'custom'})`,
      ));
      return;
    }
    if (result.status === 'restored') {
      this.nextBlock = result.nextBlock;
      this.cursorBlockHash = result.blockHash;
      this.checkpoints = [...(result.checkpoints ?? [])];
      this.adoptedStoredCursor = true;
    }
  }

  private async observeGenesisIdentity(client: StateMachinePublicClient): Promise<void> {
    if (!this.config.cursorStore || this.genesisHash !== undefined) {
      return;
    }
    if (typeof client.getBlock !== 'function') {
      return;
    }
    const hash = await tryGetBlockHash(client, 0n);
    if (hash !== undefined) {
      if (this.genesisIdentityUnknownRounds > 0) {
        this.config.onError?.(new ExecutorKitError(
          `chain genesis hash is readable again after ${this.genesisIdentityUnknownRounds} degraded poll round(s);`
            + ' subsequent cursor saves re-bind the genesis identity, restoring reset-chain detection for restarts',
        ));
      }
      this.genesisHash = hash;
      this.genesisIdentityUnknownRounds = 0;
      return;
    }
    this.genesisIdentityUnknownRounds += 1;
    this.config.onError?.(new ExecutorKitError(
      `chain genesis hash could not be read (degraded for ${this.genesisIdentityUnknownRounds} poll round(s));`
        + ' the persisted scan cursor is restored and re-saved with a degraded chain identity'
        + ' (chain id and state-machine set only), so a chain reset at the same chain id'
        + ' goes undetected while this persists; the read is retried every poll round and the'
        + ' identity binding self-heals once block 0 is readable',
    ));
  }

  async pollOnce(): Promise<StateMachinePollResult> {
    await this.retryPendingClaimReleases();
    const client = getPublicClient(this.config);
    await ensureChainId(client, this.config.chainId);
    const cursorAlreadyRestored = this.cursorRestored;
    await this.restoreCursor(client);
    if (cursorAlreadyRestored) {
      await this.observeGenesisIdentity(client);
    }

    const latestBlock = await client.getBlockNumber();
    const toBlock = latestBlock > BigInt(this.config.confirmations)
      ? latestBlock - BigInt(this.config.confirmations)
      : 0n;
    let fromBlock = this.nextBlock ?? this.config.fromBlock ?? toBlock;

    if (fromBlock > latestBlock) {
      this.config.onError?.(new ExecutorKitError(
        `scan cursor ${fromBlock} is beyond the chain head ${latestBlock}${this.adoptedStoredCursor ? ' (persisted cursor is stale)' : ''}`
        + `; ${this.config.fromBlock !== undefined ? `rescanning from fromBlock ${this.config.fromBlock}` : 'waiting for the chain to grow'}`,
      ));
      if (this.adoptedStoredCursor && this.config.fromBlock !== undefined && this.config.fromBlock <= toBlock) {
        fromBlock = this.config.fromBlock;
        this.adoptedStoredCursor = false;
        this.checkpoints = [];
        this.cursorBlockHash = undefined;
      } else {
        this.trackHeldForeignClaims(await this.config.jobStore.list());
        return { fromBlock, toBlock, scannedLogs: 0, results: [], decodeFailures: 0 };
      }
    } else {
      fromBlock = await this.enforceCursorContinuity(client, fromBlock);
    }

    if (fromBlock > toBlock) {
      const revisitResults = await this.revisitOpenJobs(fromBlock, new Set());
      return {
        fromBlock,
        toBlock,
        scannedLogs: 0,
        results: revisitResults,
        decodeFailures: revisitResults.filter((result) => result.decodeFailure).length,
      };
    }

    const scanRequests = this.config.stateMachines.flatMap((deployment) =>
      blockRanges(fromBlock, toBlock, BigInt(this.config.getLogsBlockSpan))
        .map((range) => ({ deployment, range })),
    );
    const logs = (
      await mapWithConcurrency(
        scanRequests,
        DEFAULT_GET_LOGS_CONCURRENCY,
        ({ deployment, range }) => client.getLogs({
          address: deployment.stateMachineAddress,
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
        }),
      )
    )
      .flatMap((logsForRequest, index) => {
        const deployment = scanRequests[index]?.deployment;
        return logsForRequest.map((log) => (log.address ? log : deployment ? { ...log, address: deployment.stateMachineAddress } : log));
      })
      .sort(compareRawLogs);
    const scannedEventIds = scannedHookReadyEventIds(logs);
    const results: StateMachineLogProcessResult[] = [];
    for (const log of logs) {
      results.push(await this.handleLog(log));
    }
    const nextBlock = toBlock + 1n;
    const stagedCheckpoints = [...this.checkpoints];
    let roundCursorBlockHash: string | undefined;
    for (const anchorHeight of checkpointAnchorHeights(fromBlock, toBlock, this.config.reorgWindow)) {
      const anchorHash = await tryGetBlockHash(client, anchorHeight);
      if (anchorHash !== undefined) {
        recordCheckpoint(stagedCheckpoints, anchorHeight, anchorHash, this.config.reorgWindow);
        if (anchorHeight === toBlock) {
          roundCursorBlockHash = anchorHash;
        }
      }
    }
    results.push(...await this.revisitOpenJobs(fromBlock, scannedEventIds));
    if (this.config.cursorStore) {
      await this.config.cursorStore.save(
        {
          nextBlock,
          ...(roundCursorBlockHash !== undefined ? { blockHash: roundCursorBlockHash } : {}),
          ...(stagedCheckpoints.length > 0 ? { checkpoints: stagedCheckpoints } : {}),
        },
        this.cursorContext(),
      );
    }
    this.nextBlock = nextBlock;
    this.checkpoints = stagedCheckpoints;
    this.cursorBlockHash = roundCursorBlockHash;

    const decodeFailures = results.filter((result) => result.decodeFailure).length;
    return {
      fromBlock,
      toBlock,
      scannedLogs: logs.length,
      results,
      decodeFailures,
    };
  }

  async handleLog(log: StateMachineRawLog, options?: {
    readonly resubmitDelivered?: boolean;
    readonly bypassResendBackoff?: boolean;
  }): Promise<StateMachineLogProcessResult> {
    if (log.topics[0] !== HOOK_READY_TOPIC) {
      return {
        status: 'skipped',
        submissions: [],
      };
    }

    let event: StateMachineHookReady;
    try {
      const decoded = decodeHookReadyLog(log, this.config.artifact);
      if (!decoded) {
        throw new ValidationError('HookReady log matched the topic but did not decode into an event');
      }
      event = decoded;
    } catch (error) {
      return this.isolateUndecodableLog(log, error);
    }

    const detectedAt = this.config.now();
    let job = await this.config.jobStore.upsertDetected(event, {
      now: detectedAt,
      maxAttempts: this.config.retry.maxAttempts,
      ...(this.config.supplierId ? { supplierId: this.config.supplierId } : {}),
    });
    if (isTerminalJobStatus(job.status)) {
      return {
        status: 'ignored',
        event,
        submissions: [],
        job,
      };
    }
    if (
      job.status === 'matched'
      && job.claim === undefined
      && job.dryRunConcludedAt !== undefined
      && this.config.dryRun
    ) {
      return {
        status: 'ignored',
        event,
        submissions: [],
        job,
      };
    }

    const resolved = resolveStateMachineHandler(this.config.handlers, event);
    if (!resolved) {
      const error = classifyExecutorKitError(
        new Error(`no state machine handler for ${event.stageIdentifier && event.hookName ? `${event.stageIdentifier}#${event.hookName}` : event.hookId}`),
        'missing_handler',
      );
      return this.ignoredVerdictResult(event, await this.recordIgnoredVerdict(job, error), error);
    }

    const claimOutcome = await this.claimForRun(job, resolved.key);
    if (claimOutcome.outcome !== 'claimed') {
      return {
        status: 'skipped',
        event,
        submissions: [],
        ...(claimOutcome.job ? { job: claimOutcome.job } : {}),
      };
    }
    try {
      return await this.processClaimedRun(claimOutcome.job, event, resolved, options);
    } finally {
      await this.releaseRunClaim(job.id);
    }
  }

  private async processClaimedRun(
    claimedJob: StateMachineWatcherJob,
    event: StateMachineHookReady,
    resolved: { readonly key: string; readonly handler: StateMachineHookReadyHandler },
    options?: {
      readonly resubmitDelivered?: boolean;
      readonly bypassResendBackoff?: boolean;
    },
  ): Promise<StateMachineLogProcessResult> {
    let job = claimedJob;
    let currentJob = claimedJob;
    let attempts = currentJob.attempts;
    const jobSubmissions: StateMachineJobSubmission[] = [...currentJob.submissions];
    const eventSubmitConfig = {
      ...this.config,
      stateMachineAddress: event.stateMachineAddress ?? this.config.stateMachineAddress,
    };
    const capabilityTables = capabilityTablesOf(this.config.artifact);
    const submitSignalWithJobRetry = async (
      signal: StateMachineSignal,
      signalIndex: number,
      identityRequest: SubmitStateMachineSignalCall,
    ): Promise<SubmitStateMachineSignalResult | DeferredBroadcastOutcome> => {
      let lastError: ClassifiedExecutorKitError | undefined;
      for (let attemptForSignal = 1; attemptForSignal <= this.config.retry.maxAttempts; attemptForSignal += 1) {
        try {
          const result = await submitStateMachineSignal(eventSubmitConfig, signal);
          appendJobSubmission(jobSubmissions, toJobSubmission(signalIndex, attemptForSignal, result));
          currentJob = await this.updateJob(job.id, {
            updatedAt: this.config.now(),
            ...(result.dryRun ? {} : { lastSignalAttemptAt: this.config.now() }),
            submissions: jobSubmissions,
          });
          return result;
        } catch (error) {
          const classified = classifyExecutorKitError(error);
          attempts += 1;
          lastError = classified;
          const broadcastTxHash = broadcastTxHashFromError(error);
          jobSubmissions.push({
            signalIndex,
            attempt: attemptForSignal,
            request: identityRequest,
            ...(broadcastTxHash ? { txHash: broadcastTxHash } : {}),
            error: classified,
          });
          currentJob = await this.updateJob(job.id, {
            updatedAt: this.config.now(),
            attempts,
            lastSignalAttemptAt: this.config.now(),
            submissions: jobSubmissions,
            lastError: classified,
          });
          if (classified.retryable && broadcastTxHash !== undefined) {
            const recovered = await this.recoverBroadcastSubmission(eventSubmitConfig, signal, broadcastTxHash);
            if (recovered) {
              appendJobSubmission(jobSubmissions, toJobSubmission(signalIndex, attemptForSignal, recovered));
              currentJob = await this.updateJob(job.id, {
                updatedAt: this.config.now(),
                submissions: jobSubmissions,
                clearLastError: true,
              });
              return recovered;
            }
            return { deferredBroadcast: true };
          }
          if (!classified.retryable || attemptForSignal >= this.config.retry.maxAttempts) {
            throw new ClassifiedStateMachineError(classified, { cause: error });
          }
          await delay(this.config.retry.baseDelayMs * attemptForSignal);
        }
      }

      throw new ClassifiedStateMachineError(lastError ?? classifyExecutorKitError(new Error('submission failed')));
    };

    let contextSubmissionCount = 0;
    let deferredResend = false;
    const priorContextSignalCount = new Set(
      jobSubmissions.filter((submission) => submission.signalIndex < 0).map((submission) => submission.signalIndex),
    ).size;
    const context: StateMachineHookReadyHandlerContext = {
      matchedKey: resolved.key,
      submitSignal: async (signal, overrides) => {
        const signalIndex = -1 - priorContextSignalCount - contextSubmissionCount;
        contextSubmissionCount += 1;
        const attempt = contextSubmissionCount;
        const submitConfig = normalizeSubmitConfig({ ...eventSubmitConfig, ...overrides });
        const provenSignal = withCapabilityProofs(signal, capabilityTables);
        const identityRequest = buildSubmitStateMachineSignalCall(submitConfig, provenSignal);
        const priorRecords = jobSubmissions.filter((submission) => submission.request?.data === identityRequest.data);
        const deliveredPrior = options?.resubmitDelivered
          ? undefined
          : priorRecords.find(isDeliveredSubmission);
        if (deliveredPrior?.txHash !== undefined && !deliveredPrior.dryRun) {
          return {
            dryRun: false,
            request: deliveredPrior.request ?? identityRequest,
            txHash: deliveredPrior.txHash,
            confirmed: true,
          };
        }
        const unresolvedPrior = priorRecords
          .filter((submission) => isUnconfirmedBroadcast(submission))
          .at(-1);
        if (unresolvedPrior?.txHash !== undefined) {
          const recovered = await this.recoverBroadcastSubmission(submitConfig, provenSignal, unresolvedPrior.txHash);
          if (recovered) {
            appendJobSubmission(jobSubmissions, toJobSubmission(
              unresolvedPrior.signalIndex,
              nextSubmissionAttempt(jobSubmissions, unresolvedPrior.signalIndex),
              recovered,
            ));
            currentJob = await this.updateJob(job.id, {
              updatedAt: this.config.now(),
              submissions: jobSubmissions,
              clearLastError: true,
            });
            return recovered;
          }
          const priorUnconfirmed = priorRecords
            .filter((submission) => isUnconfirmedBroadcast(submission)).length;
          const requiredDelayMs = resendBackoffDelayMs(this.config.resendBackoff, priorUnconfirmed);
          const lastAttemptAtMs = Date.parse(currentJob.lastSignalAttemptAt ?? '');
          if (
            options?.bypassResendBackoff !== true
            && Number.isFinite(lastAttemptAtMs)
            && this.config.nowMs() - lastAttemptAtMs < requiredDelayMs
          ) {
            deferredResend = true;
            return { deferredBroadcast: true };
          }
        }
        try {
          const result = await submitStateMachineSignal(submitConfig, provenSignal);
          appendJobSubmission(jobSubmissions, toJobSubmission(signalIndex, attempt, result));
          currentJob = await this.updateJob(job.id, {
            updatedAt: this.config.now(),
            ...(result.dryRun ? {} : { lastSignalAttemptAt: this.config.now() }),
            submissions: jobSubmissions,
          });
          return result;
        } catch (error) {
          const classified = classifyExecutorKitError(error);
          const broadcastTxHash = broadcastTxHashFromError(error);
          jobSubmissions.push({
            signalIndex,
            attempt,
            request: identityRequest,
            ...(broadcastTxHash ? { txHash: broadcastTxHash } : {}),
            error: classified,
          });
          if (broadcastTxHash !== undefined && !carriesKnownRevert(error)) {
            const recovered = await this.recoverBroadcastSubmission(submitConfig, provenSignal, broadcastTxHash)
              .catch(() => undefined);
            if (recovered) {
              appendJobSubmission(jobSubmissions, toJobSubmission(signalIndex, attempt, recovered));
              currentJob = await this.updateJob(job.id, {
                updatedAt: this.config.now(),
                submissions: jobSubmissions,
                clearLastError: true,
              });
              return recovered;
            }
            currentJob = await this.updateJob(job.id, {
              updatedAt: this.config.now(),
              lastSignalAttemptAt: this.config.now(),
              submissions: jobSubmissions,
              lastError: classified,
            });
            deferredResend = true;
            return { deferredBroadcast: true };
          }
          currentJob = await this.updateJob(job.id, {
            updatedAt: this.config.now(),
            lastSignalAttemptAt: this.config.now(),
            submissions: jobSubmissions,
            lastError: classified,
          });
          throw error;
        }
      },
    };
    let handlerResult: StateMachineHookReadyHandlerResult = undefined;
    for (let attemptForHandler = 1; attemptForHandler <= this.config.retry.maxAttempts; attemptForHandler += 1) {
      try {
        handlerResult = await resolved.handler(event, context);
        currentJob = await this.updateJob(job.id, {
          updatedAt: this.config.now(),
          submissions: jobSubmissions,
        });
        break;
      } catch (error) {
        const classified = classifyExecutorKitError(error, 'handler_failure');
        attempts += 1;
        currentJob = await this.updateJob(job.id, {
          updatedAt: this.config.now(),
          attempts,
          submissions: jobSubmissions,
          lastError: classified,
        });
        if (classified.retryable && attemptForHandler < this.config.retry.maxAttempts) {
          await delay(this.config.retry.baseDelayMs * attemptForHandler);
          continue;
        }
        const failed = await this.concludeRun(job.id, {
          status: statusForTerminalError(error, classified, jobSubmissions),
          updatedAt: this.config.now(),
          attempts,
          submissions: jobSubmissions,
          lastError: classified,
        });
        return {
          status: 'handled',
          event,
          matchedKey: resolved.key,
          submissions: [],
          job: failed,
          error: classified,
        };
      }
    }

    const submissions: SubmitStateMachineSignalResult[] = [];
    const eventPlanId = event.planId !== ZERO_BYTES32 ? event.planId : undefined;
    const fallbackPlanId = eventPlanId ?? job.planId;
    if (eventPlanId !== undefined && job.planId === undefined) {
      const withPlanId = await this.updateJob(job.id, {
        updatedAt: this.config.now(),
        planId: normalizeBytes32(eventPlanId, 'job.planId'),
      });
      if (withPlanId) {
        job = withPlanId;
      }
    }
    const resolvedSignals = normalizeHandlerResult(handlerResult).map((signal): StateMachineSignal => ({
      ...signal,
      ...(signal.planId === undefined && fallbackPlanId !== undefined ? { planId: fallbackPlanId } : {}),
    }));
    const deliveredRequestDatas = options?.resubmitDelivered
      ? new Set<string>()
      : deliveredRequestDatasFromSubmissions(currentJob.submissions);
    for (const submission of unresolvedBroadcasts(currentJob.submissions)) {
      let receiptStatus: 'success' | 'reverted' | undefined;
      try {
        receiptStatus = await this.lookupBroadcastReceipt(eventSubmitConfig, submission.txHash);
      } catch (error) {
        const classified = classifyExecutorKitError(error);
        attempts += 1;
        const failed = await this.concludeRun(job.id, {
          status: jobStatusForError(classified),
          updatedAt: this.config.now(),
          attempts,
          submissions: jobSubmissions,
          lastError: classified,
        });
        return {
          status: 'handled',
          event,
          matchedKey: resolved.key,
          submissions,
          job: failed,
          error: classified,
        };
      }
      if (receiptStatus === undefined) {
        continue;
      }
      appendJobSubmission(jobSubmissions, {
        signalIndex: submission.signalIndex,
        attempt: nextSubmissionAttempt(jobSubmissions, submission.signalIndex),
        dryRun: false,
        ...(submission.request ? { request: submission.request } : {}),
        txHash: submission.txHash,
        confirmed: receiptStatus === 'success',
      });
      if (submission.request) {
        submissions.push({
          dryRun: false,
          request: submission.request,
          txHash: submission.txHash,
          confirmed: receiptStatus === 'success',
        });
        deliveredRequestDatas.add(submission.request.data);
      }
      currentJob = await this.updateJob(job.id, {
        updatedAt: this.config.now(),
        submissions: jobSubmissions,
        clearLastError: true,
      });
    }
    const identityDatas: string[] = [];
    for (const [index, handlerSignal] of resolvedSignals.entries()) {
      let resolvedSignal = handlerSignal;
      let identityRequest: SubmitStateMachineSignalCall;
      try {
        resolvedSignal = withCapabilityProofs(handlerSignal, capabilityTables);
        identityRequest = buildSubmitStateMachineSignalCall(eventSubmitConfig, resolvedSignal);
      } catch (error) {
        const classified = error instanceof ClassifiedStateMachineError
          ? error.classified
          : classifyExecutorKitError(error);
        const failed = await this.concludeRun(job.id, {
          status: statusForTerminalError(error, classified, jobSubmissions),
          updatedAt: this.config.now(),
          attempts,
          submissions: jobSubmissions,
          lastError: classified,
        });
        return {
          status: 'handled',
          event,
          matchedKey: resolved.key,
          submissions,
          job: failed,
          error: classified,
        };
      }
      identityDatas.push(identityRequest.data);
      if (deliveredRequestDatas.has(identityRequest.data)) {
        continue;
      }
      try {
        const priorUnconfirmedBroadcasts = unresolvedBroadcasts(currentJob.submissions)
          .filter((submission) => submission.request?.data === identityRequest.data).length;
        if (priorUnconfirmedBroadcasts > 0 && options?.bypassResendBackoff !== true) {
          const requiredDelayMs = resendBackoffDelayMs(this.config.resendBackoff, priorUnconfirmedBroadcasts);
          const lastAttemptAtMs = Date.parse(currentJob.lastSignalAttemptAt ?? '');
          if (Number.isFinite(lastAttemptAtMs) && this.config.nowMs() - lastAttemptAtMs < requiredDelayMs) {
            deferredResend = true;
            continue;
          }
        }
        const result = await submitSignalWithJobRetry(resolvedSignal, index, identityRequest);
        if ('deferredBroadcast' in result) {
          deferredResend = true;
          continue;
        }
        submissions.push(result);
        if (!result.dryRun) {
          deliveredRequestDatas.add(identityRequest.data);
        }
      } catch (error) {
        const classified = error instanceof ClassifiedStateMachineError
          ? error.classified
          : classifyExecutorKitError(error);
        if (classified.kind === 'duplicate_signal') {
          deliveredRequestDatas.add(identityRequest.data);
          continue;
        }
        const failed = await this.concludeRun(job.id, {
          status: statusForTerminalError(error, classified, jobSubmissions),
          updatedAt: this.config.now(),
          attempts,
          submissions: jobSubmissions,
          lastError: classified,
        });
        return {
          status: 'handled',
          event,
          matchedKey: resolved.key,
          submissions,
          job: failed,
          error: classified,
        };
      }
    }

    const finalStatus = statusForCompletedRun({
      dryRun: this.config.dryRun,
      identityDatas,
      jobSubmissions,
    });
    if (deferredResend) {
      currentJob = await this.concludeRun(job.id, {
        status: finalStatus === 'matched' ? 'submitted' : finalStatus,
        updatedAt: currentJob.updatedAt,
        attempts,
        submissions: jobSubmissions,
      });
    } else {
      currentJob = await this.concludeRun(job.id, {
        status: finalStatus,
        updatedAt: this.config.now(),
        attempts,
        submissions: jobSubmissions,
        clearLastError: true,
        ...(this.config.dryRun && finalStatus === 'matched'
          ? { dryRunConcludedAt: this.config.now() }
          : {}),
      });
    }

    return {
      status: 'handled',
      event,
      matchedKey: resolved.key,
      submissions,
      job: currentJob,
    };
  }

  async start(): Promise<StateMachineWatchHandle> {
    const run = async (): Promise<void> => {
      const result = await this.pollOnce();
      this.config.onPoll?.(result);
    };
    await run();
    let running = false;
    let stopped = false;
    let consecutiveFailures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveStopped: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    const tick = (): void => {
      if (running || stopped) {
        return;
      }
      running = true;
      void run()
        .then(() => {
          consecutiveFailures = 0;
        })
        .catch((error: unknown) => {
          consecutiveFailures += 1;
          this.config.onError?.(error);
        })
        .finally(() => {
          running = false;
          if (!stopped) {
            const delayMs = consecutiveFailures > 0
              ? pollFailureDelayMs(this.config.pollIntervalMs, consecutiveFailures)
              : this.config.pollIntervalMs;
            timer = setTimeout(tick, delayMs);
          }
        });
    };
    tick();

    return {
      stop(): void {
        stopped = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        resolveStopped?.();
      },
      done,
    };
  }

  private async updateJob(jobId: Hex, patch: StateMachineJobPatch): Promise<StateMachineWatcherJob> {
    let guarded = patch;
    if ((patch.lastError !== undefined || patch.clearLastError === true) && await this.jobReachedTerminal(jobId)) {
      const { lastError: omittedError, clearLastError: omittedClear, ...rest } = patch;
      void omittedError;
      void omittedClear;
      guarded = rest;
    }
    const updated = await this.config.jobStore.update(jobId, withConclusiveClaimRelease(guarded));
    if (!updated) {
      throw new ValidationError(`job ${jobId} not found`);
    }
    return updated;
  }

  private async jobReachedTerminal(jobId: Hex): Promise<boolean> {
    const current = await this.config.jobStore.get(jobId);
    return current !== undefined && isTerminalJobStatus(current.status);
  }

  private async concludeRun(jobId: Hex, patch: StateMachineJobPatch): Promise<StateMachineWatcherJob> {
    const concluded = await this.config.jobStore.update(jobId, {
      ...withConclusiveClaimRelease(patch),
      expectStatus: 'matched',
    });
    if (concluded) {
      return concluded;
    }
    const current = await this.config.jobStore.get(jobId);
    if (!current) {
      throw new ValidationError(`job ${jobId} not found`);
    }
    return current;
  }

  private async recordIgnoredVerdict(
    job: StateMachineWatcherJob,
    lastError: ClassifiedExecutorKitError,
  ): Promise<{ readonly written: boolean; readonly job: StateMachineWatcherJob }> {
    if (isHeldRunClaim(job.claim)) {
      return { written: false, job };
    }
    const ignored = await this.config.jobStore.update(job.id, withConclusiveClaimRelease({
      status: 'ignored',
      updatedAt: this.config.now(),
      lastError,
      expectStatus: job.status,
      expectClaimPid: job.claim?.pid ?? null,
    }));
    if (ignored) {
      return { written: true, job: ignored };
    }
    const current = await this.config.jobStore.get(job.id);
    if (!current) {
      throw new ValidationError(`job ${job.id} not found`);
    }
    return { written: false, job: current };
  }

  private ignoredVerdictResult(
    event: StateMachineHookReady,
    verdict: { readonly written: boolean; readonly job: StateMachineWatcherJob },
    error: ClassifiedExecutorKitError,
  ): StateMachineLogProcessResult {
    if (verdict.written) {
      return {
        status: 'ignored',
        event,
        submissions: [],
        job: verdict.job,
        error,
      };
    }
    return {
      status: isTerminalJobStatus(verdict.job.status) ? 'ignored' : 'skipped',
      event,
      submissions: [],
      job: verdict.job,
    };
  }

  private async claimForRun(
    job: StateMachineWatcherJob,
    matchedKey: string,
  ): Promise<
    | { readonly outcome: 'claimed'; readonly job: StateMachineWatcherJob }
    | { readonly outcome: 'busy' | 'terminal' | 'lost'; readonly job?: StateMachineWatcherJob }
  > {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fresh = await this.config.jobStore.get(job.id);
      if (!fresh) {
        return { outcome: 'lost' };
      }
      if (isTerminalJobStatus(fresh.status)) {
        return { outcome: 'terminal', job: fresh };
      }
      if (isHeldRunClaim(fresh.claim)) {
        return { outcome: 'busy', job: fresh };
      }
      const at = this.config.now();
      const claimed = await this.config.jobStore.update(job.id, {
        status: 'matched',
        updatedAt: at,
        matchedKey,
        claim: { pid: process.pid, at },
        dryRunConcludedAt: null,
        expectStatus: fresh.status,
        expectClaimPid: fresh.claim?.pid ?? null,
      });
      if (claimed) {
        return { outcome: 'claimed', job: claimed };
      }
    }
    return { outcome: 'lost' };
  }

  private async releaseRunClaim(jobId: Hex): Promise<void> {
    try {
      await this.config.jobStore.update(jobId, {
        updatedAt: this.config.now(),
        claim: null,
        expectClaimPid: process.pid,
      });
    } catch (error) {
      this.pendingClaimReleases.add(jobId);
      this.config.onError?.(new ExecutorKitError(
        `failed to release the run claim for job ${jobId} (${describeError(error)});`
          + ` the job stays claimed by pid ${process.pid} and is excluded from scans and manual retries until the release succeeds; the release is retried every poll round`,
      ));
    }
  }

  private async retryPendingClaimReleases(): Promise<void> {
    if (this.pendingClaimReleases.size === 0) {
      return;
    }
    for (const jobId of [...this.pendingClaimReleases]) {
      try {
        await this.config.jobStore.update(jobId, {
          updatedAt: this.config.now(),
          claim: null,
          expectClaimPid: process.pid,
        });
        this.pendingClaimReleases.delete(jobId);
      } catch (error) {
        this.config.onError?.(new ExecutorKitError(
          `releasing the run claim for job ${jobId} failed again (${describeError(error)});`
            + ` the job remains claimed by pid ${process.pid} and excluded from scans and manual retries`,
        ));
      }
    }
  }

  private async lookupBroadcastReceipt(
    config: NormalizedSubmitConfig,
    txHash: Hex,
  ): Promise<'success' | 'reverted' | undefined> {
    const client = getPublicClient(config);
    if (!client.getTransactionReceipt) {
      return undefined;
    }
    let receipt: { readonly status?: 'success' | 'reverted' | string } | null | undefined;
    try {
      receipt = await client.getTransactionReceipt({ hash: txHash });
    } catch {
      return undefined;
    }
    if (!receipt) {
      return undefined;
    }
    if (receipt.status === 'reverted') {
      throw new SubmitSignalReceiptError(txHash, `submitSignal transaction receipt status ${receipt.status}`, { reverted: true });
    }
    return receipt.status === 'success' ? 'success' : undefined;
  }

  private async recoverBroadcastSubmission(
    config: NormalizedSubmitConfig,
    signal: StateMachineSignal,
    txHash: Hex,
  ): Promise<SubmitStateMachineSignalResult | undefined> {
    const receiptStatus = await this.lookupBroadcastReceipt(config, txHash);
    if (receiptStatus === undefined) {
      return undefined;
    }
    return {
      dryRun: false,
      request: buildSubmitStateMachineSignalCall(config, signal, config.walletAddress),
      txHash,
      confirmed: receiptStatus === 'success',
    };
  }

  private cursorContext(): StateMachineCursorContext {
    return {
      chainId: this.config.chainId,
      stateMachines: this.config.stateMachines
        .map((deployment) => deployment.stateMachineAddress.toLowerCase())
        .sort(),
      ...(this.genesisHash ? { genesisHash: this.genesisHash } : {}),
    };
  }

  private async enforceCursorContinuity(
    client: StateMachinePublicClient,
    fromBlock: bigint,
  ): Promise<bigint> {
    if (!client.getBlock || this.cursorBlockHash === undefined || fromBlock <= 0n) {
      return fromBlock;
    }
    const cursorHeight = fromBlock - 1n;
    const canonicalHash = await tryGetBlockHash(client, cursorHeight);
    if (canonicalHash === undefined || sameBlockHash(canonicalHash, this.cursorBlockHash)) {
      return fromBlock;
    }

    const candidates = this.checkpoints
      .filter((checkpoint) => checkpoint.blockNumber < fromBlock)
      .sort((left, right) => (left.blockNumber > right.blockNumber ? -1 : left.blockNumber < right.blockNumber ? 1 : 0));
    for (const candidate of candidates) {
      const ancestorHash = await tryGetBlockHash(client, candidate.blockNumber);
      if (ancestorHash !== undefined && sameBlockHash(ancestorHash, candidate.blockHash)) {
        this.config.onError?.(new ExecutorKitError(
          `chain reorg detected at height ${cursorHeight} (stored ${this.cursorBlockHash}, canonical ${canonicalHash});`
          + ` rolling the scan cursor back to the common ancestor at block ${candidate.blockNumber} and rescanning from ${candidate.blockNumber + 1n}`,
        ));
        this.checkpoints = this.checkpoints.filter((checkpoint) => checkpoint.blockNumber <= candidate.blockNumber);
        this.cursorBlockHash = candidate.blockHash;
        return candidate.blockNumber + 1n;
      }
    }

    const rescanFloor = this.config.fromBlock ?? 0n;
    this.config.onError?.(new ExecutorKitError(
      `chain reorg at height ${cursorHeight} deeper than the ${this.config.reorgWindow}-block checkpoint window;`
      + ` rescanning from block ${rescanFloor} instead of trusting the diverged cursor`,
    ));
    this.checkpoints = [];
    this.cursorBlockHash = undefined;
    return rescanFloor;
  }

  private async revisitOpenJobs(
    fromBlock: bigint,
    scannedEventIds: ReadonlySet<Hex>,
  ): Promise<readonly StateMachineLogProcessResult[]> {
    const jobs = await this.config.jobStore.list();
    this.trackHeldForeignClaims(jobs);
    const watched = new Set(this.config.stateMachines.map((deployment) => normalizeAddress(deployment.stateMachineAddress, 'stateMachines[].stateMachineAddress')));
    const open = jobs.filter((job) => {
      const strandedMatched = job.status === 'matched' && !isHeldRunClaim(job.claim);
      if (job.status !== 'detected' && job.status !== 'submitted' && !strandedMatched) {
        return false;
      }
      if (!job.raw) {
        return false;
      }
      if (job.raw.blockNumber !== undefined && job.raw.blockNumber !== null && job.raw.blockNumber >= fromBlock) {
        return false;
      }
      if (scannedEventIds.has(job.eventId)) {
        return false;
      }
      if (job.stateMachineAddress && !watched.has(normalizeAddress(job.stateMachineAddress, 'job.stateMachineAddress'))) {
        return false;
      }
      return true;
    });
    const results: StateMachineLogProcessResult[] = [];
    for (const job of open) {
      const raw = job.raw;
      if (raw) {
        results.push(await this.handleLog(raw));
      }
    }
    return results;
  }

  private trackHeldForeignClaims(jobs: readonly StateMachineWatcherJob[]): void {
    for (const job of jobs) {
      const claim = job.claim;
      if (claim === undefined || claim.pid === process.pid || !isHeldRunClaim(claim)) {
        this.heldForeignClaimRounds.delete(job.id);
        this.alertedHeldForeignClaims.delete(job.id);
        continue;
      }
      const rounds = (this.heldForeignClaimRounds.get(job.id) ?? 0) + 1;
      this.heldForeignClaimRounds.set(job.id, rounds);
      if (rounds >= HELD_FOREIGN_CLAIM_ALERT_ROUNDS && !this.alertedHeldForeignClaims.has(job.id)) {
        this.alertedHeldForeignClaims.add(job.id);
        this.config.onError?.(new ExecutorKitError(
          `job ${job.id} has stayed claimed by pid ${claim.pid} (claimed at ${claim.at}) for ${rounds} consecutive poll rounds;`
            + ' pid liveness cannot tell a live executor from a crashed one whose pid the OS reused,'
            + ' and such a claim blocks later scans, manual retries, and dead-lettering;'
            + ' verify the pid on this host and, when it is not the executor, unlock the job with'
            + ` deadLetterStateMachineJob(store, '${job.id}', { operator, reason, force: true })`,
        ));
      }
    }
  }

  private async isolateUndecodableLog(log: StateMachineRawLog, error: unknown): Promise<StateMachineLogProcessResult> {
    const classified = classifyExecutorKitError(error, 'validation_failure');
    this.decodeFailuresTotal += 1;
    this.config.onError?.(error instanceof Error ? error : new Error(classified.message));

    const eventId = tryHookReadyEventId(log);
    if (!eventId) {
      return {
        status: 'ignored',
        submissions: [],
        error: classified,
        decodeFailure: true,
      };
    }

    const now = this.config.now();
    const stateMachineAddress = tryNormalizeStateMachineAddress(log.address);
    const event: StateMachineHookReady = {
      type: 'HookReady',
      eventId,
      ...(stateMachineAddress ? { stateMachineAddress } : {}),
      planId: ZERO_BYTES32,
      orderId: ZERO_BYTES32,
      hookId: ZERO_BYTES32,
      stageId: ZERO_BYTES32,
      hookNameId: ZERO_BYTES32,
      ...(log.blockNumber !== undefined && log.blockNumber !== null ? { blockNumber: BigInt(log.blockNumber) } : {}),
      ...(log.transactionHash ? { transactionHash: log.transactionHash } : {}),
      ...(log.logIndex !== undefined && log.logIndex !== null ? { logIndex: BigInt(log.logIndex) } : {}),
      raw: log,
    };
    const job = await this.config.jobStore.upsertDetected(event, {
      now,
      maxAttempts: this.config.retry.maxAttempts,
      ...(this.config.supplierId ? { supplierId: this.config.supplierId } : {}),
    });
    const verdict = await this.recordIgnoredVerdict(job, classified);
    if (verdict.written) {
      return {
        status: 'ignored',
        submissions: [],
        job: verdict.job,
        error: classified,
        decodeFailure: true,
      };
    }
    return {
      status: isTerminalJobStatus(verdict.job.status) ? 'ignored' : 'skipped',
      submissions: [],
      job: verdict.job,
      decodeFailure: true,
    };
  }
}

export function createStateMachineWatcher(config: StateMachineWatcherConfig): StateMachineWatcher {
  return new StateMachineWatcher(config);
}

export interface NormalizedStateMachineWatcherConfig extends NormalizedSubmitConfig {
  readonly supplierId?: string;
  readonly stateMachines: readonly NormalizedStateMachineDeploymentWatcherConfig[];
  readonly handlers: Readonly<Record<string, StateMachineHookReadyHandler>>;
  readonly artifact?: StateMachineArtifactIndex;
  readonly fromBlock?: bigint;
  readonly pollIntervalMs: number;
  readonly confirmations: number;
  readonly runtimeEnvironment?: StateMachineRuntimeEnvironment;
  readonly reorgWindow: number;
  readonly getLogsBlockSpan: number;
  readonly retry: NormalizedStateMachineRetryConfig;
  readonly resendBackoff: NormalizedStateMachineResendBackoffConfig;
  readonly nowMs: () => number;
  readonly jobStore: StateMachineJobStore;
  readonly cursorStore?: StateMachineCursorStore;
  readonly now: () => string;
  readonly onPoll?: (result: StateMachinePollResult) => void;
  readonly onError?: (error: unknown) => void;
}

interface NormalizedStateMachineDeploymentWatcherConfig {
  readonly stateMachineAddress: Address;
  readonly deploymentId?: Hex;
  readonly status?: 'active' | 'deprecated' | 'canary' | 'candidate' | 'retired';
}

function normalizeStateMachineWatcherConfig(config: StateMachineWatcherConfig): NormalizedStateMachineWatcherConfig {
  const stateMachines = normalizeStateMachineDeployments(config);
  const defaultStateMachineAddress = config.stateMachineAddress ?? stateMachines[0]?.stateMachineAddress;
  if (!defaultStateMachineAddress) {
    throw new ValidationError('state machine watcher requires stateMachineAddress or stateMachines[]');
  }
  const runtimeEnvironment = normalizeRuntimeEnvironment(config.runtimeEnvironment);
  const confirmations = config.confirmations !== undefined
    ? parseNonNegativeSafeInteger(asNumberOrString(config.confirmations, 'confirmations'), 'confirmations')
    : undefined;
  if (runtimeEnvironment !== undefined && runtimeEnvironment !== 'local') {
    if (confirmations === undefined) {
      throw new ValidationError(
        `confirmations must be explicitly configured when runtimeEnvironment is ${runtimeEnvironment}:`
          + ` the default ${DEFAULT_FINALITY_CONFIRMATIONS}-block finality buffer lets a single-block reorg flip already-processed logs past the scan cursor`
          + ' (same caliber as chain-services UVP_FINALITY_CONFIRMATIONS)',
      );
    }
    if (confirmations === 0) {
      throw new ValidationError(
        `confirmations must be a positive integer when runtimeEnvironment is ${runtimeEnvironment};`
          + ' 0 (tip scanning) is only for local throwaway chains',
      );
    }
  }
  const normalized = normalizeSubmitConfig({
    ...config,
    stateMachineAddress: defaultStateMachineAddress,
  });
  return {
    ...normalized,
    ...(config.supplierId ? { supplierId: asNonEmptyString(config.supplierId, 'supplierId') } : {}),
    stateMachines,
    handlers: config.handlers,
    ...(config.artifact ? { artifact: normalizeArtifactIndex(config.artifact) } : {}),
    ...(config.fromBlock !== undefined ? { fromBlock: parseBigNumberish(config.fromBlock, 'fromBlock') } : {}),
    ...(runtimeEnvironment ? { runtimeEnvironment } : {}),
    pollIntervalMs: config.pollIntervalMs !== undefined
      ? parsePositiveInteger(config.pollIntervalMs, 'pollIntervalMs')
      : DEFAULT_STATE_MACHINE_POLL_INTERVAL_MS,
    confirmations: confirmations ?? DEFAULT_FINALITY_CONFIRMATIONS,
    reorgWindow: config.reorgWindow !== undefined
      ? parsePositiveInteger(asNumberOrString(config.reorgWindow, 'reorgWindow'), 'reorgWindow')
      : DEFAULT_REORG_WINDOW_BLOCKS,
    getLogsBlockSpan: config.getLogsBlockSpan !== undefined
      ? parsePositiveInteger(asNumberOrString(config.getLogsBlockSpan, 'getLogsBlockSpan'), 'getLogsBlockSpan')
      : DEFAULT_GET_LOGS_BLOCK_SPAN,
    retry: normalizeRetryConfig(config.retry),
    resendBackoff: {
      baseDelayMs: config.resendBackoff?.baseDelayMs !== undefined
        ? parseNonNegativeSafeInteger(asNumberOrString(config.resendBackoff.baseDelayMs, 'resendBackoff.baseDelayMs'), 'resendBackoff.baseDelayMs')
        : DEFAULT_RESEND_BACKOFF_BASE_DELAY_MS,
      maxDelayMs: config.resendBackoff?.maxDelayMs !== undefined
        ? parseNonNegativeSafeInteger(asNumberOrString(config.resendBackoff.maxDelayMs, 'resendBackoff.maxDelayMs'), 'resendBackoff.maxDelayMs')
        : DEFAULT_RESEND_BACKOFF_MAX_DELAY_MS,
    },
    nowMs: config.nowMs ?? (() => Date.now()),
    jobStore: config.jobStore ?? new InMemoryStateMachineJobStore(),
    ...(config.cursorStore ? { cursorStore: config.cursorStore } : {}),
    now: config.now ?? (() => new Date().toISOString()),
    ...(config.onPoll ? { onPoll: config.onPoll } : {}),
    ...(config.onError ? { onError: config.onError } : {}),
  };
}

function normalizeStateMachineDeployments(
  config: Pick<StateMachineWatcherConfig, 'stateMachineAddress' | 'stateMachines'>,
): readonly NormalizedStateMachineDeploymentWatcherConfig[] {
  const rawDeployments = config.stateMachines?.length
    ? config.stateMachines
    : config.stateMachineAddress
      ? [{ stateMachineAddress: config.stateMachineAddress }]
      : [];
  if (rawDeployments.length === 0) {
    throw new ValidationError('state machine watcher requires stateMachineAddress or stateMachines[]');
  }
  const seen = new Set<string>();
  const deployments: NormalizedStateMachineDeploymentWatcherConfig[] = [];
  for (const [index, deployment] of rawDeployments.entries()) {
    const normalized = normalizeStateMachineDeploymentConfig(deployment, `stateMachines[${index}]`);
    if (normalized.status === 'retired') {
      continue;
    }
    const key = normalizeAddress(normalized.stateMachineAddress, 'stateMachines.stateMachineAddress');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deployments.push(normalized);
  }
  if (deployments.length === 0) {
    throw new ValidationError('state machine watcher requires at least one non-retired state machine deployment');
  }
  return deployments;
}

export function normalizeStateMachineDeploymentConfig(
  deployment: StateMachineDeploymentWatcherConfig,
  path = 'stateMachine',
): NormalizedStateMachineDeploymentWatcherConfig {
  const status = deployment.status;
  if (status && !['active', 'deprecated', 'canary', 'candidate', 'retired'].includes(status)) {
    throw new ValidationError(`${path}.status must be active, deprecated, canary, candidate, or retired`);
  }
  return {
    stateMachineAddress: normalizeAddressChecksummed(deployment.stateMachineAddress, `${path}.stateMachineAddress`),
    ...(deployment.deploymentId ? { deploymentId: normalizeBytes32(deployment.deploymentId, `${path}.deploymentId`) } : {}),
    ...(status ? { status } : {}),
  };
}

function scannedHookReadyEventIds(logs: readonly StateMachineRawLog[]): Set<Hex> {
  const eventIds = new Set<Hex>();
  for (const log of logs) {
    if (log.topics[0] !== HOOK_READY_TOPIC) {
      continue;
    }
    const eventId = tryHookReadyEventId(log);
    if (eventId !== undefined) {
      eventIds.add(eventId);
    }
  }
  return eventIds;
}

function pollFailureDelayMs(pollIntervalMs: number, consecutiveFailures: number): number {
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 3);
  return pollIntervalMs * Math.min(2 ** exponent, POLL_FAILURE_BACKOFF_MULTIPLIER_CAP);
}

function normalizeRuntimeEnvironment(value: StateMachineRuntimeEnvironment | undefined): StateMachineRuntimeEnvironment | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'local' || value === 'testnet' || value === 'staging' || value === 'production') {
    return value;
  }
  throw new ValidationError(`runtimeEnvironment must be local, testnet, staging, or production (got ${String(value)})`);
}
