/**
 * Operation vocabulary and execution engine shared by the browser, headless and
 * CLI shells: one operation set, one prepare/sign path, direct/relay as a
 * transport parameter. Operation-specific construction delegates to the core
 * builders (registration/birth/signal) and protocol-bindings; this module owns
 * only the envelope, the signer contract, the result/error model, and the
 * client interface all three shells implement.
 */
import type { Address, Hex, TypedDataDefinition } from 'viem';
import {
  buildApplyStageExecutorPatchForCall,
  buildApplyStageResourcePatchForCall,
  buildProductSubmitTypedData,
  buildStageExecutorPatchTypedData,
  buildStageResourcePatchTypedData,
  buildSubmitSignalForCall,
  buildUVPStageInviteCreateTypedData,
  validateUVPOrderFinalizeTypedData,
  validateUVPStageInviteAcceptTypedData,
  type SelectorBindingPayload,
  type SignalAttributionPayload,
  type SignalAuthorizationPayload,
  type StageExecutorPatchCallPatch,
  type StageResourcePatchCallPatch,
  type TriggerOrderFromOutsidePayload,
  type UVPOrderFinalizeTypedData,
  type UVPStageInviteAcceptTypedData,
} from '@uvp-eth/protocol-bindings';
import {
  assertBirthAuthorizationSigner,
  buildOrderBirthAuthorization,
  buildOrderBirthIntent,
  orderBirthAuthorizationCall,
} from './birth.js';
import {
  buildPlanCommitCall,
  buildPlanCommitTypedDataFor,
  buildPlanFinalizeCall,
  type PlanRegistrationArgs,
} from './registration.js';
import { normalizeSignalSubmission, type StateMachineSignal } from './signal/build.js';
import type { OperationTransport } from './transport.js';
import {
  ExecutorKitError,
  normalizeAddressChecksummed,
  parseBigNumberish,
  parsePositiveInteger,
  ValidationError,
} from './validation.js';

export const OPERATION_NAMES = [
  'plan.register',
  'order.birth',
  'order.finalize',
  'invite.accept',
  'invite.create',
  'signal.submit',
  'stagePatch.submit',
  'registry.write',
] as const;

export type OperationName = (typeof OPERATION_NAMES)[number];

export type SubmitMode = 'direct' | 'relay';

export interface OperationCall {
  readonly to: Address;
  readonly functionName: string;
  readonly data: Hex;
}

export interface PreparedOperation {
  /** Unsigned envelope: the signer authorizes typedData, then buildCalls embeds the signature. */
  readonly operation: OperationName;
  readonly chainId: number;
  readonly signer: Address;
  readonly typedData: TypedDataDefinition;
  readonly buildCalls: (signature: Hex) => readonly OperationCall[];
}

export interface SignedOperation {
  readonly operation: OperationName;
  readonly chainId: number;
  readonly signer: Address;
  readonly typedData: TypedDataDefinition;
  readonly signature: Hex;
  readonly calls: readonly OperationCall[];
}

export type OperationStatus = 'submitted' | 'accepted';

export interface OperationResult {
  readonly operation: OperationName;
  readonly mode: SubmitMode;
  readonly chainId: number;
  readonly signer: Address;
  readonly status: OperationStatus;
  readonly txHashes: readonly Hex[];
  readonly relayRef?: string;
}

export type OperationErrorCode =
  | 'unsupported_delivery'
  | 'signer_mismatch'
  | 'invalid_signature'
  | 'broadcast_failed'
  | 'relay_unreachable'
  | 'relay_rejected'
  | 'invalid_relay_response';

export interface OperationErrorInput {
  readonly operation: OperationName;
  readonly code: OperationErrorCode;
  readonly message: string;
  readonly retryable?: boolean | undefined;
  readonly cause?: unknown;
}

const RETRYABLE: Readonly<Record<OperationErrorCode, boolean>> = {
  unsupported_delivery: false,
  signer_mismatch: false,
  invalid_signature: false,
  broadcast_failed: false,
  relay_unreachable: true,
  relay_rejected: false,
  invalid_relay_response: false,
};

