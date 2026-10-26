/**
 * doctor command: non-spending executor diagnostic over the SDK doctor
 * (config, RPC chain, state-machine code, signer wallet). Exits non-zero when
 * any check fails.
 */
import type { Command } from 'commander';
import { runExecutorDoctor } from '../../doctor.js';
import { stringifyForTransport } from '../../transport.js';
import { parsePositiveInteger } from '../../validation.js';
import type { DoctorOptions } from '../options.js';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('non-spending executor diagnostic: config, RPC chain, state-machine code, wallet')
    .option('--config <path>', 'state machine handler config JSON path to validate')
    .option('--rpc-url <url>', 'EVM RPC URL to probe')
    .option('--chain-id <id>', 'expected chain id for the probed RPC')
    .option('--state-machine <address>', 'UVPStateMachine contract address to check for deployed code')
    .option('--wallet-address <address>', 'executor wallet address to report or verify against the signer')
    .option('--private-key-env <name>', 'env var containing the executor private key; only the derived address is reported')
    .option('--timeout-ms <ms>', 'per-probe RPC timeout in milliseconds', '10000')
    .action(async (options: DoctorOptions) => {
      const report = await runExecutorDoctor({
        ...(options.config ? { configPath: options.config } : {}),
        ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
        ...(options.chainId ? { chainId: parsePositiveInteger(options.chainId, 'chainId') } : {}),
        ...(options.stateMachine ? { stateMachineAddress: options.stateMachine } : {}),
        ...(options.walletAddress ? { walletAddress: options.walletAddress } : {}),
        ...(options.privateKeyEnv ? { privateKeyEnv: options.privateKeyEnv } : {}),
        ...(options.timeoutMs ? { timeoutMs: parsePositiveInteger(options.timeoutMs, 'timeoutMs') } : {}),
      });
      console.log(stringifyForTransport(report));
      if (!report.ok) {
        process.exitCode = 1;
      }
    });
}
