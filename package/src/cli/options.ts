/**
 * Commander option shapes for the uvp-client CLI commands; the watch/signal
 * option shapes mirror the headless runtime and core builders they feed, and
 * operation commands share the --mode/--relay-url/--dry-run vocabulary.
 */
import type { StateMachineWatchOptions } from '../headless/runtime.js';
import type { OperationCliOptions } from './operation.js';

export type ChainWatchOptions = StateMachineWatchOptions;

export interface ChainSignalOptions {
  rpcUrl: string;
  stateMachine: string;
  chainId: string;
  privateKeyEnv: string;
  walletAddress?: string;
  orderId: string;
  planId: string;
  source: string;
  stage: string;
  signalName: string;
  payloadHash?: string;
  payloadRef?: string;
  idempotencyKey?: string;
  dryRun?: boolean;
  waitForReceipt?: boolean;
}

export interface WalletNewOptions {
  envFile: string;
  overwrite?: boolean;
  privateKeyEnv: string;
  addressEnv: string;
}

export interface WalletAddressOptions {
  privateKeyEnv: string;
}

export interface FaucetInfoOptions {
  network: string;
  address?: string;
}

export interface PlanCompileOptions {
  definition: string;
  publisher: string;
  out?: string;
}

export interface PlanRegisterOptions extends OperationCliOptions {
  definition: string;
  rpcUrl: string;
  chainId: string;
  stateMachine: string;
  privateKeyEnv: string;
  deadlineSeconds?: string;
  birthAuthorizer?: string;
  finalize?: boolean;
}

export interface OrderBirthIntentOptions extends OperationCliOptions {
  rpcUrl: string;
  chainId: string;
  stateMachine: string;
  privateKeyEnv: string;
  planId: string;
  orderId: string;
  termsHash: string;
  nonce: string;
  deadline: string;
}

export interface OrderBirthAuthorizeOptions extends OperationCliOptions {
  rpcUrl: string;
  chainId: string;
  stateMachine: string;
  privateKeyEnv: string;
  birth: string;
}

export interface OrderFinalizeOptions extends OperationCliOptions {
  typedData: string;
  privateKeyEnv: string;
}

export interface InviteAcceptOptions extends OperationCliOptions {
  typedData: string;
  privateKeyEnv: string;
}

export interface InviteCreateOptions extends OperationCliOptions {
  payload: string;
  privateKeyEnv: string;
}

export interface SignalSubmitOptions extends OperationCliOptions {
  rpcUrl: string;
  chainId: string;
  stateMachine: string;
  privateKeyEnv: string;
  planId: string;
  orderId: string;
  source: string;
  stage: string;
  signalName: string;
  payloadHash?: string;
  idempotencyKey?: string;
  deadline?: string;
  deadlineSeconds?: string;
}

export interface RegistrySignOptions extends OperationCliOptions {
  typedData: string;
  privateKeyEnv: string;
}

export interface DoctorOptions {
  config?: string;
  rpcUrl?: string;
  chainId?: string;
  stateMachine?: string;
  walletAddress?: string;
  privateKeyEnv?: string;
  timeoutMs?: string;
}

export function waitForShutdown(close: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const shutdown = (): void => {
      close().then(resolve, reject);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
