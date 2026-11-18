import { describe, expect, it } from 'vitest';
import {
  decodeFunctionData,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  PLAN_COMMIT_PRIMARY_TYPE,
  SIGNAL_SUBMISSION_PRIMARY_TYPE,
  STAGE_DOCK_SUPPLIER_SELECTION_PRIMARY_TYPE,
  STAGE_SUPPLIER_PATCH_PRIMARY_TYPE,
  STATE_MACHINE_ABI,
  STAGE_PATCH_MODULE_ABI,
  UVP_STAGE_INVITE_CREATE_PRIMARY_TYPE,
  buildUVPOrderFinalizeTypedData,
  buildUVPStageInviteAcceptTypedData,
} from '@uvp-eth/protocol-bindings';
import {
  prepareOperation,
  signOperation,
  signOperationWithSignature,
  type OperationInput,
} from '../../src/core/operations.js';
import {
  STATE_MACHINE,
  STAGE_PATCH_MODULE,
  SIGNAL_DEADLINE,
  bytes32,
  planRegistrationFixture,
  stateMachineSignalFixture,
  triggerSignalFixture,
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
    deadline: SIGNAL_DEADLINE,
  };
}

function stageSupplierPatchInput(signer: Address): OperationInput {
  return {
    operation: 'stagePatch.submit',
    chainId: 31337,
    stagePatchModuleAddress: STAGE_PATCH_MODULE,
    signer,
    planId: bytes32('01'),
    orderId: bytes32('02'),
    deadline: SIGNAL_DEADLINE,
    patch: {
      selectorStageId: bytes32('04'),
      targetStageId: bytes32('05'),
      supplierId: bytes32('06'),
      previousSupplierId: bytes32('00'),
      patchNonce: 3,
    },
    previousSupplierSignature: `0x${'22'.repeat(65)}`,
    bindingProof: { selectorStageId: bytes32('09'), proof: [] },
    candidateProof: [],
  };
}

function stageDockSelectInput(signer: Address): OperationInput {
  return {
    operation: 'stageDock.select',
    chainId: 31337,
    stagePatchModuleAddress: STAGE_PATCH_MODULE,
    signer,
    planId: bytes32('01'),
    orderId: bytes32('02'),
    deadline: SIGNAL_DEADLINE,
    selection: {
      selectorStageId: bytes32('04'),
      targetStageId: bytes32('05'),
      dockId: bytes32('06'),
      supplierId: bytes32('07'),
      patchNonce: 1,
    },
    bindingProof: { selectorStageId: bytes32('04'), proof: [] },
  };
}

function signalSubmitInput(signer: Address): OperationInput {
  return {
    operation: 'signal.submit',
    chainId: 31337,
    stateMachineAddress: STATE_MACHINE,
    signer,
    signal: stateMachineSignalFixture(),
    deadline: SIGNAL_DEADLINE,
  };
}

