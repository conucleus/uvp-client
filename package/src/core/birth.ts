/**
 * Order-birth split: the buyer signs an intent (a terms commitment) and the
 * plan's birthAuthorizer signs the on-chain birth authorization. The two
 * builders return disjoint types, so a signature produced for one role can
 * never be submitted for the other. The authorization typed data/calldata stay
 * single-sourced in @uvp-eth/protocol-bindings; the intent field table and
 * domain below are the only copies.
 */
import { keccak256, toHex, type Address, type Hex } from 'viem';
import {
  buildTriggerOrderFromOutsideForCall,
  buildTriggerOrderFromOutsideTypedData,
  type SignalAttributionPayload,
  type SignalAuthorizationPayload,
  type TriggerOrderFromOutsidePayload,
  type TriggerOrderFromOutsideTypedData,
} from '@uvp-eth/protocol-bindings';
import type { OperationCall } from './operations.js';
import {
  normalizeAddressChecksummed,
  normalizeBytes32,
  parseBigNumberish,
  parsePositiveInteger,
  ValidationError,
} from './validation.js';

export const ORDER_BIRTH_INTENT_DOMAIN_NAME = 'UVPOrderBirth' as const;
export const ORDER_BIRTH_INTENT_DOMAIN_VERSION = '1' as const;
export const ORDER_BIRTH_INTENT_PRIMARY_TYPE = 'UVPOrderBirthIntent' as const;

export interface OrderBirthIntentField {
  readonly name: string;
  readonly type: string;
}

/** Buyer consent fields: terms (stages/amount/participants) are committed via termsHash. */
export const ORDER_BIRTH_INTENT_TYPED_DATA_FIELDS: readonly OrderBirthIntentField[] = [
  { name: 'planId', type: 'bytes32' },
  { name: 'orderId', type: 'bytes32' },
  { name: 'buyer', type: 'address' },
  { name: 'termsHash', type: 'bytes32' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
];

export const ORDER_BIRTH_INTENT_TYPE_HASH: Hex = keccak256(toHex(
  `${ORDER_BIRTH_INTENT_PRIMARY_TYPE}(${ORDER_BIRTH_INTENT_TYPED_DATA_FIELDS
    .map((field) => `${field.type} ${field.name}`)
    .join(',')})`,
));

export interface OrderBirthIntentDomain {
  readonly name: typeof ORDER_BIRTH_INTENT_DOMAIN_NAME;
  readonly version: typeof ORDER_BIRTH_INTENT_DOMAIN_VERSION;
  readonly chainId: number;
  readonly verifyingContract: Address;
}

export interface OrderBirthIntent {
  readonly domain: OrderBirthIntentDomain;
  readonly types: { readonly UVPOrderBirthIntent: readonly OrderBirthIntentField[] };
  readonly primaryType: typeof ORDER_BIRTH_INTENT_PRIMARY_TYPE;
  readonly message: {
    readonly planId: Hex;
    readonly orderId: Hex;
    readonly buyer: Address;
    readonly termsHash: Hex;
    readonly nonce: string;
    readonly deadline: string;
  };
}

export interface BuildOrderBirthIntentInput {
  readonly chainId: number;
  readonly stateMachineAddress: Address | string;
  readonly planId: Hex | string;
  readonly orderId: Hex | string;
  readonly buyer: Address | string;
  readonly termsHash: Hex | string;
  readonly nonce: bigint | number | string;
  readonly deadline: bigint | number | string;
}

export function buildOrderBirthIntent(input: BuildOrderBirthIntentInput): OrderBirthIntent {
  return {
    domain: {
      name: ORDER_BIRTH_INTENT_DOMAIN_NAME,
      version: ORDER_BIRTH_INTENT_DOMAIN_VERSION,
      chainId: parsePositiveInteger(input.chainId, 'chainId'),
      verifyingContract: normalizeAddressChecksummed(input.stateMachineAddress, 'stateMachineAddress'),
    },
    types: { UVPOrderBirthIntent: ORDER_BIRTH_INTENT_TYPED_DATA_FIELDS },
    primaryType: ORDER_BIRTH_INTENT_PRIMARY_TYPE,
    message: {
      planId: normalizeBytes32(input.planId, 'planId'),
      orderId: normalizeBytes32(input.orderId, 'orderId'),
      buyer: normalizeAddressChecksummed(input.buyer, 'buyer'),
      termsHash: normalizeBytes32(input.termsHash, 'termsHash'),
      nonce: parseBigNumberish(input.nonce, 'nonce').toString(10),
      deadline: parseBigNumberish(input.deadline, 'deadline').toString(10),
    },
  };
}

export interface BuildOrderBirthAuthorizationInput {
  readonly chainId: number;
  readonly stateMachineAddress: Address | string;
  readonly trigger: TriggerOrderFromOutsidePayload;
  readonly authorizations: readonly SignalAuthorizationPayload[];
}

export type OrderBirthAuthorization = TriggerOrderFromOutsideTypedData;

export function buildOrderBirthAuthorization(
  input: BuildOrderBirthAuthorizationInput,
): OrderBirthAuthorization {
  return buildTriggerOrderFromOutsideTypedData({
    ...input.trigger,
    chainId: parsePositiveInteger(input.chainId, 'chainId'),
    verifyingContract: normalizeAddressChecksummed(input.stateMachineAddress, 'stateMachineAddress'),
    authorizations: input.authorizations,
  });
}

export interface OrderBirthAuthorizationCallInput extends BuildOrderBirthAuthorizationInput {
  readonly signature: Hex | string;
  readonly birthFactAttribution: SignalAttributionPayload;
}

export function orderBirthAuthorizationCall(input: OrderBirthAuthorizationCallInput): OperationCall {
  const call = buildTriggerOrderFromOutsideForCall(
    {
      stateMachineAddress: normalizeAddressChecksummed(input.stateMachineAddress, 'stateMachineAddress'),
      chainId: parsePositiveInteger(input.chainId, 'chainId'),
    },
    {
      ...input.trigger,
      authorizations: input.authorizations,
      signature: input.signature,
      birthFactAttribution: input.birthFactAttribution,
    },
  );
  return { to: call.address, functionName: call.functionName, data: call.data };
}

/** BirthAuthorizer is the plan's birth submitter: the chain rejects any other signer. */
export function assertBirthAuthorizationSigner(input: {
  readonly signer: Address;
  readonly trigger: TriggerOrderFromOutsidePayload;
}): void {
  const submitter = normalizeAddressChecksummed(input.trigger.submitter, 'trigger.submitter');
  if (submitter !== input.signer) {
    throw new ValidationError(
      `signer ${input.signer} is not the birth authorizer declared by trigger.submitter ${submitter}:`
        + ' the state machine only accepts a birth authorization signed by the plan birthAuthorizer',
    );
  }
}
