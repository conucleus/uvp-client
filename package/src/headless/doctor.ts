/**
 * Non-spending executor diagnostic: validates the state-machine handler
 * config, probes the RPC chain and state-machine code, and derives the
 * configured signer address without echoing key material. Config shape is
 * owned by watcher/execution/handler.ts; the signer key comes only from an
 * explicit env name (signing.ts).
 */
import { createPublicClient, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { classifyExecutorKitError } from '../core/errors.js';
import { loadPrivateKeyFromEnv } from '../core/signing.js';
import { normalizeAddressChecksummed, ValidationError } from '../core/validation.js';
import {
  loadStateMachineHandlerConfig,
  type StateMachineHandlerConfig,
} from './watcher/execution/handler.js';

const DEFAULT_DOCTOR_TIMEOUT_MS = 10_000;

export interface DoctorCheck {
  readonly ok: boolean;
  readonly label: string;
  readonly detail?: string;
  readonly latencyMs?: number;
}

export interface ExecutorDoctorConfigSummary {
  readonly path: string;
  readonly handlerCount: number;
  readonly signalCount: number;
  readonly stateMachineAddresses: readonly Address[];
  readonly supplierId?: string;
  readonly walletAddress?: Address;
  readonly chainId?: number;
  readonly dryRun: boolean;
}

export interface ExecutorDoctorRpcSummary {
  readonly chainId: number;
  readonly blockNumber: string;
}

export interface ExecutorDoctorReport {
  readonly ok: boolean;
  readonly timestamp: string;
  readonly checks: readonly DoctorCheck[];
  readonly warnings: readonly string[];
  readonly config?: ExecutorDoctorConfigSummary;
  readonly rpc?: ExecutorDoctorRpcSummary;
  readonly stateMachineAddress?: Address;
  readonly walletAddress?: Address;
}

export interface ExecutorDoctorInput {
  readonly configPath?: string;
  readonly rpcUrl?: string;
  readonly chainId?: number;
  readonly stateMachineAddress?: Address | string;
  readonly walletAddress?: Address | string;
  readonly privateKeyEnv?: string;
  readonly timeoutMs?: number;
}

export async function runExecutorDoctor(input: ExecutorDoctorInput): Promise<ExecutorDoctorReport> {
  if (!input.configPath && !input.rpcUrl) {
    throw new ValidationError('doctor requires --config and/or --rpc-url');
  }

  const checks: DoctorCheck[] = [];
  const warnings: string[] = [];
  let config: ExecutorDoctorConfigSummary | undefined;
  let rpc: ExecutorDoctorRpcSummary | undefined;
  let walletAddress: Address | undefined;
  let stateMachineAddress: Address | undefined;

  if (input.configPath) {
    const configPath = input.configPath;
    const started = Date.now();
    try {
      const loaded = await loadStateMachineHandlerConfig(configPath);
      config = summarizeConfig(configPath, loaded);
      checks.push({
        ok: true,
        label: 'config',
        detail: `${config.handlerCount} handler(s), ${config.signalCount} signal(s)`,
        latencyMs: Date.now() - started,
      });
      if (!config.walletAddress && !input.walletAddress && !input.privateKeyEnv) {
        warnings.push('config has no walletAddress and no --wallet-address/--private-key-env was given');
      }
      if (config.chainId === undefined && input.chainId === undefined) {
        warnings.push('config has no chainId; pass --chain-id so the scan checks the expected chain');
      }
      if (config.chainId !== undefined && input.chainId !== undefined && config.chainId !== input.chainId) {
        warnings.push(`config chainId ${config.chainId} differs from --chain-id ${input.chainId}; the scan uses --chain-id`);
      }
      if (config.stateMachineAddresses.length === 0 && !input.stateMachineAddress) {
        warnings.push('config declares no state machine; pass --state-machine or set stateMachines[]');
      }
    } catch (error) {
      checks.push({
        ok: false,
        label: 'config',
        detail: classifyExecutorKitError(error).message,
        latencyMs: Date.now() - started,
      });
    }
  }

  if (input.privateKeyEnv) {
    const privateKeyEnv = input.privateKeyEnv;
    const started = Date.now();
    try {
      const privateKey = loadPrivateKeyFromEnv(privateKeyEnv);
      if (!privateKey) {
        throw new ValidationError(`missing private key env var ${privateKeyEnv}`);
      }
      const signer = privateKeyToAccount(privateKey).address;
      if (input.walletAddress) {
        const expected = normalizeAddressChecksummed(input.walletAddress, 'walletAddress');
        const matches = expected === signer;
        walletAddress = matches ? signer : undefined;
        checks.push({
          ok: matches,
          label: 'wallet',
          detail: matches
            ? `signer ${signer} matches --wallet-address`
            : `signer ${signer} does not match --wallet-address ${expected}`,
          latencyMs: Date.now() - started,
        });
      } else {
        walletAddress = signer;
        checks.push({
          ok: true,
          label: 'wallet',
          detail: `signer ${signer} (${privateKeyEnv})`,
          latencyMs: Date.now() - started,
        });
      }
    } catch (error) {
      checks.push({
        ok: false,
        label: 'wallet',
        detail: classifyExecutorKitError(error).message,
        latencyMs: Date.now() - started,
      });
    }
  } else if (input.walletAddress) {
    const started = Date.now();
    try {
      walletAddress = normalizeAddressChecksummed(input.walletAddress, 'walletAddress');
      checks.push({
        ok: true,
        label: 'wallet',
        detail: `wallet address ${walletAddress} configured (no private key loaded)`,
        latencyMs: Date.now() - started,
      });
    } catch (error) {
      checks.push({
        ok: false,
        label: 'wallet',
        detail: classifyExecutorKitError(error).message,
        latencyMs: Date.now() - started,
      });
    }
  }

  if (!input.rpcUrl) {
    warnings.push('no --rpc-url; RPC chain and state-machine checks skipped');
  } else {
    const client = createPublicClient({
      transport: http(input.rpcUrl, {
        timeout: input.timeoutMs ?? DEFAULT_DOCTOR_TIMEOUT_MS,
        retryCount: 0,
      }),
    });
    const started = Date.now();
    try {
      const chainId = await client.getChainId();
      const blockNumber = await client.getBlockNumber();
      rpc = { chainId, blockNumber: blockNumber.toString() };
      checks.push({
        ok: true,
        label: 'rpc',
        detail: `chain id ${chainId}, head ${blockNumber}`,
        latencyMs: Date.now() - started,
      });

      if (input.chainId !== undefined) {
        const matches = chainId === input.chainId;
        checks.push({
          ok: matches,
          label: 'chain-id',
          detail: matches
            ? `RPC chain id ${chainId} matches --chain-id ${input.chainId}`
            : `RPC chain id ${chainId} does not match --chain-id ${input.chainId}`,
        });
      }

      if (input.stateMachineAddress) {
        const address = normalizeAddressChecksummed(input.stateMachineAddress, 'stateMachineAddress');
        stateMachineAddress = address;
        const codeStarted = Date.now();
        try {
          const code = await client.getCode({ address });
          const deployed = code !== undefined && code !== '0x';
          checks.push({
            ok: deployed,
            label: 'state-machine',
            detail: deployed
              ? `contract code present at ${address}`
              : `no contract code at ${address}`,
            latencyMs: Date.now() - codeStarted,
          });
        } catch (error) {
          checks.push({
            ok: false,
            label: 'state-machine',
            detail: classifyExecutorKitError(error).message,
            latencyMs: Date.now() - codeStarted,
          });
        }
      }
    } catch (error) {
      checks.push({
        ok: false,
        label: 'rpc',
        detail: classifyExecutorKitError(error).message,
        latencyMs: Date.now() - started,
      });
    }
  }

  return {
    ok: checks.every((check) => check.ok),
    timestamp: new Date().toISOString(),
    checks,
    warnings,
    ...(config ? { config } : {}),
    ...(rpc ? { rpc } : {}),
    ...(stateMachineAddress ? { stateMachineAddress } : {}),
    ...(walletAddress ? { walletAddress } : {}),
  };
}

function summarizeConfig(path: string, config: StateMachineHandlerConfig): ExecutorDoctorConfigSummary {
  const signalCount = Object.values(config.handlers)
    .reduce((count, handler) => count + handler.signals.length, 0);
  const stateMachineAddresses = (config.stateMachines ?? [])
    .map((deployment) => normalizeAddressChecksummed(deployment.stateMachineAddress, 'stateMachines[].stateMachineAddress'));
  if (stateMachineAddresses.length === 0 && config.stateMachineAddress) {
    stateMachineAddresses.push(config.stateMachineAddress);
  }
  return {
    path,
    handlerCount: Object.keys(config.handlers).length,
    signalCount,
    stateMachineAddresses,
    ...(config.supplierId ?? config.executorId ? { supplierId: config.supplierId ?? config.executorId } : {}),
    ...(config.walletAddress ? { walletAddress: config.walletAddress } : {}),
    ...(config.chainId !== undefined ? { chainId: config.chainId } : {}),
    dryRun: config.dryRun ?? false,
  };
}
