import type { Command } from 'commander';
import type {
  StageFile,
  SignalAttributionPayload,
} from '@uvp-eth/protocol-bindings';
import { readFile } from 'node:fs/promises';
import { parsePositiveInteger, ValidationError } from '../../core/validation.js';
import {
  DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV,
  submitStateMachineSignal,
  type StateMachinePollResult,
  type StateMachineSignal,
} from '../../headless/watcher/index.js';
import { chainPollExecutionFailed, stringifyForCli } from '../output.js';
import { redactRpcUrlsInText } from '../../core/redact.js';
import {
  waitForShutdown,
  type ChainSignalOptions,
  type ChainWatchOptions,
} from '../options.js';
import {
  buildStateMachineWatcher,
  DEFAULT_WATCHER_STATE_DIR,
  EXECUTOR_RUNTIME_ENV,
  WATCHER_STATE_DIR_ENV,
} from '../../headless/runtime.js';

/** chain-once / chain-watch / chain-signal 命令分发。 */
export function registerChainCommands(program: Command): void {
  program
    .command('chain-once')
    .description('scan UVPStateMachine HookReady logs once and submit callback txs')
    .requiredOption('--rpc-url <url>', 'EVM RPC URL')
    .option('--state-machine <address>', 'UVPStateMachine contract address; optional when config stateMachines[] is set')
    .requiredOption('--chain-id <id>', 'expected chain id')
    .requiredOption('--config <path>', 'state machine handler config JSON path')
    .option('--wallet-address <address>', 'executor wallet address shown as submitSignal sender in dry-run')
    .option('--private-key-env <name>', 'environment variable containing the callback tx private key', DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV)
    .option('--from-block <uint>', 'first block to scan; on restart a persisted scan cursor takes precedence')
    .option('--confirmations <n>', 'finality buffer in blocks: scan only up to head - n (0 restores tip scanning); defaults to 1 only for local/undeclared runtime envs and must be passed explicitly for non-local ones')
    .option('--runtime-env <env>', `declared runtime environment (local, testnet, staging, production); non-local values make an explicit --confirmations mandatory (default: $${EXECUTOR_RUNTIME_ENV} or local caliber)`)
    .option('--reorg-window <blocks>', 'bounded reorg checkpoint window for the common-ancestor rollback', '64')
    .option('--max-get-logs-block-span <blocks>', 'max blocks per eth_getLogs request; deeper ranges are chunked', '9999')
    .option('--jobs-file <path>', 'watcher jobs JSON file (default: <state-dir>/jobs.json)')
    .option('--state-dir <path>', `watcher state directory holding jobs.json and cursor.json (default: $${WATCHER_STATE_DIR_ENV} or ${DEFAULT_WATCHER_STATE_DIR})`)
    .option('--job-store <file|memory>', 'watcher state store: file persists jobs and scan cursor across restarts, memory keeps them in-process', 'file')
    .option('--dry-run', 'build submitSignal tx requests without broadcasting')
    .option('--wait-for-receipt', 'wait for tx receipt after broadcasting')
    .action(async (options: ChainWatchOptions) => {
      const { watcher, storage, stateLock } = await buildStateMachineWatcher(options, watchCallbacks());
      try {
        const poll = await watcher.pollOnce();
        console.log(stringifyForCli({ watcher: watcher.describe(), storage, poll }));
        if (chainPollExecutionFailed(poll)) {
          process.exitCode = 1;
        }
      } finally {
        await stateLock?.release();
      }
    });

  program
    .command('chain-watch')
    .description('poll UVPStateMachine HookReady logs and submit callback txs')
    .requiredOption('--rpc-url <url>', 'EVM RPC URL')
    .option('--state-machine <address>', 'UVPStateMachine contract address; optional when config stateMachines[] is set')
    .requiredOption('--chain-id <id>', 'expected chain id')
    .requiredOption('--config <path>', 'state machine handler config JSON path')
    .option('--wallet-address <address>', 'executor wallet address shown as submitSignal sender in dry-run')
    .option('--private-key-env <name>', 'environment variable containing the callback tx private key', DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV)
    .option('--from-block <uint>', 'first block to scan; on restart a persisted scan cursor takes precedence')
    .option('--poll-interval-ms <ms>', 'polling interval in milliseconds')
    .option('--confirmations <n>', 'finality buffer in blocks: scan only up to head - n (0 restores tip scanning); defaults to 1 only for local/undeclared runtime envs and must be passed explicitly for non-local ones')
    .option('--runtime-env <env>', `declared runtime environment (local, testnet, staging, production); non-local values make an explicit --confirmations mandatory (default: $${EXECUTOR_RUNTIME_ENV} or local caliber)`)
    .option('--reorg-window <blocks>', 'bounded reorg checkpoint window for the common-ancestor rollback', '64')
    .option('--max-get-logs-block-span <blocks>', 'max blocks per eth_getLogs request; deeper ranges are chunked', '9999')
    .option('--jobs-file <path>', 'watcher jobs JSON file (default: <state-dir>/jobs.json)')
    .option('--state-dir <path>', `watcher state directory holding jobs.json and cursor.json (default: $${WATCHER_STATE_DIR_ENV} or ${DEFAULT_WATCHER_STATE_DIR})`)
    .option('--job-store <file|memory>', 'watcher state store: file persists jobs and scan cursor across restarts, memory keeps them in-process', 'file')
    .option('--dry-run', 'build submitSignal tx requests without broadcasting')
    .option('--wait-for-receipt', 'wait for tx receipt after broadcasting')
    .action(async (options: ChainWatchOptions) => {
      const { watcher, storage, stateLock } = await buildStateMachineWatcher(options, watchCallbacks());
      try {
        console.log(stringifyForCli({ watcher: watcher.describe(), storage }));
        const handle = await watcher.start();
        try {
          await Promise.race([
            handle.done,
            waitForShutdown(async () => {
              await handle.stop();
            }),
          ]);
        } finally {
          await handle.stop();
        }
      } finally {
        await stateLock?.release();
      }
    });

  program
    .command('chain-signal')
    .description('build and optionally submit one direct UVPStateMachine submitSignal tx (empty signature)')
    .requiredOption('--rpc-url <url>', 'EVM RPC URL')
    .requiredOption('--state-machine <address>', 'UVPStateMachine contract address')
    .requiredOption('--chain-id <id>', 'expected chain id')
    .option('--wallet-address <address>', 'submitting wallet address shown as submitSignal sender in dry-run')
    .requiredOption('--plan-id <bytes32>', 'plan id')
    .option('--order-id <bytes32>', 'order id; omitted or zero = trigger creation (the state machine generates the order id)')
    .option('--source <source>', 'signal source (required for a non-trigger order signal)')
    .option('--stage <stageIdentifier>', 'stage identifier (with --signal-name)')
    .option('--signal-name <signalName>', 'signal name; signalId is derived from stageIdentifier.signalName')
    .option('--signal-id <bytes32>', 'explicit signal id; zero marks a pure file patch')
    .option('--payload-hash <bytes32>', 'off-chain payload hash')
    .option('--idempotency-key <key>', 'idempotency key; required for trigger creation')
    .option('--attribution <json>', 'fact attribution JSON (sourceId, signalId, stageId, capabilityProof)')
    .option('--target-stage-id <bytes32>', 'stage whose file map receives the files')
    .option('--files <json>', 'stage files JSON array of { key, payload }')
    .option('--deadline-seconds <n>', 'seconds from now for the submission deadline', '3600')
    .option('--private-key-env <name>', 'environment variable containing the callback tx private key', DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV)
    .option('--dry-run', 'build the submitSignal tx request without broadcasting')
    .option('--wait-for-receipt', 'wait for tx receipt after broadcasting')
    .action(async (options: ChainSignalOptions) => {
      const signal = await signalFromOptions(options);
      const result = await submitStateMachineSignal({
        rpcUrl: options.rpcUrl,
        stateMachineAddress: options.stateMachine,
        chainId: parsePositiveInteger(options.chainId, 'chainId'),
        ...(options.walletAddress ? { walletAddress: options.walletAddress } : {}),
        privateKeyEnv: options.privateKeyEnv,
        dryRun: options.dryRun ?? false,
        ...(options.deadlineSeconds !== undefined ? { deadlineSeconds: options.deadlineSeconds } : {}),
        ...(options.waitForReceipt !== undefined ? { waitForReceipt: options.waitForReceipt } : {}),
      }, signal);
      console.log(stringifyForCli({ stateMachineSignal: result }));
    });
}

