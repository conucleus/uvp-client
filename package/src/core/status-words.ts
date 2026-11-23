/**
 * On-chain status words: the ordinal order is the Solidity enum order behind the
 * @uvp-eth/protocol-bindings ABIs (UVPStateMachine.HookStatus via getHookStatus,
 * IUVPIdentityRegistry.SupplierStatus via statusOf); an ordinal outside the
 * mapping is the explicit "unknown" word, never a thrown error.
 */

export const HOOK_STATUS_WORDS = ['init', 'waiting', 'ready', 'cancelled'] as const;
export type HookStatusWord = (typeof HOOK_STATUS_WORDS)[number] | 'unknown';

export const SUPPLIER_STATUS_WORDS = ['pending', 'active', 'suspended', 'revoked'] as const;
export type SupplierStatusWord = (typeof SUPPLIER_STATUS_WORDS)[number] | 'unknown';

export function hookStatusWordOf(ordinal: unknown): HookStatusWord {
  return statusWordOf(HOOK_STATUS_WORDS, ordinal) ?? 'unknown';
}

export function supplierStatusWordOf(ordinal: unknown): SupplierStatusWord {
  return statusWordOf(SUPPLIER_STATUS_WORDS, ordinal) ?? 'unknown';
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
