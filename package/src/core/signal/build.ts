import { encodeFunctionData, keccak256, stringToBytes, type Address, type Hex } from 'viem';
import {
  factAttribution,
  STATE_MACHINE_ABI,
  type SignalAttributionCallStruct,
  type SignalAttributionPayload,
  type SignalCapabilityTableEntry,
  type StageSelectorBindingTableEntry,
} from '@uvp-eth/protocol-bindings';
import { DEFAULT_SIGNING_KEY_ENV } from '../signing.js';
import {
  normalizeAddressChecksummed,
  normalizeBytes32,
  parsePositiveInteger,
  ValidationError,
} from '../validation.js';
import { ZERO_BYTES32 } from '../constants.js';
import { asNonEmptyString } from '../internal.js';
import type { StateMachineRawLog } from './decode.js';


export const DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV = DEFAULT_SIGNING_KEY_ENV;

export interface StateMachineSignal {
  readonly orderId: Hex | string;
  readonly planId?: Hex | string;
  readonly source?: string;
  readonly stageIdentifier?: string;
  readonly signalName?: string;
  readonly sourceId?: Hex | string;
  readonly signalId?: Hex | string;
  readonly payloadHash?: Hex | string;
  readonly payloadRef?: string;
  readonly idempotencyKey?: string;
  readonly attribution?: SignalAttributionPayload;
}

export interface StateMachineSignalCallArgs {
  readonly planId: Hex;
  readonly orderId: Hex;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly payloadHash: Hex;
  readonly idempotencyKey: Hex;
  readonly attribution: SignalAttributionCallStruct;
}

export const ZERO_FACT_ATTRIBUTION: SignalAttributionCallStruct = {
  sourceId: ZERO_BYTES32,
  signalId: ZERO_BYTES32,
  stageId: ZERO_BYTES32,
  capabilityProof: [],
};

export interface StateMachineCapabilityTables {
  readonly selectorBindings: readonly StageSelectorBindingTableEntry[];
  readonly signalCapabilities: readonly SignalCapabilityTableEntry[];
}

export function capabilityTablesOf(
  artifact?: {
    readonly selectorBindings?: readonly StageSelectorBindingTableEntry[];
    readonly signalCapabilities?: readonly SignalCapabilityTableEntry[];
  },
): StateMachineCapabilityTables | undefined {
  if (!artifact) {
    return undefined;
  }
  const selectorBindings = artifact.selectorBindings ?? [];
  const signalCapabilities = artifact.signalCapabilities ?? [];
  if (selectorBindings.length === 0 && signalCapabilities.length === 0) {
    return undefined;
  }
  return { selectorBindings, signalCapabilities };
}

export function withCapabilityProofs(
  signal: StateMachineSignal,
  tables: StateMachineCapabilityTables | undefined,
): StateMachineSignal {
  if (tables === undefined || signal.attribution !== undefined) {
    return signal;
  }
  const normalized = normalizeSignalSubmission(signal);
  const attribution = factAttributionShape(
    factAttribution(tables.selectorBindings, tables.signalCapabilities, normalized.sourceId, normalized.signalId),
    normalized.sourceId,
    normalized.signalId,
  );
  if (attribution === undefined) {
    return signal;
  }
  return { ...signal, attribution };
}

function factAttributionShape(
  attribution: { readonly stageId: Hex; readonly capabilityProof: readonly Hex[] } | undefined,
  sourceId: Hex,
  signalId: Hex,
): SignalAttributionPayload | undefined {
  if (attribution === undefined) {
    return undefined;
  }
  return {
    sourceId,
    signalId,
    stageId: attribution.stageId,
    capabilityProof: attribution.capabilityProof,
  };
}

export interface SubmitStateMachineSignalCall {
  readonly address: Address;
  readonly abi: typeof STATE_MACHINE_ABI;
  readonly functionName: 'submitSignal';
  readonly args: readonly [
    Hex,
    Hex,
    Hex,
    Hex,
    Hex,
    Hex,
    SignalAttributionCallStruct,
  ];
  readonly data: Hex;
  readonly chainId: number;
  readonly from?: Address;
}

export interface SubmitStateMachineSignalConfig {
  readonly stateMachineAddress?: Address | string;
  readonly rpcUrl: string;
  readonly chainId: number | string;
  readonly walletAddress?: Address | string;
  readonly privateKeyEnv?: string;
  readonly dryRun?: boolean;
  readonly waitForReceipt?: boolean;
  readonly publicClient?: StateMachinePublicClient;
}

export interface StateMachinePublicClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getLogs(args: {
    readonly address: Address;
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
  }): Promise<readonly StateMachineRawLog[]>;
  waitForTransactionReceipt?(args: {
    readonly hash: Hex;
  }): Promise<{ readonly status?: 'success' | 'reverted' | string }>;
  getTransactionReceipt?(args: {
    readonly hash: Hex;
  }): Promise<{ readonly status?: 'success' | 'reverted' | string } | null | undefined>;
  getBlock?(args: {
    readonly blockNumber: bigint;
  }): Promise<{ readonly hash?: Hex | string }>;
}

