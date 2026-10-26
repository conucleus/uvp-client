/**
 * EIP-1193 participant signing for product-submit typed data: asks the injected
 * provider to sign with the wallet that matches the server-declared submitter.
 * Only the provider request crosses this seam; keys and session tokens stay in
 * the host.
 */
import { isHex, type Address, type Hex } from 'viem';
import { normalizeAddress, type ProductSubmitTypedData } from '@uvp-eth/protocol-bindings';
import { UnsupportedChainTargetError, type ChainTarget } from '../../core/chain-target.js';
import type { Eip1193Provider } from './provider.js';

export interface ProductSubmitSignatureRequest {
  readonly target?: ChainTarget;
  readonly provider: Eip1193Provider;
  readonly typedData: ProductSubmitTypedData;
  readonly submitter: Address | string;
}

export async function requestProductSubmitSignature(
  provider: Eip1193Provider,
  typedData: ProductSubmitTypedData,
  submitter: Address | string,
): Promise<Hex> {
  const normalizedSubmitter = normalizeAddress(submitter, 'submitter');
  if (normalizedSubmitter !== normalizeAddress(typedData.message.submitter, 'typedData.message.submitter')) {
    throw new Error('submitter does not match typedData.message.submitter');
  }

  const signature = await provider.request({
    method: 'eth_signTypedData_v4',
    params: [normalizedSubmitter, JSON.stringify(typedData)],
  });
  if (typeof signature !== 'string' || !isHex(signature)) {
    throw new Error('wallet returned an invalid hex signature');
  }
  return signature;
}

export async function requestProductSubmitSignatureForTarget(
  input: ProductSubmitSignatureRequest,
): Promise<Hex> {
  const target = input.target ?? 'evm';
  switch (target) {
    case 'evm':
      return requestProductSubmitSignature(input.provider, input.typedData, input.submitter);
    case 'solana':
      throw new UnsupportedChainTargetError('solana', 'solana participant signing is reserved but not implemented');
  }
}
