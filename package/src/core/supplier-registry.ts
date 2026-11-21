/**
 * Supplier registry write surface: activateSupplier is a registrar/owner direct
 * call with no EIP-712 payload; supplier registration stays outside this client.
 */
import { encodeFunctionData, type Address, type Hex } from 'viem';
import { SUPPLIER_REGISTRY_ABI } from '@uvp-eth/protocol-bindings';
import { normalizeAddressChecksummed, normalizeBytes32, parsePositiveInteger } from './validation.js';

export interface SupplierRegistryCallConfig {
  readonly supplierRegistryAddress: Address | string;
  readonly chainId?: number;
}

export interface ActivateSupplierCall {
  readonly address: Address;
  readonly abi: typeof SUPPLIER_REGISTRY_ABI;
  readonly functionName: 'activateSupplier';
  readonly args: readonly [Hex];
  readonly data: Hex;
  readonly chainId?: number;
}

export function buildActivateSupplierCall(
  config: SupplierRegistryCallConfig,
  supplierId: Hex | string,
): ActivateSupplierCall {
  const address = normalizeAddressChecksummed(config.supplierRegistryAddress, 'supplierRegistryAddress');
  const normalizedSupplierId = normalizeBytes32(supplierId, 'supplierId');
  const chainId = config.chainId === undefined ? undefined : parsePositiveInteger(config.chainId, 'chainId');
  return {
    address,
    abi: SUPPLIER_REGISTRY_ABI,
    functionName: 'activateSupplier',
    args: [normalizedSupplierId],
    data: encodeFunctionData({
      abi: SUPPLIER_REGISTRY_ABI,
      functionName: 'activateSupplier',
      args: [normalizedSupplierId],
    }),
    ...(chainId === undefined ? {} : { chainId }),
  };
}
