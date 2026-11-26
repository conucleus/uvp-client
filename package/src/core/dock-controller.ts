/**
 * UVPDockController client surface: EIP-712 bind-link signing, direct write
 * submission (txSender or viem WalletClient), and typed contract reads.
 * ABI, EIP-712 typed data, and calldata builders are single-sourced in
 * @uvp-eth/protocol-bindings.
 */
import {
  createPublicClient,
  http,
  isHex,
  type Address,
  type Hex,
  type TypedDataDefinition,
} from 'viem';
import {
  DOCK_BIND_LINK_EIP712_TYPES,
  DOCK_BIND_LINK_PRIMARY_TYPE,
  DOCK_CONTROLLER_ABI,
  DOCK_CONTROLLER_CONTRACT_NAME,
  DOCK_CONTROLLER_DOMAIN_VERSION,
  buildBindLinkCall,
  buildBindLinkDigestCall,
  buildBindLinkPairCall,
  buildBindLinkTypedDataFor,
  buildDockOutputWindowCall,
  buildGetDockCall,
  buildGetDockOutputCall,
  buildGetLinkCall,
  buildGetStageLinkCall,
  buildReconcileCall,
  buildReconcileOutputCall,
  buildRegisterDockCall,
  type BindLinkPairCallArgs,
  type DockAtomCallInput,
  type DockBindLinkRequestInput,
  type DockBindLinkTypedData,
  type DockBindLinkTypedDataInput,
  type DockControllerCallConfig,
  type DockControllerReadCall,
  type DockControllerTransactionCall,
  type DockOutputCallInput,
  type RegisterDockCallArgs,
} from '@uvp-eth/protocol-bindings';
import type { EngineReadClient } from './engine-read.js';
import {
  ExecutorKitError,
  normalizeAddressChecksummed,
  normalizeBytes32,
  parseBigNumberish,
} from './validation.js';

export {
  DOCK_BIND_LINK_EIP712_TYPES,
  DOCK_BIND_LINK_PRIMARY_TYPE,
  DOCK_CONTROLLER_ABI,
  DOCK_CONTROLLER_CONTRACT_NAME,
  DOCK_CONTROLLER_DOMAIN_VERSION,
  buildBindLinkCall,
  buildBindLinkDigestCall,
  buildBindLinkPairCall,
  buildBindLinkTypedDataFor,
  buildDockOutputWindowCall,
  buildGetDockCall,
  buildGetDockOutputCall,
  buildGetLinkCall,
  buildGetStageLinkCall,
  buildReconcileCall,
  buildReconcileOutputCall,
  buildRegisterDockCall,
};

export type {
  BindLinkPairCallArgs,
  DockAtomCallInput,
  DockBindLinkRequestInput,
  DockBindLinkTypedData,
  DockBindLinkTypedDataInput,
  DockControllerCallConfig,
  DockControllerReadCall,
  DockControllerTransactionCall,
  DockOutputCallInput,
  RegisterDockCallArgs,
};

export type DockControllerErrorCode =
  | 'invalid_config'
  | 'invalid_input'
  | 'sign_failed'
  | 'write_failed'
  | 'read_failed'
  | 'invalid_response';

export class DockControllerError extends ExecutorKitError {
  override readonly name = 'DockControllerError';
  readonly code: DockControllerErrorCode;

