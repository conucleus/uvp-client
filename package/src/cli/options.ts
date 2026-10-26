/**
 * Commander option shapes for the uvp-client CLI commands; the watch/signal
 * option shapes mirror the headless runtime and core builders they feed.
 */
import type { StateMachineWatchOptions } from '../headless/runtime.js';

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
