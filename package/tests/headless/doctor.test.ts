import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { main } from '../../src/cli/index.js';
import { runExecutorDoctor } from '../../src/headless/doctor.js';

const privateKey = `0x${'11'.repeat(32)}` as const;
const account = privateKeyToAccount(privateKey);
const KEY_ENV = 'UVP_DOCTOR_TEST_PRIVATE_KEY';
const STATE_MACHINE = '0x0000000000000000000000000000000000000001' as const;

describe('executor doctor', () => {
  it('reports config, wallet, RPC, chain-id, and state-machine checks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-doctor-'));
    const configPath = join(dir, 'executor.json');
    const previousKey = process.env[KEY_ENV];
    process.env[KEY_ENV] = privateKey;
    const stub = await startRpcStub({ chainId: '0x7a69', code: '0x6001' });
    try {
      await writeFile(configPath, JSON.stringify({
        supplierId: 'role-a',
        walletAddress: account.address,
        chainId: 31_337,
        stateMachines: [{ stateMachineAddress: STATE_MACHINE }],
        handlers: {
          'stage-a#START': {
            signals: [{ source: 'role-a', stageIdentifier: 'stage-a', signalName: 'cmp' }],
          },
        },
      }));

      const report = await runExecutorDoctor({
        configPath,
        rpcUrl: stub.url,
        chainId: 31_337,
        stateMachineAddress: STATE_MACHINE,
        privateKeyEnv: KEY_ENV,
      });

      expect(report.ok).toBe(true);
      expect(report.checks.map((check) => check.label))
        .toEqual(['config', 'wallet', 'rpc', 'chain-id', 'state-machine']);
      expect(report.config).toMatchObject({
        handlerCount: 1,
        signalCount: 1,
        stateMachineAddresses: [STATE_MACHINE],
        chainId: 31_337,
        dryRun: false,
      });
      expect(report.rpc).toEqual({ chainId: 31_337, blockNumber: '16' });
      expect(report.walletAddress).toBe(account.address);
      expect(report.warnings).toEqual([]);
    } finally {
      await stub.close();
      if (previousKey === undefined) {
        delete process.env[KEY_ENV];
      } else {
        process.env[KEY_ENV] = previousKey;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails the chain-id and state-machine checks with both sides named', async () => {
    const stub = await startRpcStub({ chainId: '0x2105', code: '0x' });
    try {
      const report = await runExecutorDoctor({
        rpcUrl: stub.url,
        chainId: 31_337,
        stateMachineAddress: STATE_MACHINE,
      });

      expect(report.ok).toBe(false);
      expect(report.rpc).toEqual({ chainId: 8453, blockNumber: '16' });
      const chainIdCheck = report.checks.find((check) => check.label === 'chain-id');
      expect(chainIdCheck).toMatchObject({ ok: false });
      expect(chainIdCheck?.detail).toContain('8453');
      expect(chainIdCheck?.detail).toContain('31337');
      const stateMachineCheck = report.checks.find((check) => check.label === 'state-machine');
      expect(stateMachineCheck).toMatchObject({ ok: false });
      expect(stateMachineCheck?.detail).toContain(STATE_MACHINE);
    } finally {
      await stub.close();
    }
  });

  it('prints the report and exits non-zero when the RPC check fails', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    try {
      await main([
        'node', 'uvp-client', 'doctor',
        '--rpc-url', 'http://127.0.0.1:1',
        '--timeout-ms', '500',
      ]);

      const report = JSON.parse(logs[0] ?? '{}') as {
        ok?: boolean;
        checks?: Array<{ ok?: boolean; label?: string }>;
      };
      expect(report.ok).toBe(false);
      expect(report.checks?.[0]).toMatchObject({ ok: false, label: 'rpc' });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      console.log = originalLog;
    }
  });
});

async function startRpcStub(options: {
  readonly chainId: string;
  readonly blockNumber?: string;
  readonly code?: string;
}): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        id?: unknown;
        method?: string;
      };
      let result: unknown = null;
      if (parsed.method === 'eth_chainId') {
        result = options.chainId;
      } else if (parsed.method === 'eth_blockNumber') {
        result = options.blockNumber ?? '0x10';
      } else if (parsed.method === 'eth_getCode') {
        result = options.code ?? '0x6001';
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, result }));
    })().catch(() => {
      response.statusCode = 500;
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('RPC stub did not bind to a TCP address');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
