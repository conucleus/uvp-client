/**
 * Operation vocabulary and execution engine shared by the browser, headless and
 * CLI shells: one operation set, one prepare/sign path, direct/relay as a
 * transport parameter. Signal submissions carry an empty signature when sent
 * directly (submitter == sender) and the participant-signed typed data when
 * relayed. Operation-specific construction delegates to the core builders
 * (registration/signal) and protocol-bindings; this module owns only the
 * envelope, the signer contract, the result/error model, and the client
 * interface all three shells implement.
 */
import type { Address, Hex, TypedDataDefinition } from 'viem';
import {
  buildApplyStageSupplierPatchForCall,
  buildSelectStageDockSupplierForCall,
  buildSignalSubmissionTypedData,
  buildStageDockSupplierSelectionTypedData,
  buildStageSupplierPatchTypedData,
  buildSubmitSignalCall,
  buildUVPStageInviteCreateTypedData,
  validateUVPOrderFinalizeTypedData,
  validateUVPStageInviteAcceptTypedData,
  type SelectorBindingPayload,
  type StageDockSupplierSelectionPayload,
  type StageSupplierPatchCallPatch,
  type UVPOrderFinalizeTypedData,
  type UVPStageInviteAcceptTypedData,
} from '@uvp-eth/protocol-bindings';
import { ZERO_BYTES32 } from './constants.js';
import {
  buildPlanCommitCall,
  buildPlanCommitTypedDataFor,
  buildPlanFinalizeCall,
  planRegistrationFromCompiled,
  type CompiledPlanRegistration,
  type PlanRegistrationArgs,
} from './registration.js';
import {
  normalizeSignalSubmission,
  parseDeadline,
  type StateMachineSignal,
} from './signal/build.js';
import { buildPokeTimerCall } from './timer.js';
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
  'order.trigger',
  'order.finalize',
  'invite.accept',
  'invite.create',
  'signal.submit',
  'stagePatch.submit',
  'stageDock.select',
  'registry.write',
  'timer.poke',
] as const;

export type OperationName = (typeof OPERATION_NAMES)[number];

export type SubmitMode = 'direct' | 'relay';

/**
 * `direct-empty`: a direct submission is authorized by the sender itself, so
 * the calldata carries an empty signature (submitSignal direct path); relayed
 * submissions still sign the typed data. `signed` always signs. `direct-only`
 * operations carry neither typed data nor a signature: the sending account is
 * the whole authorization and relay delivery is rejected.
 */
export type OperationSignatureDelivery = 'signed' | 'direct-empty' | 'direct-only';

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
  /** Absent only for `direct-only` operations, which have no typed data. */
  readonly typedData?: TypedDataDefinition | undefined;
  readonly buildCalls: (signature: Hex) => readonly OperationCall[];
  readonly signatureDelivery?: OperationSignatureDelivery | undefined;
}

export interface SignedOperation {
  readonly operation: OperationName;
  readonly chainId: number;
  readonly signer: Address;
  readonly typedData?: TypedDataDefinition | undefined;
  readonly signature: Hex;
  readonly calls: readonly OperationCall[];
  readonly signatureDelivery?: OperationSignatureDelivery | undefined;
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
  readonly transport: OperationTransport;
}): OperationClient {
  const signer = normalizeAddressChecksummed(input.signer.address, 'signer');
  const transport = input.transport;
  return {
    mode: input.transport.mode,
    signer,
    prepare: (operationInput) => prepareOperation(operationInput),
    sign: (operationInput) => signOperation(prepareOperation(operationInput), input.signer),
    submit: (signed) => transport.submit(signed),
    async execute(operationInput) {
      const prepared = prepareOperation(operationInput);
      if (prepared.signatureDelivery === 'direct-only') {
        return transport.submit(buildDirectOperation(prepared));
      }
      if (transport.mode === 'direct' && prepared.signatureDelivery === 'direct-empty') {
        return transport.submit(buildEmptySignatureOperation(prepared));
      }
      return transport.submit(await signOperation(prepared, input.signer));
    },
  };
}

export async function signOperation(
  prepared: PreparedOperation,
  signer: OperationSigner,
): Promise<SignedOperation> {
  if (prepared.signatureDelivery === 'direct-only' || prepared.typedData === undefined) {
    throw new OperationError({
      operation: prepared.operation,
      code: 'unsupported_delivery',
      message: `${prepared.operation} carries no typed data to sign; deliver it directly instead`,
    });
  }
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
  return signedOperationOf(prepared, signature);
}

/**
 * Direct delivery of a submission whose authorization is the sender itself:
 * the calldata carries an empty signature, so no typed-data prompt is needed.
 */
export function buildEmptySignatureOperation(prepared: PreparedOperation): SignedOperation {
  return signedOperationOf(prepared, '0x');
}

/** Direct delivery of a permissionless operation: no signature, no typed data, no relay. */
export function buildDirectOperation(prepared: PreparedOperation): SignedOperation {
  if (prepared.signatureDelivery !== 'direct-only') {
    throw new OperationError({
      operation: prepared.operation,
      code: 'unsupported_delivery',
      message: `${prepared.operation} is not a direct-only operation`,
    });
  }
  return signedOperationOf(prepared, '0x');
}

