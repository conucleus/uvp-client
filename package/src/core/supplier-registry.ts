/**
 * Supplier registry register surface: registerSupplier(account) is the
 * supplier account's own direct call; platform status writes live in the
 * /platform entry and registry reads in ./engine-read.js.
 */
import { encodeFunctionData, type Address, type Hex } from 'viem';
import { SUPPLIER_REGISTRY_ABI } from '@uvp-eth/protocol-bindings';
import { normalizeAddressChecksummed, parsePositiveInteger } from './validation.js';

export interface SupplierRegistryCallConfig {
  readonly supplierRegistryAddress: Address | string;
  readonly chainId?: number;
}

export interface RegisterSupplierCall {
  readonly address: Address;
  readonly abi: typeof SUPPLIER_REGISTRY_ABI;
  readonly functionName: 'registerSupplier';
  readonly args: readonly [Address];
  readonly data: Hex;
  readonly chainId?: number;
}

export function buildRegisterSupplierCall(
  config: SupplierRegistryCallConfig,
  account: Address | string,
): RegisterSupplierCall {
  const address = normalizeAddressChecksummed(config.supplierRegistryAddress, 'supplierRegistryAddress');
  const normalizedAccount = normalizeAddressChecksummed(account, 'account');
  const chainId = config.chainId === undefined ? undefined : parsePositiveInteger(config.chainId, 'chainId');
  return {
    address,
    abi: SUPPLIER_REGISTRY_ABI,
    functionName: 'registerSupplier',
    args: [normalizedAccount],
    data: encodeFunctionData({
      abi: SUPPLIER_REGISTRY_ABI,
      functionName: 'registerSupplier',
      args: [normalizedAccount],
    }),
    ...(chainId === undefined ? {} : { chainId }),
  };
}
