import { describe, expect, it } from 'vitest';
import type { Address, TypedDataDefinition } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createBrowserClient } from '../../src/browser/client.js';
import { createHeadlessClient } from '../../src/headless/client.js';
import type { Eip1193Provider } from '../../src/browser/wallet/provider.js';
import type { OperationInput } from '../../src/core/operations.js';
import {
  STATE_MACHINE,
  SIGNAL_DEADLINE,
  bytes32,
  planRegistrationFixture,
  triggerSignalFixture,
} from '../core/fixtures.js';

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
    deadline: SIGNAL_DEADLINE,
  };
}

function triggerInput(signer: Address): OperationInput {
  return {
    operation: 'order.trigger',
    chainId: 31337,
    stateMachineAddress: STATE_MACHINE,
    signer,
    signal: triggerSignalFixture(bytes32('17')),
    deadline: SIGNAL_DEADLINE,
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

    for (const input of [planInput(account.address), triggerInput(account.address)]) {
      const browserSigned = await browser.sign(input);
      const headlessSigned = await headless.sign(input);
      expect(browserSigned.typedData).toEqual(headlessSigned.typedData);
      expect(browserSigned.signature).toBe(headlessSigned.signature);
      expect(browserSigned.calls).toEqual(headlessSigned.calls);
    }
  });

  it('sign the same relay-mode trigger identically', async () => {
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
      relayPath: '/relay',
      fetcher: neverCalled,
    });
    const headless = createHeadlessClient({
      privateKey,
      mode: 'relay',
      relayUrl: 'https://relay.example',
      relayPath: '/relay',
      fetcher: neverCalled,
    });

    const input = triggerInput(account.address);
    const browserSigned = await browser.sign(input);
    const headlessSigned = await headless.sign(input);
    expect(browserSigned.typedData).toEqual(headlessSigned.typedData);
    expect(browserSigned.signature).toBe(headlessSigned.signature);
    expect(browserSigned.calls).toEqual(headlessSigned.calls);
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
});
