/**
 * Browser write surface: EIP-1193 wallet-signed plan registration, order birth,
 * and registry record submission. The browser entry has no compiler and never
 * touches private keys; it signs typed data with the injected provider and
 * sends the resulting transactions.
 */
import {
  buildTriggerOrderFromOutsideForCall,
  buildTriggerOrderFromOutsideTypedData,
  type SignalAttributionPayload,
  type SignalAuthorizationPayload,
  type TriggerOrderFromOutsidePayload,
} from '@uvp-eth/protocol-bindings';
import { isHex, type Address, type Hex, type TypedDataDefinition } from 'viem';
import {
  buildPlanCommitCall,
  buildPlanCommitTypedDataFor,
  buildPlanFinalizeCall,
  type PlanRegistrationArgs,
} from '../core/registration.js';
import { normalizeAddressChecksummed, ValidationError } from '../core/validation.js';
import type { Eip1193Provider } from './wallet/provider.js';

export interface BrowserPlanRegistrationInput {
  readonly provider: Eip1193Provider;
  readonly signer: Address | string;
  readonly chainId: number;
  readonly stateMachineAddress: Address | string;
  readonly registration: PlanRegistrationArgs;
  readonly birthAuthorizer?: Address | string;
  /** Explicit commit deadline in unix seconds; otherwise block timestamp + deadlineSeconds. */
  readonly deadline?: bigint | number | string;
  readonly deadlineSeconds?: number;
  readonly finalize?: boolean;
}

export interface BrowserPlanRegistrationResult {
  readonly typedData: TypedDataDefinition;
  readonly signature: Hex;
  readonly commitTxHash: Hex;
  readonly finalizeTxHash?: Hex;
}

export interface BrowserOrderBirthInput {
  readonly provider: Eip1193Provider;
  readonly signer: Address | string;
  readonly chainId: number;
  readonly stateMachineAddress: Address | string;
  readonly trigger: TriggerOrderFromOutsidePayload;
  readonly authorizations: readonly SignalAuthorizationPayload[];
  readonly birthFactAttribution: SignalAttributionPayload;
}

export interface BrowserOrderBirthResult {
  readonly signature: Hex;
  readonly txHash: Hex;
  readonly calldata: Hex;
}

export interface BrowserRegistryWriteInput<TResult> {
  readonly provider: Eip1193Provider;
  readonly signer: Address | string;
  readonly typedData: TypedDataDefinition;
  readonly submit: (signed: {
    readonly signer: Address;
    readonly typedData: TypedDataDefinition;
    readonly signature: Hex;
  }) => Promise<TResult>;
}

export interface BrowserRegistryWriteResult<TResult> {
  readonly signature: Hex;
  readonly submission: TResult;
}

export async function signTypedDataWithProvider(
  provider: Eip1193Provider,
  typedData: TypedDataDefinition,
  signer: Address | string,
): Promise<Hex> {
  const normalizedSigner = normalizeAddressChecksummed(signer, 'signer');
  const signature = await provider.request({
    method: 'eth_signTypedData_v4',
    params: [normalizedSigner, JSON.stringify(typedData)],
  });
  if (typeof signature !== 'string' || !isHex(signature)) {
    throw new ValidationError('wallet returned an invalid hex signature');
  }
  return signature;
}

export async function sendProviderTransaction(
  provider: Eip1193Provider,
  input: {
    readonly from: Address | string;
    readonly to: Address | string;
    readonly data: Hex;
  },
): Promise<Hex> {
  const from = normalizeAddressChecksummed(input.from, 'from');
  const to = normalizeAddressChecksummed(input.to, 'to');
  if (!isHex(input.data)) {
    throw new ValidationError('transaction data must be hex calldata');
  }
  const txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from, to, data: input.data }],
  });
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new ValidationError('wallet returned an invalid transaction hash');
  }
  return txHash as Hex;
}

