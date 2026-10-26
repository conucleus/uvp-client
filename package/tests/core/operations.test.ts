import { describe, expect, it } from 'vitest';
import {
  decodeFunctionData,
  keccak256,
  recoverTypedDataAddress,
  stringToBytes,
  type Address,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  PLAN_COMMIT_PRIMARY_TYPE,
  PRODUCT_SUBMIT_PRIMARY_TYPE,
  STAGE_EXECUTOR_PATCH_PRIMARY_TYPE,
  STAGE_RESOURCE_PATCH_PRIMARY_TYPE,
  UVP_STAGE_INVITE_CREATE_PRIMARY_TYPE,
  STATE_MACHINE_ABI,
  TRIGGER_ORDER_FROM_OUTSIDE_PRIMARY_TYPE,
  buildUVPOrderFinalizeTypedData,
  buildUVPStageInviteAcceptTypedData,
} from '@uvp-eth/protocol-bindings';
import {
  ORDER_BIRTH_INTENT_DOMAIN_NAME,
  ORDER_BIRTH_INTENT_PRIMARY_TYPE,
  ORDER_BIRTH_INTENT_TYPED_DATA_FIELDS,
} from '../../src/core/birth.js';
import {
  OperationError,
  prepareOperation,
  signOperation,
  type OperationInput,
} from '../../src/core/operations.js';
import {
  STATE_MACHINE,
  STAGE_PATCH_MODULE,
  authorizationsFixture,
  birthAttributionFixture,
  bytes32,
  planRegistrationFixture,
  triggerFixture,
} from './fixtures.js';

const ORDER_FINALIZE_PRIMARY_TYPE = 'UVPOrderFinalize';
const INVITE_ACCEPT_PRIMARY_TYPE = 'UVPStageInviteAccept';

function registrationInput(signer: Address): OperationInput {
  return {
    operation: 'plan.register',
    chainId: 31337,
    stateMachineAddress: STATE_MACHINE,
    signer,
    registration: planRegistrationFixture(),
    deadline: 1_700_000_000n,
  };
}

function signalInput(signer: Address): OperationInput {
  return {
    operation: 'signal.submit',
    chainId: 31337,
    stateMachineAddress: STATE_MACHINE,
    signer,
    deadline: 1_700_000_000n,
    signal: {
      planId: bytes32('01'),
      orderId: bytes32('02'),
      source: 'slot-a',
      stageIdentifier: 'exec.main',
      signalName: 'cmp',
      payloadHash: bytes32('03'),
      idempotencyKey: 'signal-key-1',
    },
  };
}

function stageExecutorPatchInput(signer: Address): OperationInput {
  return {
    operation: 'stagePatch.submit',
    kind: 'executor',
    chainId: 31337,
    stagePatchModuleAddress: STAGE_PATCH_MODULE,
    signer,
    planId: bytes32('01'),
    orderId: bytes32('02'),
    deadline: 1_700_000_000n,
    patch: {
      selectorStageId: bytes32('04'),
      targetStageId: bytes32('05'),
      executor: signer,
      role: bytes32('00'),
      executorMetadataHash: bytes32('06'),
      mode: 'assign',
      previousExecutor: '0x0000000000000000000000000000000000000021',
      authorizationsHash: bytes32('07'),
      patchNonce: 3,
      metadataURI: 'ipfs://patch',
      patchHash: bytes32('08'),
    },
    previousExecutorSignature: `0x${'22'.repeat(65)}`,
    bindingProof: { selectorStageId: bytes32('09'), proof: [] },
    candidateProof: [],
    executorAuthorizations: [],
  };
}

function stageResourcePatchInput(signer: Address): OperationInput {
  return {
    operation: 'stagePatch.submit',
    kind: 'resource',
    chainId: 31337,
    stagePatchModuleAddress: STAGE_PATCH_MODULE,
    signer,
    planId: bytes32('01'),
    orderId: bytes32('02'),
    deadline: 1_700_000_000n,
    patch: {
      selectorStageId: bytes32('04'),
      targetStageId: bytes32('05'),
      resourceKey: bytes32('06'),
      manifestHash: bytes32('07'),
      policyHash: bytes32('08'),
      patchNonce: 3,
      manifestURI: 'ipfs://manifest',
      patchHash: bytes32('09'),
    },
    bindingProof: { selectorStageId: bytes32('09'), proof: [] },
  };
}