export class OperationError extends ExecutorKitError {
  override readonly name = 'OperationError';
  readonly operation: OperationName;
  readonly code: OperationErrorCode;
  readonly retryable: boolean;

  constructor(input: OperationErrorInput) {
    super(input.message);
    if (input.cause !== undefined) {
      this.cause = input.cause;
    }
    this.operation = input.operation;
    this.code = input.code;
    this.retryable = input.retryable ?? RETRYABLE[input.code];
  }
}

export interface OperationSigner {
  readonly address: Address;
  signTypedData(typedData: TypedDataDefinition): Promise<Hex>;
}

export interface OperationClient {
  readonly mode: SubmitMode;
  readonly signer: Address;
  prepare(input: OperationInput): PreparedOperation;
  sign(input: OperationInput): Promise<SignedOperation>;
  submit(signed: SignedOperation): Promise<OperationResult>;
  execute(input: OperationInput): Promise<OperationResult>;
}

export function createOperationClient(input: {
  readonly signer: OperationSigner;
  readonly mode: SubmitMode;
  readonly transport: OperationTransport;
}): OperationClient {
  const signer = normalizeAddressChecksummed(input.signer.address, 'signer');
  return {
    mode: input.mode,
    signer,
    prepare: (operationInput) => prepareOperation(operationInput),
    sign: (operationInput) => signOperation(prepareOperation(operationInput), input.signer),
    submit: (signed) => input.transport.submit(signed),
    async execute(operationInput) {
      const signed = await signOperation(prepareOperation(operationInput), input.signer);
      return input.transport.submit(signed);
    },
  };
}

export async function signOperation(
  prepared: PreparedOperation,
  signer: OperationSigner,
): Promise<SignedOperation> {
  const signerAddress = normalizeAddressChecksummed(signer.address, 'signer');
  if (signerAddress !== prepared.signer) {
    throw new OperationError({
      operation: prepared.operation,
      code: 'signer_mismatch',
      message: `operation ${prepared.operation} is prepared for ${prepared.signer}, not ${signerAddress}`,
    });
  }
  const signature = await signer.signTypedData(prepared.typedData);
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new OperationError({
      operation: prepared.operation,
      code: 'invalid_signature',
      message: `signer returned a non-65-byte signature for ${prepared.operation}`,
    });
  }
  return {
    operation: prepared.operation,
    chainId: prepared.chainId,
    signer: prepared.signer,
    typedData: prepared.typedData,
    signature,
    calls: prepared.buildCalls(signature),
  };
}

export interface PlanRegisterOperationInput {
  readonly operation: 'plan.register';
  readonly chainId: number;
  readonly stateMachineAddress: Address | string;
  readonly signer: Address | string;
  readonly registration: PlanRegistrationArgs;
  readonly deadline: bigint | number | string;
  readonly birthAuthorizer?: Address | string | undefined;
  /** Registering includes the second step unless the caller explicitly stages only the commit. */
  readonly finalize?: boolean | undefined;
}

export interface OrderBirthIntentOperationInput {
  readonly operation: 'order.birth';
  readonly role: 'buyer-intent';
  readonly chainId: number;
  readonly stateMachineAddress: Address | string;
  /** Buyer wallet; signs the intent, never the birth authorization. */
  readonly signer: Address | string;
  readonly planId: Hex | string;
  readonly orderId: Hex | string;
  readonly termsHash: Hex | string;
  readonly nonce: bigint | number | string;
  readonly deadline: bigint | number | string;
}

export interface OrderBirthAuthorizationOperationInput {
  readonly operation: 'order.birth';
  readonly role: 'birth-authorizer';
  readonly chainId: number;
  readonly stateMachineAddress: Address | string;
  /** Must equal trigger.submitter: the plan's birthAuthorizer. */
  readonly signer: Address | string;
  readonly trigger: TriggerOrderFromOutsidePayload;
  readonly authorizations: readonly SignalAuthorizationPayload[];
  readonly birthFactAttribution: SignalAttributionPayload;
}

export interface OrderFinalizeOperationInput {
  readonly operation: 'order.finalize';
  readonly signer: Address | string;
  /** Buyer-signed UVPOrderFinalize prepared by the order service; validated field-by-field. */
  readonly typedData: UVPOrderFinalizeTypedData;
}

