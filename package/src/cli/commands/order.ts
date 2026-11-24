/**
 * order commands: trigger creation (orderId 0 SignalSubmission, submitter =
 * trigger stage supplier). Construction, signing and delivery go through core
 * operations; no per-shape sign flow lives here.
 */
import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import type {
  StageFile,
  SignalAttributionPayload,
} from '@uvp-eth/protocol-bindings';
import type { OperationInput } from '../../core/operations.js';
import { parsePositiveInteger, ValidationError } from '../../core/validation.js';
import type { OrderTriggerOptions } from '../options.js';
import { cliOperationContext, executeCliOperation } from '../operation.js';
import { stringifyForCli } from '../output.js';

const ORDER_PRIVATE_KEY_ENV = 'UVP_EXECUTOR_PRIVATE_KEY';
const DEFAULT_TRIGGER_DEADLINE_SECONDS = 3_600;

export function registerOrderCommands(program: Command): void {
  const order = program.command('order').description('sign and deliver order trigger/finalize operations');

  order
    .command('trigger')
    .description('trigger creation: submitSignal with orderId 0 (the state machine generates the order id)')
    .requiredOption('--plan-id <bytes32>', 'plan the new order is created under')
    .requiredOption('--source <source>', 'trigger signal source')
    .requiredOption('--stage <stageIdentifier>', 'trigger stage identifier')
    .requiredOption('--signal-name <signalName>', 'trigger signal name')
    .requiredOption('--idempotency-key <key>', 'trigger idempotency key (non-zero; persisted by the caller)')
    .option('--payload-hash <bytes32>', 'off-chain payload hash')
    .option('--attribution <json>', 'fact attribution JSON (sourceId, signalId, stageId, capabilityProof)')
    .option('--target-stage-id <bytes32>', 'stage whose file map receives the files')
    .option('--files <json>', 'stage files JSON array of { key, payload }')
    .option('--deadline-seconds <n>', 'seconds from now for the submission deadline', String(DEFAULT_TRIGGER_DEADLINE_SECONDS))
    .option('--chain-id <id>', 'chain id of the state machine')
    .option('--state-machine <address>', 'UVPStateMachine contract address')
    .option('--rpc-url <url>', 'EVM RPC URL (required with --mode direct)')
    .option('--private-key-env <name>', 'env var containing the trigger submitter private key', ORDER_PRIVATE_KEY_ENV)
    .option('--mode <mode>', 'delivery mode: direct or relay', 'direct')
    .option('--relay-url <url>', 'relay service base URL (required with --mode relay)')
    .option('--relay-path <path>', 'relay endpoint path (required with --mode relay)')
    .option('--dry-run', 'build/sign the operation locally but do not deliver it')
    .action(async (options: OrderTriggerOptions) => {
      const context = cliOperationContext(options, ORDER_PRIVATE_KEY_ENV);
      const deadlineSeconds = parsePositiveInteger(
        options.deadlineSeconds ?? String(DEFAULT_TRIGGER_DEADLINE_SECONDS),
        'deadlineSeconds',
      );
      const input: OperationInput = {
        operation: 'order.trigger',
        chainId: parsePositiveInteger(requireValue(options.chainId, '--chain-id'), 'chainId'),
        stateMachineAddress: requireValue(options.stateMachine, '--state-machine'),
        signer: context.signer.address,
        signal: {
          planId: options.planId,
          ...(options.source !== undefined ? { source: options.source } : {}),
          ...(options.stage !== undefined ? { stageIdentifier: options.stage } : {}),
          ...(options.signalName !== undefined ? { signalName: options.signalName } : {}),
          ...(options.payloadHash !== undefined ? { payloadHash: options.payloadHash } : {}),
          idempotencyKey: options.idempotencyKey,
          ...(options.attribution !== undefined
            ? { attribution: await readJson<SignalAttributionPayload>(options.attribution, 'attribution') }
            : {}),
          ...(options.targetStageId !== undefined ? { targetStageId: options.targetStageId } : {}),
          ...(options.files !== undefined
            ? { files: await readJson<readonly StageFile[]>(options.files, 'files') }
            : {}),
        },
        deadline: BigInt(Math.floor(Date.now() / 1_000)) + BigInt(deadlineSeconds),
      };
      const result = await executeCliOperation(input, options, ORDER_PRIVATE_KEY_ENV);
      console.log(stringifyForCli({ order: options.dryRun ? { mode: context.mode, ...result } : result }));
    });
}

function requireValue(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new ValidationError(`${flag} is required`);
  }
  return value;
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