/**
 * plan compile/register commands: Node compiler wrapper plus the core
 * plan.register operation (commitPlan + finalizePlan) delivered direct or via
 * relay. Signing uses an explicit env-named private key; `--dry-run` signs
 * locally but never broadcasts.
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { createPublicClient, http, type Address } from 'viem';
import type { OperationInput } from '../../core/operations.js';
import { parsePositiveInteger } from '../../core/validation.js';
import { compilePlan, planRegistrationArgs } from '../../headless/plan.js';
import type { PlanCompileOptions, PlanRegisterOptions } from '../options.js';
import {
  cliOperationContext,
  executeCliOperation,
  parseSubmitMode,
  signWith,
} from '../operation.js';
import { stringifyForTransport } from '../output.js';

const PLAN_PRIVATE_KEY_ENV = 'UVP_ETH_DEPLOYER_PRIVATE_KEY';

export function registerPlanCommands(program: Command): void {
  const plan = program.command('plan').description('compile and register Zhixu plans');

  plan
    .command('compile')
    .description('compile a Zhixu YAML into plan registration args and a planId')
    .requiredOption('--definition <path>', 'Zhixu YAML definition path')
    .requiredOption('--publisher <address>', 'publisher address used for planId derivation')
    .option('--out <path>', 'write the compiled artifact/registration JSON to this path')
    .action(async (options: PlanCompileOptions) => {
      const compiled = await compilePlan({
        definitionPath: options.definition,
        publisher: options.publisher as Address,
      });
      const summary = {
        planId: compiled.planId,
        planHash: compiled.registerArgs.planHash,
        hooks: compiled.registerArgs.hooks.length,
        executorCandidates: compiled.registerArgs.executorCandidates.length,
      };
      if (options.out) {
        await writeFile(resolve(options.out), `${stringifyForTransport({
          artifact: compiled.artifact,
          registerArgs: compiled.registerArgs,
          planId: compiled.planId,
        })}\n`, 'utf8');
      }
      console.log(stringifyForTransport({ plan: summary, ...(options.out ? { out: resolve(options.out) } : {}) }));
    });

  plan
    .command('register')
    .description('compile, sign, and submit plan.register (commitPlan + finalizePlan) direct or via relay')
    .requiredOption('--definition <path>', 'Zhixu YAML definition path')
    .requiredOption('--rpc-url <url>', 'EVM RPC URL (block clock for the commit deadline)')
    .requiredOption('--chain-id <id>', 'expected chain id')
    .requiredOption('--state-machine <address>', 'UVPStateMachine contract address')
    .option('--private-key-env <name>', 'env var containing the publisher private key', PLAN_PRIVATE_KEY_ENV)
    .option('--deadline-seconds <n>', 'seconds from the current block timestamp for the commit deadline', '3600')
    .option('--birth-authorizer <address>', 'birth authorizer (defaults to the publisher)')
    .option('--mode <mode>', 'delivery mode: direct or relay', 'direct')
    .option('--relay-url <url>', 'relay service base URL (required with --mode relay)')
    .option('--relay-path <path>', 'relay endpoint path', '/relay')
    .option('--no-finalize', 'stop after commitPlan and leave the plan unfinalized')
    .option('--dry-run', 'sign the operation locally but do not deliver it')
    .action(async (options: PlanRegisterOptions) => {
      const context = cliOperationContext(options, PLAN_PRIVATE_KEY_ENV);
      const chainId = parsePositiveInteger(options.chainId, 'chainId');
      const deadlineSeconds = parsePositiveInteger(options.deadlineSeconds ?? '3600', 'deadlineSeconds');
      const publicClient = createPublicClient({ transport: http(options.rpcUrl) });
      const block = await publicClient.getBlock({ blockTag: 'latest' });
      const deadline = block.timestamp + BigInt(deadlineSeconds);
      const compiled = await compilePlan({ definitionPath: options.definition, publisher: context.signer.address });
      const input: OperationInput = {
        operation: 'plan.register',
        chainId,
        stateMachineAddress: options.stateMachine,
        signer: context.signer.address,
        registration: planRegistrationArgs(compiled.registerArgs, compiled.planId),
        deadline,
        ...(options.birthAuthorizer !== undefined ? { birthAuthorizer: options.birthAuthorizer } : {}),
        finalize: options.finalize !== false,
      };

      if (options.dryRun) {
        const signed = await signWith(context, input);
        console.log(stringifyForTransport({
          plan: {
            planId: compiled.planId,
            operation: signed.operation,
            mode: parseSubmitMode(options.mode),
            signer: signed.signer,
            signature: signed.signature,
            calls: signed.calls,
            dryRun: true,
          },
        }));
        return;
      }

      const result = await executeCliOperation(input, options, PLAN_PRIVATE_KEY_ENV);
      console.log(stringifyForTransport({ plan: { planId: compiled.planId, ...result } }));
    });
}
