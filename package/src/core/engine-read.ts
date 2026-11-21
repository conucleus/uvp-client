/**
 * Engine contract read surface: typed direct views of UVPStateMachine,
 * UVPStateMachineLens and UVPSupplierRegistry; ABI single source is
 * @uvp-eth/protocol-bindings and any failed read is an explicit error.
 */
import { createPublicClient, http, type Address, type Hex } from 'viem';
import {
  STATE_MACHINE_ABI,
  STATE_MACHINE_LENS_ABI,
  SUPPLIER_REGISTRY_ABI,
} from '@uvp-eth/protocol-bindings';
import type { StageFilesReadClient } from './signal/files.js';
import {
  hookStatusWordOf,
  supplierStatusWordOf,
  type HookStatusWord,
  type SupplierStatusWord,
} from './status-words.js';
import {
  ExecutorKitError,
  normalizeAddressChecksummed,
  normalizeBytes32,
} from './validation.js';

export type EngineReadErrorCode = 'invalid_config' | 'invalid_input' | 'read_failed' | 'invalid_response';

export class EngineReadError extends ExecutorKitError {
  override readonly name = 'EngineReadError';
  readonly code: EngineReadErrorCode;

  constructor(code: EngineReadErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message);
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export type EngineReadClient = StageFilesReadClient;

export interface StateMachineReadConfig {
  /** Required unless publicClient is supplied (browser hosts inject one). */
  readonly rpcUrl?: string | undefined;
  readonly stateMachineAddress: Address | string;
  readonly publicClient?: EngineReadClient;
}

export interface SupplierRegistryReadConfig {
  /** Required unless publicClient is supplied (browser hosts inject one). */
  readonly rpcUrl?: string | undefined;
  readonly supplierRegistryAddress: Address | string;
  readonly publicClient?: EngineReadClient;
}

export interface HookKey {
  readonly planId: Hex | string;
  readonly orderId: Hex | string;
  readonly hookId: Hex | string;
}

export interface SignalKey {
  readonly planId: Hex | string;
  readonly orderId: Hex | string;
  readonly sourceId: Hex | string;
  readonly signalId: Hex | string;
}

export interface StageKey {
  readonly planId: Hex | string;
  readonly orderId: Hex | string;
  readonly stageId: Hex | string;
}

export interface HookStatusRead {
  readonly status: HookStatusWord;
  readonly dueAt: bigint;
  readonly readyEmitted: boolean;
}

export interface SignalRead {
  readonly exists: boolean;
  readonly payloadHash: Hex;
  readonly idempotencyKey: Hex;
  readonly submittedAt: bigint;
  readonly submitter: Address;
}

export interface PlanState {
  readonly planId: Hex;
  readonly exists: boolean;
  readonly committed: boolean;
  readonly finalized: boolean;
  readonly publisher: Address;
  readonly planHash: Hex;
  readonly supplierBindingsRoot: Hex;
}

export type PlanCapabilitiesRootRead =
  | {
      readonly kind: 'available';
      readonly planId: Hex;
      readonly capabilitiesRoot: Hex;
    }
  | {
      readonly kind: 'unavailable';
      readonly planId: Hex;
      readonly reason: 'lens_not_configured';
    };

export type SupplierRegistrationRead =
  | {
      readonly kind: 'unregistered';
      readonly account: Address;
    }
  | {
      readonly kind: 'registered';
      readonly account: Address;
      readonly supplierId: Hex;
      readonly status: SupplierStatusWord;
    }
  | {
      readonly kind: 'unknown';
      readonly account: Address;
      readonly supplierId: Hex;
      readonly statusOrdinal: bigint;
    };

export async function getHookStatus(
  config: StateMachineReadConfig,
  key: HookKey,
): Promise<HookStatusRead> {
  const read = normalizeStateMachineRead(config);
  const value = await readOf(read, STATE_MACHINE_ABI, 'getHookStatus', read.stateMachineAddress, [
    bytes32Input(key.planId, 'planId'),
    bytes32Input(key.orderId, 'orderId'),
    bytes32Input(key.hookId, 'hookId'),
  ]);
  const fields = tupleOf(value, 'getHookStatus', 3);
  return {
    status: hookStatusWordOf(fields[0]),
    dueAt: uintOf(fields[1], 'getHookStatus.dueAt'),
    readyEmitted: boolOf(fields[2], 'getHookStatus.readyEmitted'),
  };
}

export async function getSignal(
  config: StateMachineReadConfig,
  key: SignalKey,
): Promise<SignalRead> {
  const read = normalizeStateMachineRead(config);
  const value = await readOf(read, STATE_MACHINE_ABI, 'getSignal', read.stateMachineAddress, [
    bytes32Input(key.planId, 'planId'),
    bytes32Input(key.orderId, 'orderId'),
    bytes32Input(key.sourceId, 'sourceId'),
    bytes32Input(key.signalId, 'signalId'),
  ]);
  const fields = tupleOf(value, 'getSignal', 5);
  return {
    exists: boolOf(fields[0], 'getSignal.exists'),
    payloadHash: bytes32Of(fields[1], 'getSignal.payloadHash'),
    idempotencyKey: bytes32Of(fields[2], 'getSignal.idempotencyKey'),
    submittedAt: uintOf(fields[3], 'getSignal.submittedAt'),
    submitter: addressOf(fields[4], 'getSignal.submitter'),
  };
}

export async function readPlanState(
  config: StateMachineReadConfig,
  planId: Hex | string,
): Promise<PlanState> {
  const read = normalizeStateMachineRead(config);
  const normalizedPlanId = bytes32Input(planId, 'planId');
  const [exists, committed, finalized, publisher, planHash, supplierBindingsRoot] = await Promise.all([
    readOf(read, STATE_MACHINE_ABI, 'planExists', read.stateMachineAddress, [normalizedPlanId]),
    readOf(read, STATE_MACHINE_ABI, 'planCommitted', read.stateMachineAddress, [normalizedPlanId]),
    readOf(read, STATE_MACHINE_ABI, 'planFinalized', read.stateMachineAddress, [normalizedPlanId]),
    readOf(read, STATE_MACHINE_ABI, 'planPublisher', read.stateMachineAddress, [normalizedPlanId]),
    readOf(read, STATE_MACHINE_ABI, 'planHash', read.stateMachineAddress, [normalizedPlanId]),
    readOf(read, STATE_MACHINE_ABI, 'planSupplierBindingsRoot', read.stateMachineAddress, [normalizedPlanId]),
  ]);
  return {
    planId: normalizedPlanId,
    exists: boolOf(exists, 'planExists'),
    committed: boolOf(committed, 'planCommitted'),
    finalized: boolOf(finalized, 'planFinalized'),
    publisher: addressOf(publisher, 'planPublisher'),
    planHash: bytes32Of(planHash, 'planHash'),
    supplierBindingsRoot: bytes32Of(supplierBindingsRoot, 'planSupplierBindingsRoot'),
  };
}

export async function readPlanCapabilitiesRoot(
  config: StateMachineReadConfig,
  planId: Hex | string,
): Promise<PlanCapabilitiesRootRead> {
  const read = normalizeStateMachineRead(config);
  const normalizedPlanId = bytes32Input(planId, 'planId');
  const lens = await readOf(read, STATE_MACHINE_ABI, 'lens', read.stateMachineAddress, []);
  const lensAddress = addressOf(lens, 'lens');
  if (lensAddress === ZERO_ADDRESS) {
    return { kind: 'unavailable', planId: normalizedPlanId, reason: 'lens_not_configured' };
  }
  const capabilitiesRoot = await readOf(read, STATE_MACHINE_LENS_ABI, 'planCapabilitiesRoot', lensAddress, [
    normalizedPlanId,
  ]);
  return {
    kind: 'available',
    planId: normalizedPlanId,
    capabilitiesRoot: bytes32Of(capabilitiesRoot, 'planCapabilitiesRoot'),
  };
}

export async function effectiveStageSupplier(
  config: StateMachineReadConfig,
  key: StageKey,
): Promise<Hex> {
  const read = normalizeStateMachineRead(config);
  const value = await readOf(read, STATE_MACHINE_ABI, 'effectiveStageSupplier', read.stateMachineAddress, [
    bytes32Input(key.planId, 'planId'),
    bytes32Input(key.orderId, 'orderId'),
    bytes32Input(key.stageId, 'stageId'),
  ]);
  return bytes32Of(value, 'effectiveStageSupplier');
}

export async function effectiveStageAccount(
  config: StateMachineReadConfig,
  key: StageKey,
): Promise<Address> {
  const read = normalizeStateMachineRead(config);
  const value = await readOf(read, STATE_MACHINE_ABI, 'effectiveStageAccount', read.stateMachineAddress, [
    bytes32Input(key.planId, 'planId'),
    bytes32Input(key.orderId, 'orderId'),
    bytes32Input(key.stageId, 'stageId'),
  ]);
  return addressOf(value, 'effectiveStageAccount');
}

/** Supplier registry address configured on the state machine (deployment manifests do not duplicate it). */
export async function supplierRegistry(config: StateMachineReadConfig): Promise<Address> {
  const read = normalizeStateMachineRead(config);
  const value = await readOf(read, STATE_MACHINE_ABI, 'supplierRegistry', read.stateMachineAddress, []);
  return addressOf(value, 'supplierRegistry');
}

export async function supplierIdOf(
  config: SupplierRegistryReadConfig,
  account: Address | string,
): Promise<Hex> {
  const read = normalizeSupplierRegistryRead(config);
  const value = await readOf(read, SUPPLIER_REGISTRY_ABI, 'supplierOf', read.supplierRegistryAddress, [
    addressInput(account, 'account'),
  ]);
  return bytes32Of(value, 'supplierOf');
}

export async function supplierAccountOf(
  config: SupplierRegistryReadConfig,
  supplierId: Hex | string,
): Promise<Address> {
  const read = normalizeSupplierRegistryRead(config);
  const value = await readOf(read, SUPPLIER_REGISTRY_ABI, 'accountOf', read.supplierRegistryAddress, [
    bytes32Input(supplierId, 'supplierId'),
  ]);
  return addressOf(value, 'accountOf');
}

export async function supplierStatusOf(
  config: SupplierRegistryReadConfig,
  supplierId: Hex | string,
): Promise<SupplierStatusWord> {
  const read = normalizeSupplierRegistryRead(config);
  const value = await readOf(read, SUPPLIER_REGISTRY_ABI, 'statusOf', read.supplierRegistryAddress, [
    bytes32Input(supplierId, 'supplierId'),
  ]);
  const ordinal = uintOf(value, 'statusOf');
  return supplierStatusWordOf(Number(ordinal));
}

export async function readSupplierRegistration(
  config: SupplierRegistryReadConfig,
  account: Address | string,
): Promise<SupplierRegistrationRead> {
  const read = normalizeSupplierRegistryRead(config);
  const normalizedAccount = addressInput(account, 'account');
  const supplierId = bytes32Of(
    await readOf(read, SUPPLIER_REGISTRY_ABI, 'supplierOf', read.supplierRegistryAddress, [normalizedAccount]),
    'supplierOf',
  );
  if (supplierId === ZERO_BYTES32) {
    return { kind: 'unregistered', account: normalizedAccount };
  }
  const statusOrdinal = uintOf(
    await readOf(read, SUPPLIER_REGISTRY_ABI, 'statusOf', read.supplierRegistryAddress, [supplierId]),
    'statusOf',
  );
  const status = supplierStatusWordOf(Number(statusOrdinal));
  if (status === 'unknown') {
    return {
      kind: 'unknown',
      account: normalizedAccount,
      supplierId,
      statusOrdinal,
    };
  }
  return { kind: 'registered', account: normalizedAccount, supplierId, status };
}

export async function isActiveSupplier(
  config: SupplierRegistryReadConfig,
  supplierId: Hex | string,
): Promise<boolean> {
  const read = normalizeSupplierRegistryRead(config);
  const value = await readOf(read, SUPPLIER_REGISTRY_ABI, 'isActiveSupplier', read.supplierRegistryAddress, [
    bytes32Input(supplierId, 'supplierId'),
  ]);
  return boolOf(value, 'isActiveSupplier');
}

interface NormalizedStateMachineRead {
  readonly stateMachineAddress: Address;
  readonly publicClient: EngineReadClient;
}

interface NormalizedSupplierRegistryRead {
  readonly supplierRegistryAddress: Address;
  readonly publicClient: EngineReadClient;
}

function normalizeStateMachineRead(config: StateMachineReadConfig): NormalizedStateMachineRead {
  return {
    stateMachineAddress: addressConfig(config.stateMachineAddress, 'stateMachineAddress'),
    publicClient: readClient(config.rpcUrl, config.publicClient),
  };
}

function normalizeSupplierRegistryRead(config: SupplierRegistryReadConfig): NormalizedSupplierRegistryRead {
  return {
    supplierRegistryAddress: addressConfig(config.supplierRegistryAddress, 'supplierRegistryAddress'),
    publicClient: readClient(config.rpcUrl, config.publicClient),
  };
}

function addressConfig(raw: Address | string, field: string): Address {
  try {
    return normalizeAddressChecksummed(raw, field);
  } catch (error) {
    throw new EngineReadError(
      'invalid_config',
      `${field} is not a valid address: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function readClient(rpcUrl: string | undefined, client: EngineReadClient | undefined): EngineReadClient {
  if (client !== undefined) {
    return client;
  }
  if (typeof rpcUrl !== 'string' || rpcUrl.trim().length === 0) {
    throw new EngineReadError('invalid_config', 'engine reads require rpcUrl or an injected publicClient');
  }
  return createPublicClient({ transport: http(rpcUrl) }) as unknown as EngineReadClient;
}

async function readOf(
  read: NormalizedStateMachineRead | NormalizedSupplierRegistryRead,
  abi: readonly unknown[],
  functionName: string,
  address: Address,
  args: readonly unknown[],
): Promise<unknown> {
  try {
    return await read.publicClient.readContract({ address, abi, functionName, args });
  } catch (error) {
    throw new EngineReadError(
      'read_failed',
      `${functionName} read against ${address} failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function addressInput(value: Address | string, field: string): Address {
  try {
    return normalizeAddressChecksummed(value, field);
  } catch (error) {
    throw new EngineReadError(
      'invalid_input',
      `${field} is not a valid address: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function bytes32Input(value: Hex | string, field: string): Hex {
  try {
    return normalizeBytes32(value, field);
  } catch (error) {
    throw new EngineReadError(
      'invalid_input',
      `${field} is not a bytes32 value: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function tupleOf(value: unknown, functionName: string, length: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw invalidResponse(`${functionName} did not return ${length} values`);
  }
  return value;
}

function boolOf(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw invalidResponse(`${field} did not return a boolean`);
  }
  return value;
}

function bytes32Of(value: unknown, field: string): Hex {
  if (typeof value !== 'string') {
    throw invalidResponse(`${field} did not return a bytes32 hex string`);
  }
  try {
    return normalizeBytes32(value, field);
  } catch (error) {
    throw invalidResponse(`${field} did not return a bytes32 hex string: ${errorMessage(error)}`);
  }
}

function addressOf(value: unknown, field: string): Address {
  if (typeof value !== 'string') {
    throw invalidResponse(`${field} did not return an address`);
  }
  try {
    return normalizeAddressChecksummed(value, field);
  } catch (error) {
    throw invalidResponse(`${field} did not return an address: ${errorMessage(error)}`);
  }
}

function uintOf(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw invalidResponse(`${field} did not return an unsigned integer`);
}

function invalidResponse(message: string): EngineReadError {
  return new EngineReadError('invalid_response', message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as Hex;
