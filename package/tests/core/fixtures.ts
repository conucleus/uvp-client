import type { Address, Hex } from 'viem';
import {
  supplierIdFromUuid,
  type SignalAttributionPayload,
  type TriggerOrderFromOutsidePayload,
} from '@uvp-eth/protocol-bindings';
import type { PlanRegistrationArgs } from '../../src/core/registration.js';
import type { StateMachineSignal } from '../../src/core/signal/build.js';

export const STATE_MACHINE = '0x0000000000000000000000000000000000000001' as Address;
export const STAGE_PATCH_MODULE = '0x0000000000000000000000000000000000000003' as Address;
export const CHAIN_ID = 31337;

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

export function triggerFixture(submitter: Address): TriggerOrderFromOutsidePayload {
  return {
    planId: bytes32('01'),
    creator: '0x0000000000000000000000000000000000000020',
    triggerHookId: bytes32('11'),
    triggerStageId: bytes32('12'),
    sourceId: bytes32('13'),
    signalId: bytes32('14'),
    payloadHash: bytes32('15'),
    idempotencyKey: bytes32('16'),
    submitter,
    deadline: 1_700_000_000n,
  };
}

export function birthAttributionFixture(trigger: TriggerOrderFromOutsidePayload): SignalAttributionPayload {
  return {
    sourceId: trigger.sourceId,
    signalId: trigger.signalId,
    stageId: bytes32('00'),
    capabilityProof: [],
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
