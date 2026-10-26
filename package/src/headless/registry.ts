/**
 * Headless registry publish surface: registry EIP-712 records are single-sourced
 * in @uvp-eth/zhixu-registry/eip712 (default builder, no local typed data), and
 * signing goes through the core registry.write operation. Storage/HTTP is an
 * injected submitter; this module owns no registry persistence.
 */
import {
  identityClaimTypedData,
  zhixuRecordTypedData,
} from '@uvp-eth/zhixu-registry/eip712';
import type { TypedDataDefinition } from 'viem';
import { prepareOperation, signOperation, type SignedOperation } from '../core/operations.js';
import type { TypedDataSigner } from './signers.js';

type ZhixuRecordFields = Parameters<typeof zhixuRecordTypedData>[0];
type IdentityClaimDraft = Parameters<typeof identityClaimTypedData>[0];

export type RegistryRecordSubmitter<TResult> = (signed: SignedOperation) => Promise<TResult>;

export interface RegistryRecordPublishInput<TFields, TResult> {
  readonly fields: TFields;
  readonly signer: TypedDataSigner;
  readonly submit: RegistryRecordSubmitter<TResult>;
}

export interface PublishedRegistryRecord<TResult> {
  readonly signed: SignedOperation;
  readonly submission: TResult;
}

export function publishZhixuRecord<TResult>(
  input: RegistryRecordPublishInput<ZhixuRecordFields, TResult>,
): Promise<PublishedRegistryRecord<TResult>> {
  return publish(input, zhixuRecordTypedData);
}

export function publishIdentityClaim<TResult>(
  input: RegistryRecordPublishInput<IdentityClaimDraft, TResult>,
): Promise<PublishedRegistryRecord<TResult>> {
  return publish(input, identityClaimTypedData);
}

async function publish<TFields, TResult>(
  input: RegistryRecordPublishInput<TFields, TResult>,
  buildTypedData: (fields: TFields) => TypedDataDefinition,
): Promise<PublishedRegistryRecord<TResult>> {
  const typedData = buildTypedData(input.fields);
  const prepared = prepareOperation({
    operation: 'registry.write',
    signer: input.signer.address,
    typedData,
  });
  const signed = await signOperation(prepared, input.signer);
  const submission = await input.submit(signed);
  return { signed, submission };
}
