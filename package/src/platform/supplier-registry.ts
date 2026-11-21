/**
 * Platform supplier registry writes: registrar-gated activate/suspend/revoke
 * direct calls with no EIP-712 payload. Registry ABI is single-sourced in
 * @uvp-eth/protocol-bindings; self-registration and reads stay in /core.
 */
import { encodeFunctionData, type Address, type Hex } from 'viem';
import { SUPPLIER_REGISTRY_ABI } from '@uvp-eth/protocol-bindings';
import { normalizeAddressChecksummed, normalizeBytes32, parsePositiveInteger } from '../core/validation.js';

export interface PlatformSupplierRegistryCallConfig {
  readonly supplierRegistryAddress: Address | string;
  readonly chainId?: number;
}

type StatusWriteFunctionName = 'activateSupplier' | 'suspendSupplier' | 'revokeSupplier';

export interface SupplierStatusWriteCall {
  readonly address: Address;
  readonly abi: typeof SUPPLIER_REGISTRY_ABI;
  readonly functionName: StatusWriteFunctionName;
  readonly args: readonly [Hex];
  readonly data: Hex;
  readonly chainId?: number;
}

export function buildActivateSupplierCall(
  config: PlatformSupplierRegistryCallConfig,
  supplierId: Hex | string,
): SupplierStatusWriteCall {
  return buildSupplierStatusWriteCall(config, 'activateSupplier', supplierId);
}

export function buildSuspendSupplierCall(
  config: PlatformSupplierRegistryCallConfig,
  supplierId: Hex | string,
): SupplierStatusWriteCall {
  return buildSupplierStatusWriteCall(config, 'suspendSupplier', supplierId);
}

export function buildRevokeSupplierCall(
  config: PlatformSupplierRegistryCallConfig,
  supplierId: Hex | string,
): SupplierStatusWriteCall {
  return buildSupplierStatusWriteCall(config, 'revokeSupplier', supplierId);
}

function buildSupplierStatusWriteCall(
  config: PlatformSupplierRegistryCallConfig,
  functionName: StatusWriteFunctionName,
  supplierId: Hex | string,
): SupplierStatusWriteCall {
  const address = normalizeAddressChecksummed(config.supplierRegistryAddress, 'supplierRegistryAddress');
  const normalizedSupplierId = normalizeBytes32(supplierId, 'supplierId');
  const chainId = config.chainId === undefined ? undefined : parsePositiveInteger(config.chainId, 'chainId');
  return {
    address,
    abi: SUPPLIER_REGISTRY_ABI,
    functionName,
    args: [normalizedSupplierId],
    data: encodeFunctionData({
      abi: SUPPLIER_REGISTRY_ABI,
      functionName,
      args: [normalizedSupplierId],
    }),
    ...(chainId === undefined ? {} : { chainId }),
  };
}
