/**
 * registry sign command: sign a registry EIP-712 record through the core
 * registry.write operation. Registry storage/HTTP stays in @uvp-eth/zhixu-registry;
 * the CLI produces the signed envelope only.
 */
import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import type { TypedDataDefinition } from 'viem';
import { ValidationError } from '../../core/validation.js';
import { cliOperationContext, signWith } from '../operation.js';
import type { RegistrySignOptions } from '../options.js';
import { stringifyForTransport } from '../output.js';

const REGISTRY_PRIVATE_KEY_ENV = 'UVP_EXECUTOR_PRIVATE_KEY';

export function registerRegistryCommands(program: Command): void {
  program
    .command('registry')
    .description('registry operations')
    .command('sign')
    .description('sign a registry EIP-712 record (registry storage/HTTP is not a client transport)')
    .requiredOption('--typed-data <path>', 'JSON file with registry typed data (e.g. from @uvp-eth/protocol-bindings buildZhixuRecordTypedData / buildIdentityClaimTypedData)')
    .option('--private-key-env <name>', 'env var containing the signer private key', REGISTRY_PRIVATE_KEY_ENV)
    .action(async (options: RegistrySignOptions) => {
      const context = cliOperationContext(options, REGISTRY_PRIVATE_KEY_ENV);
      const typedData = await readTypedData(options.typedData);
      const signed = await signWith(context, {
        operation: 'registry.write',
        signer: context.signer.address,
        typedData,
      });
      console.log(stringifyForTransport({
        operation: signed.operation,
        chainId: signed.chainId,
        signer: signed.signer,
        typedData: signed.typedData,
        signature: signed.signature,
      }));
    });
}

async function readTypedData(path: string): Promise<TypedDataDefinition> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ValidationError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text) as TypedDataDefinition;
  } catch (error) {
    throw new ValidationError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
