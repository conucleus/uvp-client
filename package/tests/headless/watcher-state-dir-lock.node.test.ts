import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile, readFile, rm as rmFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Hex } from 'viem';
import {
  acquireWatcherStateDirLock,
  createStateMachineWatcher,
  deadLetterStateMachineJob,
  decodeHookReadyLog,
  FileStateMachineJobStore,
  HOOK_READY_TOPIC,
  InMemoryStateMachineJobStore,
  retryStateMachineJob,
  stateMachineJobId,
  type StateMachineJobPatch,
} from '../../src/headless/watcher/index.js';
import { putBackDisplacedMarker } from '../../src/headless/watcher/storage/lock.js';
import { main } from '../../src/cli/index.js';

const stateMachine = '0x1111111111111111111111111111111111111111' as const;
const wallet = '0x2222222222222222222222222222222222222222' as const;

async function startChainStub(): Promise<{ readonly url: string; close(): Promise<void> }> {
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
        result = '0x7a69';
      } else if (parsed.method === 'eth_blockNumber') {
        result = '0xd';
      } else if (parsed.method === 'eth_getLogs') {
        result = [];
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, result }));
    })().catch(() => {
      response.statusCode = 500;
      response.end('{}');
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('chain stub did not bind to a TCP address');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolvePromise) => {
      server.closeAllConnections();
      server.close(() => resolvePromise());
    }),
  };
}

async function writeHandlerConfig(dir: string): Promise<string> {
  const configPath = join(dir, 'executor.json');
  await writeFile(configPath, JSON.stringify({
    supplierId: 'lock-test-supplier',
    walletAddress: wallet,
    chainId: 31_337,
    stateMachineAddress: stateMachine,
    handlers: {
      '*': { signals: [{ source: 'slot-a', stageIdentifier: 'exec.main', signalName: 'cmp' }] },
    },
  }));
  return configPath;
}

function chainOnceArgv(input: { readonly stubUrl: string; readonly configPath: string; readonly stateDir: string }): string[] {
  return [
    'node', 'uvp-client', 'chain-once',
    '--rpc-url', input.stubUrl,
    '--state-machine', stateMachine,
    '--chain-id', '31337',
    '--config', input.configPath,
    '--wallet-address', wallet,
    '--dry-run',
    '--state-dir', input.stateDir,
  ];
}

function deadPid(): number {
  for (let pid = 99_999; pid > 1; pid -= 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return pid;
      }
    }
  }
  throw new Error('no dead pid available for the stale-lock fixture');
}

