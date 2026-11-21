/**
 * Timer hook poke calldata: pokeTimer is permissionless, so this module only
 * normalizes ids and encodes the STATE_MACHINE_ABI call.
 */
import { encodeFunctionData, type Address, type Hex } from 'viem';
import { STATE_MACHINE_ABI } from '@uvp-eth/protocol-bindings';
import { normalizeAddressChecksummed, normalizeBytes32, parsePositiveInteger } from './validation.js';

export interface TimerPokeKey {
  readonly planId: Hex | string;
  readonly orderId: Hex | string;
  readonly hookId: Hex | string;
}

export interface PokeTimerCallConfig {
  readonly stateMachineAddress: Address | string;
  readonly chainId?: number;
}

export interface PokeTimerCall {
  readonly address: Address;
  readonly abi: typeof STATE_MACHINE_ABI;
  readonly functionName: 'pokeTimer';
  readonly args: readonly [Hex, Hex, Hex];
  readonly data: Hex;
  readonly chainId?: number;
}

export function buildPokeTimerCall(config: PokeTimerCallConfig, key: TimerPokeKey): PokeTimerCall {
  const address = normalizeAddressChecksummed(config.stateMachineAddress, 'stateMachineAddress');
  const planId = normalizeBytes32(key.planId, 'planId');
  const orderId = normalizeBytes32(key.orderId, 'orderId');
  const hookId = normalizeBytes32(key.hookId, 'hookId');
  const chainId = config.chainId === undefined ? undefined : parsePositiveInteger(config.chainId, 'chainId');
  return {
    address,
    abi: STATE_MACHINE_ABI,
    functionName: 'pokeTimer',
    args: [planId, orderId, hookId],
    data: encodeFunctionData({
      abi: STATE_MACHINE_ABI,
      functionName: 'pokeTimer',
      args: [planId, orderId, hookId],
    }),
    ...(chainId === undefined ? {} : { chainId }),
  };
}