export async function submitPlanRegistration(
  input: BrowserPlanRegistrationInput,
): Promise<BrowserPlanRegistrationResult> {
  const signer = normalizeAddressChecksummed(input.signer, 'signer');
  const stateMachineAddress = normalizeAddressChecksummed(input.stateMachineAddress, 'stateMachineAddress');
  const deadline = input.deadline ?? (
    await providerBlockTimestamp(input.provider)
    + BigInt(input.deadlineSeconds ?? 3_600)
  );
  const typedData = buildPlanCommitTypedDataFor(
    { stateMachineAddress, chainId: input.chainId },
    {
      publisher: signer,
      deadline,
      registration: input.registration,
      ...(input.birthAuthorizer !== undefined ? { birthAuthorizer: input.birthAuthorizer } : {}),
    },
  );
  const signature = await signTypedDataWithProvider(input.provider, typedData, signer);
  const commitCall = buildPlanCommitCall(
    { stateMachineAddress, chainId: input.chainId },
    {
      publisher: signer,
      deadline,
      registration: input.registration,
      signature,
      ...(input.birthAuthorizer !== undefined ? { birthAuthorizer: input.birthAuthorizer } : {}),
    },
  );
  const commitTxHash = await sendProviderTransaction(input.provider, {
    from: signer,
    to: commitCall.address,
    data: commitCall.data,
  });
  if (input.finalize === false) {
    return { typedData, signature, commitTxHash };
  }
  const finalizeCall = buildPlanFinalizeCall({ stateMachineAddress, chainId: input.chainId }, input.registration.planId);
  const finalizeTxHash = await sendProviderTransaction(input.provider, {
    from: signer,
    to: finalizeCall.address,
    data: finalizeCall.data,
  });
  return { typedData, signature, commitTxHash, finalizeTxHash };
}

export async function submitOrderBirth(
  input: BrowserOrderBirthInput,
): Promise<BrowserOrderBirthResult> {
  const signer = normalizeAddressChecksummed(input.signer, 'signer');
  const stateMachineAddress = normalizeAddressChecksummed(input.stateMachineAddress, 'stateMachineAddress');
  const typedData = buildTriggerOrderFromOutsideTypedData({
    ...input.trigger,
    chainId: input.chainId,
    verifyingContract: stateMachineAddress,
    authorizations: input.authorizations,
  });
  const signature = await signTypedDataWithProvider(input.provider, typedData, signer);
  const call = buildTriggerOrderFromOutsideForCall(
    { stateMachineAddress, chainId: input.chainId },
    {
      ...input.trigger,
      authorizations: input.authorizations,
      signature,
      birthFactAttribution: input.birthFactAttribution,
    },
  );
  const txHash = await sendProviderTransaction(input.provider, {
    from: signer,
    to: call.address,
    data: call.data,
  });
  return { signature, txHash, calldata: call.data };
}

export async function submitSignedRegistryRecord<TResult>(
  input: BrowserRegistryWriteInput<TResult>,
): Promise<BrowserRegistryWriteResult<TResult>> {
  const signer = normalizeAddressChecksummed(input.signer, 'signer');
  const signature = await signTypedDataWithProvider(input.provider, input.typedData, signer);
  const submission = await input.submit({ signer, typedData: input.typedData, signature });
  return { signature, submission };
}

async function providerBlockTimestamp(provider: Eip1193Provider): Promise<bigint> {
  const block = await provider.request({
    method: 'eth_getBlockByNumber',
    params: ['latest', false],
  });
  if (typeof block !== 'object' || block === null || !('timestamp' in block)) {
    throw new ValidationError('provider returned a block without timestamp');
  }
  const timestamp = (block as { readonly timestamp?: unknown }).timestamp;
  if (typeof timestamp !== 'string' || !/^0x[0-9a-fA-F]+$/.test(timestamp)) {
    throw new ValidationError('provider returned an invalid block timestamp');
  }
  return BigInt(timestamp);
}
