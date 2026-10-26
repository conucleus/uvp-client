/**
 * plan compile/register commands: Node compiler wrapper plus the two-step
 * registration flow (commitPlan + finalizePlan). Signing uses an explicit
 * env-named private key; `--dry-run` signs locally but never broadcasts.
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadPrivateKeyFromEnv } from '../../core/signing.js';
import { ValidationError } from '../../core/validation.js';
import { compilePlan, planRegistrationArgs, registerPlan } from '../../headless/plan.js';
import { signerFromPrivateKey } from '../../headless/signers.js';
import { parsePositiveInteger } from '../../core/validation.js';
import type { PlanCompileOptions, PlanRegisterOptions } from '../options.js';
import { stringifyForTransport } from '../output.js';

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
    .description('compile, sign, and submit plan registration (commitPlan + finalizePlan); --dry-run only signs')
    .requiredOption('--definition <path>', 'Zhixu YAML definition path')
    .requiredOption('--rpc-url <url>', 'EVM RPC URL')
    .requiredOption('--chain-id <id>', 'expected chain id')
    .requiredOption('--state-machine <address>', 'UVPStateMachine contract address')
    .option('--private-key-env <name>', 'env var containing the publisher private key', 'UVP_ETH_DEPLOYER_PRIVATE_KEY')
    .option('--deadline-seconds <n>', 'seconds from the current block timestamp for the commit deadline', '3600')
    .option('--birth-authorizer <address>', 'birth authorizer (defaults to the publisher)')
    .option('--dry-run', 'sign the commit locally but do not broadcast')
    .action(async (options: PlanRegisterOptions) => {
      const privateKey = loadPrivateKeyFromEnv(options.privateKeyEnv);
      if (!privateKey) {
        throw new ValidationError(`missing private key env var ${options.privateKeyEnv}`);
      }
      const chainId = parsePositiveInteger(options.chainId, 'chainId');
      const publicClient = createPublicClient({ transport: http(options.rpcUrl) });
      const deadlineSeconds = parsePositiveInteger(options.deadlineSeconds ?? '3600', 'deadlineSeconds');
      const block = await publicClient.getBlock({ blockTag: 'latest' });
      const deadline = block.timestamp + BigInt(deadlineSeconds);
      const signer = signerFromPrivateKey(privateKey);
      const compiled = await compilePlan({ definitionPath: options.definition, publisher: signer.address });
      const registration = planRegistrationArgs(compiled.registerArgs, compiled.planId);

      if (options.dryRun) {
        const signed = await registerPlan({
          chainId,
          stateMachineAddress: options.stateMachine,
          registration,
          signer,
          deadline,
          ...(options.birthAuthorizer ? { birthAuthorizer: options.birthAuthorizer } : {}),
        });
        console.log(stringifyForTransport({
          plan: {
            planId: signed.planId,
            signature: signed.signature,
            commitCall: signed.commitCall,
            finalizeCall: signed.finalizeCall,
            dryRun: true,
          },
        }));
        return;
      }

      const account = privateKeyToAccount(privateKey);
      const wallet = createWalletClient({ account, transport: http(options.rpcUrl) });
      const registered = await registerPlan({
        chainId,
        stateMachineAddress: options.stateMachine,
        registration,
        signer,
        deadline,
        ...(options.birthAuthorizer ? { birthAuthorizer: options.birthAuthorizer } : {}),
        submit: {
          sendTransaction: ({ to, data }: { readonly to: Address; readonly data: Hex }) =>
            wallet.sendTransaction({ account, to, data, chain: null }),
        },
      });
      console.log(stringifyForTransport({
        plan: {
          planId: registered.planId,
          commitTxHash: registered.commitTxHash,
          finalizeTxHash: registered.finalizeTxHash,
        },
      }));
    });
}