async function signalFromOptions(options: ChainSignalOptions): Promise<StateMachineSignal> {
  if ((options.signalName === undefined) === (options.signalId === undefined)) {
    throw new ValidationError('pass exactly one of --signal-name or --signal-id');
  }
  if (options.signalName !== undefined && (options.stage === undefined || options.stage.trim().length === 0)) {
    throw new ValidationError('--stage is required with --signal-name');
  }
  return {
    planId: options.planId,
    ...(options.orderId !== undefined && options.orderId.trim().length > 0 ? { orderId: options.orderId } : {}),
    ...(options.source !== undefined ? { source: options.source } : {}),
    ...(options.stage !== undefined ? { stageIdentifier: options.stage } : {}),
    ...(options.signalName !== undefined ? { signalName: options.signalName } : {}),
    ...(options.signalId !== undefined ? { signalId: options.signalId } : {}),
    ...(options.payloadHash !== undefined ? { payloadHash: options.payloadHash } : {}),
    ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    ...(options.attribution !== undefined
      ? { attribution: await readJson<SignalAttributionPayload>(options.attribution, 'attribution') }
      : {}),
    ...(options.targetStageId !== undefined ? { targetStageId: options.targetStageId } : {}),
    ...(options.files !== undefined
      ? { files: await readJson<readonly StageFile[]>(options.files, 'files') }
      : {}),
  };
}

async function readJson<T>(path: string, description: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ValidationError(`cannot read ${description} file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ValidationError(`${description} file ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function watchCallbacks(): Parameters<typeof buildStateMachineWatcher>[1] {
  return {
    onPoll: (poll: StateMachinePollResult) => {
      console.log(stringifyForCli({ poll }));
    },
    onError: (error: unknown) => {
      console.error(redactRpcUrlsInText(error instanceof Error ? `${error.name}: ${error.message}` : String(error)));
    },
    onWarning: (message: string) => {
      console.error(redactRpcUrlsInText(message));
    },
  };
}