function finalizeInput(signer: Address, buyer: Address): OperationInput {
  return {
    operation: 'order.finalize',
    signer,
    typedData: buildUVPOrderFinalizeTypedData({
      chainId: 31337,
      verifyingContract: STATE_MACHINE,
      draftId: 'draft-1',
      planId: bytes32('01'),
      configId: 'used-car.v3',
      configVersion: '1',
      configHash: bytes32('0a'),
      buyer,
      termsHash: bytes32('0b'),
      nonce: 1,
      deadline: 1_700_000_000n,
    }),
  };
}

function inviteInput(signer: Address, invitee: Address): OperationInput {
  return {
    operation: 'invite.accept',
    signer,
    typedData: buildUVPStageInviteAcceptTypedData({
      chainId: 31337,
      verifyingContract: STATE_MACHINE,
      draftId: 'draft-1',
      inviteId: 'invite-1',
      stageKey: 'main',
      stageId: bytes32('0c'),
      slotKey: 'performer',
      invitee,
      amount: 100n,
      finalStandardHash: bytes32('0d'),
      workDeadline: 1_700_000_500n,
      termsHash: bytes32('0e'),
      nonce: 1,
      deadline: 1_700_000_000n,
    }),
  };
}

function inviteCreateInput(signer: Address): OperationInput {
  return {
    operation: 'invite.create',
    signer,
    chainId: 31337,
    stateMachineAddress: STATE_MACHINE,
    draftId: 'draft-1',
    stageKey: 'main',
    stageId: bytes32('0c'),
    slotKey: 'performer',
    invitee: '0x0000000000000000000000000000000000000022',
    amount: 100n,
    finalStandardHash: bytes32('0d'),
    workDeadline: 1_700_000_500n,
    termsHash: bytes32('0e'),
    nonce: 1,
    deadline: 1_700_000_000n,
  };
}

function registryInput(signer: Address): OperationInput {
  return {
    operation: 'registry.write',
    signer,
    typedData: {
      domain: { name: 'UVPZhixuRegistry', version: '1', chainId: 31337 },
      types: { ZhixuRecord: [{ name: 'planId', type: 'bytes32' }] },
      primaryType: 'ZhixuRecord',
      message: { planId: bytes32('01') },
    },
  };
}

