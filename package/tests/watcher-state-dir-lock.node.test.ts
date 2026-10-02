import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, stat, writeFile, readFile, rm as rmFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import type { Hex } from 'viem';
import {
  acquireWatcherStateDirLock,
  createStateMachineWatcher,
  deadLetterStateMachineJob,
  decodeHookReadyLog,
  FileStateMachineJobStore,
  InMemoryStateMachineJobStore,
  retryStateMachineJob,
  stateMachineJobId,
  type StateMachineJobPatch,
} from '../src/watcher/index.js';
import { putBackDisplacedMarker } from '../src/watcher/storage/lock.js';
import { main } from '../src/cli.js';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watcherEntryUrl = pathToFileURL(join(packageDir, 'src/watcher/storage/lock.ts')).href;
const stateMachine = '0x1111111111111111111111111111111111111111' as const;
const wallet = '0x2222222222222222222222222222222222222222' as const;

/** Minimal JSON-RPC chain stub: chainId + movable head + empty getLogs, enough for a dry-run scan. */
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
      '*': { signals: [{ source: 'buyer', stageIdentifier: 'exec.main', signalName: 'cmp' }] },
    },
  }));
  return configPath;
}

function chainOnceArgv(input: { readonly stubUrl: string; readonly configPath: string; readonly stateDir: string }): string[] {
  return [
    'node', 'uvp-executor', 'chain-once',
    '--rpc-url', input.stubUrl,
    '--state-machine', stateMachine,
    '--chain-id', '31337',
    '--config', input.configPath,
    '--wallet-address', wallet,
    '--dry-run',
    '--state-dir', input.stateDir,
  ];
}

