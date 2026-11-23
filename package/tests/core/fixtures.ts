import type { Address, Hex } from 'viem';
import { supplierIdFromUuid } from '@uvp-eth/protocol-bindings';
import type { PlanRegistrationArgs } from '../../src/core/registration.js';
import type { StateMachineSignal } from '../../src/core/signal/build.js';

export const STATE_MACHINE = '0x0000000000000000000000000000000000000001' as Address;
export const STAGE_PATCH_MODULE = '0x0000000000000000000000000000000000000003' as Address;
export const CHAIN_ID = 31337;
/** Far enough ahead to stay valid against wall-clock deadlines (year 2096). */
export const SIGNAL_DEADLINE = 4_000_000_000n;

export function bytes32(suffix: string): Hex {
  return `0x${suffix.padStart(64, '0')}` as Hex;
}

export function planRegistrationFixture(): PlanRegistrationArgs {
  return {
    planId: bytes32('01'),
    planHash: bytes32('02'),
    hooksHash: bytes32('03'),
    capabilitiesRoot: bytes32('04'),
    supplierBindingsRoot: bytes32('07'),
    fileWritersHash: bytes32('08'),
    fileWriters: [],
    hooks: [{
      hookId: bytes32('0a'),
      stageId: bytes32('0b'),
      hookName: bytes32('0c'),
      flags: 1,
      instructions: [{ op: 'SIGNAL', sourceId: bytes32('0d'), signalId: bytes32('0e') }],
      dependencyKeys: [bytes32('0f')],
    }],
    supplierBindings: [{
      stageId: bytes32('0b'),
      supplierId: supplierIdFromUuid('11111111-1111-4111-8111-111111111111'),
      kind: 0,
    }],
  };
}

export function stateMachineSignalFixture(): StateMachineSignal {
  return {
    planId: bytes32('01'),
    orderId: bytes32('02'),
    sourceId: bytes32('0d'),
    signalId: bytes32('0e'),
    payloadHash: bytes32('15'),
    idempotencyKey: bytes32('16'),
  };
}

export function triggerSignalFixture(idempotencyKey: Hex | string = bytes32('17')): StateMachineSignal {
  return {
    planId: bytes32('01'),
    sourceId: bytes32('13'),
    signalId: bytes32('14'),
    payloadHash: bytes32('15'),
    idempotencyKey,
  };
}
