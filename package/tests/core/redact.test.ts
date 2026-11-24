// RPC 端点脱敏：watcher describe 与 CLI stdout 都会打印配置/错误文本，带
// userinfo、secret query 或 API-key 形状路径段的 RPC URL 必须在打印前替换，
// 干净端点保持原样（不能因为脱敏改写成另一个可读路径）。

import { describe, expect, it } from 'vitest';
import { createStateMachineWatcher } from '../../src/headless/watcher/index.js';
import { redactRpcUrl, redactRpcUrlsInText } from '../../src/core/redact.js';
import { stringifyForCli } from '../../src/cli/output.js';

const STATE_MACHINE = '0x0000000000000000000000000000000000000001';

describe('RPC endpoint redaction', () => {
  it('removes userinfo, secret query parameters, and API-key path segments', () => {
    const redacted = redactRpcUrl(
      'https://alice:hunter2@rpc.example.com/v2/AbCdEf0123456789AbCdEf01?api_key=secret-key',
    );

    expect(redacted).not.toContain('alice');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('AbCdEf0123456789AbCdEf01');
    expect(redacted).not.toContain('secret-key');
    expect(redacted).toContain('rpc.example.com');
    expect(redacted).toContain('/v2/redacted');
  });

  it('leaves key-free endpoints untouched', () => {
    expect(redactRpcUrl('https://sepolia.base.org')).toBe('https://sepolia.base.org');
    expect(redactRpcUrl('http://127.0.0.1:8545')).toBe('http://127.0.0.1:8545');
  });

  it('redacts endpoints embedded in error text while keeping the surrounding message', () => {
    const text = redactRpcUrlsInText(
      'HttpRequestError: URL: https://rpc.example/v2/AbCdEf0123456789AbCdEf01, retry later',
    );

    expect(text).toContain('HttpRequestError');
    expect(text).toContain('retry later');
    expect(text).not.toContain('AbCdEf0123456789AbCdEf01');
  });

  it('serializes CLI stdout with endpoints redacted', () => {
    const output = stringifyForCli({
      error: 'transport failed for https://alice:hunter2@rpc.example.com/v2/AbCdEf0123456789AbCdEf01',
      watcher: { rpcUrl: 'https://rpc.example/v2/AbCdEf0123456789AbCdEf01?api_key=secret-key' },
    });

    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('AbCdEf0123456789AbCdEf01');
    expect(output).not.toContain('secret-key');
  });

  it('renders a redacted rpcUrl in watcher describe()', () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'https://alice:hunter2@rpc.example.com/v2/AbCdEf0123456789AbCdEf01?token=server-token',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      privateKeyEnv: 'UVP_TEST_PRIVATE_KEY',
      dryRun: true,
      handlers: {},
    });

    const described = JSON.stringify(watcher.describe());
    expect(described).not.toContain('hunter2');
    expect(described).not.toContain('AbCdEf0123456789AbCdEf01');
    expect(described).not.toContain('server-token');
    expect(watcher.describe()['rpcUrl']).toContain('rpc.example.com');
  });
});
