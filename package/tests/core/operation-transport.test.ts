import { describe, expect, it } from 'vitest';
import {
  decodeFunctionData,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { STATE_MACHINE_ABI } from '@uvp-eth/protocol-bindings';
import { prepareOperation, signOperation } from '../../src/core/operations.js';
import {
  createDirectTransport,
  createRelayTransport,
  stringifyOperation,
  type DirectCall,
  type OperationFetcher,
} from '../../src/core/transport.js';
import {
  STATE_MACHINE,
  SIGNAL_DEADLINE,
  bytes32,
  planRegistrationFixture,
  stateMachineSignalFixture,
} from './fixtures.js';

function planOperation(signer: Address) {
  return {
    operation: 'plan.register' as const,
    chainId: 31337,
    stateMachineAddress: STATE_MACHINE,
    signer,
    registration: planRegistrationFixture(),
    deadline: SIGNAL_DEADLINE,
  };
}

function txHash(suffix: string): Hex {
  return bytes32(suffix);
}

describe('direct transport', () => {
  it('broadcasts the signed calls in order and reports every tx hash', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signed = await signOperation(prepareOperation(planOperation(account.address)), account);
    const sent: DirectCall[] = [];
    const transport = createDirectTransport({
      submitter: {
        sendCall: async (call) => {
          sent.push(call);
          return txHash(`a${sent.length}`);
        },
      },
    });

    const result = await transport.submit(signed);

    expect(result).toEqual({
      operation: 'plan.register',
      mode: 'direct',
      chainId: 31337,
      signer: account.address,
      status: 'submitted',
      txHashes: [txHash('a1'), txHash('a2')],
    });
    expect(sent.map((call) => decodeFunctionData({ abi: STATE_MACHINE_ABI, data: call.data }).functionName))
      .toEqual(['commitPlan', 'finalizePlan']);
    expect(sent.map((call) => call.to)).toEqual([STATE_MACHINE, STATE_MACHINE]);
    expect(sent.map((call) => call.from)).toEqual([account.address, account.address]);
  });

  it('refuses to deliver an operation that has no chain call', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signed = await signOperation(prepareOperation({
      operation: 'registry.write',
      signer: account.address,
      typedData: {
        domain: { name: 'UVPZhixuRegistry', version: '1', chainId: 31337 },
        types: { ZhixuRecord: [{ name: 'planId', type: 'bytes32' }] },
        primaryType: 'ZhixuRecord',
        message: { planId: bytes32('01') },
      },
    }), account);
    const transport = createDirectTransport({
      submitter: { sendCall: async () => txHash('a1') },
    });

    await expect(transport.submit(signed)).rejects.toMatchObject({
      operation: 'registry.write',
      code: 'unsupported_delivery',
      retryable: false,
    });
  });

  it('reports the calls already broadcast when a later call fails', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signed = await signOperation(prepareOperation(planOperation(account.address)), account);
    let sent = 0;
    const transport = createDirectTransport({
      submitter: {
        sendCall: async () => {
          sent += 1;
          if (sent === 2) {
            throw new Error('replacement transaction underpriced');
          }
          return txHash('b1');
        },
      },
    });

    const error = await captureRejection(transport.submit(signed));
    expect(error).toMatchObject({
      operation: 'plan.register',
      code: 'broadcast_failed',
      retryable: false,
    });
    expect(String((error as Error).message)).toContain(`already broadcast: ${txHash('b1')}`);
  });

  it('sends a participant-signed submitSignal envelope from the relayer, not the signer', async () => {
    const supplierAccount = privateKeyToAccount(generatePrivateKey());
    const relayer = privateKeyToAccount(generatePrivateKey());
    const signed = await signOperation(prepareOperation({
      operation: 'signal.submit',
      chainId: 31337,
      stateMachineAddress: STATE_MACHINE,
      signer: supplierAccount.address,
      signal: stateMachineSignalFixture(),
      deadline: SIGNAL_DEADLINE,
    }), supplierAccount);
    const sent: DirectCall[] = [];
    const transport = createDirectTransport({
      relayer: relayer.address,
      submitter: {
        sendCall: async (call) => {
          sent.push(call);
          return txHash('d1');
        },
      },
    });

    const result = await transport.submit(signed);

    expect(result.signer).toBe(supplierAccount.address);
    expect(sent.map((call) => call.from)).toEqual([relayer.address]);
    const decoded = decodeFunctionData({ abi: STATE_MACHINE_ABI, data: sent[0]!.data });
    expect(decoded.functionName).toBe('submitSignal');
    const submission = decoded.args[0] as unknown as { readonly submitter: string };
    expect(submission.submitter).toBe(supplierAccount.address);
    expect(decoded.args[1]).toBe(signed.signature);
  });
});

