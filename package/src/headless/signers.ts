/**
 * Headless signing/submission seams: typed-data signing and transaction
 * submission are injected so callers can use a local key, a keystore, or a
 * relay without the SDK owning key material.
 */
import type { Address, Hex, TypedDataDefinition } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export interface TypedDataSigner {
  readonly address: Address;
  signTypedData(typedData: TypedDataDefinition): Promise<Hex>;
}

export interface TransactionSubmitter {
  sendTransaction(input: {
    readonly to: Address;
    readonly data: Hex;
    readonly chainId?: number;
  }): Promise<Hex>;
}

export function signerFromPrivateKey(privateKey: Hex): TypedDataSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    signTypedData: (typedData) => account.signTypedData(typedData),
  };
}
