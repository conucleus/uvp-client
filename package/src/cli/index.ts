#!/usr/bin/env node
/**
 * CLI entry point: command registration lives in ./commands, watch runtime in
 * ../headless/runtime.ts, and scan exit-code adaptation in ./output.ts.
 * Programmatic callers depend on this single module.
 */
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { ExecutorKitError } from '../core/validation.js';
import { registerChainCommands } from './commands/chain.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerPlanCommands } from './commands/plan.js';
import { registerWalletCommands } from './commands/wallet.js';

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('uvp-client')
    .description('UVP client CLI for executors')
    .version('0.1.0');

  registerWalletCommands(program);
  registerDoctorCommand(program);
  registerPlanCommands(program);
  registerChainCommands(program);

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  const runtime = argv[0] ?? 'node';
  const script = argv[1] ?? 'uvp-client';
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