/**
 * Attaches a contract-wallet signature (EIP-1271) to a prepared operation: an
 * EIP-1271 signature is contract-defined bytes, not the 65-byte ECDSA envelope
 * `signOperation` enforces. The state machine verifies it when the submission's
 * submitter is a contract account.
 */
export function signOperationWithSignature(
  prepared: PreparedOperation,
  signature: Hex | string,
): SignedOperation {
  if (typeof signature !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(signature)) {
    throw new OperationError({
      operation: prepared.operation,
      code: 'invalid_signature',
      message: `${prepared.operation} contract signature must be non-empty 0x-prefixed bytes`,
    });
  }
  return signedOperationOf(prepared, signature);
}

function signedOperationOf(prepared: PreparedOperation, signature: Hex | string): SignedOperation {
  return {
    operation: prepared.operation,
    chainId: prepared.chainId,
    signer: prepared.signer,
    ...(prepared.typedData === undefined ? {} : { typedData: prepared.typedData }),
    signature: signature as Hex,
    calls: prepared.buildCalls(signature as Hex),
    ...(prepared.signatureDelivery === 'direct-only' ? { signatureDelivery: 'direct-only' as const } : {}),
  };
}

export interface PlanRegisterOperationInput {
  readonly operation: 'plan.register';
  readonly chainId: number;
  readonly stateMachineAddress: Address | string;
  readonly signer: Address | string;
  readonly registration: PlanRegistrationArgs;
  readonly deadline: bigint | number | string;
  /** Registering includes the second step unless the caller explicitly stages only the commit. */
  readonly finalize?: boolean | undefined;
}

/** Signal fields of an operation: the deadline is the operation envelope's signed field. */
export type OperationSignal = Omit<StateMachineSignal, 'deadline'>;

export interface PlanRegisterFromCompiledInput {
  readonly chainId: number;
  readonly stateMachineAddress: Address | string;
  readonly signer: Address | string;
  readonly deadline: bigint | number | string;
  readonly finalize?: boolean | undefined;
  /** Compiler register args plus the publisher-keyed planId the compiler derived. */
  readonly registration: CompiledPlanRegistration;
}

export function planRegisterFromCompiled(
  input: PlanRegisterFromCompiledInput,
): PlanRegisterOperationInput {
  return {
    operation: 'plan.register',
    chainId: input.chainId,
    stateMachineAddress: input.stateMachineAddress,
    signer: input.signer,
    registration: planRegistrationFromCompiled(input.registration),
    deadline: input.deadline,
    ...(input.finalize === undefined ? {} : { finalize: input.finalize }),
  };
}

export interface OrderTriggerOperationInput {
  readonly operation: 'order.trigger';
  readonly chainId: number;
  readonly stateMachineAddress: Address | string;
  /** Trigger submitter: the trigger stage's assigned supplier account; signs a relayed submission. */
  readonly signer: Address | string;
  readonly signal: OperationSignal;
  readonly deadline: bigint | number | string;
}

export interface SignalSubmitOperationInput {
  readonly operation: 'signal.submit';
  readonly chainId: number;
  readonly stateMachineAddress: Address | string;
  /** Effective stage supplier account the EIP-712 submitter binds to; the relayer only pays for the tx. */
  readonly signer: Address | string;
  readonly signal: OperationSignal;
  readonly deadline: bigint | number | string;
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

export interface StageSupplierPatchOperationInput {
  readonly operation: 'stagePatch.submit';
  readonly chainId: number;
  readonly stagePatchModuleAddress: Address | string;
  /** Selector wallet; signs the patch typed data. */
  readonly signer: Address | string;
  readonly planId: Hex | string;
  readonly orderId: Hex | string;
  readonly deadline: bigint | number | string;
  readonly patch: StageSupplierPatchCallPatch;
  readonly previousSupplierSignature: Hex | string;
  readonly bindingProof: SelectorBindingPayload;
  readonly candidateProof: readonly (Hex | string)[];
}

export interface StageDockSelectOperationInput {
  readonly operation: 'stageDock.select';
  readonly chainId: number;
  readonly stagePatchModuleAddress: Address | string;
  /** Selector wallet; signs the dock selection typed data. */
  readonly signer: Address | string;
  readonly planId: Hex | string;
  readonly orderId: Hex | string;
  readonly deadline: bigint | number | string;
  readonly selection: StageDockSupplierSelectionPayload;
  readonly bindingProof: SelectorBindingPayload;
}

export interface RegistryWriteOperationInput {
  readonly operation: 'registry.write';
  readonly signer: Address | string;
  /** Registry EIP-712 record; schema single-sourced in @uvp-eth/protocol-bindings. */
  readonly typedData: TypedDataDefinition;
}

export interface TimerPokeOperationInput {
  readonly operation: 'timer.poke';
  readonly chainId: number;
  readonly stateMachineAddress: Address | string;
  /** Wallet account that sends the poke; pokeTimer is permissionless and direct-only. */
  readonly signer: Address | string;
  readonly planId: Hex | string;
  readonly orderId: Hex | string;
  readonly hookId: Hex | string;
}

export type OperationInput =
  | PlanRegisterOperationInput
  | OrderTriggerOperationInput
  | SignalSubmitOperationInput
  | OrderFinalizeOperationInput
  | InviteAcceptOperationInput
  | InviteCreateOperationInput
  | StageSupplierPatchOperationInput
  | StageDockSelectOperationInput
  | RegistryWriteOperationInput
  | TimerPokeOperationInput;

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

