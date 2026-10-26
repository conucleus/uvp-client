import { describe, expect, it } from 'vitest';
import { decodeFunctionData, type Address, type Hex, type TypedDataDefinition } from 'viem';
import { STATE_MACHINE_ABI } from '@uvp-eth/protocol-bindings';
import type { ZhixuDefinition } from '@uvp-eth/compiler';
import { compilePlan, planRegistrationArgs, registerPlan } from '../../src/headless/plan.js';
import { publishIdentityClaim, publishZhixuRecord } from '../../src/headless/registry.js';
import type { TransactionSubmitter, TypedDataSigner } from '../../src/headless/signers.js';

const PUBLISHER = '0x0000000000000000000000000000000000000002' as Address;
const STATE_MACHINE = '0x0000000000000000000000000000000000000001' as Address;
const SIGNATURE = `0x${'11'.repeat(65)}` as Hex;
const TX_HASH_1 = `0x${'22'.repeat(32)}` as Hex;
const TX_HASH_2 = `0x${'33'.repeat(32)}` as Hex;

const definition: ZhixuDefinition = {
  apiVersion: 'uvp/v0',
  kind: 'Zhixu',
  metadata: { name: 'write_sdk_demo' },
  spec: {
    platform: { type: 'cloud' },
    nucleation: { id: 'core' },
    stages: [
      {
        name: 'assign',
        source: 'buyer',
        selectedStages: ['main'],
        receiveSignals: { PLACE: 'buyer::assign.seed' },
        sendSignals: [{ name: 'executor_selected' }, { name: 'seed' }],
        executor: { supplierType: 'organization', supplierID: 'selector-org' },
      },
      {
        name: 'main',
        source: 'buyer',
        receiveSignals: {
          START: 'buyer::assign.executor_selected',
          TIMEOUT: 'buyer::(assign.executor_selected +5s) & ~main.cmp',
        },
        sendSignals: [{ name: 'str' }, { name: 'cmp' }, { name: 'err' }],
        executor: { supplierType: 'organization', supplierID: 'org-1' },
      },
    ],
  },
};

function mockSigner(captured: { typedData?: TypedDataDefinition }): TypedDataSigner {
  return {
    address: PUBLISHER,
    signTypedData: async (typedData) => {
      captured.typedData = typedData;
      return SIGNATURE;
    },
  };
}

describe('headless plan write surface', () => {
  it('compiles a definition into register args and a publisher-bound planId', async () => {
    const compiled = await compilePlan({ definition, publisher: PUBLISHER });
    expect(compiled.planId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(compiled.registerArgs.planHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(compiled.registerArgs.hooks.length).toBeGreaterThan(0);
    const registration = planRegistrationArgs(compiled.registerArgs, compiled.planId);
    expect(registration.planId).toBe(compiled.planId);
    expect(registration.hooks.length).toBe(compiled.registerArgs.hooks.length);
    expect(registration.executorCandidatesRoot).toBe(compiled.registerArgs.executorCandidatesRoot);
  });

  it('signs plan commit and returns relay-ready calls without a submitter', async () => {
    const compiled = await compilePlan({ definition, publisher: PUBLISHER });
    const captured: { typedData?: TypedDataDefinition } = {};
    const result = await registerPlan({
      chainId: 31337,
      stateMachineAddress: STATE_MACHINE,
      registration: planRegistrationArgs(compiled.registerArgs, compiled.planId),
      signer: mockSigner(captured),
      deadline: 1_700_000_000n,
    });

    expect(result.signature).toBe(SIGNATURE);
    expect(result.commitTxHash).toBeUndefined();
    expect(result.finalizeTxHash).toBeUndefined();
    expect(captured.typedData?.primaryType).toBe('UVPStateMachinePlanCommit');
    expect(captured.typedData?.message).toMatchObject({ publisher: PUBLISHER, deadline: '1700000000' });
    expect(result.commitCall.functionName).toBe('commitPlan');
    expect(result.finalizeCall.functionName).toBe('finalizePlan');
  });

  it('submits commitPlan then finalizePlan and reports both tx hashes', async () => {
    const compiled = await compilePlan({ definition, publisher: PUBLISHER });
    const calls: Array<{ readonly to: Address; readonly data: Hex; readonly chainId?: number }> = [];
    const submitter: TransactionSubmitter = {
      sendTransaction: async (input) => {
        calls.push(input);
        return calls.length === 1 ? TX_HASH_1 : TX_HASH_2;
      },
    };
    const result = await registerPlan({
      chainId: 31337,
      stateMachineAddress: STATE_MACHINE,
      registration: planRegistrationArgs(compiled.registerArgs, compiled.planId),
      signer: mockSigner({}),
      deadline: 1_700_000_000n,
      submit: submitter,
    });

    expect(result.commitTxHash).toBe(TX_HASH_1);
    expect(result.finalizeTxHash).toBe(TX_HASH_2);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.to === STATE_MACHINE && call.chainId === 31337)).toBe(true);
    const commit = decodeFunctionData({ abi: STATE_MACHINE_ABI, data: calls[0]!.data });
    expect(commit.functionName).toBe('commitPlan');
    const finalize = decodeFunctionData({ abi: STATE_MACHINE_ABI, data: calls[1]!.data });
    expect(finalize.functionName).toBe('finalizePlan');
    expect(finalize.args[0]).toBe(result.planId);
  });
});

describe('headless registry publish surface', () => {
  const typedData: TypedDataDefinition = {
    domain: { name: 'UVPZhixuRegistry', version: '1', chainId: 31337 },
    types: { ZhixuRecord: [{ name: 'planId', type: 'bytes32' }] },
    primaryType: 'ZhixuRecord',
    message: { planId: `0x${'01'.repeat(32)}` },
  };

  it('signs the injected registry typed data and hands the signed record to the injected submitter', async () => {
    const captured: { typedData?: TypedDataDefinition } = {};
    const submitted: Array<{ readonly signature: Hex; readonly signer: Address }> = [];
    const result = await publishZhixuRecord({
      fields: { planId: `0x${'01'.repeat(32)}` },
      buildTypedData: () => typedData,
      signer: mockSigner(captured),
      submit: async (signed) => {
        submitted.push({ signature: signed.signature, signer: signed.signer });
        return 'registry-ok';
      },
    });

    expect(result.signature).toBe(SIGNATURE);
    expect(result.submission).toBe('registry-ok');
    expect(submitted[0]).toMatchObject({ signature: SIGNATURE, signer: PUBLISHER });
    expect(captured.typedData?.primaryType).toBe('ZhixuRecord');
  });

  it('publishes identity claims through the same EIP-712 injection seam', async () => {
    const claimTypedData: TypedDataDefinition = {
      ...typedData,
      types: { IdentityClaim: [{ name: 'wallet', type: 'address' }] },
      primaryType: 'IdentityClaim',
      message: { wallet: PUBLISHER },
    };
    const result = await publishIdentityClaim({
      fields: { wallet: PUBLISHER },
      buildTypedData: () => claimTypedData,
      signer: mockSigner({}),
      submit: async (signed) => signed.typedData.primaryType,
    });
    expect(result.submission).toBe('IdentityClaim');
  });
});
