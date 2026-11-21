/**
 * On-chain status ordinals: words are the @uvp-eth/chain-read-contract
 * vocabulary, ordinals are the Solidity enums behind the protocol-bindings ABIs.
 */
import type { ChainHookStatus, ChainSupplierStatus } from '@uvp-eth/chain-read-contract';

export const HOOK_STATUS_WORDS: readonly Exclude<ChainHookStatus, 'unknown'>[] = [
  'init',
  'waiting',
  'ready',
  'cancelled',
];
export type HookStatusWord = Exclude<ChainHookStatus, 'unknown'>;

export const SUPPLIER_STATUS_WORDS: readonly Exclude<ChainSupplierStatus, 'unknown'>[] = [
  'pending',
  'active',
  'suspended',
  'revoked',
];
export type SupplierStatusWord = Exclude<ChainSupplierStatus, 'unknown'>;

export function hookStatusWordOf(ordinal: unknown): HookStatusWord | undefined {
  return statusWordOf(HOOK_STATUS_WORDS, ordinal);
}

export function supplierStatusWordOf(ordinal: unknown): SupplierStatusWord | undefined {
  return statusWordOf(SUPPLIER_STATUS_WORDS, ordinal);
}

function statusWordOf<TWord extends string>(
  words: readonly TWord[],
  ordinal: unknown,
): TWord | undefined {
  if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= words.length) {
    return undefined;
  }
  return words[ordinal];
}
