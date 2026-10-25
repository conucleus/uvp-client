import { dirname, join, resolve } from 'node:path';
import {
  normalizeAddressChecksummed,
  parsePositiveInteger,
  ValidationError,
} from '../validation.js';
import { stringifyForTransport } from '../transport.js';
import {
  FileStateMachineCursorStore,
  FileStateMachineJobStore,
  acquireWatcherStateDirLock,
  createStateMachineHandlersFromConfig,
  createStateMachineWatcher,
  loadStateMachineHandlerConfig,
  type StateMachineCursorStore,
  type StateMachineJobStore,
  type StateMachineRuntimeEnvironment,
  type WatcherStateDirLock,
} from '../watcher/index.js';
import { parseNonNegativeIntegerOption, type ChainWatchOptions } from './options.js';

export const DEFAULT_WATCHER_STATE_DIR = './uvp-watcher-state';
export const WATCHER_STATE_DIR_ENV = 'UVP_WATCHER_STATE_DIR';
export const EXECUTOR_RUNTIME_ENV = 'UVP_EXECUTOR_RUNTIME_ENV';

export function resolveRuntimeEnvironment(
  flagValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): StateMachineRuntimeEnvironment | undefined {
  const raw = (flagValue ?? env[EXECUTOR_RUNTIME_ENV])?.trim().toLowerCase();
  if (!raw) {
    return undefined;
  }
  if (raw === 'local' || raw === 'testnet' || raw === 'staging' || raw === 'production') {
    return raw;
  }
  throw new ValidationError(`--runtime-env / ${EXECUTOR_RUNTIME_ENV} must be local, testnet, staging, or production (got ${raw})`);
}

export type WatcherStorageSummary =
  | { readonly mode: 'memory' }
  | {
    readonly mode: 'file';
    readonly stateDir: string;
    readonly jobsFile: string;
    readonly cursorFile: string;
  };

export interface WatcherStorageResolution {
  readonly summary: WatcherStorageSummary;
  readonly jobStore?: StateMachineJobStore;
  readonly cursorStore?: StateMachineCursorStore;
}

export function resolveWatcherStorage(
  options: Pick<ChainWatchOptions, 'jobStore' | 'stateDir' | 'jobsFile'>,
  env: NodeJS.ProcessEnv = process.env,
): WatcherStorageResolution {
  const mode = options.jobStore ?? 'file';
  if (mode !== 'file' && mode !== 'memory') {
    throw new ValidationError(`--job-store must be "file" or "memory", got ${mode}`);
  }
  if (mode === 'memory') {
    return { summary: { mode: 'memory' } };
  }

  const stateDir = options.jobsFile
    ? dirname(resolve(options.jobsFile))
    : resolve(options.stateDir ?? env[WATCHER_STATE_DIR_ENV] ?? DEFAULT_WATCHER_STATE_DIR);
  const jobsFile = options.jobsFile ? resolve(options.jobsFile) : join(stateDir, 'jobs.json');
  const cursorFile = join(stateDir, 'cursor.json');
  return {
    summary: {
      mode: 'file',
      stateDir,
      jobsFile,
      cursorFile,
    },
    jobStore: new FileStateMachineJobStore(jobsFile),
    cursorStore: new FileStateMachineCursorStore(cursorFile),
  };
}

export async function buildStateMachineWatcherFromCli(
  options: ChainWatchOptions,
  builderOptions: {
    readonly holdStateDirLock?: boolean;
  } = {},
): Promise<{
  watcher: ReturnType<typeof createStateMachineWatcher>;
  storage: WatcherStorageSummary;
  stateLock?: WatcherStateDirLock | undefined;
}> {
  const config = await loadStateMachineHandlerConfig(options.config);
  const configuredStateMachines = config.stateMachines ?? [];
  if (options.stateMachine && configuredStateMachines.length > 0) {
    throw new ValidationError(
      `--state-machine ${options.stateMachine} conflicts with stateMachines[] in ${options.config}`
      + ' (the flag would be silently ignored by the scan set); configure the scanned state machines in exactly one place',
    );
  }
  const stateMachineAddress = options.stateMachine
    ? normalizeAddressChecksummed(options.stateMachine, 'stateMachine')
    : config.stateMachineAddress ?? configuredStateMachines[0]?.stateMachineAddress;
  if (!stateMachineAddress) {
    throw new ValidationError('missing state machine address: pass --state-machine or set stateMachines[] in config');
  }
  const storage = resolveWatcherStorage(options);
  const runtimeEnvironment = resolveRuntimeEnvironment(options.runtimeEnv);
  const stateLock = storage.summary.mode === 'file' && builderOptions.holdStateDirLock !== false
    ? await acquireWatcherStateDirLock(storage.summary.stateDir)
    : undefined;
  try {
    const effectiveDryRun = options.dryRun ?? config.dryRun ?? false;
    if (options.dryRun === undefined && config.dryRun === true) {
      console.error(
        `warning: dryRun:true in ${options.config} is active; nothing is broadcast until it is removed or --dry-run is passed explicitly`,
      );
    }
    const watcher = createStateMachineWatcher({
      rpcUrl: options.rpcUrl,
      stateMachineAddress,
      stateMachines: configuredStateMachines.length > 0
        ? configuredStateMachines
        : [{ stateMachineAddress }],
      chainId: parsePositiveInteger(options.chainId, 'chainId'),
      ...(config.supplierId ?? config.executorId ? { supplierId: config.supplierId ?? config.executorId } : {}),
      ...(options.walletAddress ? { walletAddress: normalizeAddressChecksummed(options.walletAddress, 'walletAddress') } : config.walletAddress ? { walletAddress: config.walletAddress } : {}),
      privateKeyEnv: options.privateKeyEnv,
      handlers: createStateMachineHandlersFromConfig(config),
      ...(config.artifact ? { artifact: config.artifact } : {}),
      ...(config.retry ? { retry: config.retry } : {}),
      ...(storage.jobStore ? { jobStore: storage.jobStore } : {}),
      ...(storage.cursorStore ? { cursorStore: storage.cursorStore } : {}),
      dryRun: effectiveDryRun,
      ...(options.waitForReceipt !== undefined ? { waitForReceipt: options.waitForReceipt } : {}),
      ...(options.fromBlock ? { fromBlock: options.fromBlock } : {}),
      ...(options.pollIntervalMs ? { pollIntervalMs: parsePositiveInteger(options.pollIntervalMs, 'pollIntervalMs') } : {}),
      ...(options.confirmations !== undefined ? { confirmations: parseNonNegativeIntegerOption(options.confirmations, 'confirmations') } : {}),
      ...(runtimeEnvironment ? { runtimeEnvironment } : {}),
      ...(options.reorgWindow !== undefined ? { reorgWindow: parsePositiveInteger(options.reorgWindow, 'reorgWindow') } : {}),
      ...(options.maxGetLogsBlockSpan !== undefined ? { getLogsBlockSpan: parsePositiveInteger(options.maxGetLogsBlockSpan, 'maxGetLogsBlockSpan') } : {}),
      onPoll: (poll) => {
        console.log(stringifyForTransport({ poll }));
      },
      onError: (error) => {
        console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      },
    });
    return { watcher, storage: storage.summary, stateLock };
  } catch (error) {
    await stateLock?.release();
    throw error;
  }
}
