/**
 * order commands: buyer birth intent (relay-delivered), birthAuthorizer birth
 * authorization (direct or relay), and buyer UVPOrderFinalize signing. All go
 * through core operations; no per-shape sign flow lives here.
 */
import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import type {
  SignalAttributionPayload,
  SignalAuthorizationPayload,
  TriggerOrderFromOutsidePayload,
  UVPOrderFinalizeTypedData,
} from '@uvp-eth/protocol-bindings';
import { ZERO_BYTES32 } from '../../core/constants.js';
import type { OperationInput } from '../../core/operations.js';
import { parsePositiveInteger, ValidationError } from '../../core/validation.js';
import type {
  OrderBirthAuthorizeOptions,
  OrderBirthIntentOptions,
  OrderFinalizeOptions,
} from '../options.js';
import { cliOperationContext, executeCliOperation, signWith } from '../operation.js';
import { stringifyForTransport } from '../output.js';

const ORDER_PRIVATE_KEY_ENV = 'UVP_EXECUTOR_PRIVATE_KEY';

export function registerOrderCommands(program: Command): void {
  const order = program.command('order').description('sign and deliver order birth/finalize operations');

  order
    .command('birth-intent')
    .description('buyer signs the order birth intent; delivery is relay (the birthAuthorizer submits birth)')
    .requiredOption('--chain-id <id>', 'chain id of the birth state machine')
    .requiredOption('--state-machine <address>', 'UVPStateMachine contract address the intent binds to')
    .requiredOption('--plan-id <bytes32>', 'plan the order is born under')
    .requiredOption('--order-id <bytes32>', 'derived order id the buyer consents to')
    .requiredOption('--terms-hash <bytes32>', 'hash of the buyer-accepted order terms')
    .requiredOption('--nonce <uint>', 'buyer intent nonce')
    .requiredOption('--deadline <unix>', 'intent deadline in unix seconds')
    .option('--private-key-env <name>', 'env var containing the buyer private key', ORDER_PRIVATE_KEY_ENV)
    .option('--mode <mode>', 'delivery mode: relay only for the buyer intent', 'relay')
    .option('--relay-url <url>', 'relay service base URL')
    .option('--relay-path <path>', 'relay endpoint path', '/relay')
    .option('--dry-run', 'sign the intent locally but do not deliver it')
    .action(async (options: OrderBirthIntentOptions) => {
      const context = cliOperationContext(options, ORDER_PRIVATE_KEY_ENV);
      if (context.mode !== 'relay') {
        throw new ValidationError('order birth-intent is relay-delivered: pass --mode relay --relay-url');
      }
      const input: OperationInput = {
        operation: 'order.birth',
        role: 'buyer-intent',
        chainId: parsePositiveInteger(options.chainId, 'chainId'),
        stateMachineAddress: options.stateMachine,
        signer: context.signer.address,
        planId: options.planId,
        orderId: options.orderId,
        termsHash: options.termsHash,
        nonce: options.nonce,
        deadline: options.deadline,
      };
      const result = await executeCliOperation(input, options, ORDER_PRIVATE_KEY_ENV);
      console.log(stringifyForTransport({ order: options.dryRun ? { mode: context.mode, ...result } : result }));
    });

  order
    .command('birth-authorize')
    .description('birthAuthorizer signs the birth authorization and delivers triggerOrderFromOutsideFor')
    .requiredOption('--birth <path>', 'JSON file with trigger, authorizations, birthFactAttribution')
    .requiredOption('--chain-id <id>', 'chain id of the birth state machine')
    .requiredOption('--state-machine <address>', 'UVPStateMachine contract address')
    .option('--private-key-env <name>', 'env var containing the birthAuthorizer private key', ORDER_PRIVATE_KEY_ENV)
    .option('--mode <mode>', 'delivery mode: direct or relay', 'direct')
    .option('--relay-url <url>', 'relay service base URL (required with --mode relay)')
    .option('--relay-path <path>', 'relay endpoint path', '/relay')
    .option('--rpc-url <url>', 'EVM RPC URL (required with --mode direct)')
    .option('--dry-run', 'sign the authorization locally but do not deliver it')
    .action(async (options: OrderBirthAuthorizeOptions) => {
      const context = cliOperationContext(options, ORDER_PRIVATE_KEY_ENV);
      const birth = await readBirthSubmission(options.birth);
      const input: OperationInput = {
        operation: 'order.birth',
        role: 'birth-authorizer',
        chainId: parsePositiveInteger(options.chainId, 'chainId'),
        stateMachineAddress: options.stateMachine,
        signer: context.signer.address,
        trigger: birth.trigger,
        authorizations: birth.authorizations,
        birthFactAttribution: birth.birthFactAttribution,
      };
      const result = await executeCliOperation(input, options, ORDER_PRIVATE_KEY_ENV);
      console.log(stringifyForTransport({ order: options.dryRun ? { mode: context.mode, ...result } : result }));
    });

  order
    .command('finalize')
    .description('sign the buyer UVPOrderFinalize typed data (service delivery stays with order app)')
    .requiredOption('--typed-data <path>', 'JSON file with UVPOrderFinalize typed data from finalize/prepare')
    .option('--private-key-env <name>', 'env var containing the buyer private key', ORDER_PRIVATE_KEY_ENV)
    .action(async (options: OrderFinalizeOptions) => {
      const context = cliOperationContext(options, ORDER_PRIVATE_KEY_ENV);
      const typedData = await readTypedData<UVPOrderFinalizeTypedData>(options.typedData);
      const signed = await signWith(context, {
        operation: 'order.finalize',
        signer: context.signer.address,
        typedData,
      });
      console.log(stringifyForTransport({
        operation: signed.operation,
        chainId: signed.chainId,
        signer: signed.signer,
        signature: signed.signature,
      }));
    });
}

interface BirthSubmissionFile {
  readonly trigger: TriggerOrderFromOutsidePayload;
  readonly authorizations: readonly SignalAuthorizationPayload[];
  readonly birthFactAttribution: SignalAttributionPayload;
}

async function readBirthSubmission(path: string): Promise<BirthSubmissionFile> {
  const parsed = await readTypedData<{
    readonly trigger?: TriggerOrderFromOutsidePayload;
    readonly authorizations?: readonly SignalAuthorizationPayload[];
    readonly birthFactAttribution?: SignalAttributionPayload;
  }>(path);
  if (typeof parsed.trigger !== 'object' || parsed.trigger === null) {
    throw new ValidationError(`${path} must contain a trigger object`);
  }
  return {
    trigger: parsed.trigger,
    authorizations: parsed.authorizations ?? [],
    birthFactAttribution: parsed.birthFactAttribution ?? {
      sourceId: parsed.trigger.sourceId,
      signalId: parsed.trigger.signalId,
      stageId: ZERO_BYTES32,
      capabilityProof: [],
    },
  };
}

async function readTypedData<T>(path: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ValidationError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ValidationError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
