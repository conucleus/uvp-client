import type { Address, Hex } from 'viem';
import {
  normalizeAddress as normalizeAddressKey,
  normalizeAddressChecksummed as normalizeAddressChecksummedKey,
  normalizeBytes32 as normalizeBytes32Key,
} from '@uvp-eth/protocol-bindings';

export class ExecutorKitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorKitError';
  }
}

export class ValidationError extends ExecutorKitError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotImplementedExecutorKitError extends ExecutorKitError {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedExecutorKitError';
  }
}

function rethrowAsValidationError<T>(normalize: () => T): T {
  try {
    return normalize();
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : String(error));
  }
}

export function normalizeAddress(value: Address | string, fieldName = 'address'): Address {
  return rethrowAsValidationError(() => normalizeAddressKey(value, fieldName));
}

export function normalizeAddressChecksummed(value: Address | string, fieldName = 'address'): Address {
  return rethrowAsValidationError(() => normalizeAddressChecksummedKey(value, fieldName));
}

export function normalizeBytes32(value: Hex | string, fieldName = 'bytes32'): Hex {
  return rethrowAsValidationError(() => normalizeBytes32Key(value, fieldName));
}

export function parseBigNumberish(value: bigint | number | string, fieldName: string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ValidationError(`${fieldName} must be a non-negative safe integer`);
    }
    return BigInt(value);
  }

  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ValidationError(`${fieldName} must be a non-negative integer string`);
  }

  return BigInt(value);
}

export function parsePositiveInteger(value: number | string, fieldName: string): number {
  if (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ValidationError(`${fieldName} must be a positive integer string`);
  }

  const numberValue = typeof value === 'number' ? value : Number(value);

  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    throw new ValidationError(`${fieldName} must be a positive safe integer`);
  }

  return numberValue;
}