describe('watcher state-dir 进程锁', () => {
  it('同 state-dir 第二个 watcher 启动即拒绝，报出持有 pid 与锁路径；释放后可重启', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-state-lock-'));
    try {
      const first = await acquireWatcherStateDirLock(dir);
      const lockPath = join(dir, 'watcher.lock');
      assert.equal(first.lockPath, lockPath);
      assert.equal(await readFile(lockPath, 'utf8'), `${process.pid}\n`);

      await assert.rejects(
        acquireWatcherStateDirLock(dir),
        (error: unknown) => {
          assert.match(String((error as Error).message), new RegExp(`process ${process.pid}`));
          assert.match(String((error as Error).message), /watcher\.lock/u);
          return true;
        },
      );

      await first.release();
      assert.equal(await rmFile(join(dir, 'watcher.lock')).then(() => 'still-there', () => 'removed'), 'removed');
      const restarted = await acquireWatcherStateDirLock(dir);
      await restarted.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('陈旧锁（pid 不存活）启动时接管并重写为当前 pid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-state-lock-stale-'));
    try {
      const lockPath = join(dir, 'watcher.lock');
      await writeFile(lockPath, `${deadPid()}\n`);
      const lock = await acquireWatcherStateDirLock(dir);
      assert.equal(await readFile(lockPath, 'utf8'), `${process.pid}\n`);
      await lock.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('陈旧锁的并发接管竞态：同时判陈旧也只有唯一持有者，协议自身不留残留文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-state-lock-race-'));
    try {
      const lockPath = join(dir, 'watcher.lock');
      await writeFile(lockPath, `${deadPid()}\n`);

      const settled = await Promise.allSettled([
        acquireWatcherStateDirLock(dir),
        acquireWatcherStateDirLock(dir),
        acquireWatcherStateDirLock(dir),
      ]);
      const holders = settled.filter((result) => result.status === 'fulfilled');
      const refused = settled.filter((result) => result.status === 'rejected');
      assert.equal(holders.length, 1, 'exactly one contender may end up holding the lock');
      assert.equal(refused.length, 2);
      for (const result of refused) {
        const reason = result.status === 'rejected' ? result.reason : undefined;
        assert.match(
          String(reason instanceof Error ? reason.message : String(reason)),
          /locked by running process/u,
          'the loser must lose by reading the winner as a live holder, not by double-holding',
        );
      }

      const winner = holders[0];
      assert.ok(winner && winner.status === 'fulfilled');
      assert.equal(await readFile(lockPath, 'utf8'), `${process.pid}\n`);
      await winner.value.release();
      assert.deepEqual(
        (await readdir(dir)).sort(),
        [],
        'the takeover protocol must clean up its contender and graveyard files',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('取锁后的构造/参数解析失败必须释放锁——泄漏的 watcher.lock 会拒绝下一个进程', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-state-lock-release-'));
    const originalLog = console.log;
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = () => {};
    const stub = await startChainStub();
    const configPath = await writeHandlerConfig(dir);
    try {
      await assert.rejects(
        main(chainOnceArgv({ stubUrl: stub.url, configPath, stateDir: dir }).map(
          (arg, index, all) => (all[index - 1] === '--chain-id' ? 'abc' : arg),
        )),
        /chainId/u,
      );
      assert.equal(await readFile(join(dir, 'watcher.lock'), 'utf8').then(() => 'still-there', () => 'removed'), 'removed');
      const lock = await acquireWatcherStateDirLock(dir);
      await lock.release();
    } finally {
      await stub.close();
      console.log = originalLog;
      process.exitCode = previousExitCode;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('锁占位放回协议', () => {
  it('放回让位或失败时不得销毁坟场条目：被挪活锁的最后存置必须保留', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-lock-putback-'));
    try {
      const lockPath = join(dir, 'watcher.lock');
      const gravePath = join(dir, 'watcher.lock.contend-4242-putback.broken');
      await writeFile(gravePath, '4242\n');
      const graveBefore = await stat(gravePath);

      await writeFile(lockPath, `${process.pid}\n`);
      await putBackDisplacedMarker(gravePath, lockPath);
      const graveSurvived = await stat(gravePath);
      assert.equal(graveSurvived.ino, graveBefore.ino, 'a failed put-back must not destroy the graveyard entry');
      assert.equal(await readFile(lockPath, 'utf8'), `${process.pid}\n`, 'the newer lock keeps its place');

      await rm(lockPath);
      await putBackDisplacedMarker(gravePath, lockPath);
      assert.equal(await readFile(lockPath, 'utf8'), '4242\n', 'a free lock path takes the displaced lock back');
      await assert.rejects(() => stat(gravePath), /ENOENT/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('watcher 任务级运行认领', () => {
  const machine = '0x1111111111111111111111111111111111111111' as const;
  const word = (hex: string) => `0x${hex.repeat(32)}`;

  function hookReadyLog(): Parameters<ReturnType<typeof createStateMachineWatcher>['handleLog']>[0] {
    return {
      address: machine,
      topics: [HOOK_READY_TOPIC, word('77'), word('11'), word('22')],
      data: `0x${'55'.repeat(32)}${'66'.repeat(32)}`,
      blockNumber: 12n,
      transactionHash: word('33'),
      logIndex: 7,
    };
  }

  it('handler 运行中手工 retry 被拒，handler 不被并发二次执行', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-run-claim-'));
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolveStarted) => { entered = resolveStarted; });
    const blocked = new Promise<void>((resolveBlocked) => { release = resolveBlocked; });
    let effects = 0;
    const build = (handler: () => Promise<void>) => createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:1',
      stateMachineAddress: machine,
      chainId: 31_337,
      walletAddress: wallet,
      privateKeyEnv: 'UVP_RUN_CLAIM_UNUSED_KEY',
      dryRun: true,
      jobStore: new FileStateMachineJobStore(join(dir, 'jobs.json')),
      handlers: { '*': handler },
    });
    try {
      const running = build(async () => { effects += 1; entered(); await blocked; });
      const manual = build(async () => { effects += 1; });
      const log = await hookReadyLog();
      const active = running.handleLog(log);
      await started;

      const jobId = stateMachineJobId(decodeHookReadyLog(log));
      const duringRun = await manual.config.jobStore.get(jobId);
      assert.equal(duringRun?.status, 'matched', 'precondition: the job is claimed mid-run');
      assert.ok(duringRun?.claim !== undefined, 'precondition: the claim is recorded');

      await assert.rejects(
        retryStateMachineJob(manual, jobId, { operator: 'claim-test' }),
        (error: unknown) => {
          assert.match(String((error as Error).message), /being processed by executor pid/u);
          return true;
        },
      );
      assert.equal(effects, 1, 'the handler must not have been invoked a second time while blocked');

      release();
      await active;
      assert.equal(effects, 1);
    } finally {
      release?.();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('持有者已死的 matched 认领可被手工 retry 接管（崩溃恢复通道）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-run-claim-dead-'));
    let effects = 0;
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:1',
      stateMachineAddress: machine,
      chainId: 31_337,
      walletAddress: wallet,
      privateKeyEnv: 'UVP_RUN_CLAIM_UNUSED_KEY',
      dryRun: true,
      jobStore: new FileStateMachineJobStore(join(dir, 'jobs.json')),
      handlers: { '*': async () => { effects += 1; } },
    });
    try {
      const log = await hookReadyLog();
      await watcher.handleLog(log);
      assert.equal(effects, 1);

      const jobId = stateMachineJobId(decodeHookReadyLog(log));
      const crashedPid = deadPid();
      await watcher.config.jobStore.update(jobId, {
        status: 'matched',
        updatedAt: new Date().toISOString(),
        claim: { pid: crashedPid, at: new Date().toISOString() },
      });

      const retried = await retryStateMachineJob(watcher, jobId, { operator: 'claim-test' });
      assert.equal(retried.status, 'handled', 'a dead claim must not block the manual recovery channel');
      assert.equal(effects, 2, 'the retry runs the handler exactly once more');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('handler 运行中手工 dead-letter 被拒：dead_letter 附带 claim:null 不得清掉活认领', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-run-claim-deadletter-'));
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolveStarted) => { entered = resolveStarted; });
    const blocked = new Promise<void>((resolveBlocked) => { release = resolveBlocked; });
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:1',
      stateMachineAddress: machine,
      chainId: 31_337,
      walletAddress: wallet,
      privateKeyEnv: 'UVP_RUN_CLAIM_UNUSED_KEY',
      dryRun: true,
      jobStore: new FileStateMachineJobStore(join(dir, 'jobs.json')),
      handlers: { '*': async () => { entered(); await blocked; } },
    });
    try {
      const log = await hookReadyLog();
      const active = watcher.handleLog(log);
      await started;

      const jobId = stateMachineJobId(decodeHookReadyLog(log));
      await assert.rejects(
        deadLetterStateMachineJob(watcher.config.jobStore, jobId, {
          operator: 'claim-test',
          reason: 'operator verdict',
        }),
        (error: unknown) => {
          assert.match(String((error as Error).message), /being processed by executor pid/u);
          return true;
        },
      );
      const duringRun = await watcher.config.jobStore.get(jobId);
      assert.ok(duringRun?.claim, 'the refused dead-letter must leave the live claim intact');

      release();
      const settled = await active;
      assert.equal(settled.job?.status, 'matched', 'the dry-run run still concludes its own outcome');
    } finally {
      release?.();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('运行收尾终态写入不得覆盖并发落下的操作员 dead-letter 裁决', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-run-claim-finalize-'));
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolveStarted) => { entered = resolveStarted; });
    const blocked = new Promise<void>((resolveBlocked) => { release = resolveBlocked; });
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:1',
      stateMachineAddress: machine,
      chainId: 31_337,
      walletAddress: wallet,
      privateKeyEnv: 'UVP_RUN_CLAIM_UNUSED_KEY',
      dryRun: true,
      jobStore: new FileStateMachineJobStore(join(dir, 'jobs.json')),
      handlers: { '*': async () => { entered(); await blocked; } },
    });
    try {
      const log = await hookReadyLog();
      const active = watcher.handleLog(log);
      await started;

      const jobId = stateMachineJobId(decodeHookReadyLog(log));
      const operatorAt = new Date().toISOString();
      await watcher.config.jobStore.update(jobId, {
        status: 'dead_letter',
        updatedAt: operatorAt,
        lastError: { kind: 'unknown', message: 'operator verdict', retryable: false },
        claim: null,
      });

      release();
      const settled = await active;
      assert.equal(settled.job?.status, 'dead_letter', 'the run must not overwrite the operator verdict');
      const stored = await watcher.config.jobStore.get(jobId);
      assert.equal(stored?.status, 'dead_letter');
      assert.equal(stored?.lastError?.message, 'operator verdict', 'the operator reason must survive the run');
    } finally {
      release?.();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('运行中的失败分类写入不得覆盖并发落下的操作员 dead-letter 理由（终态守卫）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-run-claim-lasterror-'));
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolveStarted) => { entered = resolveStarted; });
    const blocked = new Promise<void>((resolveBlocked) => { release = resolveBlocked; });
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:1',
      stateMachineAddress: machine,
      chainId: 31_337,
      walletAddress: wallet,
      privateKeyEnv: 'UVP_RUN_CLAIM_UNUSED_KEY',
      dryRun: true,
      jobStore: new FileStateMachineJobStore(join(dir, 'jobs.json')),
      handlers: { '*': async () => { entered(); await blocked; throw new Error('handler boom'); } },
    });
    try {
      const log = await hookReadyLog();
      const active = watcher.handleLog(log);
      await started;

      const jobId = stateMachineJobId(decodeHookReadyLog(log));
      await watcher.config.jobStore.update(jobId, {
        status: 'dead_letter',
        updatedAt: new Date().toISOString(),
        lastError: { kind: 'unknown', message: 'operator verdict', retryable: false },
        claim: null,
      });

      release();
      const settled = await active;
      assert.equal(settled.job?.status, 'dead_letter');
      const stored = await watcher.config.jobStore.get(jobId);
      assert.equal(stored?.status, 'dead_letter');
      assert.equal(
        stored?.lastError?.message,
        'operator verdict',
        'the in-run failure classification must not clobber the operator-stored reason',
      );
    } finally {
      release?.();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('搁浅的 matched（认领持有者已死）被后续扫描自动接管重跑，而非仅剩人工 retry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-run-claim-stranded-'));
    let effects = 0;
    const store = new FileStateMachineJobStore(join(dir, 'jobs.json'));
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:1',
      stateMachineAddress: machine,
      chainId: 31_337,
      walletAddress: wallet,
      privateKeyEnv: 'UVP_RUN_CLAIM_UNUSED_KEY',
      dryRun: true,
      jobStore: store,
      fromBlock: 13n,
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 100n;
        },
        async getLogs() {
          return [];
        },
      },
      handlers: {
        '*': (event) => {
          effects += 1;
          return [{ orderId: event.orderId, source: 'slot-a', signalName: 'cmp' }];
        },
      },
    });
    try {
      const log = await hookReadyLog();
      const event = decodeHookReadyLog(log);
      if (!event) {
        throw new Error('test fixture log must decode as HookReady');
      }
      const created = await store.upsertDetected(event, { now: new Date().toISOString(), maxAttempts: 3 });
      await store.update(created.id, {
        status: 'matched',
        updatedAt: new Date().toISOString(),
        matchedKey: '*',
        claim: { pid: deadPid(), at: new Date().toISOString() },
        expectStatus: 'detected',
      });

      await watcher.pollOnce();

      assert.equal(effects, 1, 'the later-scan pass must take over the stranded matched job');
      const revived = await store.get(created.id);
      assert.equal(revived?.submissions.length, 1, 'the takeover run records its dry-run submission');
      assert.ok(!revived?.claim, 'the concluded run releases the claim');

      await watcher.pollOnce();
      assert.equal(effects, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('store 更新的 CAS 守卫：状态或认领不符时拒写并返回 undefined', async () => {
    const store = new InMemoryStateMachineJobStore();
    const log = await hookReadyLog();
    const event = decodeHookReadyLog(log);
    if (!event) {
      throw new Error('test fixture log must decode as HookReady');
    }
    const created = await store.upsertDetected(event, { now: new Date().toISOString(), maxAttempts: 3 });

    assert.equal(await store.update(created.id, {
      updatedAt: new Date().toISOString(),
      status: 'matched',
      expectStatus: 'confirmed',
    }), undefined, 'expectStatus mismatch must reject the write');

    const claimed = await store.update(created.id, {
      updatedAt: new Date().toISOString(),
      status: 'matched',
      claim: { pid: 424_242, at: new Date().toISOString() },
      expectStatus: 'detected',
      expectClaimPid: null,
    });
    assert.ok(claimed?.claim, 'the CAS-accepted write records the claim');

    assert.equal(await store.update(created.id, {
      updatedAt: new Date().toISOString(),
      claim: null,
      expectClaimPid: null,
    }), undefined, 'a claim mismatch must reject the release');

    const released = await store.update(created.id, {
      updatedAt: new Date().toISOString(),
      status: 'failed',
      claim: null,
      expectClaimPid: 424_242,
    });
    assert.equal(released?.status, 'failed');
    assert.equal(released?.claim, undefined, 'the conclusive status write releases the claim');
  });

  it('missing-handler 终态写入不得清掉并发活认领：旁路执行器让位，任务保持 matched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-run-claim-missing-'));
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolveStarted) => { entered = resolveStarted; });
    const blocked = new Promise<void>((resolveBlocked) => { release = resolveBlocked; });
    const store = new FileStateMachineJobStore(join(dir, 'jobs.json'));
    const build = (handlers: Record<string, () => Promise<void>>) => createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:1',
      stateMachineAddress: machine,
      chainId: 31_337,
      walletAddress: wallet,
      privateKeyEnv: 'UVP_RUN_CLAIM_UNUSED_KEY',
      dryRun: true,
      jobStore: store,
      handlers,
    });
    try {
      const running = build({ '*': async () => { entered(); await blocked; } });
      const bystander = build({});
      const log = await hookReadyLog();
      const active = running.handleLog(log);
      await started;

      const bystanded = await bystander.handleLog(log);
      assert.equal(bystanded.status, 'skipped', 'a live claim must beat the missing-handler verdict');
      assert.equal(bystanded.error, undefined, 'the bystander must not stamp its classification onto the concurrent run');

      const jobId = stateMachineJobId(decodeHookReadyLog(log));
      const duringRun = await store.get(jobId);
      assert.equal(duringRun?.status, 'matched', 'the verdict must not flip the running job terminal');
      assert.ok(duringRun?.claim, 'the verdict must not clear the live claim');
      assert.equal(duringRun?.lastError, undefined, 'the verdict must not stamp its error onto the running job');

      release();
      const settled = await active;
      assert.equal(settled.job?.status, 'matched', 'the blocked run still concludes its own dry-run outcome');
    } finally {
      release?.();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('undecodable log 的隔离写入不得清掉并发活认领', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-run-claim-isolate-'));
    const store = new FileStateMachineJobStore(join(dir, 'jobs.json'));
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:1',
      stateMachineAddress: machine,
      chainId: 31_337,
      walletAddress: wallet,
      privateKeyEnv: 'UVP_RUN_CLAIM_UNUSED_KEY',
      dryRun: true,
      jobStore: store,
      handlers: {},
    });
    try {
      const log = await hookReadyLog();
      const broken = { ...log, data: '0xdeadbeef' as Hex };
      const first = await watcher.handleLog(broken);
      assert.equal(first.status, 'ignored');
      assert.ok(first.job?.id, 'precondition: the undecodable log is isolated as a job');
      const jobId = first.job.id;

      await store.update(jobId, {
        status: 'matched',
        updatedAt: new Date().toISOString(),
        claim: { pid: process.pid, at: new Date().toISOString() },
      });

      const second = await watcher.handleLog(broken);
      assert.equal(second.status, 'skipped', 'a live claim must beat the undecodable-log isolation verdict');
      assert.equal(second.decodeFailure, true);

      const stored = await store.get(jobId);
      assert.equal(stored?.status, 'matched', 'the isolation verdict must not flip the running job terminal');
      assert.ok(stored?.claim, 'the isolation verdict must not clear the live claim');
      assert.equal((await store.list()).length, 1, 'the same log must not create a second job');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('missing-handler 裁决在 CAS 失败时让位：并发落下的操作员裁决不被覆盖', async () => {
    class RacingVerdictStore extends InMemoryStateMachineJobStore {
      private raced = false;

      override async update(jobId: Hex, patch: StateMachineJobPatch) {
        if (!this.raced && patch.status === 'ignored') {
          this.raced = true;
          await super.update(jobId, {
            status: 'dead_letter',
            updatedAt: new Date().toISOString(),
            lastError: { kind: 'unknown', message: 'operator verdict', retryable: false },
            claim: null,
          });
        }
        return super.update(jobId, patch);
      }
    }

    const store = new RacingVerdictStore();
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:1',
      stateMachineAddress: machine,
      chainId: 31_337,
      walletAddress: wallet,
      privateKeyEnv: 'UVP_RUN_CLAIM_UNUSED_KEY',
      dryRun: true,
      jobStore: store,
      handlers: {},
    });

    const result = await watcher.handleLog(await hookReadyLog());

    assert.equal(result.status, 'ignored', 'the stored terminal verdict decides the scan-level status');
    assert.equal(result.error, undefined, 'the lost race must not misattribute its own classification');
    assert.equal(result.job?.status, 'dead_letter', 'the operator verdict must survive the verdict write');
    assert.equal(result.job?.lastError?.message, 'operator verdict');
  });
});