export function buildSubmitStateMachineSignalCall(
  config: SubmitStateMachineSignalConfig,
  signal: StateMachineSignal,
  from?: Address,
): SubmitStateMachineSignalCall {
  const normalizedConfig = normalizeSubmitConfig(config);
  const args = normalizeSignalSubmission(signal);
  const callArgs = [
    args.planId,
    args.orderId,
    args.sourceId,
    args.signalId,
    args.payloadHash,
    args.idempotencyKey,
    args.attribution,
  ] as const;
  const request = {
    address: normalizedConfig.stateMachineAddress,
    abi: STATE_MACHINE_ABI,
    functionName: 'submitSignal',
    args: callArgs,
    data: encodeFunctionData({
      abi: STATE_MACHINE_ABI,
      functionName: 'submitSignal',
      args: callArgs,
    }),
    chainId: normalizedConfig.chainId,
    ...(from ? { from } : {}),
  } as const;
  return request;
}

export interface NormalizedSubmitConfig extends SubmitStateMachineSignalConfig {
  readonly stateMachineAddress: Address;
  readonly chainId: number;
  readonly walletAddress?: Address;
  readonly privateKeyEnv: string;
  readonly dryRun: boolean;
  readonly waitForReceipt: boolean;
}

export function normalizeSubmitConfig(config: SubmitStateMachineSignalConfig): NormalizedSubmitConfig {
  if (!config.stateMachineAddress) {
    throw new ValidationError('stateMachineAddress is required');
  }
  return {
    rpcUrl: config.rpcUrl,
    stateMachineAddress: normalizeAddressChecksummed(config.stateMachineAddress, 'stateMachineAddress'),
    chainId: parsePositiveInteger(config.chainId, 'chainId'),
    ...(config.walletAddress ? { walletAddress: normalizeAddressChecksummed(config.walletAddress, 'walletAddress') } : {}),
    privateKeyEnv: config.privateKeyEnv ?? DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV,
    dryRun: config.dryRun ?? false,
    waitForReceipt: config.waitForReceipt ?? true,
    ...(config.publicClient ? { publicClient: config.publicClient } : {}),
  };
}

/** Normalized submitSignal keys shared by the direct call builders and the signed relay operation. */
export function normalizeSignalSubmission(signal: StateMachineSignal): StateMachineSignalCallArgs {
  const rawPlanId = signal.planId ?? undefined;
  if (rawPlanId === undefined || (typeof rawPlanId === 'string' && rawPlanId.trim().length === 0)) {
    throw new ValidationError(
      'planId is required to submit a state machine signal: the plan-scoped submitSignal(orderId, ...) ABI now takes the order planId as its first argument and rejects the zero placeholder on chain',
    );
  }
  const planId = normalizeBytes32(rawPlanId, 'planId');
  if (planId === ZERO_BYTES32) {
    throw new ValidationError('planId must be a non-zero bytes32: the zero placeholder cannot satisfy the on-chain (planId, orderId) existence check');
  }
  const orderId = normalizeBytes32(signal.orderId, 'orderId');
  const payloadHash = signal.payloadHash ? normalizeBytes32(signal.payloadHash, 'payloadHash') : ZERO_BYTES32;
  if (signal.sourceId === undefined && (signal.source ?? '').trim().length === 0) {
    throw new ValidationError(
      'signal.source (or signal.sourceId) is required to submit a state machine signal: without an explicit source the sourceId would be a constant keccak("") shared by every unattributed signal',
    );
  }
  const sourceId = signal.sourceId
    ? normalizeBytes32(signal.sourceId, 'sourceId')
    : hashText(signal.source!, 'source');
  const signalName = signal.signalName && signal.stageIdentifier && !signal.signalName.includes('.')
    ? `${signal.stageIdentifier}.${signal.signalName}`
    : signal.signalName;
  const signalId = signal.signalId
    ? normalizeBytes32(signal.signalId, 'signalId')
    : hashText(asNonEmptyString(signalName, 'signalName'), 'signalName');

  return {
    planId,
    orderId,
    sourceId,
    signalId,
    payloadHash,
    idempotencyKey: signal.idempotencyKey
      ? hashText(signal.idempotencyKey, 'idempotencyKey')
      : hashText(`${planId}:${orderId}:${sourceId}:${signalId}`, 'idempotencyKey'),
    attribution: normalizeAttribution(signal.attribution, sourceId, signalId),
  };
}

function normalizeAttribution(
  attribution: SignalAttributionPayload | undefined,
  sourceId: Hex,
  signalId: Hex,
): SignalAttributionCallStruct {
  if (attribution === undefined) {
    return ZERO_FACT_ATTRIBUTION;
  }
  const normalizedSourceId = normalizeBytes32(attribution.sourceId, 'attribution.sourceId');
  const normalizedSignalId = normalizeBytes32(attribution.signalId, 'attribution.signalId');
  const stageId = normalizeBytes32(attribution.stageId, 'attribution.stageId');
  if (stageId !== ZERO_BYTES32
    && (normalizedSourceId !== sourceId || normalizedSignalId !== signalId)) {
    throw new ValidationError(
      'attribution.sourceId/attribution.signalId must match the signal sourceId/signalId when attribution.stageId is non-zero:'
        + ' the contract rejects a mismatched fact key with InvalidFactAttribution',
    );
  }
  return {
    sourceId: normalizedSourceId,
    signalId: normalizedSignalId,
    stageId,
    capabilityProof: attribution.capabilityProof.map((word, index) =>
      normalizeBytes32(word, `attribution.capabilityProof[${index}]`)),
  };
}

function hashText(value: string, fieldName: string): Hex {
  if (typeof value !== 'string') {
    throw new ValidationError(`${fieldName} must be a string`);
  }
  return keccak256(stringToBytes(value));
}
