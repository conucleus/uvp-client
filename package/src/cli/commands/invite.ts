/**
 * invite commands: accept signs the invitee's UVPStageInviteAccept typed data
 * prepared at preview; create signs the buyer's UVPStageInviteCreate payload so
 * an app backend may mint the invite. Delivery stays with the order service;
 * the CLI only produces signed envelopes through core invite operations.
 */
import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import type { UVPStageInviteAcceptTypedData } from '@uvp-eth/protocol-bindings';
import type { OperationInput } from '../../core/operations.js';
import { ValidationError } from '../../core/validation.js';
import { cliOperationContext, signWith } from '../operation.js';
import type { InviteAcceptOptions, InviteCreateOptions } from '../options.js';
import { stringifyForTransport } from '../output.js';

const INVITE_PRIVATE_KEY_ENV = 'UVP_EXECUTOR_PRIVATE_KEY';

export function registerInviteCommands(program: Command): void {
  const invite = program.command('invite').description('invite operations');

  invite
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

  invite
    .command('create')
    .description('buyer signs an invite payload (UVPStageInviteCreate); the app backend mints the invite')
    .requiredOption('--payload <path>', 'JSON file with chainId, stateMachineAddress and the invite terms')
    .option('--private-key-env <name>', 'env var containing the buyer private key', INVITE_PRIVATE_KEY_ENV)
    .action(async (options: InviteCreateOptions) => {
      const context = cliOperationContext(options, INVITE_PRIVATE_KEY_ENV);
      const payload = await readPayload<InviteCreatePayload>(options.payload);
      const input: OperationInput = {
        operation: 'invite.create',
        signer: context.signer.address,
        chainId: payload.chainId,
        stateMachineAddress: payload.stateMachineAddress,
        draftId: payload.draftId,
        stageKey: payload.stageKey,
        stageId: payload.stageId,
        slotKey: payload.slotKey,
        invitee: payload.invitee,
        amount: payload.amount,
        finalStandardHash: payload.finalStandardHash,
        workDeadline: payload.workDeadline,
        termsHash: payload.termsHash,
        nonce: payload.nonce,
        deadline: payload.deadline,
      };
      const signed = await signWith(context, input);
      console.log(stringifyForTransport({
        operation: signed.operation,
        chainId: signed.chainId,
        signer: signed.signer,
        typedData: signed.typedData,
        signature: signed.signature,
      }));
    });
}

interface InviteCreatePayload {
  readonly chainId: number;
  readonly stateMachineAddress: string;
  readonly draftId: string;
  readonly stageKey: string;
  readonly stageId: string;
  readonly slotKey: string;
  readonly invitee: string;
  readonly amount: string | number;
  readonly finalStandardHash: string;
  readonly workDeadline: string | number;
  readonly termsHash: string;
  readonly nonce: string | number;
  readonly deadline: string | number;
}

async function readTypedData(path: string): Promise<UVPStageInviteAcceptTypedData> {
  return readPayload<UVPStageInviteAcceptTypedData>(path);
}

async function readPayload<T>(path: string): Promise<T> {
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
