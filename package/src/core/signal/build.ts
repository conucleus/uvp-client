/**
 * Signal submission surface: one SignalSubmission shape covers order signals,
 * trigger creation (orderId 0) and pure file patches (signalId 0). The
 * struct/ABI, typed-data field table, stageFilesHash and attribution hash are
 * single-sourced in @uvp-eth/protocol-bindings; this module only resolves
 * client inputs and builds the direct (empty-signature) call.
 */
import { keccak256, stringToBytes, type Address, type Hex } from 'viem';
import { onchainSignalId, onchainSourceId } from '@uvp-eth/compiler/browser';
import {
  buildSubmitSignalCall,
  factAttribution,
  stageFilesHash,
  type SignalAttributionCallStruct,
  type SignalAttributionPayload,
  type SignalCapabilityTableEntry,
  type StageFile,
  type StageSelectorBindingTableEntry,
  type SubmitSignalCall,
} from '@uvp-eth/protocol-bindings';
import {
  normalizeAddressChecksummed,
  normalizeBytes32,
  parsePositiveInteger,
  ValidationError,
} from '../validation.js';
import { ZERO_BYTES32 } from '../constants.js';
import { asNonEmptyString } from '../internal.js';
import type { StateMachineRawLog } from './decode.js';

export { buildSubmitSignalCall, stageFilesHash } from '@uvp-eth/protocol-bindings';
export type {
  SignalSubmissionCallStruct,
  SubmitSignalCall,
  SubmitSignalCallArgs,
  SubmitSignalCallConfig,
} from '@uvp-eth/protocol-bindings';

export const DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV = 'UVP_EXECUTOR_PRIVATE_KEY';
export const DEFAULT_SIGNAL_DEADLINE_SECONDS = 3_600;

export interface StateMachineSignal {
  readonly planId?: Hex | string;
  /** Zero/absent = trigger creation (the contract generates the order id). */
  readonly orderId?: Hex | string;
  readonly source?: string;
  readonly stageIdentifier?: string;
  readonly signalName?: string;
  readonly sourceId?: Hex | string;
  /** Zero = pure file patch (orderId must be non-zero). */
  readonly signalId?: Hex | string;
  readonly payloadHash?: Hex | string;
  readonly idempotencyKey?: Hex | string;
  readonly attribution?: SignalAttributionPayload;
  readonly targetStageId?: Hex | string;
  readonly files?: readonly StageFile[];
  readonly deadline?: bigint | number | string;
}

export interface NormalizedStateMachineSignal {
  readonly planId: Hex;
  readonly orderId: Hex;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly payloadHash: Hex;
  readonly idempotencyKey: Hex;
  readonly attribution: SignalAttributionCallStruct;
  readonly targetStageId: Hex;
  readonly files: readonly StageFile[];
  readonly filesHash: Hex;
  readonly deadline?: bigint;
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

export type SubmitStateMachineSignalCall = SubmitSignalCall & {
  readonly chainId: number;
  readonly from?: Address;
};

export interface SubmitStateMachineSignalConfig {
  readonly stateMachineAddress?: Address | string;
  readonly rpcUrl: string;
  readonly chainId: number | string;
  readonly walletAddress?: Address | string;
  readonly privateKeyEnv?: string;
  readonly dryRun?: boolean;
  readonly waitForReceipt?: boolean;
  readonly deadlineSeconds?: number | string;
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
  }): Promise<{
    readonly status?: 'success' | 'reverted' | string;
    readonly logs?: readonly StateMachineRawLog[];
  } | null | undefined>;
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
  const submitter = from ?? normalizedConfig.walletAddress;
  if (!submitter) {
    throw new ValidationError(
      'submitSignal needs the submitting wallet: pass the wallet address or configure a wallet/private-key env',
    );
  }
  const deadline = resolveSignalDeadline(args.deadline, normalizedConfig.deadlineSeconds);
  const call = buildSubmitSignalCall(
    { stateMachineAddress: normalizedConfig.stateMachineAddress, chainId: normalizedConfig.chainId },
    {
      planId: args.planId,
      orderId: args.orderId,
      sourceId: args.sourceId,
      signalId: args.signalId,
      payloadHash: args.payloadHash,
      idempotencyKey: args.idempotencyKey,
      attribution: args.attribution,
      targetStageId: args.targetStageId,
      files: args.files,
      submitter,
      deadline,
    },
  );
  return {
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
    data: call.data,
    chainId: normalizedConfig.chainId,
    from: submitter,
  };
}

export interface NormalizedSubmitConfig extends SubmitStateMachineSignalConfig {
  readonly stateMachineAddress: Address;
  readonly chainId: number;
  readonly walletAddress?: Address;
  readonly privateKeyEnv: string;
  readonly dryRun: boolean;
  readonly waitForReceipt: boolean;
  readonly deadlineSeconds: number;
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
    deadlineSeconds: config.deadlineSeconds === undefined
      ? DEFAULT_SIGNAL_DEADLINE_SECONDS
      : parsePositiveInteger(config.deadlineSeconds, 'deadlineSeconds'),
    ...(config.publicClient ? { publicClient: config.publicClient } : {}),
  };
}

export function normalizeSignalPlanId(rawPlanId: Hex | string | undefined): Hex {
  if (rawPlanId === undefined || (typeof rawPlanId === 'string' && rawPlanId.trim().length === 0)) {
    throw new ValidationError('planId is required to submit a state machine signal');
  }
  const planId = normalizeBytes32(rawPlanId, 'planId');
  if (planId === ZERO_BYTES32) {
    throw new ValidationError('planId must be a non-zero bytes32');
  }
  return planId;
}

