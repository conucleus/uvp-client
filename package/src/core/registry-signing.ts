/**
 * Registry signing precondition: `registry.write` may only sign the canonical
 * ZhixuRecord envelope (primary type, UVPZhixuRegistry domain, field table,
 * record chain id, registeredBy). Field tables and the signing gate are owned
 * by @uvp-eth/protocol-bindings; this module only binds them to the registry
 * record and maps a rejected envelope to a named reason. The registry domain
 * is chain-wide and carries no verifyingContract, so the gate's shape check on
 * that optional field is satisfied by a sentinel only when the field is absent.
 */
import type { TypedDataDefinition } from 'viem';
import {
  ZHIXU_RECORD_PRIMARY_TYPE,
  ZHIXU_RECORD_TYPED_DATA_FIELDS,
  ZHIXU_REGISTRY_DOMAIN_NAME,
  ZHIXU_REGISTRY_DOMAIN_VERSION,
  validateTypedDataForSigning,
  type TypedDataSigningMismatchReason,
} from './typed-data.js';
import { ExecutorKitError } from './validation.js';

const ADDRESS_WIDTH = 20;
const ZERO_ADDRESS = `0x${'0'.repeat(ADDRESS_WIDTH * 2)}`;
const UINT_STRING = /^(0|[1-9][0-9]*)$/;

export type RegistryTypedDataRejectionReason =
  | TypedDataSigningMismatchReason
  | 'message-chain-id'
  | 'message-field';

export class RegistryTypedDataError extends ExecutorKitError {
  override readonly name = 'RegistryTypedDataError';
  readonly reason: RegistryTypedDataRejectionReason;

  constructor(reason: RegistryTypedDataRejectionReason, detail?: string) {
    super(
      `registry.write typed data rejected (${reason})`
      + `${detail === undefined ? '' : `: ${detail}`}`
      + `; only canonical ${ZHIXU_REGISTRY_DOMAIN_NAME}/v${ZHIXU_REGISTRY_DOMAIN_VERSION} `
      + `${ZHIXU_RECORD_PRIMARY_TYPE} records may be signed`,
    );
    this.reason = reason;
  }
}

/**
 * Rejects any typed data that is not a canonical ZhixuRecord for `signer`:
 * primary type, domain name/version/chain id, canonical field table, message
 * chain id, message field shapes, and registeredBy (the gate's signer field).
 */
export function assertRegistryTypedDataForSigning(
  typedData: unknown,
  signer: string,
): asserts typedData is TypedDataDefinition {
  const envelope = asRecord(typedData);
  if (envelope === undefined) {
    throw new RegistryTypedDataError('not-typed-data');
  }
  const domain = asRecord(envelope.domain);
  if (domain === undefined) {
    throw new RegistryTypedDataError('domain-shape');
  }
  const gateCheck = validateTypedDataForSigning(
    withRegistryDomainShape(envelope, domain),
    {
      primaryType: ZHIXU_RECORD_PRIMARY_TYPE,
      domainName: ZHIXU_REGISTRY_DOMAIN_NAME,
      domainVersion: ZHIXU_REGISTRY_DOMAIN_VERSION,
      submitterField: 'registeredBy',
      submitter: signer,
    },
  );
  if (!gateCheck.ok) {
    throw new RegistryTypedDataError(gateCheck.reason, gateCheck.detail);
  }

  const types = asRecord(envelope.types);
  const fields = types?.[ZHIXU_RECORD_PRIMARY_TYPE];
  if (!Array.isArray(fields) || !matchesCanonicalFields(fields)) {
    throw new RegistryTypedDataError(
      'primary-type-fields',
      `${ZHIXU_RECORD_PRIMARY_TYPE} must declare exactly the canonical registry fields`,
    );
  }

  const message = asRecord(envelope.message);
  if (message === undefined) {
    throw new RegistryTypedDataError('message-shape');
  }
  const domainChainId = decimalOf(domain.chainId);
  const messageChainId = decimalOf(message.chainId);
  if (domainChainId === undefined || messageChainId === undefined || domainChainId !== messageChainId) {
    throw new RegistryTypedDataError(
      'message-chain-id',
      `message.chainId ${String(message.chainId)} must equal domain.chainId ${String(domain.chainId)}`,
    );
  }
  for (const field of ZHIXU_RECORD_TYPED_DATA_FIELDS) {
    if (!hasCanonicalValue(message[field.name], field.type)) {
      throw new RegistryTypedDataError(
        'message-field',
        `message.${field.name} is not a canonical ${field.type}`,
      );
    }
  }
}

function withRegistryDomainShape(
  envelope: Record<string, unknown>,
  domain: Record<string, unknown>,
): unknown {
  if (domain.verifyingContract !== undefined) {
    return envelope;
  }
  return { ...envelope, domain: { ...domain, verifyingContract: ZERO_ADDRESS } };
}

function matchesCanonicalFields(fields: readonly unknown[]): boolean {
  if (fields.length !== ZHIXU_RECORD_TYPED_DATA_FIELDS.length) {
    return false;
  }
  return fields.every((field, index) => {
    const entry = asRecord(field);
    const canonical = ZHIXU_RECORD_TYPED_DATA_FIELDS[index];
    return canonical !== undefined
      && entry !== undefined
      && entry['name'] === canonical.name
      && entry['type'] === canonical.type;
  });
}

function hasCanonicalValue(value: unknown, type: string): boolean {
  switch (type) {
    case 'uint256':
      return decimalOf(value) !== undefined;
    case 'bytes32':
      return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
    case 'address':
      return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
    case 'string':
      return typeof value === 'string';
    default:
      return false;
  }
}

function decimalOf(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') {
    return value >= 0n ? value : undefined;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
  }
  if (typeof value === 'string' && UINT_STRING.test(value)) {
    return BigInt(value);
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
