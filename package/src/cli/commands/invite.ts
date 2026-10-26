/**
 * invite accept command: sign the invitee's UVPStageInviteAccept typed data
 * prepared at invite preview. Delivery stays with the order service; the CLI
 * only produces the signature through the core invite.accept operation.
 */
import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import type { UVPStageInviteAcceptTypedData } from '@uvp-eth/protocol-bindings';
import { ValidationError } from '../../core/validation.js';
import { cliOperationContext, signWith } from '../operation.js';
import type { InviteAcceptOptions } from '../options.js';
import { stringifyForTransport } from '../output.js';

const INVITE_PRIVATE_KEY_ENV = 'UVP_EXECUTOR_PRIVATE_KEY';

export function registerInviteCommands(program: Command): void {
  program
    .command('invite')
    .description('invite operations')
    .command('accept')
    .description('sign the invitee UVPStageInviteAccept typed data (service delivery stays with order app)')
    .requiredOption('--typed-data <path>', 'JSON file with UVPStageInviteAccept typed data from invite preview')
    .option('--private-key-env <name>', 'env var containing the invitee private key', INVITE_PRIVATE_KEY_ENV)
    .action(async (options: InviteAcceptOptions) => {
      const context = cliOperationContext(options, INVITE_PRIVATE_KEY_ENV);
      const typedData = await readTypedData(options.typedData);
      const signed = await signWith(context, {
        operation: 'invite.accept',
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

async function readTypedData(path: string): Promise<UVPStageInviteAcceptTypedData> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ValidationError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text) as UVPStageInviteAcceptTypedData;
  } catch (error) {
    throw new ValidationError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