/** Normalized SignalSubmission fields shared by the direct builder and the signed relay operation. */
export function normalizeSignalSubmission(signal: StateMachineSignal): NormalizedStateMachineSignal {
  const planId = normalizeSignalPlanId(signal.planId);
  const orderId = signal.orderId === undefined ? ZERO_BYTES32 : normalizeBytes32(signal.orderId, 'orderId');
  const signalId = resolveSignalId(signal);
  const sourceId = resolveSourceId(signal, signalId);
  const payloadHash = signal.payloadHash === undefined
    ? ZERO_BYTES32
    : normalizeBytes32(signal.payloadHash, 'payloadHash');
  const files = signal.files === undefined || signal.files.length === 0 ? [] : signal.files;
  const filesHash = stageFilesHash(files);
  const targetStageId = signal.targetStageId === undefined
    ? ZERO_BYTES32
    : normalizeBytes32(signal.targetStageId, 'targetStageId');
  const idempotencyKey = resolveIdempotencyKey(signal.idempotencyKey, {
    planId,
    orderId,
    sourceId,
    signalId,
    payloadHash,
    targetStageId,
    filesHash,
  });
  return {
    planId,
    orderId,
    sourceId,
    signalId,
    payloadHash,
    idempotencyKey,
    attribution: normalizeAttribution(signal.attribution, sourceId, signalId),
    targetStageId,
    files,
    filesHash,
    ...(signal.deadline === undefined ? {} : { deadline: parseDeadline(signal.deadline, 'deadline') }),
  };
}

function resolveSignalId(signal: StateMachineSignal): Hex {
  if (signal.signalId !== undefined) {
    return normalizeBytes32(signal.signalId, 'signalId');
  }
  if ((signal.signalName ?? '').trim().length === 0) {
    throw new ValidationError('signal.signalName (or signal.signalId) is required; signalId 0 marks a pure file patch');
  }
  const signalName = signal.signalName && signal.stageIdentifier && !signal.signalName.includes('.')
    ? `${signal.stageIdentifier}.${signal.signalName}`
    : signal.signalName;
  return onchainSignalId(asNonEmptyString(signalName, 'signalName'));
}

function resolveSourceId(signal: StateMachineSignal, signalId: Hex): Hex {
  if (signal.sourceId !== undefined) {
    return normalizeBytes32(signal.sourceId, 'sourceId');
  }
  if ((signal.source ?? '').trim().length > 0) {
    return onchainSourceId(signal.source!);
  }
  if (signalId === ZERO_BYTES32) {
    return ZERO_BYTES32;
  }
  throw new ValidationError(
    'signal.source (or signal.sourceId) is required to submit a state machine signal',
  );
}

function resolveIdempotencyKey(
  raw: Hex | string | undefined,
  identity: {
    readonly planId: Hex;
    readonly orderId: Hex;
    readonly sourceId: Hex;
    readonly signalId: Hex;
    readonly payloadHash: Hex;
    readonly targetStageId: Hex;
    readonly filesHash: Hex;
  },
): Hex {
  const text = typeof raw === 'string' ? raw.trim() : raw;
  if (text !== undefined && text !== '') {
    const key = typeof text === 'string' && text.startsWith('0x')
      ? normalizeBytes32(text, 'idempotencyKey')
      : hashText(String(text), 'idempotencyKey');
    if (key === ZERO_BYTES32) {
      throw new ValidationError('idempotencyKey must be non-zero');
    }
    return key;
  }
  if (identity.orderId === ZERO_BYTES32) {
    throw new ValidationError(
      'idempotencyKey is required for trigger creation (orderId 0): the state machine keeps (submitter, idempotencyKey) -> orderId so a retried trigger cannot create a second order',
    );
  }
  // Stable per signal identity so retried submissions/deduped watcher requests keep the same key.
  return hashText(
    `uvp:signal-idempotency:v1:${identity.planId}:${identity.orderId}:${identity.sourceId}:${identity.signalId}:${identity.payloadHash}:${identity.targetStageId}:${identity.filesHash}`,
    'idempotencyKey',
  );
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
      'attribution.sourceId/attribution.signalId must match the signal sourceId/signalId when attribution.stageId is non-zero',
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

export function parseDeadline(value: bigint | number | string, fieldName: string): bigint {
  let deadline: bigint;
  if (typeof value === 'bigint') {
    deadline = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ValidationError(`${fieldName} must be a non-negative safe integer`);
    }
    deadline = BigInt(value);
  } else {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
      throw new ValidationError(`${fieldName} must be a non-negative integer string`);
    }
    deadline = BigInt(value);
  }
  if (deadline === 0n) {
    throw new ValidationError(`${fieldName} must be non-zero: the state machine rejects an expired submission`);
  }
  return deadline;
}

export function resolveSignalDeadline(
  explicit: bigint | undefined,
  deadlineSeconds: number,
  nowMs: number = Date.now(),
): bigint {
  if (explicit !== undefined) {
    return explicit;
  }
  return BigInt(Math.floor(nowMs / 1_000)) + BigInt(deadlineSeconds);
}

function hashText(value: string, fieldName: string): Hex {
  if (typeof value !== 'string') {
    throw new ValidationError(`${fieldName} must be a string`);
  }
  return keccak256(stringToBytes(value));
}