describe('relay transport', () => {
  it('posts the signed envelope to /relay and maps the receipt', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signed = await signOperation(prepareOperation(planOperation(account.address)), account);
    const requests: Array<{ readonly url: string; readonly body: string }> = [];
    const fetcher: OperationFetcher = async (input, init) => {
      requests.push({ url: String(input), body: String(init?.body) });
      return Response.json({
        status: 'submitted',
        operation: 'plan.register',
        txHashes: [txHash('c1'), txHash('c2')],
      });
    };
    const transport = createRelayTransport({ relayUrl: 'https://relay.example/api/', fetcher });

    const result = await transport.submit(signed);

    expect(requests[0]?.url).toBe('https://relay.example/api/relay');
    const body = JSON.parse(requests[0]?.body as string) as {
      readonly operation: string;
      readonly signer: string;
      readonly signature: string;
      readonly calls: ReadonlyArray<{ readonly functionName: string }>;
    };
    expect(body.operation).toBe('plan.register');
    expect(body.signer).toBe(account.address);
    expect(body.signature).toBe(signed.signature);
    expect(body.calls.map((call) => call.functionName)).toEqual(['commitPlan', 'finalizePlan']);
    expect(result).toEqual({
      operation: 'plan.register',
      mode: 'relay',
      chainId: 31337,
      signer: account.address,
      status: 'submitted',
      txHashes: [txHash('c1'), txHash('c2')],
    });
  });

  it('serializes bigint typed-data fields as base-10 strings', () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const body = stringifyOperation({
      operation: 'registry.write',
      chainId: 31337,
      signer: account.address,
      typedData: {
        domain: { name: 'UVPZhixuRegistry', version: '1', chainId: 31337 },
        types: { ZhixuRecord: [{ name: 'chainId', type: 'uint256' }] },
        primaryType: 'ZhixuRecord',
        message: { chainId: 31337n },
      },
      signature: `0x${'11'.repeat(65)}`,
      calls: [],
    });

    expect(JSON.parse(body).typedData.message.chainId).toBe('31337');
  });

  it('keeps the operation code and retryability of relay rejections', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signed = await signOperation(prepareOperation(planOperation(account.address)), account);
    const transport = createRelayTransport({
      relayUrl: 'https://relay.example',
      fetcher: async () => Response.json(
        { error: 'overloaded', message: 'retry later', retryable: true },
        { status: 503 },
      ),
    });

    await expect(transport.submit(signed)).rejects.toMatchObject({
      operation: 'plan.register',
      code: 'relay_rejected',
      retryable: true,
    });
  });

  it('rejects a 2xx receipt that claims submitted without a tx hash', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signed = await signOperation(prepareOperation(planOperation(account.address)), account);
    const transport = createRelayTransport({
      relayUrl: 'https://relay.example',
      fetcher: async () => Response.json({ status: 'submitted' }),
    });

    await expect(transport.submit(signed)).rejects.toMatchObject({
      operation: 'plan.register',
      code: 'invalid_relay_response',
      retryable: false,
    });
  });
});

async function captureRejection(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error('expected the transport to reject');
}
