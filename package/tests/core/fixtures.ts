import type { Address, Hex } from 'viem';
import type {
  SignalAttributionPayload,
  SignalAuthorizationPayload,
  TriggerOrderFromOutsidePayload,
} from '@uvp-eth/protocol-bindings';
import type { PlanRegistrationArgs } from '../../src/core/registration.js';

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
    dockRoutesRoot: bytes32('05'),
    dockInterfaceRoot: bytes32('06'),
    executorCandidatesRoot: bytes32('07'),
    hooks: [{
      hookId: bytes32('0a'),
      stageId: bytes32('0b'),
      hookName: bytes32('0c'),
      flags: 1,
      instructions: [{ op: 'SIGNAL', sourceId: bytes32('0d'), signalId: bytes32('0e') }],
      dependencyKeys: [bytes32('0f')],
    }],
    executorCandidates: [],
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

export function authorizationsFixture(submitter: Address): readonly SignalAuthorizationPayload[] {
  return [{
    sourceId: bytes32('17'),
    signalId: bytes32('18'),
    submitter,
    role: bytes32('00'),
    metadataHash: bytes32('00'),
  }];
}

export function birthAttributionFixture(trigger: TriggerOrderFromOutsidePayload): SignalAttributionPayload {
  return {
    sourceId: trigger.sourceId,
    signalId: trigger.signalId,
    stageId: bytes32('00'),
    capabilityProof: [],
  };
}