  constructor(
    code: DockControllerErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message);
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export interface DockBindLinkSigner {
  signTypedData(typedData: TypedDataDefinition): Promise<Hex>;
}

export interface DockControllerTransactionSender {
  sendTransaction(args: {
    readonly to: Address;
    readonly data: Hex;
    readonly chainId?: number;
  }): Promise<Hex>;
}

export interface DockControllerWalletClient {
  readonly account?: unknown;
  sendTransaction(args: {
    readonly to: Address;
    readonly data: Hex;
    readonly chain?: null;
  }): Promise<Hex>;
}

export interface DockControllerWriteConfig extends DockControllerCallConfig {
  readonly txSender?: DockControllerTransactionSender | undefined;
  readonly walletClient?: DockControllerWalletClient | undefined;
}

export interface DockControllerReadConfig {
  readonly rpcUrl?: string | undefined;
  readonly dockControllerAddress: Address | string;
  readonly publicClient?: EngineReadClient | undefined;
}

export interface DockControllerClientConfig
  extends DockControllerWriteConfig,
    DockControllerReadConfig {
  readonly signer?: DockBindLinkSigner | undefined;
}

export interface DockRead {
  readonly fromPlanId: Hex;
  readonly fromSourceId: Hex;
  readonly toPlanId: Hex;
  readonly toStageId: Hex;
  readonly toSourceId: Hex;
  readonly docHash: Hex;
  readonly publisher: Address;
  readonly exists: boolean;
}

export interface DockAtomRead {
  readonly stageId: Hex;
  readonly signalId: Hex;
  readonly relation: number;
}

export interface DockWindowInstructionRead {
  readonly op: number;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly arity: number;
  readonly delaySeconds: bigint;
}

export interface DockOutputRead {
  readonly signalId: Hex;
  readonly relation: number;
  readonly atoms: readonly DockAtomRead[];
  readonly window: readonly DockWindowInstructionRead[];
}

export interface DockLinkRead {
  readonly dkid: Hex;
  readonly fromPlanId: Hex;
  readonly fromOrderId: Hex;
  readonly toPlanId: Hex;
  readonly toOrderId: Hex;
  readonly toStageId: Hex;
  readonly toConsent: Address;
  readonly boundAt: bigint;
  readonly exists: boolean;
}

export interface DockOutputWindowRead {
  readonly active: boolean;
  readonly srcSatisfied: boolean;
  readonly srcDueAt: bigint;
  readonly dstAdmissionReady: boolean;
  readonly emitted: boolean;
}

export interface UVPDockControllerClient {
  signBindLink(req: DockBindLinkTypedDataInput, signer?: DockBindLinkSigner): Promise<Hex>;
  registerDock(args: RegisterDockCallArgs): Promise<Hex>;
  bindLink(req: DockBindLinkRequestInput, toSignature?: Hex | string): Promise<Hex>;
  bindLinkPair(args: BindLinkPairCallArgs): Promise<Hex>;
  reconcile(
    linkId: Hex | string,
    outputCapabilityProofs: readonly (readonly (Hex | string)[])[],
  ): Promise<Hex>;
  reconcileOutput(
    linkId: Hex | string,
    outputIndex: bigint | number,
    capabilityProof: readonly (Hex | string)[],
  ): Promise<Hex>;
  getDock(dkid: Hex | string): Promise<DockRead>;
  getDockOutput(dkid: Hex | string, outputIndex: bigint | number): Promise<DockOutputRead>;
  getLink(linkId: Hex | string): Promise<DockLinkRead>;
  getStageLink(
    toPlanId: Hex | string,
    toOrderId: Hex | string,
    toStageId: Hex | string,
  ): Promise<Hex>;
  dockOutputWindow(
    linkId: Hex | string,
    outputIndex: bigint | number,
  ): Promise<DockOutputWindowRead>;
}

export async function signBindLink(
  config: DockControllerCallConfig,
  req: DockBindLinkTypedDataInput,
  signer: DockBindLinkSigner,
): Promise<Hex> {
  let typedData: DockBindLinkTypedData;
  try {
    typedData = buildBindLinkTypedDataFor(config, req);
  } catch (error) {
    throw new DockControllerError(
      'invalid_input',
      `bindLink typed data is invalid: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  let signature: unknown;
  try {
    signature = await signer.signTypedData(typedData as unknown as TypedDataDefinition);
  } catch (error) {
    throw new DockControllerError(
      'sign_failed',
      `bindLink signing failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (typeof signature !== 'string' || !isHex(signature) || signature.length % 2 !== 0) {
    throw new DockControllerError(
      'invalid_response',
      'bindLink signer returned a non-hex signature',
    );
  }
  return signature;
}

export async function registerDock(
  config: DockControllerWriteConfig,
  args: RegisterDockCallArgs,
): Promise<Hex> {
  const call = buildWriteCall('registerDock', () => buildRegisterDockCall(config, args));
  return sendWriteCall(config, call);
}

export async function bindLink(
  config: DockControllerWriteConfig,
  req: DockBindLinkRequestInput,
  toSignature: Hex | string = '0x',
): Promise<Hex> {
  const call = buildWriteCall('bindLink', () => buildBindLinkCall(config, req, toSignature));
  return sendWriteCall(config, call);
}

export async function bindLinkPair(
  config: DockControllerWriteConfig,
  args: BindLinkPairCallArgs,
): Promise<Hex> {
  const call = buildWriteCall('bindLinkPair', () => buildBindLinkPairCall(config, args));
  return sendWriteCall(config, call);
}

export async function reconcile(
  config: DockControllerWriteConfig,
  linkId: Hex | string,
  outputCapabilityProofs: readonly (readonly (Hex | string)[])[],
): Promise<Hex> {
  const call = buildWriteCall('reconcile', () =>
    buildReconcileCall(config, linkId, outputCapabilityProofs),
  );
  return sendWriteCall(config, call);
}

export async function reconcileOutput(
  config: DockControllerWriteConfig,
  linkId: Hex | string,
  outputIndex: bigint | number,
  capabilityProof: readonly (Hex | string)[],
): Promise<Hex> {
  const call = buildWriteCall('reconcileOutput', () =>
    buildReconcileOutputCall(config, linkId, outputIndex, capabilityProof),
  );
  return sendWriteCall(config, call);
}

export async function getDock(
  config: DockControllerReadConfig,
  dkid: Hex | string,
): Promise<DockRead> {
  const read = normalizeReadConfig(config);
  const value = await readOf(read, 'getDock', [bytes32Input(dkid, 'dkid')]);
  const fields = tupleOf(value, 'getDock', 8);
  return {
    fromPlanId: bytes32Of(fields[0], 'getDock.fromPlanId'),
    fromSourceId: bytes32Of(fields[1], 'getDock.fromSourceId'),
    toPlanId: bytes32Of(fields[2], 'getDock.toPlanId'),
    toStageId: bytes32Of(fields[3], 'getDock.toStageId'),
    toSourceId: bytes32Of(fields[4], 'getDock.toSourceId'),
    docHash: bytes32Of(fields[5], 'getDock.docHash'),
    publisher: addressOf(fields[6], 'getDock.publisher'),
    exists: boolOf(fields[7], 'getDock.exists'),
  };
}

export async function getDockOutput(
  config: DockControllerReadConfig,
  dkid: Hex | string,
  outputIndex: bigint | number,
): Promise<DockOutputRead> {
  const read = normalizeReadConfig(config);
  const value = await readOf(read, 'getDockOutput', [
    bytes32Input(dkid, 'dkid'),
    uintInput(outputIndex, 'outputIndex'),
  ]);
  const fields = tupleOf(value, 'getDockOutput', 4);
  if (!Array.isArray(fields[2])) {
    throw invalidResponse('getDockOutput.atoms did not return an array');
  }
  if (!Array.isArray(fields[3])) {
    throw invalidResponse('getDockOutput.window did not return an array');
  }
  return {
    signalId: bytes32Of(fields[0], 'getDockOutput.signalId'),
    relation: safeNumberOf(fields[1], 'getDockOutput.relation'),
    atoms: fields[2].map((atom, index) => dockAtomOf(atom, `getDockOutput.atoms[${index}]`)),
    window: fields[3].map((instruction, index) =>
      windowInstructionOf(instruction, `getDockOutput.window[${index}]`),
    ),
  };
}

export async function getLink(
  config: DockControllerReadConfig,
  linkId: Hex | string,
): Promise<DockLinkRead> {
  const read = normalizeReadConfig(config);
  const value = await readOf(read, 'getLink', [bytes32Input(linkId, 'linkId')]);
  if (Array.isArray(value)) {
    const fields = tupleOf(value, 'getLink', 9);
    return {
      dkid: bytes32Of(fields[0], 'getLink.dkid'),
      fromPlanId: bytes32Of(fields[1], 'getLink.fromPlanId'),
      fromOrderId: bytes32Of(fields[2], 'getLink.fromOrderId'),
      toPlanId: bytes32Of(fields[3], 'getLink.toPlanId'),
      toOrderId: bytes32Of(fields[4], 'getLink.toOrderId'),
      toStageId: bytes32Of(fields[5], 'getLink.toStageId'),
      toConsent: addressOf(fields[6], 'getLink.toConsent'),
      boundAt: uintOf(fields[7], 'getLink.boundAt'),
      exists: boolOf(fields[8], 'getLink.exists'),
    };
  }
  const record = recordOf(value, 'getLink');
  return {
    dkid: bytes32Of(record['dkid'], 'getLink.dkid'),
    fromPlanId: bytes32Of(record['fromPlanId'], 'getLink.fromPlanId'),
    fromOrderId: bytes32Of(record['fromOrderId'], 'getLink.fromOrderId'),
    toPlanId: bytes32Of(record['toPlanId'], 'getLink.toPlanId'),
    toOrderId: bytes32Of(record['toOrderId'], 'getLink.toOrderId'),
    toStageId: bytes32Of(record['toStageId'], 'getLink.toStageId'),
    toConsent: addressOf(record['toConsent'], 'getLink.toConsent'),
    boundAt: uintOf(record['boundAt'], 'getLink.boundAt'),
    exists: boolOf(record['exists'], 'getLink.exists'),
  };
}

export async function getStageLink(
  config: DockControllerReadConfig,
  toPlanId: Hex | string,
  toOrderId: Hex | string,
  toStageId: Hex | string,
): Promise<Hex> {
  const read = normalizeReadConfig(config);
  const value = await readOf(read, 'getStageLink', [
    bytes32Input(toPlanId, 'toPlanId'),
    bytes32Input(toOrderId, 'toOrderId'),
    bytes32Input(toStageId, 'toStageId'),
  ]);
  return bytes32Of(value, 'getStageLink');
}

export async function dockOutputWindow(
  config: DockControllerReadConfig,
  linkId: Hex | string,
  outputIndex: bigint | number,
): Promise<DockOutputWindowRead> {
  const read = normalizeReadConfig(config);
  const value = await readOf(read, 'dockOutputWindow', [
    bytes32Input(linkId, 'linkId'),
    uintInput(outputIndex, 'outputIndex'),
  ]);
  const fields = tupleOf(value, 'dockOutputWindow', 5);
  return {
    active: boolOf(fields[0], 'dockOutputWindow.active'),
    srcSatisfied: boolOf(fields[1], 'dockOutputWindow.srcSatisfied'),
    srcDueAt: uintOf(fields[2], 'dockOutputWindow.srcDueAt'),
    dstAdmissionReady: boolOf(fields[3], 'dockOutputWindow.dstAdmissionReady'),
    emitted: boolOf(fields[4], 'dockOutputWindow.emitted'),
  };
}

export function createDockControllerClient(
  config: DockControllerClientConfig,
): UVPDockControllerClient {
  return {
    signBindLink(req, signer = config.signer) {
      if (signer === undefined) {
        return Promise.reject(
          new DockControllerError(
            'invalid_config',
            'signBindLink requires a signer in client config or call arguments',
          ),
        );
      }
      return signBindLink(config, req, signer);
    },
    registerDock: (args) => registerDock(config, args),
    bindLink: (req, toSignature) => bindLink(config, req, toSignature),
    bindLinkPair: (args) => bindLinkPair(config, args),
    reconcile: (linkId, outputCapabilityProofs) =>
      reconcile(config, linkId, outputCapabilityProofs),
    reconcileOutput: (linkId, outputIndex, capabilityProof) =>
      reconcileOutput(config, linkId, outputIndex, capabilityProof),
    getDock: (dkid) => getDock(config, dkid),
    getDockOutput: (dkid, outputIndex) => getDockOutput(config, dkid, outputIndex),
    getLink: (linkId) => getLink(config, linkId),
    getStageLink: (toPlanId, toOrderId, toStageId) =>
      getStageLink(config, toPlanId, toOrderId, toStageId),
    dockOutputWindow: (linkId, outputIndex) => dockOutputWindow(config, linkId, outputIndex),
  };
}

interface NormalizedDockControllerRead {
  readonly dockControllerAddress: Address;
  readonly publicClient: EngineReadClient;
}

function buildWriteCall(
  functionName: DockControllerTransactionCall['functionName'],
  build: () => DockControllerTransactionCall,
): DockControllerTransactionCall {
  try {
    return build();
  } catch (error) {
    throw new DockControllerError(
      'invalid_input',
      `${functionName} arguments are invalid: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function sendWriteCall(
  config: DockControllerWriteConfig,
  call: DockControllerTransactionCall,
): Promise<Hex> {
  if (config.txSender === undefined && config.walletClient === undefined) {
    throw new DockControllerError(
      'invalid_config',
      `${call.functionName} requires txSender or walletClient`,
    );
  }
  let txHash: unknown;
  try {
    if (config.txSender !== undefined) {
      txHash = await config.txSender.sendTransaction({
        to: call.address,
        data: call.data,
        ...(call.chainId !== undefined ? { chainId: call.chainId } : {}),
      });
    } else {
      txHash = await config.walletClient!.sendTransaction({
        to: call.address,
        data: call.data,
        chain: null,
      });
    }
  } catch (error) {
    throw new DockControllerError(
      'write_failed',
      `${call.functionName} write against ${call.address} failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  return bytes32Of(txHash, `${call.functionName}.txHash`);
}

function normalizeReadConfig(config: DockControllerReadConfig): NormalizedDockControllerRead {
  let dockControllerAddress: Address;
  try {
    dockControllerAddress = normalizeAddressChecksummed(
      config.dockControllerAddress,
      'dockControllerAddress',
    );
  } catch (error) {
    throw new DockControllerError(
      'invalid_config',
      `dockControllerAddress is not a valid address: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  return {
    dockControllerAddress,
    publicClient: readClient(config.rpcUrl, config.publicClient),
  };
}

function readClient(
  rpcUrl: string | undefined,
  client: EngineReadClient | undefined,
): EngineReadClient {
  if (client !== undefined) {
    return client;
  }
  if (typeof rpcUrl !== 'string' || rpcUrl.trim().length === 0) {
    throw new DockControllerError(
      'invalid_config',
      'dock controller reads require rpcUrl or an injected publicClient',
    );
  }
  return createPublicClient({ transport: http(rpcUrl) }) as unknown as EngineReadClient;
}

async function readOf(
  read: NormalizedDockControllerRead,
  functionName: string,
  args: readonly unknown[],
): Promise<unknown> {
  try {
    return await read.publicClient.readContract({
      address: read.dockControllerAddress,
      abi: DOCK_CONTROLLER_ABI,
      functionName,
      args,
    });
  } catch (error) {
    throw new DockControllerError(
      'read_failed',
      `${functionName} read against ${read.dockControllerAddress} failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function bytes32Input(value: Hex | string, field: string): Hex {
  try {
    return normalizeBytes32(value, field);
  } catch (error) {
    throw new DockControllerError(
      'invalid_input',
      `${field} is not a bytes32 value: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function uintInput(value: bigint | number, field: string): bigint {
  try {
    const parsed = parseBigNumberish(value, field);
    if (parsed < 0n) {
      throw new Error(`${field} must be non-negative`);
    }
    return parsed;
  } catch (error) {
    throw new DockControllerError(
      'invalid_input',
      `${field} is not a non-negative integer: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function dockAtomOf(value: unknown, label: string): DockAtomRead {
  const record = recordOf(value, label);
  return {
    stageId: bytes32Of(record['stageId'], `${label}.stageId`),
    signalId: bytes32Of(record['signalId'], `${label}.signalId`),
    relation: safeNumberOf(record['relation'], `${label}.relation`),
  };
}

function windowInstructionOf(value: unknown, label: string): DockWindowInstructionRead {
  const record = recordOf(value, label);
  return {
    op: safeNumberOf(record['op'], `${label}.op`),
    sourceId: bytes32Of(record['sourceId'], `${label}.sourceId`),
    signalId: bytes32Of(record['signalId'], `${label}.signalId`),
    arity: safeNumberOf(record['arity'], `${label}.arity`),
    delaySeconds: uintOf(record['delaySeconds'], `${label}.delaySeconds`),
  };
}

function tupleOf(value: unknown, functionName: string, length: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw invalidResponse(`${functionName} did not return ${length} values`);
  }
  return value;
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidResponse(`${label} did not return a struct object`);
  }
  return value as Record<string, unknown>;
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
  if (typeof value === 'bigint' && value >= 0n) {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw invalidResponse(`${field} did not return an unsigned integer`);
}

function safeNumberOf(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  throw invalidResponse(`${field} did not return an unsigned safe integer`);
}

function invalidResponse(message: string): DockControllerError {
  return new DockControllerError('invalid_response', message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
