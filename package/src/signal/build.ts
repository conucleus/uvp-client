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
import { asNonEmptyString } from '../watcher/internal.js';
import type { StateMachineRawLog } from './decode.js';


export const DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV = DEFAULT_SIGNING_KEY_ENV;

export interface StateMachineSignal {
  readonly orderId: Hex | string;
  /**
   * The state machine ABI is plan-scoped, so every signal carries the
   * owning order's planId as the first submitSignal argument. The zero
   * placeholder is rejected before signing/broadcasting: it can never pass the
   * on-chain (planId, orderId) existence check.
   */
  readonly planId?: Hex | string;
  readonly source?: string;
  readonly stageIdentifier?: string;
  readonly signalName?: string;
  readonly sourceId?: Hex | string;
  readonly signalId?: Hex | string;
  readonly payloadHash?: Hex | string;
  /** Off-chain metadata only: the frozen submitSignal ABI cannot carry it on chain. */
  readonly payloadRef?: string;
  readonly idempotencyKey?: string;
  /**
   * 事实属主自证（relation=0 能力叶的 membership 证明）：省略时编码为
   * 全零结构（词表外口径，合约按 stageId==0 不声明处理，兼容无词表 plan）。
   * 证明不进签名信封——PRODUCT_SUBMIT typed-data 摘要与本字段无关。
   */
  readonly attribution?: SignalAttributionPayload;
}

export interface StateMachineSignalCallArgs {
  readonly planId: Hex;
  readonly orderId: Hex;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly payloadHash: Hex;
  readonly idempotencyKey: Hex;
  /** 归一化后的属主自证；缺省输入编码为全零结构。 */
  readonly attribution: SignalAttributionCallStruct;
}

/**
 * 全零 FactAttribution：stageId==0 即"不声明属主"（词表外事实口径），
 * 与合约 _verifiedFactOwner 的 stageId==0 早退分支一致。无词表 plan 与
 * 未携带证明材料的提交方共用该编码。
 */
export const ZERO_FACT_ATTRIBUTION: SignalAttributionCallStruct = {
  sourceId: ZERO_BYTES32,
  signalId: ZERO_BYTES32,
  stageId: ZERO_BYTES32,
  capabilityProof: [],
};

/** 造证材料：plan 冻结能力词表（selector 绑定表 + 信号能力表）的链下镜像。 */
export interface StateMachineCapabilityTables {
  readonly selectorBindings: readonly StageSelectorBindingTableEntry[];
  readonly signalCapabilities: readonly SignalCapabilityTableEntry[];
}

/**
 * 抽出 artifact 索引里内嵌的两张能力词表。两表皆缺（或皆空）意味着 plan
 * 无词表：不存在成员证明可言，返回 undefined 让调用方按全零缺省提交。
 */
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

/**
 * 现场造证：能力树是 plan 冻结的，成员证明可由词表镜像随时重算。信号
 * 命中能力表（relation=0 属主）时补 attribution。镜像未命中时不猜测、
 * 原样返回（全零缺省）：携词表的 plan 上链会被 InvalidSignalCapability
 * 响亮拒绝，零词表 plan 才按 source==stage 回退解析。显式携带证明的
 * 信号不被覆盖。
 */
export function withCapabilityProofs(
  signal: StateMachineSignal,
  tables: StateMachineCapabilityTables | undefined,
): StateMachineSignal {
  if (tables === undefined || signal.attribution !== undefined) {
    return signal;
  }
  // 造证需要与链上提交一致的 (sourceId, signalId) 解析口径，复用归一化
  // 而不是重推一份哈希规则。
  const normalized = normalizeStateMachineSignal(signal);
  const attribution = factAttributionShape(
    factAttribution(tables.selectorBindings, tables.signalCapabilities, normalized.sourceId, normalized.signalId),
    normalized.sourceId,
    normalized.signalId,
  );
  if (attribution === undefined) {
    // 词表外事实：不声明属主（全零）。
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
  /**
   * Optional direct receipt lookup used by the replay guard: before a
   * retryable failure triggers a rebroadcast, the watcher checks whether the
   * already-broadcast transaction actually mined. Resolves null/undefined when
   * the receipt is not (yet) available.
   */
  getTransactionReceipt?(args: {
    readonly hash: Hex;
  }): Promise<{ readonly status?: 'success' | 'reverted' | string } | null | undefined>;
  /**
   * Optional canonical block lookup powering the reorg defenses: the genesis
   * hash binds the cursor identity to one chain, and per-round block hashes
   * anchor the cursor continuity check. Absent on a client, all hash-based
   * defenses degrade to the finality buffer alone.
   */
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
  const args = normalizeStateMachineSignal(signal);
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
    // Default ON: a broadcast whose receipt is never observed cannot be told
    // apart from a reverted one, so waiting is the safe single path. Callers
    // that explicitly opt out (`waitForReceipt: false`) keep unconfirmed jobs
    // non-terminal so the outcome is re-checked on a later scan instead of
    // being trusted.
    waitForReceipt: config.waitForReceipt ?? true,
    ...(config.publicClient ? { publicClient: config.publicClient } : {}),
  };
}

function normalizeStateMachineSignal(signal: StateMachineSignal): StateMachineSignalCallArgs {
  // submitSignal is plan-scoped. Unlike the payloadHash zero
  // sentinel below, a zero planId is NOT a legitimate encoding: the contract
  // verifies that (planId, orderId) exists, so the zero placeholder can only
  // produce a transaction that reverts. Refuse to build it instead of letting
  // the executor broadcast a doomed tx.
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
  // Protocol-defined sentinel, not a fallback: the UVPStateMachine submitSignal
  // ABI defines bytes32(0) as the legitimate encoding of "no payload".
  // A producer omitting payloadHash is asserting an empty payload on chain.
  const payloadHash = signal.payloadHash ? normalizeBytes32(signal.payloadHash, 'payloadHash') : ZERO_BYTES32;
  // Signal attribution is mandatory: hashing the empty string here minted one
  // constant pseudo sourceId shared by every unattributed signal, silently
  // collapsing the chain's (…, sourceId, signalId) identity across producers.
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
    // Default keyed to the contract's SignalAlreadyExists tuple
    // (planId, orderId, sourceId, signalId): the same logical signal keeps the
    // same key even when its HookReady event is re-emitted in a new
    // transaction after a deep reorg, so the chain's dedupe sees one identity
    // instead of a fresh key per event anchor (which put a guaranteed-reverting
    // duplicate broadcast on chain).
    idempotencyKey: signal.idempotencyKey
      ? hashText(signal.idempotencyKey, 'idempotencyKey')
      : hashText(`${planId}:${orderId}:${sourceId}:${signalId}`, 'idempotencyKey'),
    attribution: normalizeAttribution(signal.attribution, sourceId, signalId),
    // The emitting HookReady event anchor is off-chain correlation context
    // only. It is deliberately absent from both the call args and the default
    // key: the contract never sees it, and off-chain metadata must not
    // participate in the idempotency verdict.
  };
}

/**
 * 归一化事实属主自证。缺省编码为全零结构（stageId==0 不声明，词表外
 * 口径）。声明非零 stageId 时，结构内的 (sourceId, signalId) 必须与顶层
 * 事实键一致——否则合约必响 InvalidFactAttribution，与零 planId 同口径
 * 在构包期拒绝而不是广播一笔必回滚的交易。
 */
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
