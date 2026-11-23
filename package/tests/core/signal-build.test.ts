import { describe, expect, it } from 'vitest';
import { decodeFunctionData, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  STATE_MACHINE_ABI,
  factAttributionHash,
  stageFilesHash,
  type SignalAttributionPayload,
  type StageFile,
} from '@uvp-eth/protocol-bindings';
import {
  buildEmptySignatureOperation,
  prepareOperation,
  signOperation,
  type OperationInput,
} from '../../src/core/operations.js';
import {
  buildSubmitStateMachineSignalCall,
  normalizeSignalSubmission,
  ZERO_FACT_ATTRIBUTION,
} from '../../src/headless/watcher/index.js';
import { ValidationError } from '../../src/core/validation.js';
import {
  STATE_MACHINE,
  bytes32,
  SIGNAL_DEADLINE,
  stateMachineSignalFixture,
  triggerSignalFixture,
} from './fixtures.js';

const WALLET_ADDRESS = '0x0000000000000000000000000000000000000002' as Hex;

const CONFIG = {
  rpcUrl: 'http://127.0.0.1:8545',
  stateMachineAddress: STATE_MACHINE,
  chainId: 31_337,
};

const FILES: readonly StageFile[] = [
  { key: 'ipfs://evidence/25', payload: bytes32('25') },
];

const ATTRIBUTION: SignalAttributionPayload = {
  sourceId: bytes32('0d'),
  signalId: bytes32('0e'),
  stageId: bytes32('55'),
  capabilityProof: [bytes32('56')],
};

function signalSubmitInput(account: ReturnType<typeof privateKeyToAccount>, signal = signalFixture): OperationInput {
  return {
    operation: 'signal.submit',
    chainId: 31_337,
    stateMachineAddress: STATE_MACHINE,
    signer: account.address,
    signal,
    deadline: SIGNAL_DEADLINE,
  };
}

const signalFixture = stateMachineSignalFixture();

function decodeSubmission(data: Hex): {
  readonly submission: {
    readonly planId: Hex;
    readonly orderId: Hex;
    readonly sourceId: Hex;
    readonly signalId: Hex;
    readonly payloadHash: Hex;
    readonly idempotencyKey: Hex;
    readonly attribution: { readonly stageId: Hex; readonly capabilityProof: readonly Hex[] };
    readonly targetStageId: Hex;
    readonly files: readonly StageFile[];
    readonly submitter: string;
    readonly deadline: bigint;
  };
  readonly signature: Hex;
} {
  const decoded = decodeFunctionData({ abi: STATE_MACHINE_ABI, data });
  expect(decoded.functionName).toBe('submitSignal');
  const [submission, signature] = decoded.args as readonly [
    {
      readonly planId: Hex;
      readonly orderId: Hex;
      readonly sourceId: Hex;
      readonly signalId: Hex;
      readonly payloadHash: Hex;
      readonly idempotencyKey: Hex;
      readonly attribution: { readonly stageId: Hex; readonly capabilityProof: readonly Hex[] };
      readonly targetStageId: Hex;
      readonly files: readonly StageFile[];
      readonly submitter: string;
      readonly deadline: bigint;
    },
    Hex,
  ];
  return { submission, signature };
}