export interface InviteAcceptOperationInput {
  readonly operation: 'invite.accept';
  readonly signer: Address | string;
  /** Invitee-signed UVPStageInviteAccept prepared at invite preview; validated field-by-field. */
  readonly typedData: UVPStageInviteAcceptTypedData;
}

export interface InviteCreateOperationInput {
  readonly operation: 'invite.create';
  /** Draft buyer; signs the invite terms that an app backend may turn into an invite. */
  readonly signer: Address | string;
  readonly chainId: number;
  readonly stateMachineAddress: Address | string;
  readonly draftId: string;
  readonly stageKey: string;
  readonly stageId: Hex | string;
  readonly slotKey: string;
  readonly invitee: Address | string;
  readonly amount: bigint | number | string;
  readonly finalStandardHash: Hex | string;
  readonly workDeadline: bigint | number | string;
  readonly termsHash: Hex | string;
  readonly nonce: bigint | number | string;
  readonly deadline: bigint | number | string;
}

export interface SignalSubmitOperationInput {
  readonly operation: 'signal.submit';
  readonly chainId: number;
  readonly stateMachineAddress: Address | string;
  readonly signer: Address | string;
  readonly deadline: bigint | number | string;
  readonly signal: StateMachineSignal;
}

export interface StageExecutorPatchOperationInput {
  readonly operation: 'stagePatch.submit';
  readonly kind: 'executor';
  readonly chainId: number;
  readonly stagePatchModuleAddress: Address | string;
  /** Selector wallet; signs the patch typed data. */
  readonly signer: Address | string;
  readonly planId: Hex | string;
  readonly orderId: Hex | string;
  readonly deadline: bigint | number | string;
  readonly patch: StageExecutorPatchCallPatch;
  readonly previousExecutorSignature: Hex | string;
  readonly bindingProof: SelectorBindingPayload;
  readonly candidateProof: readonly (Hex | string)[];
  readonly executorAuthorizations: readonly SignalAuthorizationPayload[];
}

export interface StageResourcePatchOperationInput {
  readonly operation: 'stagePatch.submit';
  readonly kind: 'resource';
  readonly chainId: number;
  readonly stagePatchModuleAddress: Address | string;
  readonly signer: Address | string;
  readonly planId: Hex | string;
  readonly orderId: Hex | string;
  readonly deadline: bigint | number | string;
  readonly patch: StageResourcePatchCallPatch;
  readonly bindingProof: SelectorBindingPayload;
}

export interface RegistryWriteOperationInput {
  readonly operation: 'registry.write';
  readonly signer: Address | string;
  /** Registry EIP-712 record; schema single-sourced in @uvp-eth/protocol-bindings. */
  readonly typedData: TypedDataDefinition;
}

export type OperationInput =
  | PlanRegisterOperationInput
  | OrderBirthIntentOperationInput
  | OrderBirthAuthorizationOperationInput
  | OrderFinalizeOperationInput
  | InviteAcceptOperationInput
  | InviteCreateOperationInput
  | SignalSubmitOperationInput
  | StageExecutorPatchOperationInput
  | StageResourcePatchOperationInput
  | RegistryWriteOperationInput;

export function prepareOperation(input: OperationInput): PreparedOperation {
  try {
    return prepareOperationInput(input);
  } catch (error) {
    if (error instanceof ExecutorKitError) {
      throw error;
    }
    throw new ValidationError(error instanceof Error ? error.message : String(error));
  }
}

