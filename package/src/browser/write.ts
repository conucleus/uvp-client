/**
 * Browser wallet primitives: inject EIP-1193 typed-data signing and transaction
 * submission only. Operation construction, signing policy and direct/relay
 * delivery live in core operations and ./client.js; this module holds no flow.
 */
import { isHex, type Address, type Hex, type TypedDataDefinition } from 'viem';
import { normalizeAddressChecksummed, ValidationError } from '../core/validation.js';
import type { Eip1193Provider } from './wallet/provider.js';

export async function signTypedDataWithProvider(
  provider: Eip1193Provider,
  typedData: TypedDataDefinition,
  signer: Address | string,
): Promise<Hex> {
  const normalizedSigner = normalizeAddressChecksummed(signer, 'signer');
  const signature = await provider.request({
    method: 'eth_signTypedData_v4',
    params: [normalizedSigner, JSON.stringify(typedData)],
  });
  if (typeof signature !== 'string' || !isHex(signature)) {
    throw new ValidationError('wallet returned an invalid hex signature');
  }
  return signature;
}

export async function sendProviderTransaction(
  provider: Eip1193Provider,
  input: {
    readonly from: Address | string;
    readonly to: Address | string;
    readonly data: Hex;
  },
): Promise<Hex> {
  const from = normalizeAddressChecksummed(input.from, 'from');
  const to = normalizeAddressChecksummed(input.to, 'to');
  if (!isHex(input.data)) {
    throw new ValidationError('transaction data must be hex calldata');
  }
  const txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from, to, data: input.data }],
  });
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new ValidationError('wallet returned an invalid transaction hash');
  }
  return txHash as Hex;
}

export async function providerBlockTimestamp(provider: Eip1193Provider): Promise<bigint> {
  const block = await provider.request({
    method: 'eth_getBlockByNumber',
    params: ['latest', false],
  });
  if (typeof block !== 'object' || block === null || !('timestamp' in block)) {
    throw new ValidationError('provider returned a block without timestamp');
  }
  const timestamp = (block as { readonly timestamp?: unknown }).timestamp;
  if (typeof timestamp !== 'string' || !/^0x[0-9a-fA-F]+$/.test(timestamp)) {
    throw new ValidationError('provider returned an invalid block timestamp');
  }
  return BigInt(timestamp);
}