/** A pid that is definitely not alive: take it from an already-exited child process. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise()));
  if (pid === undefined) {
    throw new Error('child process did not expose a pid');
  }
  return pid;
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
      await writeFile(lockPath, `${await deadPid()}\n`);
      const lock = await acquireWatcherStateDirLock(dir);
      assert.equal(await readFile(lockPath, 'utf8'), `${process.pid}\n`);
      await lock.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('陈旧锁的并发接管竞态：同时判陈旧也只有唯一持有者，协议自身不留残留文件', async () => {
    // rm+wx 式接管里，两个同时判陈旧的进程会互删对方刚建的新锁而双双持锁
    // （TOCTOU）。原子接管下，无论事件循环如何交错，link 的 create-if-absent
    // 语义保证 lockPath 上至多一个赢家，落败者重读后按活 pid 拒绝。
    const dir = await mkdtemp(join(tmpdir(), 'uvp-state-lock-race-'));
    try {
      const lockPath = join(dir, 'watcher.lock');
      await writeFile(lockPath, `${await deadPid()}\n`);

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

  it('跨进程并发接管陈旧锁：每轮风暴至多一个持有者，落败进程按活 pid 拒绝', async () => {
    // 单次起跑的碰撞窗口只有毫秒级，一次风暴难以稳定复现 rm+wx 式接管的
    // 互删双持；改为多轮重播陈旧锁 + 8 进程同时起跑的风暴。持有者挂到
    // 本轮 stop 门才释放：轮内锁位不空闲，第二条 held 只能来自真双持。
    const dir = await mkdtemp(join(tmpdir(), 'uvp-state-lock-race-proc-'));
    const racerCount = 8;
    const rounds = 12;
    const children: ReturnType<typeof spawn>[] = [];
    try {
      const lockPath = join(dir, 'watcher.lock');
      const stalePid = await deadPid();
      const marksFile = join(dir, 'marks');
      const script = join(dir, 'racer.mts');
      await writeFile(script, [
        'import { existsSync } from \'node:fs\';',
        'import { appendFileSync } from \'node:fs\';',
        'const mod = await import(process.argv[2]);',
        'const rounds = Number(process.argv[6]);',
        'const waitFor = async (path: string) => {',
        '  while (!existsSync(path)) {',
        '    await new Promise((resolve) => setTimeout(resolve, 2));',
        '  }',
        '};',
        'for (let round = 0; round < rounds; round += 1) {',
        '  const gate = `${process.argv[4]}-${round}`;',
        '  await waitFor(`${gate}-go`);',
        '  try {',
        '    const lock = await mod.acquireWatcherStateDirLock(process.argv[3]);',
        `    appendFileSync(process.argv[5], \`held \${process.pid} r\${round}\\n\`);`,
        '    await waitFor(`${gate}-stop`);',
        '    await lock.release();',
        `    appendFileSync(process.argv[5], \`released \${process.pid} r\${round}\\n\`);`,
        '  } catch (error) {',
        `    appendFileSync(process.argv[5], \`refused \${process.pid} r\${round} \${error instanceof Error ? error.message : String(error)}\\n\`);`,
        '  }',
        `  appendFileSync(process.argv[5], \`done \${process.pid} r\${round}\\n\`);`,
        '}',
        '',
      ].join('\n'));

      const readMarks = async (): Promise<string[]> => {
        try {
          return (await readFile(marksFile, 'utf8')).split('\n').filter((line) => line.length > 0);
        } catch {
          return [];
        }
      };
      const linesOfRound = (lines: readonly string[], round: number): string[] =>
        lines.filter((line) => line.split(' ')[2] === `r${round}`);
      for (let index = 0; index < racerCount; index += 1) {
        children.push(spawn(
          process.execPath,
          ['--import', 'tsx', script, watcherEntryUrl, dir, join(dir, 'gate'), marksFile, String(rounds)],
          { cwd: packageDir, stdio: 'ignore' },
        ));
      }

      const codes = Promise.all(children.map((child) => new Promise<number | null>((resolve) => {
        child.once('exit', (code) => resolve(code));
      })));
      for (let round = 0; round < rounds; round += 1) {
        // 每轮重新播种陈旧锁，再开门让全部进程同时冲同一把锁。
        await writeFile(lockPath, `${stalePid}\n`);
        await writeFile(join(dir, `gate-${round}-go`), '');
        const roundDeadline = Date.now() + 30_000;
        const settle = async (): Promise<void> => {
          for (;;) {
            if (Date.now() > roundDeadline) {
              throw new Error(`round ${round} never settled: ${(await readMarks()).join(' | ')}`);
            }
            if (children.some((child) => child.exitCode !== null && child.exitCode !== 0)) {
              throw new Error(`a racer crashed in round ${round}: ${(await readMarks()).join(' | ')}`);
            }
            const lines = linesOfRound(await readMarks(), round);
            const held = lines.filter((line) => line.startsWith('held '));
            const done = lines.filter((line) => line.startsWith('done '));
            assert.ok(
              held.length <= 1,
              `round ${round}: at most one racer may hold the lock at a time: ${lines.join(' | ')}`,
            );
            if (held.length === 1 && done.length === racerCount - 1) {
              return;
            }
            if (done.length === racerCount) {
              throw new Error(`round ${round} produced no holder: ${lines.join(' | ')}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        };
        await settle();
        // 持有者挂到 stop 门才放锁：7 个落败者已定性，此时开门收尾。
        await writeFile(join(dir, `gate-${round}-stop`), '');
        for (;;) {
          if (Date.now() > roundDeadline) {
            throw new Error(`round ${round} holder never released: ${(await readMarks()).join(' | ')}`);
          }
          const lines = linesOfRound(await readMarks(), round);
          if (lines.filter((line) => line.startsWith('done ')).length === racerCount) {
            const held = lines.filter((line) => line.startsWith('held '));
            const released = lines.filter((line) => line.startsWith('released '));
            const refused = lines.filter((line) => line.startsWith('refused '));
            assert.equal(held.length, 1, `round ${round}: ${lines.join(' | ')}`);
            assert.equal(released.length, 1, `round ${round}: the holder must release on the stop gate`);
            assert.equal(refused.length, racerCount - 1);
            assert.ok(
              refused.every((line) => line.includes('locked by running process')),
              `round ${round}: the losers must report the live holder: ${refused.join(' | ')}`,
            );
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      const exitCodes = await codes;
      assert.deepEqual(
        exitCodes.filter((code) => code !== 0),
        [],
        'a refused racer still exits cleanly',
      );
      assert.deepEqual(
        (await readdir(dir))
          .filter((name) => name === 'watcher.lock' || name.includes('.contend-') || name.endsWith('.broken'))
          .sort(),
        [],
        'no lock, contender, or graveyard files may survive the storm',
      );
    } finally {
      for (const child of children) {
        if (!child.killed && child.exitCode === null) {
          child.kill('SIGKILL');
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('持锁进程退出（含 SIGTERM 清理）后，同 state-dir 的 watcher 可以启动', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-state-lock-proc-'));
    const logs: string[] = [];
    const originalLog = console.log;
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    const stub = await startChainStub();
    const childScript = join(dir, 'holder.mts');
    await writeFile(childScript, [
      'const mod = await import(process.argv[2]);',
      'const lock = await mod.acquireWatcherStateDirLock(process.argv[3]);',
      'console.log("holder-ready");',
      "process.on('SIGTERM', () => { void lock.release().then(() => process.exit(0)); });",
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'));

    const child = spawn(process.execPath, ['--import', 'tsx', childScript, watcherEntryUrl, dir], {
      cwd: packageDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childOutput = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      childOutput += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      childOutput += String(chunk);
    });

    const configPath = await writeHandlerConfig(dir);
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error(`holder child never became ready: ${childOutput}`)), 30_000);
        child.once('exit', () => {
          clearTimeout(timer);
          rejectPromise(new Error(`holder child exited before locking: ${childOutput}`));
        });
        child.stdout?.on('data', (chunk: Buffer) => {
          if (String(chunk).includes('holder-ready')) {
            clearTimeout(timer);
            resolvePromise();
          }
        });
      });

      // 持有进程存活期间：第二个 watcher（CLI chain-once）启动即拒绝。
      await assert.rejects(
        main(chainOnceArgv({ stubUrl: stub.url, configPath, stateDir: dir })),
        /locked by running process/u,
      );

      // SIGTERM 让持有进程退出；其清理路径必须移除锁文件。
      child.kill('SIGTERM');
      const code = await new Promise<number | null>((resolvePromise) => child.once('exit', (exitCode) => resolvePromise(exitCode)));
      assert.equal(code, 0);
      assert.equal(await readFile(join(dir, 'watcher.lock'), 'utf8').then(() => 'still-there', () => 'removed'), 'removed');

      // 持有进程退出后：同 state-dir 重启成功（锁被 CLI 取得并在运行后释放）。
      await main(chainOnceArgv({ stubUrl: stub.url, configPath, stateDir: dir }));
      assert.equal(process.exitCode, undefined);
      assert.equal(await readFile(join(dir, 'watcher.lock'), 'utf8').then(() => 'still-there', () => 'removed'), 'removed');
    } finally {
      if (!child.killed && child.exitCode === null) {
        child.kill('SIGKILL');
      }
      await stub.close();
      console.log = originalLog;
      process.exitCode = previousExitCode;
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
      // --chain-id abc 在锁取得之后才解析失败（ValidationError）。
      await assert.rejects(
        main(chainOnceArgv({ stubUrl: stub.url, configPath, stateDir: dir }).map(
          (arg, index, all) => (all[index - 1] === '--chain-id' ? 'abc' : arg),
        )),
        /chainId/u,
      );
      // 失败路径不得泄漏 watcher.lock：锁文件已移除，下一个进程可启动。
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

  it('jobs retry 不取 state-dir 启动锁：持锁 watcher 存活时仍可执行（README 承诺）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-state-lock-retry-'));
    const originalLog = console.log;
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = () => {};
    const stub = await startChainStub();
    const configPath = await writeHandlerConfig(dir);
    const holder = await acquireWatcherStateDirLock(dir);
    try {
      const jobId = '0x' + 'ab'.repeat(32);
      // 持锁进程存活：jobs retry 不因 state-dir 锁被拒——按业务事实失败
      // （job 不存在），而不是 "locked by running process"。
      await assert.rejects(
        main([
          'node', 'uvp-executor', 'jobs', 'retry', jobId,
          '--jobs-file', join(dir, 'jobs.json'),
          '--rpc-url', stub.url,
          '--state-machine', stateMachine,
          '--chain-id', '31337',
          '--config', configPath,
          '--operator', 'lock-test-operator',
        ]),
        (error: unknown) => {
          const message = String((error as Error).message);
          assert.ok(!message.includes('locked by running process'), `retry must not be rejected by the state-dir lock: ${message}`);
          assert.match(message, /job .* not found/u);
          return true;
        },
      );
    } finally {
      await holder.release();
      await stub.close();
      console.log = originalLog;
      process.exitCode = previousExitCode;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('锁占位放回协议', () => {
  it('放回让位或失败时不得销毁坟场条目：被挪活锁的最后存置必须保留', async () => {
    // rename 挪走易主活锁后，坟场条目是该锁唯一剩的存置：放回失败（锁位
    // 已被更新的锁占位而让位，或 link 瞬时失败）时销毁它，等于凭空注销
    // 他人仍持着的锁——持有者还在临界区，锁位却已空置。
    const dir = await mkdtemp(join(tmpdir(), 'uvp-lock-putback-'));
    try {
      const lockPath = join(dir, 'watcher.lock');
      const gravePath = join(dir, 'watcher.lock.contend-4242-putback.broken');
      await writeFile(gravePath, '4242\n');
      const graveBefore = await stat(gravePath);

      // 锁位已落位更新的锁：放回必须让位，坟场里的被挪活锁原样保留。
      await writeFile(lockPath, `${process.pid}\n`);
      await putBackDisplacedMarker(gravePath, lockPath);
      const graveSurvived = await stat(gravePath);
      assert.equal(graveSurvived.ino, graveBefore.ino, 'a failed put-back must not destroy the graveyard entry');
      assert.equal(await readFile(lockPath, 'utf8'), `${process.pid}\n`, 'the newer lock keeps its place');

      // 锁位空置时放回归位：坟场名清掉，锁位接回被挪的活锁。
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

  async function hookReadyLog(): Promise<Parameters<ReturnType<typeof createStateMachineWatcher>['handleLog']>[0]> {
    const fixture = JSON.parse(await readFile(
      join(packageDir, '../../uvp-protocol/contracts/uvp-contracts/fixtures/uvp-state-machine.v0.13.json'),
      'utf8',
    )) as { events: { HookReady: { topic: string } } };
    return {
      address: machine,
      topics: [fixture.events.HookReady.topic, word('77'), word('11'), word('22')],
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
      // 模拟 watcher 进程崩溃：任务停在 matched 且认领 pid 已死。
      const crashedPid = await deadPid();
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

      // 模拟认领闸读取后、运行结束前落进来的操作员裁决（读-写竞态窗口）：
      // 直接写 store，绕过已被活认领挡住的入口。
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
      // handler 先阻塞等操作员裁决落地，再抛错：失败路径会走运行中
      // lastError 写入（updateJob），正是终态守卫要拦的写。
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
          return [{ orderId: event.orderId, source: 'buyer', signalName: 'cmp' }];
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
      // 模拟崩溃残留：matched + 认领写入后、结论性写入前进程死亡。
      await store.update(created.id, {
        status: 'matched',
        updatedAt: new Date().toISOString(),
        matchedKey: '*',
        claim: { pid: await deadPid(), at: new Date().toISOString() },
        expectStatus: 'detected',
      });

      await watcher.pollOnce();

      assert.equal(effects, 1, 'the later-scan pass must take over the stranded matched job');
      const revived = await store.get(created.id);
      assert.equal(revived?.submissions.length, 1, 'the takeover run records its dry-run submission');
      assert.ok(!revived?.claim, 'the concluded run releases the claim');

      // dry-run 收敛：后续扫描不再重跑 handler。
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
      // 旁路执行器没有该事件的 handler：扫描同一日志会走 missing-handler
      // 终态写入路径。
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

      // 模拟并发执行器接管同一任务：重开并认领（matched + 本进程活认领）。
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
    // 读后写竞态窗口：裁决读取到的是 detected（无认领），写入前操作员
    // dead-letter 先落地。裁决的 CAS 守卫必须拒写并报告存储中的任务，
    // 而不是把 dead_letter 覆盖成 ignored。
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