function prepareOperationInput(input: OperationInput): PreparedOperation {
  switch (input.operation) {
    case 'plan.register': {
      const signer = normalizeAddressChecksummed(input.signer, 'signer');
      const chainId = parsePositiveInteger(input.chainId, 'chainId');
      const deadline = parseBigNumberish(input.deadline, 'deadline');
      const typedData = buildPlanCommitTypedDataFor(
        { stateMachineAddress: input.stateMachineAddress, chainId },
        {
          publisher: signer,
          deadline,
          registration: input.registration,
          ...(input.birthAuthorizer !== undefined ? { birthAuthorizer: input.birthAuthorizer } : {}),
        },
      );
      return {
        operation: 'plan.register',
        chainId,
        signer,
        typedData,
        buildCalls: (signature) => [
          callOf(buildPlanCommitCall(
            { stateMachineAddress: input.stateMachineAddress, chainId },
            {
              publisher: signer,
              deadline,
              registration: input.registration,
              signature,
              ...(input.birthAuthorizer !== undefined ? { birthAuthorizer: input.birthAuthorizer } : {}),
            },
          )),
          ...(input.finalize === false
            ? []
            : [callOf(buildPlanFinalizeCall(
              { stateMachineAddress: input.stateMachineAddress, chainId },
              input.registration.planId,
            ))]),
        ],
      };
    }

    case 'order.birth': {
      if (input.role === 'buyer-intent') {
        const signer = normalizeAddressChecksummed(input.signer, 'signer');
        const typedData = buildOrderBirthIntent({
          chainId: input.chainId,
          stateMachineAddress: input.stateMachineAddress,
          planId: input.planId,
          orderId: input.orderId,
          buyer: signer,
          termsHash: input.termsHash,
          nonce: input.nonce,
          deadline: input.deadline,
        });
        return {
          operation: 'order.birth',
          chainId: typedData.domain.chainId,
          signer,
          typedData,
          buildCalls: () => [],
        };
      }
      const signer = normalizeAddressChecksummed(input.signer, 'signer');
      try {
        assertBirthAuthorizationSigner({ signer, trigger: input.trigger });
      } catch (error) {
        throw new OperationError({
          operation: 'order.birth',
          code: 'signer_mismatch',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const authorization = buildOrderBirthAuthorization({
        chainId: input.chainId,
        stateMachineAddress: input.stateMachineAddress,
        trigger: input.trigger,
        authorizations: input.authorizations,
      });
      return {
        operation: 'order.birth',
        chainId: authorization.domain.chainId,
        signer,
        typedData: authorization,
        buildCalls: (signature) => [orderBirthAuthorizationCall({
          chainId: input.chainId,
          stateMachineAddress: input.stateMachineAddress,
          trigger: input.trigger,
          authorizations: input.authorizations,
          signature,
          birthFactAttribution: input.birthFactAttribution,
        })],
      };
    }

    case 'order.finalize': {
      const typedData = validateUVPOrderFinalizeTypedData(input.typedData);
      const signer = assertMessageSigner(typedData.message.buyer, input.signer, 'order.finalize', 'buyer');
      return {
        operation: 'order.finalize',
        chainId: typedData.domain.chainId,
        signer,
        typedData,
        buildCalls: () => [],
      };
    }

    case 'invite.accept': {
      const typedData = validateUVPStageInviteAcceptTypedData(input.typedData);
      const signer = assertMessageSigner(typedData.message.invitee, input.signer, 'invite.accept', 'invitee');
      return {
        operation: 'invite.accept',
        chainId: typedData.domain.chainId,
        signer,
        typedData,
        buildCalls: () => [],
      };
    }

    case 'invite.create': {
      const signer = normalizeAddressChecksummed(input.signer, 'signer');
      const typedData = buildUVPStageInviteCreateTypedData({
        chainId: input.chainId,
        verifyingContract: input.stateMachineAddress,
        draftId: input.draftId,
        stageKey: input.stageKey,
        stageId: input.stageId,
        slotKey: input.slotKey,
        invitee: input.invitee,
        amount: input.amount,
        finalStandardHash: input.finalStandardHash,
        workDeadline: input.workDeadline,
        termsHash: input.termsHash,
        nonce: input.nonce,
        deadline: input.deadline,
      });
      return {
        operation: 'invite.create',
        chainId: typedData.domain.chainId,
        signer,
        typedData,
        buildCalls: () => [],
      };
    }

    case 'signal.submit': {
      const signer = normalizeAddressChecksummed(input.signer, 'signer');
      const chainId = parsePositiveInteger(input.chainId, 'chainId');
      const stateMachineAddress = normalizeAddressChecksummed(
        input.stateMachineAddress,
        'stateMachineAddress',
      );
      const deadline = parseBigNumberish(input.deadline, 'deadline');
      const submission = normalizeSignalSubmission(input.signal);
      const typedData = buildProductSubmitTypedData({
        chainId,
        verifyingContract: stateMachineAddress,
        planId: submission.planId,
        orderId: submission.orderId,
        sourceId: submission.sourceId,
        signalId: submission.signalId,
        payloadHash: submission.payloadHash,
        idempotencyKey: submission.idempotencyKey,
        submitter: signer,
        deadline: deadline.toString(10),
      });
      return {
        operation: 'signal.submit',
        chainId,
        signer,
        typedData,
        buildCalls: (signature) => [callOf(buildSubmitSignalForCall(
          { stateMachineAddress, chainId },
          {
            ...submission,
            submitter: signer,
            deadline,
            signature,
          },
        ))],
      };
    }

    case 'stagePatch.submit': {
      const signer = normalizeAddressChecksummed(input.signer, 'signer');
      const chainId = parsePositiveInteger(input.chainId, 'chainId');
      const deadline = parseBigNumberish(input.deadline, 'deadline');
      if (input.kind === 'executor') {
        const typedData = buildStageExecutorPatchTypedData({
          ...input.patch,
          chainId,
          verifyingContract: input.stagePatchModuleAddress,
          planId: input.planId,
          orderId: input.orderId,
          selector: signer,
          deadline,
        });
        return {
          operation: 'stagePatch.submit',
          chainId,
          signer,
          typedData,
          buildCalls: (signature) => [callOf(buildApplyStageExecutorPatchForCall(
            { stagePatchModuleAddress: input.stagePatchModuleAddress, chainId },
            {
              planId: input.planId,
              orderId: input.orderId,
              patch: input.patch,
              selector: signer,
              deadline,
              selectorSignature: signature,
              previousExecutorSignature: input.previousExecutorSignature,
              bindingProof: input.bindingProof,
              candidateProof: input.candidateProof,
              executorAuthorizations: input.executorAuthorizations,
            },
          ))],
        };
      }
      const typedData = buildStageResourcePatchTypedData({
        ...input.patch,
        chainId,
        verifyingContract: input.stagePatchModuleAddress,
        planId: input.planId,
        orderId: input.orderId,
        selector: signer,
        deadline,
      });
      return {
        operation: 'stagePatch.submit',
        chainId,
        signer,
        typedData,
        buildCalls: (signature) => [callOf(buildApplyStageResourcePatchForCall(
          { stagePatchModuleAddress: input.stagePatchModuleAddress, chainId },
          {
            planId: input.planId,
            orderId: input.orderId,
            patch: input.patch,
            selector: signer,
            deadline,
            signature,
            bindingProof: input.bindingProof,
          },
        ))],
      };
    }

    case 'registry.write': {
      const signer = normalizeAddressChecksummed(input.signer, 'signer');
      const chainId = chainIdOfTypedData(input.typedData, 'registry.write');
      return {
        operation: 'registry.write',
        chainId,
        signer,
        typedData: input.typedData,
        buildCalls: () => [],
      };
    }
  }
  throw new ValidationError(`unsupported operation ${String((input as { readonly operation?: unknown }).operation)}`);
}

function callOf(call: { readonly address: Address; readonly functionName: string; readonly data: Hex }): OperationCall {
  return { to: call.address, functionName: call.functionName, data: call.data };
}

function assertMessageSigner(
  messageSigner: Address | string,
  signer: Address | string,
  operation: OperationName,
  field: string,
): Address {
  const declared = normalizeAddressChecksummed(messageSigner, field);
  const normalized = normalizeAddressChecksummed(signer, 'signer');
  if (declared !== normalized) {
    throw new OperationError({
      operation,
      code: 'signer_mismatch',
      message: `${operation} typed data names ${declared} as ${field}, not signer ${normalized}`,
    });
  }
  return normalized;
}

function chainIdOfTypedData(typedData: TypedDataDefinition, operation: OperationName): number {
  const domain = typedData.domain as { readonly chainId?: unknown };
  const chainId = domain.chainId;
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new ValidationError(`${operation} typed data must declare a positive integer domain.chainId`);
  }
  return chainId;
}