function orderTriggerInput(signer: Address): OperationInput {
  return {
    operation: 'order.trigger',
    chainId: 31337,
    stateMachineAddress: STATE_MACHINE,
    signer,
    signal: triggerSignalFixture(bytes32('17')),
    deadline: SIGNAL_DEADLINE,
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
      deadline: SIGNAL_DEADLINE,
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
      deadline: SIGNAL_DEADLINE,
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
    deadline: SIGNAL_DEADLINE,
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
  const buyer = privateKeyToAccount(generatePrivateKey());

  it('prepares every operation name and signs it through the single core path', async () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly input: OperationInput;
      readonly primaryType: string;
      readonly calls: readonly string[];
      readonly signer: ReturnType<typeof privateKeyToAccount>;
    }> = [
      {
        label: 'plan.register',
        input: registrationInput(signerAccount.address),
        primaryType: PLAN_COMMIT_PRIMARY_TYPE,
        calls: ['commitPlan', 'finalizePlan'],
        signer: signerAccount,
      },
      {
        label: 'order.trigger',
        input: orderTriggerInput(signerAccount.address),
        primaryType: SIGNAL_SUBMISSION_PRIMARY_TYPE,
        calls: ['submitSignal'],
        signer: signerAccount,
      },
      {
        label: 'order.finalize',
        input: finalizeInput(buyer.address, buyer.address),
        primaryType: ORDER_FINALIZE_PRIMARY_TYPE,
        calls: [],
        signer: buyer,
      },
      {
        label: 'invite.accept',
        input: inviteInput(buyer.address, buyer.address),
        primaryType: INVITE_ACCEPT_PRIMARY_TYPE,
        calls: [],
        signer: buyer,
      },
      {
        label: 'invite.create',
        input: inviteCreateInput(buyer.address),
        primaryType: UVP_STAGE_INVITE_CREATE_PRIMARY_TYPE,
        calls: [],
        signer: buyer,
      },
      {
        label: 'signal.submit',
        input: signalSubmitInput(signerAccount.address),
        primaryType: SIGNAL_SUBMISSION_PRIMARY_TYPE,
        calls: ['submitSignal'],
        signer: signerAccount,
      },
      {
        label: 'stagePatch.submit',
        input: stageSupplierPatchInput(signerAccount.address),
        primaryType: STAGE_SUPPLIER_PATCH_PRIMARY_TYPE,
        calls: ['applyStageSupplierPatchFor'],
        signer: signerAccount,
      },
      {
        label: 'stageDock.select',
        input: stageDockSelectInput(signerAccount.address),
        primaryType: STAGE_DOCK_SUPPLIER_SELECTION_PRIMARY_TYPE,
        calls: ['selectStageDockSupplierFor'],
        signer: signerAccount,
      },
      {
        label: 'registry.write',
        input: registryInput(signerAccount.address),
        primaryType: 'ZhixuRecord',
        calls: [],
        signer: signerAccount,
      },
    ];

    for (const testCase of cases) {
      const prepared = prepareOperation(testCase.input);
      expect(prepared.operation, testCase.label).toBe(testCase.input.operation);
      expect(prepared.typedData.primaryType, testCase.label).toBe(testCase.primaryType);
      const signed = await signOperation(prepared, testCase.signer);
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
    expect((finalize.args as readonly unknown[])[0]).toBe(planRegistrationFixture().planId);
  });

  it('binds the selector signature to the supplier-scoped patch and dock calldata', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const patch = await signOperation(prepareOperation(stageSupplierPatchInput(account.address)), account);
    const patchCall = decodeFunctionData({ abi: STAGE_PATCH_MODULE_ABI, data: patch.calls[0]!.data });
    expect(patchCall.functionName).toBe('applyStageSupplierPatchFor');
    expect((patchCall.args as readonly unknown[])[2]).toEqual({
      selectorStageId: bytes32('04'),
      targetStageId: bytes32('05'),
      supplierId: bytes32('06'),
      previousSupplierId: bytes32('00'),
      patchNonce: 3n,
    });
    expect((patchCall.args as readonly unknown[])[5]).toBe(patch.signature);

    const dock = await signOperation(prepareOperation(stageDockSelectInput(account.address)), account);
    const dockCall = decodeFunctionData({ abi: STAGE_PATCH_MODULE_ABI, data: dock.calls[0]!.data });
    expect(dockCall.functionName).toBe('selectStageDockSupplierFor');
    expect((dockCall.args as readonly unknown[])[2]).toEqual({
      selectorStageId: bytes32('04'),
      targetStageId: bytes32('05'),
      dockId: bytes32('06'),
      supplierId: bytes32('07'),
      patchNonce: 1n,
    });
    expect((dockCall.args as readonly unknown[])[5]).toBe(dock.signature);
  });

  it('attaches an EIP-1271 contract signature to a signal.submit envelope', () => {
    const contractSupplierAccount = '0x00000000000000000000000000000000000000c1' as Address;
    const prepared = prepareOperation(signalSubmitInput(contractSupplierAccount));
    expect(prepared.signer.toLowerCase()).toBe(contractSupplierAccount.toLowerCase());

    const signature = `0x${'a1'.repeat(80)}` as Hex;
    const signed = signOperationWithSignature(prepared, signature);
    expect(signed.signer.toLowerCase()).toBe(contractSupplierAccount.toLowerCase());
    expect(signed.signature).toBe(signature);
    const call = decodeFunctionData({ abi: STATE_MACHINE_ABI, data: signed.calls[0]!.data });
    expect(call.functionName).toBe('submitSignal');
    const submission = call.args[0] as unknown as {
      readonly submitter: string;
    };
    expect(submission.submitter.toLowerCase()).toBe(contractSupplierAccount.toLowerCase());
    expect(call.args[1]).toBe(signature);
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

  it('signs an invite.create payload that recovers to the buyer', async () => {
    const buyerAccount = privateKeyToAccount(generatePrivateKey());
    const prepared = prepareOperation(inviteCreateInput(buyerAccount.address));
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
      deadline: SIGNAL_DEADLINE.toString(10),
    });
    const signed = await signOperation(prepared, buyerAccount);
    expect(signed.calls).toEqual([]);
    expect(await recoverTypedDataAddress({
      domain: signed.typedData.domain,
      types: signed.typedData.types,
      primaryType: signed.typedData.primaryType,
      message: signed.typedData.message,
      signature: signed.signature,
    } as never)).toBe(buyerAccount.address);
  });
});

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to be rejected');
}
