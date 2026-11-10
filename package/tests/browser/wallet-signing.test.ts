import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  PRODUCT_SUBMIT_DOMAIN_VERSION,
  STATE_MACHINE_ABI,
  buildProductSubmitTypedData,
  recoverProductSubmitSigner,
  type SignalAttributionPayload,
} from '@uvp-eth/protocol-bindings';
import {
  UnsupportedChainTargetError,
  requestProductSubmitSignature,
  requestProductSubmitSignatureForTarget,
  type Eip1193Provider,
} from '../../src/browser/wallet/index.js';
import { requestSolanaProductSubmitSignature } from '../../src/browser/wallet/solana.js';
import { buildSubmitStateMachineSignalCall } from '../../src/headless/watcher/index.js';

const privateKey = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
const account = privateKeyToAccount(privateKey);
const submitter = account.address.toLowerCase() as `0x${string}`;
const verifyingContract = '0x8888888888888888888888888888888888888888' as const;
const planId = bytes32('06');
const orderId = bytes32('01');
const sourceId = bytes32('02');
const signalId = bytes32('03');
const payloadHash = bytes32('04');
const idempotencyKey = bytes32('05');
const deadline = '1777777777';

describe('participant entrypoint', () => {
  it('builds stable Product submit typed data', () => {
    const typedData = buildProductSubmitTypedData({
      chainId: 31337,
      verifyingContract,
      planId,
      orderId,
      sourceId,
      signalId,
      payloadHash,
      idempotencyKey,
      submitter,
      deadline,
    });

    expect(typedData).toEqual({
      domain: {
        name: 'UVPStateMachine',
        version: PRODUCT_SUBMIT_DOMAIN_VERSION,
        chainId: 31337,
        verifyingContract,
      },
      types: {
        UVPStateMachineSignal: [
          { name: 'planId', type: 'bytes32' },
          { name: 'orderId', type: 'bytes32' },
          { name: 'sourceId', type: 'bytes32' },
          { name: 'signalId', type: 'bytes32' },
          { name: 'payloadHash', type: 'bytes32' },
          { name: 'idempotencyKey', type: 'bytes32' },
          { name: 'submitter', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'filesDigest', type: 'bytes32' },
        ],
      },
      primaryType: 'UVPStateMachineSignal',
      message: {
        planId,
        orderId,
        sourceId,
        signalId,
        payloadHash,
        idempotencyKey,
        submitter,
        deadline,
        filesDigest: bytes32('00'),
      },
    });
  });

  it('rejects typed data built without a planId for real signing', () => {
    expect(() => buildProductSubmitTypedData({
      chainId: 31337,
      verifyingContract,
      orderId,
      sourceId,
      signalId,
      payloadHash,
      idempotencyKey,
      submitter,
      deadline,
    } as Parameters<typeof buildProductSubmitTypedData>[0])).toThrow(/planId must be a 32-byte hex value/u);
  });

  it('recovers the signer for a Product submit signature', async () => {
    const typedData = buildProductSubmitTypedData({
      chainId: 31337,
      verifyingContract,
      planId,
      orderId,
      sourceId,
      signalId,
      payloadHash,
      idempotencyKey,
      submitter,
      deadline,
    });
    const signature = await account.signTypedData(
      typedData as unknown as Parameters<typeof account.signTypedData>[0],
    );

    await expect(recoverProductSubmitSigner(typedData, signature)).resolves.toBe(submitter);
  });

  it('builds direct submitSignal calls with empty file args', () => {
    const call = buildSubmitStateMachineSignalCall(
      {
        stateMachineAddress: verifyingContract,
        rpcUrl: 'http://127.0.0.1:8545',
        chainId: 31337,
      },
      {
        planId,
        orderId,
        sourceId,
        signalId,
        payloadHash,
        idempotencyKey,
        attribution: {
          sourceId,
          signalId,
          stageId: bytes32('00'),
          capabilityProof: [],
        },
      },
    );

    expect(call).toMatchObject({
      address: verifyingContract,
      abi: STATE_MACHINE_ABI,
      functionName: 'submitSignal',
      chainId: 31337,
    });
    expect(call.args).toHaveLength(9);
    expect(call.args[6]).toEqual({
      sourceId,
      signalId,
      stageId: bytes32('00'),
      capabilityProof: [],
    });
    expect(call.args[7]).toBe(bytes32('00'));
    expect(call.args[8]).toEqual({
      targetStageId: bytes32('00'),
      baseHash: bytes32('00'),
      writerStageId: bytes32('00'),
      writerProof: [],
      ops: [],
    });
    expect(call.data).toMatch(/^0x[0-9a-f]+$/);
  });

  it('requests injected wallet typed-data signatures', async () => {
    const typedData = buildProductSubmitTypedData({
      chainId: 31337,
      verifyingContract,
      planId,
      orderId,
      sourceId,
      signalId,
      payloadHash,
      idempotencyKey,
      submitter,
      deadline,
    });
    const signature = `0x${'bb'.repeat(65)}` as const;
    const requests: unknown[] = [];
    const provider: Eip1193Provider = {
      request: async (input) => {
        requests.push(input);
        return signature;
      },
    };

    await expect(requestProductSubmitSignature(provider, typedData, submitter)).resolves.toBe(signature);
    expect(requests).toEqual([
      {
        method: 'eth_signTypedData_v4',
        params: [submitter, JSON.stringify(typedData)],
      },
    ]);
  });

  it('keeps EVM as the default participant signer target and reserves Solana', async () => {
    const typedData = buildProductSubmitTypedData({
      chainId: 31337,
      verifyingContract,
      planId,
      orderId,
      sourceId,
      signalId,
      payloadHash,
      idempotencyKey,
      submitter,
      deadline,
    });
    const signature = `0x${'cc'.repeat(65)}` as const;
    const provider: Eip1193Provider = {
      request: async () => signature,
    };

    await expect(requestProductSubmitSignatureForTarget({ provider, typedData, submitter })).resolves.toBe(signature);
    await expect(requestProductSubmitSignatureForTarget({
      target: 'solana',
      provider,
      typedData,
      submitter,
    })).rejects.toBeInstanceOf(UnsupportedChainTargetError);
    expect(() => requestSolanaProductSubmitSignature()).toThrow(UnsupportedChainTargetError);
  });
});

function bytes32(suffix: string): `0x${string}` {
  return `0x${suffix.padStart(64, '0')}`;
}
