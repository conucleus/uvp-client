import { describe, expect, it } from 'vitest';
import { decodeFunctionData, type Address, type Hex, type TypedDataDefinition } from 'viem';
import { STATE_MACHINE_ABI } from '@uvp-eth/protocol-bindings';
import type { PlanRegistrationArgs } from '../../src/core/registration.js';
import {
  submitOrderBirth,
  submitPlanRegistration,
  submitSignedRegistryRecord,
} from '../../src/browser/write.js';
import type { Eip1193Provider } from '../../src/browser/wallet/index.js';

const WALLET = '0x0000000000000000000000000000000000000002' as Address;
const STATE_MACHINE = '0x0000000000000000000000000000000000000001' as Address;
const SIGNATURE = `0x${'11'.repeat(65)}` as Hex;

function bytes32(suffix: string): Hex {
  return `0x${suffix.padStart(64, '0')}` as Hex;
}

interface MockProvider {
  readonly provider: Eip1193Provider;
  readonly requests: ReadonlyArray<{ readonly method: string; readonly params?: readonly unknown[] }>;
}

function mockProvider(): MockProvider {
  const requests: Array<{ readonly method: string; readonly params?: readonly unknown[] }> = [];
  let txCount = 0;
  const provider: Eip1193Provider = {
    request: async (args) => {
      requests.push(args);
      switch (args.method) {
        case 'eth_signTypedData_v4':
          return SIGNATURE;
        case 'eth_getBlockByNumber':
          return { timestamp: '0x64' };
        case 'eth_sendTransaction':
          txCount += 1;
          return `0x${txCount.toString(16).padStart(64, '0')}`;
        default:
          throw new Error(`unexpected provider method ${args.method}`);
      }
    },
  };
  return { provider, requests };
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
    flags: 1,
    instructions: [{ op: 'SIGNAL', sourceId: bytes32('0d'), signalId: bytes32('0e') }],
    dependencyKeys: [bytes32('0f')],
  }],
  executorCandidates: [],
};

describe('browser write surface', () => {
  it('signs plan commit with the injected provider and submits commitPlan then finalizePlan', async () => {
    const { provider, requests } = mockProvider();
    const result = await submitPlanRegistration({
      provider,
      signer: WALLET,
      chainId: 31337,
      stateMachineAddress: STATE_MACHINE,
      registration,
    });

    expect(result.signature).toBe(SIGNATURE);
    expect(result.commitTxHash).toBe(`0x${'01'.padStart(64, '0')}`);
    expect(result.finalizeTxHash).toBe(`0x${'02'.padStart(64, '0')}`);
    expect(requests.map((request) => request.method)).toEqual([
      'eth_getBlockByNumber',
      'eth_signTypedData_v4',
      'eth_sendTransaction',
      'eth_sendTransaction',
    ]);
    expect(result.typedData.message).toMatchObject({ publisher: WALLET, deadline: '3700' });

    const commitParams = requests[2]!.params as readonly [{ readonly to: string; readonly data: Hex }];
    expect(commitParams[0].to).toBe(STATE_MACHINE);
    const commit = decodeFunctionData({ abi: STATE_MACHINE_ABI, data: commitParams[0].data });
    expect(commit.functionName).toBe('commitPlan');
    expect((commit.args as readonly unknown[])[3]).toBe(SIGNATURE);

    const finalizeParams = requests[3]!.params as readonly [{ readonly data: Hex }];
    const finalize = decodeFunctionData({ abi: STATE_MACHINE_ABI, data: finalizeParams[0].data });
    expect(finalize.functionName).toBe('finalizePlan');
    expect(finalize.args[0]).toBe(registration.planId);
  });

  it('uses an explicit deadline without reading the provider block clock', async () => {
    const { provider, requests } = mockProvider();
    const result = await submitPlanRegistration({
      provider,
      signer: WALLET,
      chainId: 31337,
      stateMachineAddress: STATE_MACHINE,
      registration,
      deadline: 1_700_000_000n,
      finalize: false,
    });
    expect(result.typedData.message).toMatchObject({ deadline: '1700000000' });
    expect(requests.map((request) => request.method)).toEqual([
      'eth_signTypedData_v4',
      'eth_sendTransaction',
    ]);
  });

  it('signs and submits an order birth through triggerOrderFromOutsideFor', async () => {
    const { provider, requests } = mockProvider();
    const trigger = {
      planId: registration.planId,
      creator: WALLET,
      triggerHookId: bytes32('11'),
      triggerStageId: bytes32('12'),
      sourceId: bytes32('13'),
      signalId: bytes32('14'),
      payloadHash: bytes32('15'),
      idempotencyKey: bytes32('16'),
      submitter: WALLET,
      deadline: 1_700_000_000n,
    };
    const authorizations = [{
      sourceId: bytes32('17'),
      signalId: bytes32('18'),
      submitter: WALLET,
      role: bytes32('00'),
      metadataHash: bytes32('00'),
    }];
    const result = await submitOrderBirth({
      provider,
      signer: WALLET,
      chainId: 31337,
      stateMachineAddress: STATE_MACHINE,
      trigger,
      authorizations,
      birthFactAttribution: {
        sourceId: trigger.sourceId,
        signalId: trigger.signalId,
        stageId: bytes32('00'),
        capabilityProof: [],
      },
    });

    expect(result.signature).toBe(SIGNATURE);
    const send = requests[1]!.params as readonly [{ readonly to: string; readonly data: Hex }];
    expect(send[0].to).toBe(STATE_MACHINE);
    const decoded = decodeFunctionData({ abi: STATE_MACHINE_ABI, data: result.calldata });
    expect(decoded.functionName).toBe('triggerOrderFromOutsideFor');
    expect(decoded.args[2]).toBe(SIGNATURE);
  });

  it('signs registry typed data with the provider and forwards the signed payload', async () => {
    const { provider } = mockProvider();
    const typedData: TypedDataDefinition = {
      domain: { name: 'UVPZhixuRegistry', version: '1', chainId: 31337 },
      types: { ZhixuRecord: [{ name: 'planId', type: 'bytes32' }] },
      primaryType: 'ZhixuRecord',
      message: { planId: registration.planId },
    };
    const result = await submitSignedRegistryRecord({
      provider,
      signer: WALLET,
      typedData,
      submit: async (signed) => ({ signature: signed.signature, signer: signed.signer }),
    });

    expect(result.signature).toBe(SIGNATURE);
    expect(result.submission).toEqual({ signature: SIGNATURE, signer: WALLET });
  });
});
