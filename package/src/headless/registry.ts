/**
 * Headless registry write surface: sign a registry EIP-712 record and hand the
 * signed payload to an injected submitter. The registry typed-data builder is
 * injected (e.g. from @uvp-eth/zhixu-registry's eip712 module) so the client
 * never imports registry storage or pg, and the record shape stays single-sourced
 * in the registry package.
 */
import type { Address, Hex, TypedDataDefinition } from 'viem';
import type { TypedDataSigner } from './signers.js';

export interface RegistrySignedWrite<TFields> {
  readonly fields: TFields;
  readonly typedData: TypedDataDefinition;
  readonly signature: Hex;
  readonly signer: Address;
}

export interface PublishRegistryRecordInput<TFields, TResult> {
  readonly fields: TFields;
  readonly buildTypedData: (fields: TFields) => TypedDataDefinition;
  readonly signer: TypedDataSigner;
  readonly submit: (signed: RegistrySignedWrite<TFields>) => Promise<TResult>;
}

export interface PublishedRegistryRecord<TFields, TResult> extends RegistrySignedWrite<TFields> {
  readonly submission: TResult;
}

export async function publishRegistryRecord<TFields, TResult>(
  input: PublishRegistryRecordInput<TFields, TResult>,
): Promise<PublishedRegistryRecord<TFields, TResult>> {
  const typedData = input.buildTypedData(input.fields);
  const signature = await input.signer.signTypedData(typedData);
  const signed: RegistrySignedWrite<TFields> = {
    fields: input.fields,
    typedData,
    signature,
    signer: input.signer.address,
  };
  const submission = await input.submit(signed);
  return { ...signed, submission };
}

export function publishZhixuRecord<TFields, TResult>(
  input: PublishRegistryRecordInput<TFields, TResult>,
): Promise<PublishedRegistryRecord<TFields, TResult>> {
  return publishRegistryRecord(input);
}

export function publishIdentityClaim<TFields, TResult>(
  input: PublishRegistryRecordInput<TFields, TResult>,
): Promise<PublishedRegistryRecord<TFields, TResult>> {
  return publishRegistryRecord(input);
}
