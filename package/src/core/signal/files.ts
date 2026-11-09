/**
 * Stage file read surface: direct contract views of UVPFileResourceModule.
 * ABI single source is @uvp-eth/protocol-bindings (FILE_RESOURCE_MODULE_ABI);
 * this module only normalizes inputs, injects the public-client seam, and maps
 * failures to explicit codes so an unreachable or malformed read is never
 * reported as an empty file map entry.
 */
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { FILE_RESOURCE_MODULE_ABI } from '@uvp-eth/protocol-bindings';
import {
  ExecutorKitError,
  normalizeAddressChecksummed,
  normalizeBytes32,
} from '../validation.js';

export type StageFileReadErrorCode = 'invalid_config' | 'read_failed' | 'invalid_response';

export class StageFileReadError extends ExecutorKitError {
  override readonly name = 'StageFileReadError';
  readonly code: StageFileReadErrorCode;

  constructor(code: StageFileReadErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message);
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export interface StageFilesReadClient {
  readContract(args: {
    readonly address: Address;
    readonly abi: readonly unknown[];
    readonly functionName: string;
    readonly args: readonly unknown[];
  }): Promise<unknown>;
}

export interface StageFilesReadConfig {
  readonly rpcUrl: string;
  readonly fileResourceModuleAddress: Address | string;
  readonly publicClient?: StageFilesReadClient;
}

export interface StageFileKey {
  readonly planId: Hex | string;
  readonly orderId: Hex | string;
  readonly targetStageId: Hex | string;
}

export interface StageFileLookup extends StageFileKey {
  readonly key: Hex | string;
}

export interface StageFileRecord {
  readonly exists: boolean;
  readonly contentHash: Hex;
  readonly handle: string;
  readonly patchHash: Hex;
}

export async function getStageFile(
  config: StageFilesReadConfig,
  lookup: StageFileLookup,
): Promise<StageFileRecord> {
  const read = normalizeReadConfig(config);
  const value = await readContractOf(read, 'getStageFile', [
    normalizeBytes32Value(lookup.planId, 'planId'),
    normalizeBytes32Value(lookup.orderId, 'orderId'),
    normalizeBytes32Value(lookup.targetStageId, 'targetStageId'),
    normalizeBytes32Value(lookup.key, 'key'),
  ]);
  return stageFileRecordOf(value);
}

export async function stageFilesHash(
  config: StageFilesReadConfig,
  key: StageFileKey,
): Promise<Hex> {
  const read = normalizeReadConfig(config);
  const value = await readContractOf(read, 'stageFilesHash', [
    normalizeBytes32Value(key.planId, 'planId'),
    normalizeBytes32Value(key.orderId, 'orderId'),
    normalizeBytes32Value(key.targetStageId, 'targetStageId'),
  ]);
  if (typeof value !== 'string') {
    throw invalidResponse('stageFilesHash did not return a bytes32 hex string');
  }
  return normalizeBytes32Value(value, 'stageFilesHash');
}

interface NormalizedStageFilesReadConfig {
  readonly fileResourceModuleAddress: Address;
  readonly publicClient: StageFilesReadClient;
}

function normalizeReadConfig(config: StageFilesReadConfig): NormalizedStageFilesReadConfig {
  if (typeof config.rpcUrl !== 'string' || config.rpcUrl.trim().length === 0) {
    throw new StageFileReadError('invalid_config', 'stage file reads require a non-empty rpcUrl');
  }
  let fileResourceModuleAddress: Address;
  try {
    fileResourceModuleAddress = normalizeAddressChecksummed(
      config.fileResourceModuleAddress,
      'fileResourceModuleAddress',
    );
  } catch (error) {
    throw new StageFileReadError(
      'invalid_config',
      `fileResourceModuleAddress is not a valid address: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  return {
    fileResourceModuleAddress,
    publicClient: config.publicClient ?? defaultReadClient(config.rpcUrl),
  };
}

function defaultReadClient(rpcUrl: string): StageFilesReadClient {
  return createPublicClient({ transport: http(rpcUrl) }) as unknown as StageFilesReadClient;
}

async function readContractOf(
  config: NormalizedStageFilesReadConfig,
  functionName: 'getStageFile' | 'stageFilesHash',
  args: readonly unknown[],
): Promise<unknown> {
  try {
    return await config.publicClient.readContract({
      address: config.fileResourceModuleAddress,
      abi: FILE_RESOURCE_MODULE_ABI,
      functionName,
      args,
    });
  } catch (error) {
    throw new StageFileReadError(
      'read_failed',
      `${functionName} read against ${config.fileResourceModuleAddress} failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function stageFileRecordOf(value: unknown): StageFileRecord {
  if (!Array.isArray(value) || value.length !== 4) {
    throw invalidResponse('getStageFile did not return (exists, contentHash, handle, patchHash)');
  }
  const [exists, contentHash, handle, patchHash] = value as readonly unknown[];
  if (typeof exists !== 'boolean' || typeof handle !== 'string') {
    throw invalidResponse('getStageFile returned a non-boolean exists flag or non-string handle');
  }
  return {
    exists,
    contentHash: normalizeBytes32Value(contentHash, 'contentHash'),
    handle,
    patchHash: normalizeBytes32Value(patchHash, 'patchHash'),
  };
}

function normalizeBytes32Value(value: unknown, fieldName: string): Hex {
  if (typeof value !== 'string') {
    throw invalidResponse(`${fieldName} is not a bytes32 hex string`);
  }
  try {
    return normalizeBytes32(value, fieldName);
  } catch (error) {
    throw invalidResponse(`${fieldName} is not a bytes32 hex string: ${errorMessage(error)}`);
  }
}

function invalidResponse(message: string): StageFileReadError {
  return new StageFileReadError('invalid_response', message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
