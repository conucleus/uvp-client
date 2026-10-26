#!/usr/bin/env node
/**
 * CLI entry point: command registration lives in cli/commands/, watcher
 * assembly in cli/watcher.ts, and scan exit-code adaptation in cli/output.ts.
 * Programmatic callers depend on this single module.
 */
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { registerChainCommands } from './cli/commands/chain.js';
import { registerDoctorCommand } from './cli/commands/doctor.js';
import { registerWalletCommands } from './cli/commands/wallet.js';
import { ExecutorKitError } from './validation.js';

export { chainPollExecutionFailed } from './cli/output.js';
export {
  DEFAULT_WATCHER_STATE_DIR,
  EXECUTOR_RUNTIME_ENV,
  resolveRuntimeEnvironment,
  resolveWatcherStorage,
  WATCHER_STATE_DIR_ENV,
  type WatcherStorageResolution,
  type WatcherStorageSummary,
} from './cli/watcher.js';

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('uvp-executor')
    .description('UVP EVM executor CLI')
    .version('0.1.0');

  registerWalletCommands(program);
  registerDoctorCommand(program);
  registerChainCommands(program);

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  const runtime = argv[0] ?? 'node';
  const script = argv[1] ?? 'uvp-executor';
  const normalizedArgv = argv.length > 2 && argv[2] === '--'
    ? [runtime, script, ...argv.slice(3)]
    : argv;
  await buildProgram().parseAsync(normalizedArgv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    if (error instanceof ExecutorKitError) {
      console.error(`${error.name}: ${error.message}`);
      process.exitCode = 1;
      return;
    }

    throw error;
  });
}
