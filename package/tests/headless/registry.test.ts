import { describe, expect, it } from 'vitest';
import { getAddress, recoverTypedDataAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { publishIdentityClaim, publishZhixuRecord } from '../../src/headless/registry.js';
import type { SignedOperation } from '../../src/core/operations.js';

function bytes32(suffix: string): Hex {
  return `0x${suffix.padStart(64, '0')}` as Hex;
}

async function recoverSigner(signed: SignedOperation): Promise<string> {
  const recovered = await recoverTypedDataAddress({
    domain: signed.typedData.domain,
    types: signed.typedData.types,
    primaryType: signed.typedData.primaryType,
    message: signed.typedData.message,
    signature: signed.signature,
  } as never);
  return getAddress(recovered);
}

describe('headless registry publish default builders', () => {
  it('signs a zhixu record with the protocol-bindings typed data and hands the signed operation to the submitter', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const submitted: SignedOperation[] = [];

    const result = await publishZhixuRecord({
      fields: {
        chainId: 31337,
        planId: bytes32('01'),
        planHash: bytes32('02'),
        descriptorUri: 'ipfs://zhixu-descriptor',
        schemaHash: 'sha256:abc',
        version: '1',
        registeredBy: account.address,
      },
      signer: account,
      submit: async (signed) => {
        submitted.push(signed);
        return { stored: true };
      },
    });

    expect(result.submission).toEqual({ stored: true });
    expect(submitted).toHaveLength(1);
    const signed = submitted[0]!;
    expect(signed).toBe(result.signed);
    expect(signed.operation).toBe('registry.write');
    expect(signed.chainId).toBe(31337);
    expect(signed.calls).toEqual([]);
    expect(signed.typedData.domain).toMatchObject({
      name: 'UVPZhixuRegistry',
      version: '1',
      chainId: 31337,
    });
    expect(signed.typedData.primaryType).toBe('ZhixuRecord');
    expect(signed.typedData.message).toMatchObject({
      planId: bytes32('01'),
      planHash: bytes32('02'),
      registeredBy: account.address.toLowerCase(),
    });
    expect(await recoverSigner(signed)).toBe(account.address);
  });

  it('signs an identity claim with the protocol-bindings typed data', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const submitted: SignedOperation[] = [];

    await publishIdentityClaim({
      fields: {
        chainId: 31337,
        wallet: account.address,
        subject: 'curator-of-record',
        attestationRefs: ['https://attestations.example/1'],
      },
      signer: account,
      submit: async (signed) => {
        submitted.push(signed);
        return signed.signature;
      },
    });

    const signed = submitted[0]!;
    expect(signed.typedData.primaryType).toBe('IdentityClaim');
    expect(signed.typedData.domain).toMatchObject({ name: 'UVPZhixuRegistry', version: '1' });
    expect(signed.typedData.message).toMatchObject({
      subject: 'curator-of-record',
      attestationRefs: ['https://attestations.example/1'],
    });
    expect(await recoverSigner(signed)).toBe(account.address);
  });
});
