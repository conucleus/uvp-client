import { describe, expect, it } from 'vitest';
import { generatePrivateKey, type Hex } from 'viem/accounts';
import { main } from '../../src/cli/index.js';
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


describe('CLI operation commands', () => {
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
