import { describe, expect, it } from 'vitest';
import type { Address, TypedDataDefinition } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createBrowserClient } from '../../src/browser/client.js';
import { createHeadlessClient } from '../../src/headless/client.js';
import type { Eip1193Provider } from '../../src/browser/wallet/provider.js';
import type { OperationInput } from '../../src/core/operations.js';
import { STATE_MACHINE, bytes32, planRegistrationFixture, triggerFixture, authorizationsFixture, birthAttributionFixture } from '../core/fixtures.js';

interface ProviderRequest {
  readonly method: string;
  readonly params?: readonly unknown[];
}

function mockProvider(account: ReturnType<typeof privateKeyToAccount>): {
  readonly provider: Eip1193Provider;
  readonly requests: ProviderRequest[];
} {
  const requests: ProviderRequest[] = [];
  const provider: Eip1193Provider = {
    request: async (args) => {
      requests.push(args);
      switch (args.method) {
        case 'eth_signTypedData_v4':
          return account.signTypedData(JSON.parse(String(args.params?.[1])) as TypedDataDefinition);
        case 'eth_sendTransaction':
          return bytes32('aa');
        default:
          throw new Error(`unexpected provider method ${args.method}`);
      }
    },
  };
  return { provider, requests };
}

function planInput(signer: Address): OperationInput {
  return {
    operation: 'plan.register',
    chainId: 31337,
    stateMachineAddress: STATE_MACHINE,
    signer,
    registration: planRegistrationFixture(),
    deadline: 1_700_000_000n,
  };
}

function signalInput(signer: Address): OperationInput {
  return {
    operation: 'signal.submit',
    chainId: 31337,
    stateMachineAddress: STATE_MACHINE,
    signer,
    deadline: 1_700_000_000n,
    signal: {
      planId: bytes32('01'),
      orderId: bytes32('02'),
      source: 'slot-a',
      stageIdentifier: 'exec.main',
      signalName: 'cmp',
      payloadHash: bytes32('03'),
      idempotencyKey: 'key-1',
    },
  };
}

function birthIntentInput(signer: Address): OperationInput {
  return {
    operation: 'order.birth',
    role: 'buyer-intent',
    chainId: 31337,
    stateMachineAddress: STATE_MACHINE,
    signer,
    planId: bytes32('01'),
    orderId: bytes32('02'),
    termsHash: bytes32('03'),
    nonce: 1,
    deadline: 1_700_000_000n,
  };
}

function birthAuthorizationInput(signer: Address): OperationInput {
  const trigger = triggerFixture(signer);
  return {
    operation: 'order.birth',
    role: 'birth-authorizer',
    chainId: 31337,
    stateMachineAddress: STATE_MACHINE,
    signer,
    trigger,
    authorizations: authorizationsFixture(signer),
    birthFactAttribution: birthAttributionFixture(trigger),
  };
}

describe('browser and headless operation clients', () => {
  it('sign the same operation identically', async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const browser = createBrowserClient({
      provider: mockProvider(account).provider,
      signer: account.address,
      mode: 'direct',
    });
    const headless = createHeadlessClient({
      privateKey,
      mode: 'direct',
      rpcUrl: 'http://127.0.0.1:8545',
    });

    for (const input of [planInput(account.address), signalInput(account.address), birthIntentInput(account.address)]) {
      const browserSigned = await browser.sign(input);
      const headlessSigned = await headless.sign(input);
      expect(browserSigned.typedData).toEqual(headlessSigned.typedData);
      expect(browserSigned.signature).toBe(headlessSigned.signature);
      expect(browserSigned.calls).toEqual(headlessSigned.calls);
    }
  });

  it('sign the same relay-mode buyer intent identically', async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const neverCalled = async (): Promise<Response> => {
      throw new Error('relay must not be called while signing');
    };
    const browser = createBrowserClient({
      provider: mockProvider(account).provider,
      signer: account.address,
      mode: 'relay',
      relayUrl: 'https://relay.example',
      fetcher: neverCalled,
    });
    const headless = createHeadlessClient({
      privateKey,
      mode: 'relay',
      relayUrl: 'https://relay.example',
      fetcher: neverCalled,
    });

    const input = birthIntentInput(account.address);
    const browserSigned = await browser.sign(input);
    const headlessSigned = await headless.sign(input);
    expect(browserSigned.typedData).toEqual(headlessSigned.typedData);
    expect(browserSigned.signature).toBe(headlessSigned.signature);
    expect(browserSigned.calls).toEqual([]);
  });

  it('delivers a direct browser operation through the injected provider', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { provider, requests } = mockProvider(account);
    const browser = createBrowserClient({ provider, signer: account.address, mode: 'direct' });

    const result = await browser.execute(planInput(account.address));

    expect(result.mode).toBe('direct');
    expect(result.txHashes).toEqual([bytes32('aa'), bytes32('aa')]);
    expect(requests.map((request) => request.method)).toEqual([
      'eth_signTypedData_v4',
      'eth_sendTransaction',
      'eth_sendTransaction',
    ]);
    const send = requests[1]?.params as readonly [{ readonly from: string }];
    expect(send[0].from).toBe(account.address);
  });

  it('refuses to relay a birth authorization from the browser', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { provider } = mockProvider(account);
    let relayCalls = 0;
    const browser = createBrowserClient({
      provider,
      signer: account.address,
      mode: 'relay',
      relayUrl: 'https://relay.example',
      fetcher: async () => {
        relayCalls += 1;
        return Response.json({ status: 'accepted' });
      },
    });

    await expect(browser.execute(birthAuthorizationInput(account.address))).rejects.toMatchObject({
      operation: 'order.birth',
      code: 'unsupported_delivery',
    });
    expect(relayCalls).toBe(0);
  });

  it('refuses to deliver a buyer birth intent directly from the browser', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { provider, requests } = mockProvider(account);
    const browser = createBrowserClient({ provider, signer: account.address, mode: 'direct' });

    await expect(browser.execute(birthIntentInput(account.address))).rejects.toMatchObject({
      operation: 'order.birth',
      code: 'unsupported_delivery',
    });
    expect(requests).toEqual([]);
  });
});
