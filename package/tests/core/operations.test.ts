import { describe, expect, it } from 'vitest';
import {
  decodeFunctionData,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  PLAN_COMMIT_PRIMARY_TYPE,
  SIGNAL_SUBMISSION_PRIMARY_TYPE,
  STAGE_SUPPLIER_PATCH_PRIMARY_TYPE,
  STATE_MACHINE_ABI,
  STAGE_PATCH_MODULE_ABI,
  buildZhixuRecordTypedData,
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

function registryInput(signer: Address): OperationInput {
  return {
    operation: 'registry.write',
    signer,
    typedData: buildZhixuRecordTypedData({
      chainId: 31337,
      planId: bytes32('01'),
      planHash: bytes32('02'),
      registeredBy: signer,
    }),
  };
}

describe('operation matrix', () => {
  const signerAccount = privateKeyToAccount(generatePrivateKey());

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

  it('binds the selector signature to the supplier-scoped patch calldata', async () => {
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
});