describe('SignalSubmission call construction', () => {
  it('builds the direct submitSignal call with an empty signature and no files', () => {
    const call = buildSubmitStateMachineSignalCall(CONFIG, signalFixture, WALLET_ADDRESS);
    const { submission, signature } = decodeSubmission(call.data);

    expect(signature).toBe('0x');
    expect(submission.submitter).toBe(WALLET_ADDRESS);
    expect(submission.orderId).toBe(signalFixture.orderId);
    expect(submission.signalId).toBe(signalFixture.signalId);
    expect(submission.targetStageId).toBe(bytes32('00'));
    expect(submission.files).toEqual([]);
    expect(submission.deadline).toBeGreaterThan(0n);
    expect(submission.attribution).toEqual(ZERO_FACT_ATTRIBUTION);
  });

  it('signs the files hash and keeps the files in the encoded submission', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const prepared = prepareOperation(signalSubmitInput(account, {
      ...stateMachineSignalFixture(),
      targetStageId: bytes32('21'),
      files: FILES,
    }));
    const expectedFilesHash = stageFilesHash(FILES);
    expect(prepared.typedData.primaryType).toBe('UVPStateMachineSignalSubmission');
    expect(prepared.typedData.message).toMatchObject({
      planId: signalFixture.planId,
      orderId: signalFixture.orderId,
      targetStageId: bytes32('21'),
      filesHash: expectedFilesHash,
      deadline: SIGNAL_DEADLINE.toString(10),
    });
    expect(String(prepared.typedData.message.submitter).toLowerCase()).toBe(account.address.toLowerCase());

    const signed = await signOperation(prepared, account);
    const { submission, signature } = decodeSubmission(signed.calls[0]!.data);
    expect(signature).toBe(signed.signature);
    expect(submission.targetStageId).toBe(bytes32('21'));
    expect(submission.files).toEqual(FILES);
  });

  it('hashes the attribution in the typed data and keeps the proof in the call', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const prepared = prepareOperation(signalSubmitInput(account, {
      ...stateMachineSignalFixture(),
      attribution: ATTRIBUTION,
    }));
    expect(prepared.typedData.message.attributionHash).toBe(factAttributionHash(ATTRIBUTION));

    const signed = await signOperation(prepared, account);
    const { submission } = decodeSubmission(signed.calls[0]!.data);
    expect(submission.attribution).toEqual({
      sourceId: ATTRIBUTION.sourceId,
      signalId: ATTRIBUTION.signalId,
      stageId: ATTRIBUTION.stageId,
      capabilityProof: ATTRIBUTION.capabilityProof,
    });
  });

  it('builds a pure file submission with signalId 0', () => {
    const call = buildSubmitStateMachineSignalCall(CONFIG, {
      ...stateMachineSignalFixture(),
      signalId: bytes32('00'),
      sourceId: bytes32('00'),
      targetStageId: bytes32('21'),
      files: FILES,
    }, WALLET_ADDRESS);
    const { submission } = decodeSubmission(call.data);
    expect(submission.signalId).toBe(bytes32('00'));
    expect(submission.targetStageId).toBe(bytes32('21'));
    expect(submission.files).toEqual(FILES);
  });
});

describe('trigger operation', () => {
  const account = privateKeyToAccount(generatePrivateKey());

  it('prepares order.trigger with orderId 0 and an explicit idempotencyKey', async () => {
    const prepared = prepareOperation({
      operation: 'order.trigger',
      chainId: 31_337,
      stateMachineAddress: STATE_MACHINE,
      signer: account.address,
      signal: triggerSignalFixture(bytes32('17')),
      deadline: SIGNAL_DEADLINE,
    });

    expect(prepared.typedData.primaryType).toBe('UVPStateMachineSignalSubmission');
    expect(prepared.typedData.message.orderId).toBe(bytes32('00'));
    expect(prepared.typedData.message.idempotencyKey).toBe(bytes32('17'));
    expect(prepared.signatureDelivery).toBe('direct-empty');

    const direct = buildEmptySignatureOperation(prepared);
    expect(direct.signature).toBe('0x');
    const directCall = decodeSubmission(direct.calls[0]!.data);
    expect(directCall.signature).toBe('0x');
    expect(directCall.submission.orderId).toBe(bytes32('00'));
    expect(directCall.submission.idempotencyKey).toBe(bytes32('17'));
    expect(directCall.submission.submitter).toBe(account.address);

    const relayed = await signOperation(prepared, account);
    const relayedCall = decodeSubmission(relayed.calls[0]!.data);
    expect(relayedCall.signature).toBe(relayed.signature);
  });

  it('requires a non-zero idempotencyKey for trigger creation', () => {
    const signal = triggerSignalFixture();
    expect(normalizeSignalSubmission(signal).idempotencyKey).toBe(bytes32('17'));
    expect(() => normalizeSignalSubmission({
      planId: bytes32('01'),
      sourceId: bytes32('13'),
      signalId: bytes32('14'),
    })).toThrow(ValidationError);
  });
});
