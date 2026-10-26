/**
 * signal submit command: build the relayable submitSignalFor operation from
 * signal fields, sign it with the executor key, and deliver it direct or via
 * relay. The watcher callback path (submitSignal as msg.sender) stays in
 * headless/watcher and is not an operation.
 */
import type { Command } from 'commander';
import { createPublicClient, http } from 'viem';
import type { OperationInput } from '../../core/operations.js';
import { parseBigNumberish, parsePositiveInteger } from '../../core/validation.js';
import type { SignalSubmitOptions } from '../options.js';
import { cliOperationContext, executeCliOperation } from '../operation.js';
import { stringifyForTransport } from '../output.js';

const SIGNAL_PRIVATE_KEY_ENV = 'UVP_EXECUTOR_PRIVATE_KEY';

export function registerSignalCommands(program: Command): void {
  program
    .command('signal')
    .description('signal operations')
    .command('submit')
    .description('sign and deliver one submitSignalFor operation (direct or relay)')
    .requiredOption('--rpc-url <url>', 'EVM RPC URL (block clock for --deadline-seconds)')
    .requiredOption('--state-machine <address>', 'UVPStateMachine contract address')
    .requiredOption('--chain-id <id>', 'expected chain id')
    .requiredOption('--plan-id <bytes32>', 'plan id the order belongs to')
    .requiredOption('--order-id <bytes32>', 'order id')
    .requiredOption('--source <source>', 'signal source')
    .requiredOption('--stage <stageIdentifier>', 'stage identifier')
    .requiredOption('--signal-name <signalName>', 'signal name')
    .option('--payload-hash <bytes32>', 'off-chain payload hash')
    .option('--idempotency-key <key>', 'idempotency key (hashed before signing)')
    .option('--deadline <unix>', 'absolute signature deadline in unix seconds')
    .option('--deadline-seconds <n>', 'seconds from the current block timestamp when --deadline is omitted', '900')
    .option('--private-key-env <name>', 'env var containing the executor private key', SIGNAL_PRIVATE_KEY_ENV)
    .option('--mode <mode>', 'delivery mode: direct or relay', 'direct')
    .option('--relay-url <url>', 'relay service base URL (required with --mode relay)')
    .option('--relay-path <path>', 'relay endpoint path', '/relay')
    .option('--dry-run', 'sign the operation locally but do not deliver it')
    .action(async (options: SignalSubmitOptions) => {
      const context = cliOperationContext(options, SIGNAL_PRIVATE_KEY_ENV);
      const deadline = options.deadline !== undefined
        ? parseBigNumberish(options.deadline, 'deadline')
        : await blockDeadline(options.rpcUrl, parsePositiveInteger(options.deadlineSeconds ?? '900', 'deadlineSeconds'));
      const input: OperationInput = {
        operation: 'signal.submit',
        chainId: parsePositiveInteger(options.chainId, 'chainId'),
        stateMachineAddress: options.stateMachine,
        signer: context.signer.address,
        deadline,
        signal: {
          planId: options.planId,
          orderId: options.orderId,
          source: options.source,
          stageIdentifier: options.stage,
          signalName: options.signalName,
          ...(options.payloadHash !== undefined ? { payloadHash: options.payloadHash } : {}),
          ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
        },
      };
      const result = await executeCliOperation(input, options, SIGNAL_PRIVATE_KEY_ENV);
      console.log(stringifyForTransport({ signal: options.dryRun ? { mode: context.mode, ...result } : result }));
    });
}

async function blockDeadline(rpcUrl: string, seconds: number): Promise<bigint> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const block = await client.getBlock({ blockTag: 'latest' });
  return block.timestamp + BigInt(seconds);
}
