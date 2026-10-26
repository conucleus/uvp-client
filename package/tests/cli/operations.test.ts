import { describe, expect, it } from 'vitest';
import { generatePrivateKey, type Hex } from 'viem/accounts';
import { main } from '../../src/cli/index.js';
import { prepareOperation, signOperation, type OperationInput } from '../../src/core/operations.js';
import { signerFromPrivateKey } from '../../src/headless/signers.js';

const STATE_MACHINE = '0x0000000000000000000000000000000000000001';
const PLAN_ID = `0x${'01'.repeat(32)}`;
const ORDER_ID = `0x${'02'.repeat(32)}`;
const TERMS_HASH = `0x${'03'.repeat(32)}`;

async function runWithGeneratedKey(argv: readonly string[]): Promise<{ output: string; privateKey: Hex }> {
  const logs: string[] = [];
  const originalLog = console.log;
  const envName = 'UVP_EXECUTOR_PRIVATE_KEY';
  const previous = process.env[envName];
  const privateKey = generatePrivateKey();
  process.env[envName] = privateKey;
  console.log = (message?: unknown) => {
    logs.push(String(message));
  };
  try {
    await main(['node', 'uvp-client', ...argv]);
  } finally {
    console.log = originalLog;
    if (previous === undefined) {
      delete process.env[envName];
    } else {
      process.env[envName] = previous;
    }
  }
  return { output: logs[0] ?? '', privateKey };
}

function signalInput(signer: `0x${string}`): OperationInput {
  return {
    operation: 'signal.submit',
    chainId: 31337,
    stateMachineAddress: STATE_MACHINE,
    signer,
    deadline: 1_700_000_000n,
    signal: {
      planId: PLAN_ID,
      orderId: ORDER_ID,
      source: 'slot-a',
      stageIdentifier: 'exec.main',
      signalName: 'cmp',
    },
  };
}

describe('CLI operation commands', () => {
  it('signal submit --dry-run signs the same envelope as the headless client', async () => {
    const { output, privateKey } = await runWithGeneratedKey([
      'signal', 'submit',
      '--rpc-url', 'http://127.0.0.1:8545',
      '--state-machine', STATE_MACHINE,
      '--chain-id', '31337',
      '--plan-id', PLAN_ID,
      '--order-id', ORDER_ID,
      '--source', 'slot-a',
      '--stage', 'exec.main',
      '--signal-name', 'cmp',
      '--deadline', '1700000000',
      '--mode', 'relay',
      '--relay-url', 'https://relay.example',
      '--dry-run',
    ]);
    const cli = JSON.parse(output) as {
      signal?: {
        operation?: string;
        mode?: string;
        signer?: string;
        typedData?: { primaryType?: string };
        calls?: readonly { functionName?: string }[];
        signature?: string;
      };
    };
    const signer = signerFromPrivateKey(privateKey);
    const expected = await signOperation(prepareOperation(signalInput(signer.address)), signer);

    expect(cli.signal?.operation).toBe('signal.submit');
    expect(cli.signal?.mode).toBe('relay');
    expect(cli.signal?.typedData?.primaryType).toBe('UVPStateMachineSignal');
    expect(cli.signal?.calls?.[0]?.functionName).toBe('submitSignalFor');
    expect(cli.signal?.signer).toBe(signer.address);
    expect(cli.signal?.signature).toBe(expected.signature);
    expect(cli.signal?.typedData).toEqual(expected.typedData);
    expect(cli.signal?.calls).toEqual(expected.calls);
  });

  it('order birth-intent --dry-run signs the buyer intent under the UVPOrderBirth domain', async () => {
    const { output, privateKey } = await runWithGeneratedKey([
      'order', 'birth-intent',
      '--chain-id', '31337',
      '--state-machine', STATE_MACHINE,
      '--plan-id', PLAN_ID,
      '--order-id', ORDER_ID,
      '--terms-hash', TERMS_HASH,
      '--nonce', '1',
      '--deadline', '1700000000',
      '--mode', 'relay',
      '--relay-url', 'https://relay.example',
      '--dry-run',
    ]);
    const cli = JSON.parse(output) as {
      order?: {
        operation?: string;
        signer?: string;
        typedData?: { primaryType?: string; domain?: { name?: string }; message?: { buyer?: string } };
        calls?: readonly unknown[];
        signature?: string;
      };
    };
    const buyer = signerFromPrivateKey(privateKey);

    expect(cli.order?.operation).toBe('order.birth');
    expect(cli.order?.typedData?.primaryType).toBe('UVPOrderBirthIntent');
    expect(cli.order?.typedData?.domain?.name).toBe('UVPOrderBirth');
    expect(cli.order?.typedData?.message?.buyer?.toLowerCase()).toBe(buyer.address.toLowerCase());
    expect(cli.order?.calls).toEqual([]);
    expect(cli.order?.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });
});
