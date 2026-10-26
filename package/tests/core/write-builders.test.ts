import { describe, expect, it } from 'vitest';
import { decodeFunctionData, type Hex } from 'viem';
import {
  STATE_MACHINE_ABI,
  buildTriggerOrderFromOutsideForCall,
  buildTriggerOrderFromOutsideTypedData,
} from '@uvp-eth/protocol-bindings';
import {
  buildPlanCommitCall,
  buildPlanCommitTypedDataFor,
  buildPlanFinalizeCall,
  type PlanRegistrationArgs,
} from '../../src/core/registration.js';

const STATE_MACHINE = '0x0000000000000000000000000000000000000001' as const;
const PUBLISHER = '0x0000000000000000000000000000000000000002' as const;
const SIGNATURE = `0x${'11'.repeat(65)}` as Hex;

function bytes32(suffix: string): Hex {
  return `0x${suffix.padStart(64, '0')}` as Hex;
}

const registration: PlanRegistrationArgs = {
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
    flags: 5,
    instructions: [
      { op: 'SIGNAL', sourceId: bytes32('0d'), signalId: bytes32('0e') },
      { op: 'AND', arity: 2 },
      { op: 'DELAY', delaySeconds: 5 },
    ],
    dependencyKeys: [bytes32('0f')],
  }],
  executorCandidates: [{ stageId: bytes32('10'), executor: PUBLISHER }],
};

describe('plan registration builders', () => {
  it('encodes commitPlan with numeric instruction opcodes and the publisher commitment', () => {
    const call = buildPlanCommitCall(
      { stateMachineAddress: STATE_MACHINE, chainId: 31337 },
      {
        publisher: PUBLISHER,
        deadline: 1_700_000_000n,
        registration,
        signature: SIGNATURE,
      },
    );

    expect(call).toMatchObject({
      address: STATE_MACHINE,
      functionName: 'commitPlan',
      chainId: 31337,
    });
    const decoded = decodeFunctionData({ abi: STATE_MACHINE_ABI, data: call.data });
    expect(decoded.functionName).toBe('commitPlan');
    const [commit, hooks, candidates, signature] = decoded.args as readonly [
      { readonly publisher: string; readonly deadline: bigint; readonly hooksHash: string; readonly birthAuthorizer: string },
      readonly { readonly instructions: readonly { readonly op: number }[] }[],
      readonly { readonly executor: string }[],
      string,
    ];
    expect(commit.publisher).toBe(PUBLISHER);
    expect(commit.deadline).toBe(1_700_000_000n);
    expect(commit.hooksHash).toBe(registration.hooksHash);
    expect(commit.birthAuthorizer).toBe(PUBLISHER);
    expect(hooks[0]?.instructions.map((instruction) => instruction.op)).toEqual([0, 2, 4]);
    expect(candidates[0]?.executor).toBe(PUBLISHER);
    expect(signature).toBe(SIGNATURE);
  });

  it('derives the plan-commit digest from protocol-bindings with the same commitment fields', () => {
    const typedData = buildPlanCommitTypedDataFor(
      { stateMachineAddress: STATE_MACHINE, chainId: 31337 },
      { publisher: PUBLISHER, deadline: 1_700_000_000n, registration },
    );
    expect(typedData.primaryType).toBe('UVPStateMachinePlanCommit');
    expect(typedData.domain).toMatchObject({ name: 'UVPStateMachine', version: '0.15', chainId: 31337 });
    expect(typedData.message).toMatchObject({
      publisher: PUBLISHER,
      hooksHash: registration.hooksHash,
      capabilitiesRoot: registration.capabilitiesRoot,
      birthAuthorizer: PUBLISHER,
      deadline: '1700000000',
    });
  });

  it('encodes finalizePlan for the already-derived planId', () => {
    const call = buildPlanFinalizeCall({ stateMachineAddress: STATE_MACHINE }, registration.planId);
    expect(call).toMatchObject({ address: STATE_MACHINE, functionName: 'finalizePlan' });
    const decoded = decodeFunctionData({ abi: STATE_MACHINE_ABI, data: call.data });
    expect(decoded.functionName).toBe('finalizePlan');
    expect(decoded.args[0]).toBe(registration.planId);
  });

  it('builds order birth calldata through the protocol-bindings triggerOrderFromOutsideFor surface', () => {
    const trigger = {
      planId: registration.planId,
      creator: PUBLISHER,
      triggerHookId: bytes32('11'),
      triggerStageId: bytes32('12'),
      sourceId: bytes32('13'),
      signalId: bytes32('14'),
      payloadHash: bytes32('15'),
      idempotencyKey: bytes32('16'),
      submitter: PUBLISHER,
      deadline: 1_700_000_000n,
    };
    const authorizations = [{
      sourceId: bytes32('17'),
      signalId: bytes32('18'),
      submitter: PUBLISHER,
      role: bytes32('00'),
      metadataHash: bytes32('00'),
    }];
    const birthFactAttribution = {
      sourceId: bytes32('13'),
      signalId: bytes32('14'),
      stageId: bytes32('00'),
      capabilityProof: [],
    };
    const typedData = buildTriggerOrderFromOutsideTypedData({
      ...trigger,
      chainId: 31337,
      verifyingContract: STATE_MACHINE,
      authorizations,
    });
    expect(typedData.primaryType).toBe('UVPStateMachineTriggerOrderFromOutside');

    const call = buildTriggerOrderFromOutsideForCall(
      { stateMachineAddress: STATE_MACHINE, chainId: 31337 },
      { ...trigger, authorizations, signature: SIGNATURE, birthFactAttribution },
    );
    const decoded = decodeFunctionData({ abi: STATE_MACHINE_ABI, data: call.data });
    expect(decoded.functionName).toBe('triggerOrderFromOutsideFor');
    expect(decoded.args[2]).toBe(SIGNATURE);
    expect((decoded.args[0] as { readonly planId: string }).planId).toBe(registration.planId);
  });
});