    case 'order.trigger':
    case 'signal.submit':
      return prepareSignalSubmission(input);

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

    case 'stagePatch.submit': {
      const signer = normalizeAddressChecksummed(input.signer, 'signer');
      const chainId = parsePositiveInteger(input.chainId, 'chainId');
      const deadline = parseBigNumberish(input.deadline, 'deadline');
      const typedData = buildStageSupplierPatchTypedData({
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
        buildCalls: (signature) => [callOf(buildApplyStageSupplierPatchForCall(
          { stagePatchModuleAddress: input.stagePatchModuleAddress, chainId },
          {
            planId: input.planId,
            orderId: input.orderId,
            patch: input.patch,
            selector: signer,
            deadline,
            selectorSignature: signature,
            previousSupplierSignature: input.previousSupplierSignature,
            bindingProof: input.bindingProof,
            candidateProof: input.candidateProof,
          },
        ))],
      };
    }

    case 'stageDock.select': {
      const signer = normalizeAddressChecksummed(input.signer, 'signer');
      const chainId = parsePositiveInteger(input.chainId, 'chainId');
      const deadline = parseBigNumberish(input.deadline, 'deadline');
      const typedData = buildStageDockSupplierSelectionTypedData({
        chainId,
        verifyingContract: input.stagePatchModuleAddress,
        planId: input.planId,
        orderId: input.orderId,
        selector: signer,
        deadline,
        selection: input.selection,
      });
      return {
        operation: 'stageDock.select',
        chainId,
        signer,
        typedData,
        buildCalls: (signature) => [callOf(buildSelectStageDockSupplierForCall(
          { stagePatchModuleAddress: input.stagePatchModuleAddress, chainId },
          {
            planId: input.planId,
            orderId: input.orderId,
            selection: input.selection,
            bindingProof: input.bindingProof,
            selector: signer,
            deadline,
            signature,
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

    case 'timer.poke': {
      const signer = normalizeAddressChecksummed(input.signer, 'signer');
      const chainId = parsePositiveInteger(input.chainId, 'chainId');
      const call = buildPokeTimerCall(
        { stateMachineAddress: input.stateMachineAddress, chainId },
        { planId: input.planId, orderId: input.orderId, hookId: input.hookId },
      );
      return {
        operation: 'timer.poke',
        chainId,
        signer,
        signatureDelivery: 'direct-only',
        buildCalls: () => [callOf(call)],
      };
    }
  }
  throw new ValidationError(`unsupported operation ${String((input as { readonly operation?: unknown }).operation)}`);
}

function prepareSignalSubmission(
  input: OrderTriggerOperationInput | SignalSubmitOperationInput,
): PreparedOperation {
  const signer = normalizeAddressChecksummed(input.signer, 'signer');
  const chainId = parsePositiveInteger(input.chainId, 'chainId');
  const stateMachineAddress = normalizeAddressChecksummed(input.stateMachineAddress, 'stateMachineAddress');
  const deadline = parseDeadline(input.deadline, 'deadline');
  const signal = normalizeSignalSubmission(input.signal);
  if (input.operation === 'order.trigger' && signal.orderId !== ZERO_BYTES32) {
    throw new ValidationError(
      'order.trigger creates a new order: signal.orderId must be omitted (0); submit to an existing order with signal.submit',
    );
  }
  if (input.operation === 'signal.submit' && signal.orderId === ZERO_BYTES32) {
    throw new ValidationError(
      'signal.submit targets an existing order: signal.orderId is required; create an order with order.trigger',
    );
  }
  const typedData = buildSignalSubmissionTypedData({
    chainId,
    verifyingContract: stateMachineAddress,
    planId: signal.planId,
    orderId: signal.orderId,
    sourceId: signal.sourceId,
    signalId: signal.signalId,
    payloadHash: signal.payloadHash,
    idempotencyKey: signal.idempotencyKey,
    patchHash: signal.patchHash,
    attribution: signal.attribution,
    submitter: signer,
    deadline,
  });
  return {
    operation: input.operation,
    chainId,
    signer,
    typedData,
    signatureDelivery: 'direct-empty',
    buildCalls: (signature) => [callOf(buildSubmitSignalCall(
      { stateMachineAddress, chainId },
      {
        planId: signal.planId,
        orderId: signal.orderId,
        sourceId: signal.sourceId,
        signalId: signal.signalId,
        payloadHash: signal.payloadHash,
        idempotencyKey: signal.idempotencyKey,
        attribution: signal.attribution,
        ...(signal.filePatch !== undefined ? { filePatch: signal.filePatch } : {}),
        patchHash: signal.patchHash,
        submitter: signer,
        deadline,
        signature,
      },
    ))],
  };
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
