/**
 * CLI operation wiring: `--mode direct|relay`, `--relay-url`, `--dry-run` and
 * the private-key env resolve into the headless operation client shared by the
 * plan/order/invite/signal/registry commands. Signing and delivery are core
 * operations; commands only parse flags and print.
 */
import type { Hex } from 'viem';
import {
  prepareOperation,
  signOperation,
  type OperationClient,
  type OperationInput,
  type OperationResult,
  type SignedOperation,
  type SubmitMode,
} from '../core/operations.js';
import { loadPrivateKeyFromEnv } from '../core/signing.js';
import { ValidationError } from '../core/validation.js';
import { createHeadlessClient } from '../headless/client.js';
import { signerFromPrivateKey, type TypedDataSigner } from '../headless/signers.js';

export interface OperationCliOptions {
  readonly mode?: string | undefined;
  readonly relayUrl?: string | undefined;
  readonly relayPath?: string | undefined;
  readonly rpcUrl?: string | undefined;
  readonly privateKeyEnv?: string | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface CliOperationContext {
  readonly privateKey: Hex;
  readonly signer: TypedDataSigner;
  readonly mode: SubmitMode;
}

export function parseSubmitMode(value: string | undefined): SubmitMode {
  if (value === undefined) {
    return 'direct';
  }
  if (value === 'direct' || value === 'relay') {
    return value;
  }
  throw new ValidationError(`--mode must be direct or relay (got ${value})`);
}

export function cliOperationContext(
  options: OperationCliOptions,
  defaultPrivateKeyEnv: string,
): CliOperationContext {
  const envName = options.privateKeyEnv ?? defaultPrivateKeyEnv;
  const privateKey = loadPrivateKeyFromEnv(envName);
  if (!privateKey) {
    throw new ValidationError(`missing private key env var ${envName}`);
  }
  return { privateKey, signer: signerFromPrivateKey(privateKey), mode: parseSubmitMode(options.mode) };
}

export function signWith(context: CliOperationContext, input: OperationInput): Promise<SignedOperation> {
  return signOperation(prepareOperation(input), context.signer);
}

export function operationClient(
  context: CliOperationContext,
  options: OperationCliOptions,
): OperationClient {
  return createHeadlessClient({
    privateKey: context.privateKey,
    mode: context.mode,
    ...(options.rpcUrl !== undefined ? { rpcUrl: options.rpcUrl } : {}),
    ...(options.relayUrl !== undefined ? { relayUrl: options.relayUrl } : {}),
    ...(options.relayPath !== undefined ? { relayPath: options.relayPath } : {}),
  });
}

/** Chain path: `--dry-run` returns the signed envelope, otherwise the transport result. */
export async function executeCliOperation(
  input: OperationInput,
  options: OperationCliOptions,
  defaultPrivateKeyEnv: string,
): Promise<SignedOperation | OperationResult> {
  const context = cliOperationContext(options, defaultPrivateKeyEnv);
  if (options.dryRun) {
    return signWith(context, input);
  }
  return operationClient(context, options).execute(input);
}
