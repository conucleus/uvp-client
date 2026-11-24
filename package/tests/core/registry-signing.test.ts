// registry.write 签名闸：只有规范 ZhixuRecord（primaryType/域/字段表/
// message.chainId/registeredBy）能进入签名；任何换类型的信封在调用 signer
// 之前就以具名 reason 拒绝，不会盲签成其它链上动作。

import { describe, expect, it } from 'vitest';
import { buildPlanCommitTypedData, buildZhixuRecordTypedData } from '@uvp-eth/protocol-bindings';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { prepareOperation, signOperation } from '../../src/core/operations.js';
import { RegistryTypedDataError } from '../../src/core/registry-signing.js';
import { STATE_MACHINE, bytes32 } from './fixtures.js';

const account = privateKeyToAccount(generatePrivateKey());
const SIGNAL_DEADLINE = 1n << 40n;

function registryRecord(overrides: Partial<Parameters<typeof buildZhixuRecordTypedData>[0]> = {}) {
  return buildZhixuRecordTypedData({
    chainId: 31337,
    planId: bytes32('01'),
    planHash: bytes32('02'),
    registeredBy: account.address,
    ...overrides,
  });
}

function rejectionOf(typedData: unknown, signer = account.address): RegistryTypedDataError {
  try {
    prepareOperation({ operation: 'registry.write', signer, typedData: typedData as never });
  } catch (error) {
    if (error instanceof RegistryTypedDataError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected registry typed data to be rejected');
}

describe('registry.write signing gate', () => {
  it('signs a canonical ZhixuRecord with the registry domain only', async () => {
    const typedData = registryRecord();
    const signed = await signOperation(
      prepareOperation({ operation: 'registry.write', signer: account.address, typedData }),
      account,
    );

    expect(signed.chainId).toBe(31337);
    expect(signed.typedData?.primaryType).toBe('ZhixuRecord');
    expect(signed.typedData?.domain).toEqual({ name: 'UVPZhixuRegistry', version: '1', chainId: 31337 });
    expect(signed.typedData?.message.registeredBy).toBe(account.address.toLowerCase());
    expect(signed.calls).toEqual([]);
  });

  it('rejects a foreign primary type instead of signing the executor key for another action', async () => {
    const signal = buildPlanCommitTypedData({
      chainId: 31337,
      verifyingContract: STATE_MACHINE,
      publisher: account.address,
      hooksHash: bytes32('03'),
      capabilitiesRoot: bytes32('04'),
      supplierBindingsRoot: bytes32('05'),
      fileWritersHash: bytes32('06'),
      deadline: SIGNAL_DEADLINE,
    });

    const error = rejectionOf(signal);
    expect(error.name).toBe('RegistryTypedDataError');
    expect(error.reason).toBe('primary-type');
  });

  it('rejects a ZhixuRecord whose field table departs from the protocol single source', () => {
    const typedData = registryRecord();
    const tampered = {
      ...typedData,
      types: { ZhixuRecord: typedData.types.ZhixuRecord.slice(0, -1) },
      message: { ...typedData.message, extra: bytes32('09') },
    };

    expect(rejectionOf(tampered).reason).toBe('primary-type-fields');
  });

  it('rejects a record whose registeredBy is not the configured signer', () => {
    const other = privateKeyToAccount(generatePrivateKey()).address;
    const typedData = registryRecord({ registeredBy: other });

    expect(rejectionOf(typedData).reason).toBe('signer-not-expected');
  });

  it('rejects a message chain id that differs from the domain chain id', () => {
    const typedData = registryRecord();
    const tampered = { ...typedData, message: { ...typedData.message, chainId: 84532n } };

    expect(rejectionOf(tampered).reason).toBe('message-chain-id');
  });

  it('rejects a non-http registry typed data payload with a named shape reason', () => {
    expect(rejectionOf('not-an-envelope').reason).toBe('not-typed-data');
  });
});