describe('operation matrix', () => {
  const signerAccount = privateKeyToAccount(generatePrivateKey());

  it('prepares every operation name and signs it through the single core path', async () => {
    const authorizer = privateKeyToAccount(generatePrivateKey());
    const buyer = privateKeyToAccount(generatePrivateKey());
    const trigger = triggerFixture(authorizer.address);
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly input: OperationInput;
      readonly primaryType: string;
      readonly calls: readonly string[];
    }> = [
      {
        label: 'plan.register',
        input: registrationInput(signerAccount.address),
        primaryType: PLAN_COMMIT_PRIMARY_TYPE,
        calls: ['commitPlan', 'finalizePlan'],
      },
      {
        label: 'order.birth buyer intent',
        input: {
          operation: 'order.birth',
          role: 'buyer-intent',
          chainId: 31337,
          stateMachineAddress: STATE_MACHINE,
          signer: buyer.address,
          planId: bytes32('01'),
          orderId: bytes32('02'),
          termsHash: bytes32('03'),
          nonce: 1,
          deadline: 1_700_000_000n,
        },
        primaryType: ORDER_BIRTH_INTENT_PRIMARY_TYPE,
        calls: [],
      },
      {
        label: 'order.birth birth authorizer',
        input: {
          operation: 'order.birth',
          role: 'birth-authorizer',
          chainId: 31337,
          stateMachineAddress: STATE_MACHINE,
          signer: authorizer.address,
          trigger,
          authorizations: authorizationsFixture(authorizer.address),
          birthFactAttribution: birthAttributionFixture(trigger),
        },
        primaryType: TRIGGER_ORDER_FROM_OUTSIDE_PRIMARY_TYPE,
        calls: ['triggerOrderFromOutsideFor'],
      },
      {
        label: 'order.finalize',
        input: finalizeInput(buyer.address, buyer.address),
        primaryType: ORDER_FINALIZE_PRIMARY_TYPE,
        calls: [],
      },
      {
        label: 'invite.accept',
        input: inviteInput(buyer.address, buyer.address),
        primaryType: INVITE_ACCEPT_PRIMARY_TYPE,
        calls: [],
      },
      {
        label: 'invite.create',
        input: inviteCreateInput(buyer.address),
        primaryType: UVP_STAGE_INVITE_CREATE_PRIMARY_TYPE,
        calls: [],
      },
      {
        label: 'signal.submit',
        input: signalInput(signerAccount.address),
        primaryType: PRODUCT_SUBMIT_PRIMARY_TYPE,
        calls: ['submitSignalFor'],
      },
      {
        label: 'stagePatch.submit executor',
        input: stageExecutorPatchInput(signerAccount.address),
        primaryType: STAGE_EXECUTOR_PATCH_PRIMARY_TYPE,
        calls: ['applyStageExecutorPatchFor'],
      },
      {
        label: 'stagePatch.submit resource',
        input: stageResourcePatchInput(signerAccount.address),
        primaryType: STAGE_RESOURCE_PATCH_PRIMARY_TYPE,
        calls: ['applyStageResourcePatchFor'],
      },
      {
        label: 'registry.write',
        input: registryInput(signerAccount.address),
        primaryType: 'ZhixuRecord',
        calls: [],
      },
    ];

    for (const testCase of cases) {
      const account = signerFor(testCase.input, signerAccount, buyer, authorizer);
      const prepared = prepareOperation(testCase.input);
      expect(prepared.operation, testCase.label).toBe(testCase.input.operation);
      expect(prepared.typedData.primaryType, testCase.label).toBe(testCase.primaryType);
      const signed = await signOperation(prepared, account);
      expect(signed.calls.map((call) => call.functionName), testCase.label).toEqual(testCase.calls);
    }
  });

  it('binds the signature to the encoded calls', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const plan = await signOperation(prepareOperation(registrationInput(account.address)), account);
    const commit = decodeFunctionData({ abi: STATE_MACHINE_ABI, data: plan.calls[0]!.data });
    expect(commit.functionName).toBe('commitPlan');
    expect((commit.args as readonly unknown[])[3]).toBe(plan.signature);
    const finalize = decodeFunctionData({ abi: STATE_MACHINE_ABI, data: plan.calls[1]!.data });
    expect(finalize.functionName).toBe('finalizePlan');
    expect(finalize.args[0]).toBe(planRegistrationFixture().planId);

    const signal = await signOperation(prepareOperation(signalInput(account.address)), account);
    const submit = decodeFunctionData({ abi: STATE_MACHINE_ABI, data: signal.calls[0]!.data });
    expect(submit.functionName).toBe('submitSignalFor');
    const args = submit.args as readonly unknown[];
    expect(args[6]).toBe(account.address);
    expect(args[7]).toBe(1_700_000_000n);
    expect(args[8]).toBe(signal.signature);
    expect(await recoverTypedDataAddress({
      domain: signal.typedData.domain,
      types: signal.typedData.types,
      primaryType: signal.typedData.primaryType,
      message: signal.typedData.message,
      signature: signal.signature,
    } as never)).toBe(account.address);
  });

  it('derives the signal fact keys from source and stage/name', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signed = await signOperation(prepareOperation(signalInput(account.address)), account);
    const submit = decodeFunctionData({ abi: STATE_MACHINE_ABI, data: signed.calls[0]!.data });
    const args = submit.args as readonly unknown[];
    expect(args[2]).toBe(keccak256(stringToBytes('slot-a')));
    expect(args[3]).toBe(keccak256(stringToBytes('exec.main.cmp')));
  });

  it('keeps buyer intent and birth authorization as disjoint signed payloads', async () => {
    const buyer = privateKeyToAccount(generatePrivateKey());
    const authorizer = privateKeyToAccount(generatePrivateKey());
    const intent = prepareOperation({
      operation: 'order.birth',
      role: 'buyer-intent',
      chainId: 31337,
      stateMachineAddress: STATE_MACHINE,
      signer: buyer.address,
      planId: bytes32('01'),
      orderId: bytes32('02'),
      termsHash: bytes32('03'),
      nonce: 1,
      deadline: 1_700_000_000n,
    });
    const signedIntent = await signOperation(intent, buyer);
    expect(intent.typedData.domain).toMatchObject({
      name: ORDER_BIRTH_INTENT_DOMAIN_NAME,
      chainId: 31337,
      verifyingContract: STATE_MACHINE,
    });
    expect(intent.typedData.types.UVPOrderBirthIntent).toEqual(ORDER_BIRTH_INTENT_TYPED_DATA_FIELDS);
    expect(signedIntent.calls).toEqual([]);
    expect(await recoverTypedDataAddress({
      domain: signedIntent.typedData.domain,
      types: signedIntent.typedData.types,
      primaryType: signedIntent.typedData.primaryType,
      message: signedIntent.typedData.message,
      signature: signedIntent.signature,
    } as never)).toBe(buyer.address);

    const trigger = triggerFixture(authorizer.address);
    const authorization = prepareOperation({
      operation: 'order.birth',
      role: 'birth-authorizer',
      chainId: 31337,
      stateMachineAddress: STATE_MACHINE,
      signer: authorizer.address,
      trigger,
      authorizations: authorizationsFixture(authorizer.address),
      birthFactAttribution: birthAttributionFixture(trigger),
    });
    const signedAuthorization = await signOperation(authorization, authorizer);
    expect(authorization.typedData.primaryType).toBe(TRIGGER_ORDER_FROM_OUTSIDE_PRIMARY_TYPE);
    expect(authorization.typedData.message.submitter.toLowerCase()).toBe(authorizer.address.toLowerCase());
    expect(signedAuthorization.typedData).not.toEqual(signedIntent.typedData);
    expect(await recoverTypedDataAddress({
      domain: signedAuthorization.typedData.domain,
      types: signedAuthorization.typedData.types,
      primaryType: signedAuthorization.typedData.primaryType,
      message: signedAuthorization.typedData.message,
      signature: signedAuthorization.signature,
    } as never)).toBe(authorizer.address);
    const call = decodeFunctionData({ abi: STATE_MACHINE_ABI, data: signedAuthorization.calls[0]!.data });
    expect(call.functionName).toBe('triggerOrderFromOutsideFor');
    expect((call.args as readonly unknown[])[2]).toBe(signedAuthorization.signature);

    const mismatched = (): unknown => prepareOperation({
      operation: 'order.birth',
      role: 'birth-authorizer',
      chainId: 31337,
      stateMachineAddress: STATE_MACHINE,
      signer: buyer.address,
      trigger,
      authorizations: authorizationsFixture(authorizer.address),
      birthFactAttribution: birthAttributionFixture(trigger),
    });
    expect(captureError(mismatched)).toMatchObject({
      operation: 'order.birth',
      code: 'signer_mismatch',
      retryable: false,
    });
  });

  it('signs an invite.create payload that recovers to the buyer', async () => {
    const buyer = privateKeyToAccount(generatePrivateKey());
    const prepared = prepareOperation(inviteCreateInput(buyer.address));
    expect(prepared.typedData.domain).toMatchObject({
      name: 'UVPOrderBook',
      version: '1',
      chainId: 31337,
      verifyingContract: STATE_MACHINE,
    });
    expect(prepared.typedData.message).toMatchObject({
      draftId: 'draft-1',
      stageKey: 'main',
      slotKey: 'performer',
      amount: '100',
      workDeadline: '1700000500',
      nonce: '1',
      deadline: '1700000000',
    });
    const signed = await signOperation(prepared, buyer);
    expect(signed.calls).toEqual([]);
    expect(await recoverTypedDataAddress({
      domain: signed.typedData.domain,
      types: signed.typedData.types,
      primaryType: signed.typedData.primaryType,
      message: signed.typedData.message,
      signature: signed.signature,
    } as never)).toBe(buyer.address);
  });

  it('refuses typed data that names another party as signer', () => {
    const buyer = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    expect(captureError(() => prepareOperation(finalizeInput(other.address, buyer.address)))).toMatchObject({
      operation: 'order.finalize',
      code: 'signer_mismatch',
    });
    expect(captureError(() => prepareOperation(inviteInput(other.address, buyer.address)))).toMatchObject({
      operation: 'invite.accept',
      code: 'signer_mismatch',
    });
  });
});

function signerFor(
  input: OperationInput,
  signerAccount: ReturnType<typeof privateKeyToAccount>,
  buyer: ReturnType<typeof privateKeyToAccount>,
  authorizer: ReturnType<typeof privateKeyToAccount>,
): ReturnType<typeof privateKeyToAccount> {
  switch (input.operation) {
    case 'order.birth':
      return input.role === 'buyer-intent' ? buyer : authorizer;
    case 'order.finalize':
      return buyer;
    case 'invite.accept':
    case 'invite.create':
      return buyer;
    default:
      return signerAccount;
  }
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to be rejected');
}
