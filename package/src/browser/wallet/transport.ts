/**
 * Browser wallet transport diagnostics: mechanical EIP-1193 provider-error
 * normalization (rejection, chain switch, timeout) and the transaction receipt
 * tri-state. Product-specific UX classification stays in the host.
 */
import {
  ChainDisconnectedError,
  ChainMismatchError,
  TimeoutError,
  UserRejectedRequestError,
  getAddress,
  isAddress,
  type Address,
  type Hex,
} from 'viem';
import { ValidationError } from '../../core/validation.js';
import type { Eip1193Provider } from './provider.js';

export type WalletTransportFailureKind = 'user_rejected' | 'timeout' | 'wrong_chain' | 'other';

export interface WalletTransportFailure {
  readonly kind: WalletTransportFailureKind;
  readonly message: string;
  readonly code?: number | undefined;
}

export function classifyWalletTransportFailure(error: unknown): WalletTransportFailure {
  const code = numericCodeOf(error);
  const message = errorMessage(error);
  if (
    error instanceof UserRejectedRequestError
    || code === 4001
    || /user rejected|user denied|rejected the request/i.test(message)
  ) {
    return failure('user_rejected', message, code);
  }
  if (
    error instanceof ChainMismatchError
    || error instanceof ChainDisconnectedError
    || code === 4901
    || code === 4902
    || /chain.?mismatch|wrong chain|unrecognized chain|chain not configured/i.test(message)
  ) {
    return failure('wrong_chain', message, code);
  }
  if (
    error instanceof TimeoutError
    || isTimeoutError(error)
    || /timed out|timeout|request expired/i.test(message)
  ) {
    return failure('timeout', message, code);
  }
  return failure('other', message, code);
}

export type WalletReceiptKind = 'success' | 'reverted' | 'not_found';

export interface WalletReceiptLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly logIndex?: number;
}

export interface WalletMinedReceipt {
  readonly kind: 'success' | 'reverted';
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly from: Address;
  readonly to: Address | null;
  readonly logs: readonly WalletReceiptLog[];
}

export interface WalletMissingReceipt {
  readonly kind: 'not_found';
  readonly txHash: Hex;
}

export type WalletTransactionReceipt = WalletMinedReceipt | WalletMissingReceipt;

export async function readWalletTransactionReceipt(
  provider: Eip1193Provider,
  transactionHash: Hex | string,
): Promise<WalletTransactionReceipt> {
  const txHash = requireTxHash(transactionHash);
  const raw = await provider.request({
    method: 'eth_getTransactionReceipt',
    params: [txHash],
  });
  if (raw === null) {
    return { kind: 'not_found', txHash };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('provider returned a non-object transaction receipt');
  }
  const receipt = raw as Record<string, unknown>;
  const status = receipt['status'];
  if (status !== '0x1' && status !== '0x0') {
    throw new ValidationError('provider returned a receipt without a success/reverted status');
  }
  return {
    kind: status === '0x1' ? 'success' : 'reverted',
    txHash,
    blockNumber: requireQuantity(receipt['blockNumber'], 'blockNumber'),
    from: requireAddress(receipt['from'], 'from'),
    to: requireAddressOrNull(receipt['to'], 'to'),
    logs: requireLogs(receipt['logs']),
  };
}

function failure(
  kind: WalletTransportFailureKind,
  message: string,
  code: number | undefined,
): WalletTransportFailure {
  return code === undefined ? { kind, message } : { kind, message, code };
}

function numericCodeOf(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    const code = (current as { readonly code?: unknown }).code;
    if (typeof code === 'number' && Number.isSafeInteger(code)) {
      return code;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return undefined;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function requireTxHash(value: Hex | string): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new ValidationError('transactionHash must be a 32-byte hex string');
  }
  return value as Hex;
}

function requireQuantity(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new ValidationError(`receipt ${field} must be a hex quantity`);
  }
  return BigInt(value);
}

function requireAddress(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new ValidationError(`receipt ${field} must be an address`);
  }
  return getAddress(value);
}

function requireAddressOrNull(value: unknown, field: string): Address | null {
  if (value === null) {
    return null;
  }
  return requireAddress(value, field);
}

function requireLogs(value: unknown): readonly WalletReceiptLog[] {
  if (!Array.isArray(value)) {
    throw new ValidationError('receipt logs must be an array');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ValidationError(`receipt logs[${index}] must be an object`);
    }
    const log = entry as Record<string, unknown>;
    const topics = log['topics'];
    if (
      !Array.isArray(topics)
      || topics.some((topic) => typeof topic !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(topic))
    ) {
      throw new ValidationError(`receipt logs[${index}].topics must be a 32-byte hex array`);
    }
    const logIndex = log['logIndex'];
    return {
      address: requireAddress(log['address'], `logs[${index}].address`),
      topics: topics as readonly Hex[],
      data: requireHex(log['data'], `logs[${index}].data`),
      ...(typeof logIndex === 'string' && /^0x[0-9a-fA-F]+$/.test(logIndex)
        ? { logIndex: Number(BigInt(logIndex)) }
        : {}),
    };
  });
}

function requireHex(value: unknown, field: string): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new ValidationError(`receipt ${field} must be hex data`);
  }
  return value as Hex;
}