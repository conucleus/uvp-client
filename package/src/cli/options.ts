/**
 * Commander option shapes shared by the executor CLI commands; the parsing
 * helpers mirror the validation rules owned by validation.ts.
 */
import { ValidationError } from '../validation.js';

export interface ChainWatchOptions {
  rpcUrl: string;
  stateMachine?: string;
  chainId: string;
  config: string;
  walletAddress?: string;
  privateKeyEnv: string;
  fromBlock?: string;
  pollIntervalMs?: string;
  confirmations?: string;
  runtimeEnv?: string;
  reorgWindow?: string;
  maxGetLogsBlockSpan?: string;
  jobsFile?: string;
  jobStore?: string;
  stateDir?: string;
  dryRun?: boolean;
  waitForReceipt?: boolean;
}

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

export function parseNonNegativeIntegerOption(value: string, fieldName: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ValidationError(`${fieldName} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ValidationError(`${fieldName} must be a non-negative safe integer`);
  }
  return parsed;
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
