import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { encodeAbiParameters, keccak256, stringToBytes, stringToHex, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { classifyExecutorKitError, CodedExecutorKitError } from '../src/errors.js';
import {
  buildSubmitStateMachineSignalCall,
  createStateMachineHandlersFromConfig,
  createStateMachineWatcher,
  deadLetterStateMachineJob,
  decodeHookReadyLog,
  FileStateMachineCursorStore,
  FileStateMachineJobStore,
  hookReadyEventId,
  InMemoryStateMachineJobStore,
  loadStateMachineHandlerConfig,
  retryStateMachineJob,
  reviveStateMachineJob,
  submitStateMachineSignal,
  SubmitSignalReceiptError,
  stateMachineJobId,
  type StateMachineJobStore,
  type StateMachinePublicClient,
  type StateMachineRawLog,
} from '../src/watcher/index.js';
import { ValidationError } from '../src/validation.js';
import { appendJobSubmission, statusForCompletedRun } from '../src/watcher/execution/receipt.js';
import { HELD_FOREIGN_CLAIM_ALERT_ROUNDS } from '../src/watcher/watcher.js';
import { DEFAULT_GET_LOGS_CONCURRENCY } from '../src/watcher/scan/logs.js';
import type { StateMachineJobSubmission } from '../src/watcher/jobs/model.js';
import type { SubmitStateMachineSignalCall } from '../src/watcher/index.js';

const STATE_MACHINE = '0x0000000000000000000000000000000000000001';
const STATE_MACHINE_V2 = '0x0000000000000000000000000000000000000009';
const WALLET_ADDRESS = '0x0000000000000000000000000000000000000002';
const ORDER_ID = `0x${'11'.repeat(32)}` as Hex;
const PLAN_ID = `0x${'77'.repeat(32)}` as Hex;
const HOOK_ID = `0x${'22'.repeat(32)}` as Hex;
const STAGE_ID = `0x${'55'.repeat(32)}` as Hex;
const HOOK_NAME_ID = `0x${'66'.repeat(32)}` as Hex;
const TX_HASH = `0x${'33'.repeat(32)}` as Hex;
const TX_HASH_2 = `0x${'35'.repeat(32)}` as Hex;
const PAYLOAD_HASH = `0x${'44'.repeat(32)}` as Hex;
const SLOT_A_SOURCE_ID = keccak256(stringToBytes('slot-a'));
const EXEC_MAIN_CMP_ID = keccak256(stringToBytes('exec.main.cmp'));
const ZERO_BYTES32_WORD = `0x${'00'.repeat(32)}` as Hex;
const KEY_ENV = 'UVP_RECEIPT_TEST_PRIVATE_KEY';
const TEST_PRIVATE_KEY = `0x${'ab'.repeat(32)}`;
const STATE_MACHINE_FIXTURE = JSON.parse(
  readFileSync(new URL('../../../uvp-protocol/contracts/uvp-contracts/fixtures/uvp-state-machine.v0.17.json', import.meta.url), 'utf8'),
) as {
  readonly hashes: {
    readonly artifactHash: Hex;
  };
  readonly events: {
    readonly HookReady: {
      readonly signature: string;
      readonly topic: Hex;
    };
  };
  readonly functions: {
    readonly submitSignal: {
      readonly selector: string;
    };
  };
};

describe('state machine chain watcher', () => {
  it('decodes HookReady logs', () => {
    const log = hookReadyLog();
    const event = decodeHookReadyLog(log, artifactIndex());

    expect(STATE_MACHINE_FIXTURE.hashes.artifactHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(STATE_MACHINE_FIXTURE.events.HookReady.signature).toBe('HookReady(bytes32,bytes32,bytes32,bytes32,bytes32)');
    expect(event).toMatchObject({
      type: 'HookReady',
      stateMachineAddress: STATE_MACHINE,
      orderId: ORDER_ID,
      hookId: HOOK_ID,
      stageId: STAGE_ID,
      hookNameId: HOOK_NAME_ID,
      stageIdentifier: 'exec.main',
      hookName: 'START',
      blockNumber: 12n,
      transactionHash: TX_HASH,
      logIndex: 7n,
    });
    expect(event?.eventId).toBe(hookReadyEventId(log));
  });

  it('throws with the original context when a HookReady-topic log fails to decode', () => {
    const broken = { ...hookReadyLog(), data: '0xdeadbeef' as Hex };

    expect(() => decodeHookReadyLog(broken, artifactIndex())).toThrow(/failed to decode HookReady log data/);
  });

  it('still skips logs without the HookReady topic', () => {
    const otherTopic = keccak256(stringToBytes('Other(uint256)'));
    const unrelated = { ...hookReadyLog(), topics: [otherTopic, ORDER_ID] };

    expect(decodeHookReadyLog(unrelated, artifactIndex())).toBeUndefined();
  });

  it('refuses to derive event ids from zero values when transactionHash or logIndex is missing', () => {
    expect(() => hookReadyEventId({ transactionHash: null, logIndex: 7 })).toThrow(/transactionHash/);
    expect(() => hookReadyEventId({ transactionHash: TX_HASH, logIndex: null })).toThrow(/logIndex/);
    expect(() => hookReadyEventId({ transactionHash: TX_HASH })).toThrow(/logIndex/);
  });

  it('routes by stage, hook, and source before dry-running callback txs', async () => {
    const matchedKeys: string[] = [];
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      privateKeyEnv: 'UVP_TEST_PRIVATE_KEY',
      dryRun: true,
      artifact: artifactIndex(),
      handlers: {
        'exec.main#START': (event, context) => {
          matchedKeys.push(context.matchedKey);
          return {
            planId: PLAN_ID,
            orderId: event.orderId,
            source: 'slot-a',
            signalName: 'exec.main.cmp',
            payloadHash: PAYLOAD_HASH,
          };
        },
        [HOOK_ID]: () => {
          throw new Error('less specific handler should not run');
        },
      },
    });

    const result = await watcher.handleLog(hookReadyLog());
    const submission = result.submissions[0];
    if (!submission || !submission.dryRun) {
      throw new Error('expected a dry-run submission');
    }

    expect(result.status).toBe('handled');
    expect(result.matchedKey).toBe('exec.main#START');
    expect(result.job?.status).toBe('matched');
    expect(result.job?.matchedKey).toBe('exec.main#START');
    expect(matchedKeys).toEqual(['exec.main#START']);
    expect(submission.request.functionName).toBe('submitSignal');
    expect(submission.request.args).toEqual([
      PLAN_ID,
      ORDER_ID,
      SLOT_A_SOURCE_ID,
      EXEC_MAIN_CMP_ID,
      PAYLOAD_HASH,
      expect.any(String),
      { sourceId: ZERO_BYTES32_WORD, signalId: ZERO_BYTES32_WORD, stageId: ZERO_BYTES32_WORD, capabilityProof: [] },
    ]);
  });

  it('derives capability proofs on the fly from artifact-embedded tables', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      privateKeyEnv: 'UVP_TEST_PRIVATE_KEY',
      dryRun: true,
      artifact: capabilityArtifact(),
      handlers: {
        'exec.main#START': (event) => ({
          planId: PLAN_ID,
          orderId: event.orderId,
          source: 'slot-a',
          signalName: 'exec.main.cmp',
          payloadHash: PAYLOAD_HASH,
        }),
      },
    });

    const result = await watcher.handleLog(hookReadyLog());
    const submission = result.submissions[0];
    if (!submission || !submission.dryRun) {
      throw new Error('expected a dry-run submission');
    }
    expect(submission.request.args[6]).toMatchObject({
      sourceId: SLOT_A_SOURCE_ID,
      signalId: EXEC_MAIN_CMP_ID,
      stageId: STAGE_ID,
    });
    expect((submission.request.args[6] as { readonly capabilityProof: readonly Hex[] }).capabilityProof.length)
      .toBeGreaterThan(0);
  });

  it('keeps out-of-vocabulary signals on the zero-claim encoding even with tables present', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      privateKeyEnv: 'UVP_TEST_PRIVATE_KEY',
      dryRun: true,
      artifact: capabilityArtifact(),
      handlers: {
        'exec.main#START': (event) => ({
          planId: PLAN_ID,
          orderId: event.orderId,
          source: 'someone-else',
          signalName: 'exec.main.cmp',
          payloadHash: PAYLOAD_HASH,
        }),
      },
    });

    const result = await watcher.handleLog(hookReadyLog());
    const submission = result.submissions[0];
    if (!submission || !submission.dryRun) {
      throw new Error('expected a dry-run submission');
    }
    expect(submission.request.args[6]).toEqual({
      sourceId: ZERO_BYTES32_WORD,
      signalId: ZERO_BYTES32_WORD,
      stageId: ZERO_BYTES32_WORD,
      capabilityProof: [],
    });
  });

  it('attaches derived proofs to handler-context submissions too', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      privateKeyEnv: 'UVP_TEST_PRIVATE_KEY',
      dryRun: true,
      artifact: capabilityArtifact(),
      handlers: {
        'exec.main#START': async (event, context) => {
          await context.submitSignal({
            planId: PLAN_ID,
            orderId: event.orderId,
            source: 'slot-a',
            signalName: 'exec.main.cmp',
            payloadHash: PAYLOAD_HASH,
          });
        },
      },
    });

    const result = await watcher.handleLog(hookReadyLog());
    expect(result.submissions).toHaveLength(0);
    const recorded = result.job?.submissions?.[0]?.request;
    expect(recorded?.functionName).toBe('submitSignal');
    expect(recorded?.args[6]).toMatchObject({
      sourceId: SLOT_A_SOURCE_ID,
      signalId: EXEC_MAIN_CMP_ID,
      stageId: STAGE_ID,
    });
  });

  it('polls with an injected public client instead of a real network', async () => {
    const getLogsCalls: unknown[] = [];
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      fromBlock: 10,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: {
        '*': (event) => ({
          planId: PLAN_ID,
          orderId: event.orderId,
          source: 'slot-a',
          signalName: 'exec.main.cmp',
          payloadHash: PAYLOAD_HASH,
        }),
      },
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 12n;
        },
        async getLogs(args) {
          getLogsCalls.push(args);
          return [hookReadyLog()];
        },
      },
    });

    const poll = await watcher.pollOnce();

    expect(poll.fromBlock).toBe(10n);
    expect(poll.toBlock).toBe(11n);
    expect(poll.scannedLogs).toBe(1);
    expect(poll.results[0]?.status).toBe('handled');
    expect(poll.results[0]?.job?.status).toBe('matched');
    expect(getLogsCalls).toEqual([
      {
        address: STATE_MACHINE,
        fromBlock: 10n,
        toBlock: 11n,
      },
    ]);
  });

  it('bounds how many chunked getLogs requests are in flight during deep catch-up', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      fromBlock: 1,
      confirmations: 0,
      getLogsBlockSpan: 1,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: { '*': () => undefined },
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 12n;
        },
        async getLogs() {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight -= 1;
          return [];
        },
      },
    });

    const poll = await watcher.pollOnce();

    expect(poll.fromBlock).toBe(1n);
    expect(poll.toBlock).toBe(12n);
    expect(poll.scannedLogs).toBe(0);
    expect(maxInFlight).toBe(DEFAULT_GET_LOGS_CONCURRENCY);
  });

  it('fails the catch-up round on the first getLogs rejection without scheduling the rest', async () => {
    let started = 0;
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      fromBlock: 1,
      confirmations: 0,
      getLogsBlockSpan: 1,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: { '*': () => undefined },
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 12n;
        },
        async getLogs() {
          started += 1;
          await new Promise((resolve) => setTimeout(resolve, 1));
          throw new Error('getLogs rejected');
        },
      },
    });

    await expect(watcher.pollOnce()).rejects.toThrow(/getLogs rejected/);
    expect(started).toBe(DEFAULT_GET_LOGS_CONCURRENCY);
  });

  it('polls all configured state machines and sends callbacks to the emitting contract', async () => {
    const getLogsCalls: unknown[] = [];
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      stateMachines: [
        { stateMachineAddress: STATE_MACHINE, status: 'deprecated' },
        { stateMachineAddress: STATE_MACHINE_V2, status: 'active' },
      ],
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      fromBlock: 10,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: {
        '*': (event) => ({
          planId: PLAN_ID,
          orderId: event.orderId,
          source: 'slot-a',
          signalName: 'exec.main.cmp',
          payloadHash: PAYLOAD_HASH,
        }),
      },
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 12n;
        },
        async getLogs(args) {
          getLogsCalls.push(args);
          return [hookReadyLog(args.address)];
        },
      },
    });

    const poll = await watcher.pollOnce();
    const requests = poll.results.map((result) => result.submissions[0]?.dryRun ? result.submissions[0].request : undefined);

    expect(poll.scannedLogs).toBe(2);
    expect(getLogsCalls).toEqual([
      { address: STATE_MACHINE, fromBlock: 10n, toBlock: 11n },
      { address: STATE_MACHINE_V2, fromBlock: 10n, toBlock: 11n },
    ]);
    expect(poll.results.map((result) => result.event?.stateMachineAddress)).toEqual([STATE_MACHINE, STATE_MACHINE_V2]);
    expect(poll.results[0]?.job?.id).not.toBe(poll.results[1]?.job?.id);
    expect(requests.map((request) => request?.address)).toEqual([STATE_MACHINE, STATE_MACHINE_V2]);
  });

  it('persists the scan cursor and resumes from it after a restart instead of rescanning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-watcher-cursor-'));
    const stateDir = join(dir, 'state');
    try {
      const getLogsCalls: unknown[] = [];
      let headBlock = 13n;
      const buildWatcher = () => createStateMachineWatcher({
        rpcUrl: 'http://127.0.0.1:8545',
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        walletAddress: WALLET_ADDRESS,
        fromBlock: 10,
        dryRun: true,
        artifact: artifactIndex(),
        handlers: {
          '*': (event) => ({
            planId: PLAN_ID,
            orderId: event.orderId,
            source: 'slot-a',
            signalName: 'exec.main.cmp',
            payloadHash: PAYLOAD_HASH,
          }),
        },
        jobStore: new FileStateMachineJobStore(join(stateDir, 'jobs.json')),
        cursorStore: new FileStateMachineCursorStore(join(stateDir, 'cursor.json')),
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return headBlock;
          },
          async getLogs(args) {
            getLogsCalls.push(args);
            return args.fromBlock <= 12n && args.toBlock >= 12n ? [hookReadyLog()] : [];
          },
        },
      });

      const first = buildWatcher();
      const firstPoll = await first.pollOnce();
      expect(firstPoll.fromBlock).toBe(10n);
      expect(firstPoll.toBlock).toBe(12n);
      expect(firstPoll.scannedLogs).toBe(1);
      expect(first.describe().nextBlock).toBe('13');
      expect(first.describe().cursorStore).toBe('file');
      expect(first.describe().jobStore).toBe('file');
      const storedCursor = JSON.parse(
        await readFile(join(stateDir, 'cursor.json'), 'utf8'),
      ) as { version?: number; nextBlock?: string; chainId?: number; stateMachines?: string[] };
      expect(storedCursor).toMatchObject({
        version: 2,
        nextBlock: '13',
        chainId: 31_337,
        stateMachines: [STATE_MACHINE.toLowerCase()],
      });

      headBlock = 15n;
      const restarted = buildWatcher();
      const secondPoll = await restarted.pollOnce();
      expect(secondPoll.fromBlock).toBe(13n);
      expect(secondPoll.toBlock).toBe(14n);
      expect(secondPoll.scannedLogs).toBe(0);
      expect(getLogsCalls).toEqual([
        { address: STATE_MACHINE, fromBlock: 10n, toBlock: 12n },
        { address: STATE_MACHINE, fromBlock: 13n, toBlock: 14n },
      ]);
      const jobs = await restarted.config.jobStore.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.status).toBe('matched');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('alerts on and discards a persisted cursor bound to a different chain, machine set, or genesis', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-watcher-cursor-ctx-'));
    try {
      const cursorFile = join(dir, 'cursor.json');
      const store = new FileStateMachineCursorStore(cursorFile);
      await store.save({ nextBlock: 40n }, { chainId: 31_337, stateMachines: [STATE_MACHINE.toLowerCase()] });
      const noLogsClient = (chainId: number): StateMachinePublicClient => ({
        async getChainId() {
          return chainId;
        },
        async getBlockNumber() {
          return 12n;
        },
        async getLogs() {
          return [];
        },
      });

      const differentChain = createStateMachineWatcher({
        rpcUrl: 'http://127.0.0.1:8545',
        stateMachineAddress: STATE_MACHINE,
        chainId: 1,
        walletAddress: WALLET_ADDRESS,
        fromBlock: 10,
        dryRun: true,
        handlers: { '*': () => undefined },
        cursorStore: new FileStateMachineCursorStore(cursorFile),
        publicClient: noLogsClient(1),
      });
      expect((await differentChain.pollOnce()).fromBlock).toBe(10n);

      const differentMachine = createStateMachineWatcher({
        rpcUrl: 'http://127.0.0.1:8545',
        stateMachineAddress: STATE_MACHINE_V2,
        chainId: 31_337,
        walletAddress: WALLET_ADDRESS,
        fromBlock: 10,
        dryRun: true,
        handlers: { '*': () => undefined },
        cursorStore: new FileStateMachineCursorStore(cursorFile),
        publicClient: noLogsClient(31_337),
      });
      expect((await differentMachine.pollOnce()).fromBlock).toBe(10n);

      const resumed = createStateMachineWatcher({
        rpcUrl: 'http://127.0.0.1:8545',
        stateMachineAddress: STATE_MACHINE_V2,
        chainId: 31_337,
        walletAddress: WALLET_ADDRESS,
        fromBlock: 10,
        dryRun: true,
        handlers: { '*': () => undefined },
        cursorStore: new FileStateMachineCursorStore(cursorFile),
        publicClient: noLogsClient(31_337),
      });
      expect((await resumed.pollOnce()).fromBlock).toBe(12n);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resets and alerts when the chain genesis hash changes under the same chain id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-watcher-cursor-genesis-'));
    const errors: unknown[] = [];
    try {
      const cursorFile = join(dir, 'cursor.json');
      const genesisA = `0x${'aa'.repeat(32)}`;
      const genesisB = `0x${'bb'.repeat(32)}`;
      const clientWith = (genesis: string, head: bigint): StateMachinePublicClient => ({
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return head;
        },
        async getLogs() {
          return [];
        },
        async getBlock(args: { readonly blockNumber: bigint }) {
          if (args.blockNumber === 0n) {
            return { hash: genesis };
          }
          return { hash: `0x${(Number(args.blockNumber) + 1).toString(16).padStart(64, '0')}` };
        },
      });

      const first = createStateMachineWatcher({
        rpcUrl: 'http://127.0.0.1:8545',
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        walletAddress: WALLET_ADDRESS,
        fromBlock: 10,
        dryRun: true,
        handlers: { '*': () => undefined },
        cursorStore: new FileStateMachineCursorStore(cursorFile),
        publicClient: clientWith(genesisA, 30n),
      });
      await first.pollOnce();
      const stored = JSON.parse(await readFile(cursorFile, 'utf8')) as { genesisHash?: string; nextBlock?: string };
      expect(stored).toMatchObject({ genesisHash: genesisA, nextBlock: '30' });

      const reset = createStateMachineWatcher({
        rpcUrl: 'http://127.0.0.1:8545',
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        walletAddress: WALLET_ADDRESS,
        fromBlock: 10,
        dryRun: true,
        handlers: { '*': () => undefined },
        onError: (error) => {
          errors.push(error);
        },
        cursorStore: new FileStateMachineCursorStore(cursorFile),
        publicClient: clientWith(genesisB, 12n),
      });
      const poll = await reset.pollOnce();
      expect(poll.fromBlock).toBe(10n);
      expect(poll.toBlock).toBe(11n);
      expect(errors).toHaveLength(1);
      expect(String(errors[0])).toContain('genesis hash changed');
      const after = JSON.parse(await readFile(cursorFile, 'utf8')) as { genesisHash?: string; nextBlock?: string };
      expect(after).toMatchObject({ genesisHash: genesisB, nextBlock: '12' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a degraded genesis identity loudly instead of silently skipping the cursor chain check', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-watcher-cursor-genesis-loud-'));
    const errors: string[] = [];
    try {
      const cursorFile = join(dir, 'cursor.json');
      const genesis = `0x${'cc'.repeat(32)}`;
      let genesisReadable = false;
      let headBlock = 30n;
      const client: StateMachinePublicClient = {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return headBlock;
        },
        async getLogs() {
          return [];
        },
        async getBlock(args: { readonly blockNumber: bigint }) {
          if (args.blockNumber === 0n) {
            if (!genesisReadable) {
              throw new Error('block 0 pruned');
            }
            return { hash: genesis };
          }
          return { hash: `0x${(Number(args.blockNumber) + 1).toString(16).padStart(64, '0')}` };
        },
      };
      const buildWatcher = () => createStateMachineWatcher({
        rpcUrl: 'http://127.0.0.1:8545',
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        walletAddress: WALLET_ADDRESS,
        fromBlock: 10,
        dryRun: true,
        handlers: { '*': () => undefined },
        onError: (error) => {
          errors.push(String(error));
        },
        cursorStore: new FileStateMachineCursorStore(cursorFile),
        publicClient: client,
      });

      await new FileStateMachineCursorStore(cursorFile).save(
        { nextBlock: 22n },
        { chainId: 31_337, stateMachines: [STATE_MACHINE.toLowerCase()], genesisHash: genesis },
      );

      const degraded = buildWatcher();
      const degradedPoll = await degraded.pollOnce();
      expect(degradedPoll.fromBlock).toBe(22n);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('chain genesis hash could not be read');
      expect(errors[0]).toContain('degraded for 1 poll round');
      expect(degraded.describe()).toMatchObject({ genesisIdentity: 'unknown', genesisIdentityUnknownRounds: 1 });
      const eroded = JSON.parse(await readFile(cursorFile, 'utf8')) as { genesisHash?: string };
      expect(eroded.genesisHash).toBeUndefined();

      headBlock = 32n;
      await degraded.pollOnce();
      expect(errors).toHaveLength(2);
      expect(errors[1]).toContain('degraded for 2 poll round');
      expect(degraded.describe()).toMatchObject({ genesisIdentity: 'unknown', genesisIdentityUnknownRounds: 2 });

      genesisReadable = true;
      headBlock = 34n;
      const healedPoll = await degraded.pollOnce();
      expect(healedPoll.fromBlock).toBe(32n);
      expect(errors).toHaveLength(3);
      expect(errors[2]).toContain('readable again after 2 degraded poll round');
      expect(degraded.describe()).toMatchObject({ genesisIdentity: 'bound', genesisIdentityUnknownRounds: 0 });
      const rebound = JSON.parse(await readFile(cursorFile, 'utf8')) as { genesisHash?: string };
      expect(rebound.genesisHash).toBe(genesis);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the scan cursor in process memory when no cursor store is configured', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      fromBlock: 10,
      dryRun: true,
      handlers: { '*': () => undefined },
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 12n;
        },
        async getLogs() {
          return [];
        },
      },
    });

    expect(watcher.describe().cursorStore).toBe('memory');
    expect(watcher.describe().jobStore).toBe('memory');
    await watcher.pollOnce();
    expect(watcher.describe().nextBlock).toBe('12');
  });

  it('reports a failed cursor save as a failed round instead of pretending it was persisted', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      fromBlock: 10,
      dryRun: true,
      handlers: { '*': () => undefined },
      cursorStore: {
        kind: 'failing',
        async load() {
          return { status: 'empty' } as const;
        },
        async save() {
          throw new Error('disk full');
        },
      },
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 12n;
        },
        async getLogs() {
          return [];
        },
      },
    });

    await expect(watcher.pollOnce()).rejects.toThrow('disk full');
    expect(watcher.describe().nextBlock).toBe('10');
  });

  it('round-trips cursor state through the file cursor store and quarantines corrupt state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-cursor-store-'));
    const cursorFile = join(dir, 'nested', 'cursor.json');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const store = new FileStateMachineCursorStore(cursorFile);
      expect(await store.load({ chainId: 31_337, stateMachines: [STATE_MACHINE] })).toEqual({ status: 'empty' });

      await store.save({ nextBlock: 4_194_304n }, { chainId: 31_337, stateMachines: [STATE_MACHINE.toLowerCase()] });
      expect(await store.load({ chainId: 31_337, stateMachines: [STATE_MACHINE] })).toEqual({
        status: 'restored',
        nextBlock: 4_194_304n,
      });

      await expect(store.load({ chainId: 1, stateMachines: [STATE_MACHINE] })).resolves.toEqual({ status: 'foreign', reason: 'context' });
      await expect(store.load({ chainId: 31_337, stateMachines: [STATE_MACHINE_V2] })).resolves.toEqual({ status: 'foreign', reason: 'context' });

      await writeFile(cursorFile, '{not json', 'utf8');
      await expect(store.load({ chainId: 31_337, stateMachines: [STATE_MACHINE] }))
        .resolves.toEqual({ status: 'empty' });
      const quarantined = (await readdir(dirname(cursorFile))).filter((name) => name.startsWith('cursor.json.corrupt-'));
      expect(quarantined).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('was unreadable'));

      await writeFile(cursorFile, JSON.stringify({
        version: 2,
        nextBlock: '-3',
        chainId: 31_337,
        stateMachines: [STATE_MACHINE.toLowerCase()],
      }), 'utf8');
      await expect(store.load({ chainId: 31_337, stateMachines: [STATE_MACHINE] }))
        .resolves.toEqual({ status: 'empty' });

      await expect(store.save({ nextBlock: -1n }, { chainId: 31_337, stateMachines: [STATE_MACHINE] }))
        .rejects.toThrow(ValidationError);
      expect(() => new FileStateMachineCursorStore(' ')).toThrow(ValidationError);
    } finally {
      errorSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recovers a truncated jobs file by quarantining it instead of aborting every read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-jobs-store-corrupt-'));
    const jobsFile = join(dir, 'jobs.json');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const store = new FileStateMachineJobStore(jobsFile);
      const event = decodeHookReadyLog(hookReadyLog(), artifactIndex())!;
      await store.upsertDetected(event, { now: '2026-04-28T00:00:00.000Z', maxAttempts: 3 });
      expect((await store.list())).toHaveLength(1);

      const healthy = await readFile(jobsFile, 'utf8');
      await writeFile(jobsFile, healthy.slice(0, Math.floor(healthy.length / 2)), 'utf8');

      const jobs = await store.list();
      expect(jobs).toHaveLength(0);
      const quarantined = (await readdir(dir)).filter((name) => name.startsWith('jobs.json.corrupt-'));
      expect(quarantined).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('was unreadable'));

      const recreated = await store.upsertDetected(event, { now: '2026-04-28T00:00:01.000Z', maxAttempts: 3 });
      expect(recreated.status).toBe('detected');
      expect((await store.list())).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips and counts a log that cannot be normalized instead of aborting the round', async () => {
    const errors: unknown[] = [];
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      fromBlock: 10,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: {
        '*': (event) => ({
          planId: PLAN_ID,
          orderId: event.orderId,
          source: 'slot-a',
          signalName: 'exec.main.cmp',
          payloadHash: PAYLOAD_HASH,
        }),
      },
      onError: (error) => {
        errors.push(error);
      },
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 12n;
        },
        async getLogs() {
          return [
            { ...hookReadyLog(), logIndex: -1 },
            hookReadyLog(),
          ];
        },
      },
    });

    const poll = await watcher.pollOnce();

    expect(poll.decodeFailures).toBe(1);
    expect(poll.results[0]?.status).toBe('ignored');
    expect(poll.results[0]?.decodeFailure).toBe(true);
    expect(poll.results[0]?.error?.kind).toBe('validation_failure');
    expect(poll.results[0]?.job).toBeUndefined();
    expect(poll.results[1]?.status).toBe('handled');
    expect(errors).toHaveLength(1);
    expect(watcher.describe().nextBlock).toBe('12');
    expect(watcher.describe().decodeFailures).toBe(1);
  });

  it('isolates an undecodable HookReady log as a persisted ignored job with the raw log preserved', async () => {
    const broken = { ...hookReadyLog(), data: '0xdeadbeef' as Hex };
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: {
        '*': () => {
          throw new Error('isolated log must not reach a handler');
        },
      },
    });

    const first = await watcher.handleLog(broken);
    const second = await watcher.handleLog(broken);

    expect(first.status).toBe('ignored');
    expect(first.decodeFailure).toBe(true);
    expect(first.error?.kind).toBe('validation_failure');
    expect(first.error?.message).toContain('failed to decode HookReady log data');
    expect(first.job?.status).toBe('ignored');
    expect(first.job?.orderId).toBe(`0x${'00'.repeat(32)}`);
    expect(first.job?.raw).toEqual(broken);
    expect(second.job?.id).toBe(first.job?.id);
    expect(second.job?.status).toBe('ignored');
    expect(await watcher.config.jobStore.list()).toHaveLength(1);
  });

  it('keeps watching when every round re-scans the same undecodable log', async () => {
    let polls = 0;
    let aborted = false;
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      fromBlock: 10,
      dryRun: true,
      handlers: {
        '*': () => undefined,
      },
      pollIntervalMs: 1,
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 12n + BigInt(polls);
        },
        async getLogs() {
          polls += 1;
          return [{ ...hookReadyLog(), data: '0xdeadbeef' as Hex }];
        },
      },
    });

    const handle = await watcher.start();
    void handle.done.catch(() => {
      aborted = true;
    });

    const deadline = Date.now() + 500;
    while (polls < 12 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(polls).toBeGreaterThanOrEqual(12);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(aborted).toBe(false);

    const jobs = await watcher.config.jobStore.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('ignored');
    const described = watcher.describe() as { decodeFailures?: number };
    expect(described.decodeFailures).toBeGreaterThanOrEqual(12);

    await handle.stop();
  });

  it('keeps the first-round fail-fast behavior when the initial poll fails', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      handlers: {
        '*': () => undefined,
      },
      pollIntervalMs: 1,
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 12n;
        },
        async getLogs() {
          throw new Error('rpc down');
        },
      },
    });

    await expect(watcher.start()).rejects.toThrow('rpc down');
  });

  it('keeps the watch loop alive with backed-off retries when every poll keeps failing', async () => {
    const errors: unknown[] = [];
    let polls = 0;
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      handlers: {
        '*': () => undefined,
      },
      pollIntervalMs: 1,
      onError: (error) => {
        errors.push(error);
      },
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          polls += 1;
          if (polls === 1) {
            return 12n;
          }
          throw new Error(`rpc down ${polls}`);
        },
        async getLogs() {
          return [];
        },
      },
    });

    const handle = await watcher.start();
    let rejected: unknown = undefined;
    void handle.done.catch((error: unknown) => {
      rejected = error;
    });

    const deadline = Date.now() + 300;
    while (polls < 10 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(polls).toBeGreaterThanOrEqual(10);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(polls).toBeGreaterThan(10);
    expect(errors.length).toBe(polls - 1);
    expect(rejected).toBeUndefined();

    await handle.stop();
  });

  it('chunks deep getLogs ranges instead of issuing one unbounded query', async () => {
    const getLogsCalls: unknown[] = [];
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      fromBlock: 10,
      confirmations: 0,
      getLogsBlockSpan: 10,
      dryRun: true,
      handlers: { '*': () => undefined },
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 35n;
        },
        async getLogs(args) {
          getLogsCalls.push(args);
          return [];
        },
      },
    });

    const poll = await watcher.pollOnce();

    expect(poll.fromBlock).toBe(10n);
    expect(poll.toBlock).toBe(35n);
    expect(getLogsCalls).toEqual([
      { address: STATE_MACHINE, fromBlock: 10n, toBlock: 19n },
      { address: STATE_MACHINE, fromBlock: 20n, toBlock: 29n },
      { address: STATE_MACHINE, fromBlock: 30n, toBlock: 35n },
    ]);
    expect(watcher.describe().getLogsBlockSpan).toBe(10);
  });

  it('keeps watching when a successful round resets the consecutive-failure count', async () => {
    const script = ['ok', 'fail', 'fail', 'ok', 'fail', 'fail', 'ok'] as const;
    let polls = 0;
    let aborted = false;
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      handlers: {
        '*': () => undefined,
      },
      pollIntervalMs: 1,
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          polls += 1;
          const step = script[Math.min(polls - 1, script.length - 1)];
          if (step === 'fail') {
            throw new Error(`rpc down ${polls}`);
          }
          return 12n;
        },
        async getLogs() {
          return [];
        },
      },
    });

    const handle = await watcher.start();
    void handle.done.catch(() => {
      aborted = true;
    });

    const deadline = Date.now() + 2_000;
    while (polls < script.length + 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(polls).toBeGreaterThanOrEqual(script.length + 2);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(aborted).toBe(false);

    await handle.stop();
  });

  it('records ignored jobs for missing handlers and does not process terminal jobs again', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: {},
    });

    const first = await watcher.handleLog(hookReadyLog());
    const second = await watcher.handleLog(hookReadyLog());

    expect(first.status).toBe('ignored');
    expect(first.job?.status).toBe('ignored');
    expect(first.error?.kind).toBe('missing_handler');
    expect(second.status).toBe('ignored');
    expect(second.job?.id).toBe(first.job?.id);
    expect(await watcher.config.jobStore.list()).toHaveLength(1);
  });

  it('reports an unknown stage as a missing-handler job', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: {
        hooksByHookId: {
          [HOOK_ID]: {
            stageIdentifier: 'unknown.stage',
            hookName: 'START',
          },
        },
      },
      handlers: {
        'exec.main#START': () => {
          throw new Error('known stage handler should not run');
        },
      },
    });

    const result = await watcher.handleLog(hookReadyLog());

    expect(result.status).toBe('ignored');
    expect(result.job?.status).toBe('ignored');
    expect(result.error?.kind).toBe('missing_handler');
    expect(result.error?.message).toContain('unknown.stage#START');
  });

  it('dead-letters coded unauthorized jobs without automatic retry', async () => {
    let attempts = 0;
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      retry: { maxAttempts: 3 },
      handlers: {
        '*': () => {
          attempts += 1;
          throw new CodedExecutorKitError('UNAUTHORIZED', 'AccessControlUnauthorizedAccount submitter');
        },
      },
    });

    const result = await watcher.handleLog(hookReadyLog());

    expect(attempts).toBe(1);
    expect(result.job?.status).toBe('dead_letter');
    expect(result.error?.kind).toBe('unauthorized');
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.code).toBe('UNAUTHORIZED');
  });

  it('classifies real revert texts thrown by handlers and dead-letters them without retry', async () => {
    let attempts = 0;
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      retry: { maxAttempts: 3 },
      handlers: {
        '*': () => {
          attempts += 1;
          throw new Error('Call revert exception: execution reverted: SignalAlreadyExists()');
        },
      },
    });

    const result = await watcher.handleLog(hookReadyLog());

    expect(attempts).toBe(1);
    expect(result.status).toBe('handled');
    expect(result.job?.status).toBe('ignored');
    expect(result.error?.kind).toBe('duplicate_signal');
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.code).toBeUndefined();
  });

  it('keeps unclassifiable handler failures conservatively non-retryable in dead_letter', async () => {
    let attempts = 0;
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      retry: { maxAttempts: 3 },
      handlers: {
        '*': () => {
          attempts += 1;
          throw new Error('handler exploded in a way no pattern matches');
        },
      },
    });

    const result = await watcher.handleLog(hookReadyLog());

    expect(attempts).toBe(1);
    expect(result.job?.status).toBe('dead_letter');
    expect(result.error?.kind).toBe('handler_failure');
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.code).toBeUndefined();
  });

  it('retries coded rpc_network handler failures and leaves the job in the retryable failed lane', async () => {
    let attempts = 0;
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      retry: { maxAttempts: 2 },
      handlers: {
        '*': () => {
          attempts += 1;
          throw new CodedExecutorKitError('RPC_NETWORK', 'fetch failed ECONNRESET');
        },
      },
    });

    const result = await watcher.handleLog(hookReadyLog());

    expect(attempts).toBe(2);
    expect(result.job?.status).toBe('failed');
    expect(result.error?.kind).toBe('rpc_network');
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('RPC_NETWORK');
  });

  it('counts only real failures in attempts so completed dry-run multi-signal jobs stay retryable', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      retry: { maxAttempts: 3, baseDelayMs: 0 },
      handlers: {
        '*': (event) => ([
          { planId: PLAN_ID, orderId: event.orderId, source: 'slot-a', signalName: 'exec.main.cmp' },
          { planId: PLAN_ID, orderId: event.orderId, source: 'slot-b', signalName: 'exec.main.cmp' },
        ]),
      },
    });

    const first = await watcher.handleLog(hookReadyLog());
    expect(first.job?.status).toBe('matched');
    expect(first.job?.attempts).toBe(0);
    expect(first.job?.submissions).toHaveLength(2);

    const jobId = first.job?.id;
    if (!jobId) {
      throw new Error('expected job id');
    }
    const retried = await retryStateMachineJob(watcher, jobId, {
      operator: 'ops@example.com',
      reason: 'flipping dry-run off for the real run',
    });
    expect(retried.error).toBeUndefined();
    expect(retried.job?.status).toBe('matched');
    expect(retried.job?.lastError).toBeUndefined();
  });

  it('re-opens a failed job through the manual retry channel', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: {
        '*': (event) => ({
          planId: PLAN_ID,
          orderId: event.orderId,
          source: 'slot-a',
          signalName: 'exec.main.cmp',
          payloadHash: PAYLOAD_HASH,
        }),
      },
    });
    const initial = await watcher.handleLog(hookReadyLog());
    const jobId = initial.job?.id;
    if (!jobId) {
      throw new Error('expected job id');
    }
    await watcher.config.jobStore.update(jobId, {
      status: 'failed',
      attempts: 1,
      updatedAt: '2026-04-28T00:00:01.000Z',
      lastError: {
        kind: 'rpc_network',
        message: 'fetch failed ECONNRESET',
        retryable: true,
      },
    });

    const retried = await retryStateMachineJob(watcher, jobId, {
      operator: 'ops@example.com',
      reason: 'rpc recovered',
    });
    expect(retried.status).toBe('handled');
    expect(retried.job?.status).toBe('matched');
    expect(retried.job?.lastError).toBeUndefined();
  });

  it('persists jobs, maps DTO status, and supports manual retry/dead-letter audit actions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-state-machine-jobs-'));
    const jobsFile = join(dir, 'jobs.json');
    try {
      const store = new FileStateMachineJobStore(jobsFile);
      const failedWatcher = createStateMachineWatcher({
        rpcUrl: 'http://127.0.0.1:8545',
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        supplierId: 'role-a',
        walletAddress: WALLET_ADDRESS,
        dryRun: true,
        artifact: artifactIndex(),
        retry: { maxAttempts: 2 },
        jobStore: store,
        now: () => '2026-04-28T00:00:00.000Z',
        handlers: {
          '*': () => {
            throw new CodedExecutorKitError('RPC_NETWORK', 'fetch failed ECONNRESET');
          },
        },
      });
      const failed = await failedWatcher.handleLog(hookReadyLog());
      const jobId = failed.job?.id;
      if (!jobId) {
        throw new Error('expected failed job id');
      }

      expect(failed.job?.status).toBe('failed');
      const persistedAfterFailure = await store.get(jobId);
      expect(persistedAfterFailure?.status).toBe('failed');
      expect(persistedAfterFailure?.attempts).toBe(2);

      const overLimit = await retryStateMachineJob(failedWatcher, jobId, {
        operator: 'ops@example.com',
        reason: 'pushing past the attempt budget',
        now: () => '2026-04-28T00:00:30.000Z',
      });
      expect(overLimit.job?.status).toBe('failed');
      expect(overLimit.error?.kind).toBe('rpc_network');
      const persistedAfterOverLimit = await store.get(jobId);
      expect(persistedAfterOverLimit?.manualActions).toEqual([
        {
          action: 'retry',
          operator: 'ops@example.com',
          at: '2026-04-28T00:00:30.000Z',
          reason: 'pushing past the attempt budget',
        },
      ]);

      const deadLetter = await deadLetterStateMachineJob(store, jobId, {
        operator: 'ops@example.com',
        reason: 'manual review required',
        now: () => '2026-04-28T00:02:00.000Z',
      });

      expect(deadLetter.status).toBe('dead_letter');
      expect(deadLetter.lastError?.message).toBe('manual review required');
      expect(deadLetter.manualActions?.map((action) => action.action)).toEqual(['retry', 'dead_letter']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('revives an ignored job back into the scan queue (ignored -> detected -> re-run)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-state-machine-revive-'));
    const jobsFile = join(dir, 'jobs.json');
    try {
      const store = new FileStateMachineJobStore(jobsFile);
      const ignoreWatcher = createStateMachineWatcher({
        rpcUrl: 'http://127.0.0.1:8545',
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        walletAddress: WALLET_ADDRESS,
        dryRun: true,
        artifact: artifactIndex(),
        jobStore: store,
        now: () => '2026-04-28T00:00:00.000Z',
        handlers: {},
      });
      const ignored = await ignoreWatcher.handleLog(hookReadyLog());
      expect(ignored.status).toBe('ignored');
      const jobId = ignored.job?.id;
      if (!jobId) {
        throw new Error('expected ignored job id');
      }

      const revived = await reviveStateMachineJob(store, jobId, {
        operator: 'ops@example.com',
        reason: 'handler now configured',
        now: () => '2026-04-28T00:01:00.000Z',
      });
      expect(revived.status).toBe('detected');
      expect(revived.attempts).toBe(0);
      expect(revived.lastError).toBeUndefined();
      expect(revived.manualActions).toEqual([
        { action: 'revive', operator: 'ops@example.com', at: '2026-04-28T00:01:00.000Z', reason: 'handler now configured' },
      ]);

      await expect(reviveStateMachineJob(store, jobId, {
        operator: 'ops@example.com',
        reason: 'not ignored anymore',
        now: () => '2026-04-28T00:01:30.000Z',
      })).rejects.toThrow(/cannot be revived from status detected/u);

      let effects = 0;
      const runWatcher = createStateMachineWatcher({
        rpcUrl: 'http://127.0.0.1:8545',
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        walletAddress: WALLET_ADDRESS,
        dryRun: true,
        artifact: artifactIndex(),
        jobStore: store,
        fromBlock: 13n,
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 20n;
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
      await runWatcher.pollOnce();
      expect(effects).toBe(1);
      const rerun = await store.get(jobId);
      expect(rerun?.status).toBe('matched');
      expect(rerun?.submissions.length).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('re-opens a confirmed job through the manual retry channel with forced resubmission', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: fakeReceiptClient(31_337, { status: 'success' }),
        artifact: artifactIndex(),
        retry: { maxAttempts: 3, baseDelayMs: 0 },
        handlers: {
          '*': (event) => ({
            planId: PLAN_ID,
            orderId: event.orderId,
            source: 'slot-a',
            signalName: 'exec.main.cmp',
            payloadHash: PAYLOAD_HASH,
          }),
        },
      });
      const event = decodeHookReadyLog(hookReadyLog(), artifactIndex())!;
      const seeded = await watcher.config.jobStore.upsertDetected(event, {
        now: '2026-04-28T00:00:00.000Z',
        maxAttempts: 3,
      });
      await watcher.config.jobStore.update(seeded.id, {
        status: 'confirmed',
        updatedAt: '2026-04-28T00:00:02.000Z',
        submissions: [{ signalIndex: 0, attempt: 1, dryRun: false, txHash: TX_HASH }],
      });

      const recovered = await retryStateMachineJob(watcher, seeded.id, {
        operator: 'ops@example.com',
        reason: 'confirmation reorged away',
        now: () => '2026-04-28T00:00:30.000Z',
      });

      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
      expect(recovered.status).toBe('handled');
      expect(recovered.job?.status).toBe('confirmed');
      expect(recovered.job?.submissions).toHaveLength(2);
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('rolls the scan cursor back to the common ancestor when a reorg flips the cursor block hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-watcher-reorg-'));
    const errors: unknown[] = [];
    const getLogsCalls: unknown[] = [];
    try {
      const cursorFile = join(dir, 'cursor.json');
      let forkedAt: bigint | undefined = undefined;
      const hashAt = (height: bigint): string => `0x${(Number(height) + (forkedAt !== undefined && height >= forkedAt ? 1000 : 0)).toString(16).padStart(64, '0')}`;
      const client: StateMachinePublicClient = {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 20n;
        },
        async getLogs(args) {
          getLogsCalls.push(args);
          return [];
        },
        async getBlock(args: { readonly blockNumber: bigint }) {
          return { hash: args.blockNumber === 0n ? `0x${'aa'.repeat(32)}` : hashAt(args.blockNumber) };
        },
      };
      const buildWatcher = () => createStateMachineWatcher({
        rpcUrl: 'http://127.0.0.1:8545',
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        walletAddress: WALLET_ADDRESS,
        fromBlock: 10,
        dryRun: true,
        handlers: { '*': () => undefined },
        onError: (error: unknown) => {
          errors.push(error);
        },
        cursorStore: new FileStateMachineCursorStore(cursorFile),
        publicClient: client,
      });

      const first = buildWatcher();
      await first.pollOnce();
      const stored = JSON.parse(await readFile(cursorFile, 'utf8')) as { nextBlock?: string; blockHash?: string; checkpoints?: Array<{ blockNumber: string }> };
      expect(stored).toMatchObject({ nextBlock: '20' });
      expect(stored.checkpoints?.map((checkpoint) => checkpoint.blockNumber)).toEqual(['12', '16', '18', '19']);

      forkedAt = 18n;
      errors.length = 0;
      const second = buildWatcher();
      const poll = await second.pollOnce();

      expect(errors).toHaveLength(1);
      expect(String(errors[0])).toContain('rolling the scan cursor back');
      expect(getLogsCalls.at(-1)).toMatchObject({ fromBlock: 17n, toBlock: 19n });
      expect(poll.fromBlock).toBe(17n);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps unconfirmed submissions non-terminal so rescans and retries can still observe them', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      retry: { maxAttempts: 12 },
      handlers: {
        '*': (event) => ({
          planId: PLAN_ID,
          orderId: event.orderId,
          source: 'slot-a',
          signalName: 'exec.main.cmp',
          payloadHash: PAYLOAD_HASH,
        }),
      },
    });
    const first = await watcher.handleLog(hookReadyLog());
    const jobId = first.job?.id;
    if (!jobId) {
      throw new Error('expected job id');
    }
    await watcher.config.jobStore.update(jobId, {
      status: 'submitted',
      updatedAt: '2026-04-28T00:00:02.000Z',
    });

    const rescan = await watcher.handleLog(hookReadyLog());
    expect(rescan.status).toBe('handled');
    expect(rescan.job?.id).toBe(jobId);

    const retried = await retryStateMachineJob(watcher, jobId, {
      operator: 'ops@example.com',
      reason: 'receipt never observed',
    });
    expect(retried.status).toBe('handled');
    expect(retried.job?.status).toBe('matched');
  });

  it('throttles rebroadcasts of unconfirmed signals with capped exponential backoff', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      const anchorAt = Date.parse('2026-04-28T00:00:00.000Z');
      let clockMs = anchorAt;
      const buildWatcher = () => {
        clockMs = anchorAt;
        return createStateMachineWatcher({
          rpcUrl: stub.url,
          stateMachineAddress: STATE_MACHINE,
          chainId: 31_337,
          privateKeyEnv: KEY_ENV,
          publicClient: fakeReceiptClient(31_337, { status: 'success' }),
          artifact: artifactIndex(),
          retry: { maxAttempts: 3, baseDelayMs: 0 },
          resendBackoff: { baseDelayMs: 30_000, maxDelayMs: 60_000 },
          now: () => new Date(clockMs).toISOString(),
          nowMs: () => clockMs,
          handlers: {
            '*': (event) => ({
              planId: PLAN_ID,
              orderId: event.orderId,
              source: 'slot-a',
              signalName: 'exec.main.cmp',
              payloadHash: PAYLOAD_HASH,
            }),
          },
        });
      };

      const watcher = buildWatcher();
      const event = decodeHookReadyLog(hookReadyLog(), artifactIndex())!;
      const seeded = await watcher.config.jobStore.upsertDetected(event, {
        now: '2026-04-28T00:00:00.000Z',
        maxAttempts: 3,
      });
      await watcher.config.jobStore.update(seeded.id, {
        status: 'submitted',
        updatedAt: '2026-04-28T00:00:00.000Z',
        lastSignalAttemptAt: '2026-04-28T00:00:00.000Z',
        submissions: [
          {
            signalIndex: 0,
            attempt: 1,
            dryRun: false,
            txHash: TX_HASH,
            request: seedRequest('slot-a', PAYLOAD_HASH),
            error: { kind: 'rpc_network', message: 'Request timed out.', retryable: true },
          },
        ],
      });

      clockMs = anchorAt + 1_000;
      const deferred = await watcher.handleLog(hookReadyLog());
      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(0);
      expect(deferred.job?.status).toBe('submitted');

      clockMs = anchorAt + 30_001;
      const resent = await watcher.handleLog(hookReadyLog());
      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
      expect(resent.job?.status).toBe('confirmed');

      await watcher.config.jobStore.update(seeded.id, {
        status: 'submitted',
        updatedAt: '2026-04-28T00:01:00.000Z',
        submissions: [1, 2, 3, 4].map((attempt) => ({
          signalIndex: 0,
          attempt,
          dryRun: false,
          txHash: TX_HASH,
          request: seedRequest('slot-a', PAYLOAD_HASH),
          error: { kind: 'rpc_network', message: 'Request timed out.', retryable: true } as const,
        })),
      });
      clockMs = anchorAt + 60_001;
      const manual = await retryStateMachineJob(watcher, seeded.id, {
        operator: 'ops@example.com',
        now: () => new Date(clockMs).toISOString(),
      });
      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(2);
      expect(manual.job?.status).toBe('confirmed');
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('caps the resend backoff so a long-unconfirmed signal is never starved', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      const anchorAt = Date.parse('2026-04-28T00:00:00.000Z');
      const clockMs = anchorAt + 60_001;
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: fakeReceiptClient(31_337, { status: 'success' }),
        artifact: artifactIndex(),
        retry: { maxAttempts: 3, baseDelayMs: 0 },
        resendBackoff: { baseDelayMs: 30_000, maxDelayMs: 60_000 },
        now: () => new Date(clockMs).toISOString(),
        nowMs: () => clockMs,
        handlers: {
          '*': (event) => ({
            planId: PLAN_ID,
            orderId: event.orderId,
            source: 'slot-a',
            signalName: 'exec.main.cmp',
            payloadHash: PAYLOAD_HASH,
          }),
        },
      });
      const event = decodeHookReadyLog(hookReadyLog(), artifactIndex())!;
      const seeded = await watcher.config.jobStore.upsertDetected(event, {
        now: '2026-04-28T00:00:00.000Z',
        maxAttempts: 3,
      });
      await watcher.config.jobStore.update(seeded.id, {
        status: 'submitted',
        updatedAt: '2026-04-28T00:00:00.000Z',
        lastSignalAttemptAt: '2026-04-28T00:00:00.000Z',
        submissions: [1, 2, 3, 4].map((attempt) => ({
          signalIndex: 0,
          attempt,
          dryRun: false,
          txHash: TX_HASH,
          request: seedRequest('slot-a', PAYLOAD_HASH),
          error: { kind: 'rpc_network', message: 'Request timed out.', retryable: true } as const,
        })),
      });

      const result = await watcher.handleLog(hookReadyLog());
      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
      expect(result.job?.status).toBe('confirmed');
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('resumes a partially delivered multi-signal job from the next pending signal instead of replaying', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 12n;
          },
          async getLogs() {
            return [];
          },
          async waitForTransactionReceipt() {
            return { status: 'success' };
          },
          async getTransactionReceipt() {
            return { status: 'success' };
          },
        },
        artifact: artifactIndex(),
        retry: { maxAttempts: 3, baseDelayMs: 0 },
        handlers: {
          '*': (event) => ([
            { planId: PLAN_ID, orderId: event.orderId, source: 'slot-a', signalName: 'exec.main.cmp' },
            { planId: PLAN_ID, orderId: event.orderId, source: 'slot-b', signalName: 'exec.main.cmp' },
          ]),
        },
      });

      const event = decodeHookReadyLog(hookReadyLog(), artifactIndex())!;
      const seeded = await watcher.config.jobStore.upsertDetected(event, {
        now: '2026-04-28T00:00:00.000Z',
        maxAttempts: 3,
      });
      await watcher.config.jobStore.update(seeded.id, {
        status: 'failed',
        updatedAt: '2026-04-28T00:00:01.000Z',
        attempts: 3,
        submissions: [
          { signalIndex: 0, attempt: 1, dryRun: false, txHash: TX_HASH, request: seedRequest('slot-a') },
          {
            signalIndex: 1,
            attempt: 3,
            request: seedRequest('slot-b'),
            error: { kind: 'rpc_network', message: 'fetch failed', retryable: true },
          },
        ],
        lastError: { kind: 'rpc_network', message: 'fetch failed', retryable: true },
      });

      const result = await retryStateMachineJob(watcher, seeded.id, {
        operator: 'ops@example.com',
        reason: 'rpc recovered',
      });

      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
      expect(result.status).toBe('handled');
      expect(result.job?.status).toBe('confirmed');
      expect(result.job?.lastError).toBeUndefined();
      const submissions = result.job?.submissions ?? [];
      expect(submissions).toHaveLength(4);
      expect(submissions[2]).toMatchObject({ signalIndex: 0, dryRun: false, txHash: TX_HASH, confirmed: true });
      expect(submissions[3]).toMatchObject({ signalIndex: 1, dryRun: false, txHash: TX_HASH, confirmed: true });
      expect(submissions[3]?.error).toBeUndefined();
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('treats a duplicate signal on resume as delivered and keeps later signals progressing', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub({
      estimateGasError: { code: 3, message: 'execution reverted: SignalAlreadyExists()', times: 1 },
    });
    try {
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: fakeReceiptClient(31_337, { status: 'success' }),
        artifact: artifactIndex(),
        retry: { maxAttempts: 3, baseDelayMs: 0 },
        handlers: {
          '*': (event) => ([
            { planId: PLAN_ID, orderId: event.orderId, source: 'slot-a', signalName: 'exec.main.cmp' },
            { planId: PLAN_ID, orderId: event.orderId, source: 'slot-b', signalName: 'exec.main.cmp' },
          ]),
        },
      });

      const result = await watcher.handleLog(hookReadyLog());

      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
      expect(result.status).toBe('handled');
      expect(result.job?.status).toBe('confirmed');
      const submissions = result.job?.submissions ?? [];
      expect(submissions[0]?.error?.kind).toBe('duplicate_signal');
      expect(submissions[0]?.signalIndex).toBe(0);
      expect(submissions[1]).toMatchObject({ signalIndex: 1, dryRun: false, txHash: TX_HASH });
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('reconciles an incremental retry return set by content identity instead of slot inheritance', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub({
      sendRawTransactionErrors: [2, 3, 4],
    });
    try {
      let pendingOnly = false;
      const slotASignal = (orderId: Hex) => ({
        planId: PLAN_ID, orderId, source: 'slot-a', signalName: 'exec.main.cmp', payloadHash: PAYLOAD_HASH,
      });
      const slotBSignal = (orderId: Hex) => ({
        planId: PLAN_ID, orderId, source: 'slot-b', signalName: 'exec.main.cmp', payloadHash: PAYLOAD_HASH,
      });
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: fakeReceiptClient(31_337, { status: 'success' }),
        artifact: artifactIndex(),
        retry: { maxAttempts: 3, baseDelayMs: 0 },
        handlers: {
          '*': (event) => pendingOnly
            ? [slotBSignal(event.orderId)]
            : [slotASignal(event.orderId), slotBSignal(event.orderId)],
        },
      });

      const first = await watcher.handleLog(hookReadyLog());
      expect(first.job?.status).toBe('failed');
      const sendsAfterRun1 = stub.methods.filter((method) => method === 'eth_sendRawTransaction').length;

      pendingOnly = true;
      const retried = await retryStateMachineJob(watcher, first.job!.id, { operator: 'ops@example.com' });

      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction').length).toBe(sendsAfterRun1 + 1);
      expect(retried.status).toBe('handled');
      expect(retried.job?.status).toBe('confirmed');
      expect(retried.submissions).toHaveLength(1);
      const slotBIdentity = seedRequest('slot-b', PAYLOAD_HASH).data;
      expect(retried.submissions[0]?.request.data).toBe(slotBIdentity);
      const slotBDelivered = (retried.job?.submissions ?? []).filter(
        (submission) => submission.request?.data === slotBIdentity && submission.confirmed === true);
      expect(slotBDelivered).toHaveLength(1);
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('refuses to retry an attempts-exhausted submitted job instead of dead-lettering it', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      retry: { maxAttempts: 2 },
      handlers: {
        '*': (event) => ({
          planId: PLAN_ID,
          orderId: event.orderId,
          source: 'slot-a',
          signalName: 'exec.main.cmp',
          payloadHash: PAYLOAD_HASH,
        }),
      },
    });
    const result = await watcher.handleLog(hookReadyLog());
    const jobId = result.job?.id;
    if (!jobId) {
      throw new Error('expected job id');
    }
    await watcher.config.jobStore.update(jobId, {
      status: 'submitted',
      updatedAt: '2026-04-28T00:00:02.000Z',
      attempts: 2,
    });

    await expect(retryStateMachineJob(watcher, jobId, {
      operator: 'ops@example.com',
    })).rejects.toThrow(/broadcast without a confirmed receipt/);

    const after = await watcher.config.jobStore.get(jobId);
    expect(after?.status).toBe('submitted');
    expect(after?.manualActions).toBeUndefined();
  });

  it('accepts a manual retry for a detected job stranded by a crash', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: {
        '*': (event) => ({
          planId: PLAN_ID,
          orderId: event.orderId,
          source: 'slot-a',
          signalName: 'exec.main.cmp',
          payloadHash: PAYLOAD_HASH,
        }),
      },
    });
    const event = decodeHookReadyLog(hookReadyLog(), artifactIndex())!;
    await watcher.config.jobStore.upsertDetected(event, {
      now: '2026-04-28T00:00:00.000Z',
      maxAttempts: 3,
    });

    const retried = await retryStateMachineJob(watcher, stateMachineJobId(event), {
      operator: 'ops@example.com',
      reason: 'crash left the job detected',
    });
    expect(retried.status).toBe('handled');
    expect(retried.job?.status).toBe('matched');
  });

  it('revisits open jobs behind the cursor on later scans instead of stranding them', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      fromBlock: 20,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: {
        '*': (event) => ({
          planId: PLAN_ID,
          orderId: event.orderId,
          source: 'slot-a',
          signalName: 'exec.main.cmp',
          payloadHash: PAYLOAD_HASH,
        }),
      },
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 22n;
        },
        async getLogs() {
          return [];
        },
      },
    });
    const event = decodeHookReadyLog(hookReadyLog(), artifactIndex())!;
    await watcher.config.jobStore.upsertDetected(event, {
      now: '2026-04-28T00:00:00.000Z',
      maxAttempts: 3,
    });

    const poll = await watcher.pollOnce();

    expect(poll.scannedLogs).toBe(0);
    expect(poll.results).toHaveLength(1);
    expect(poll.results[0]?.status).toBe('handled');
    expect(poll.results[0]?.job?.status).toBe('matched');
    expect(watcher.describe().nextBlock).toBe('22');
  });

  it('does not re-enter a scanned raw without a block number in the same round\'s later-scan pass', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      let handlerRuns = 0;
      const rawWithoutBlock = { ...hookReadyLog(), blockNumber: undefined };
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        waitForReceipt: false,
        fromBlock: 12,
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 20n;
          },
          async getLogs() {
            return [rawWithoutBlock];
          },
          async getTransactionReceipt() {
            return null;
          },
        },
        artifact: artifactIndex(),
        handlers: {
          '*': (event) => {
            handlerRuns += 1;
            return {
              planId: PLAN_ID,
              orderId: event.orderId,
              source: 'slot-a',
              signalName: 'exec.main.cmp',
              payloadHash: PAYLOAD_HASH,
            };
          },
        },
      });

      const poll = await watcher.pollOnce();

      expect(handlerRuns).toBe(1);
      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
      expect(poll.results.filter((result) => result.event !== undefined)).toHaveLength(1);
      expect(poll.results[0]?.job?.status).toBe('submitted');
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('rechecks the receipt of an unconfirmed broadcast when a later scan revisits the job', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      let receipt: { readonly status?: string } | null = null;
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        waitForReceipt: false,
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 12n;
          },
          async getLogs() {
            return [];
          },
          async getTransactionReceipt() {
            return receipt;
          },
        },
        artifact: artifactIndex(),
        handlers: {
          '*': (event) => ({
            planId: PLAN_ID,
            orderId: event.orderId,
            source: 'slot-a',
            signalName: 'exec.main.cmp',
            payloadHash: PAYLOAD_HASH,
          }),
        },
      });

      const first = await watcher.handleLog(hookReadyLog());
      expect(first.job?.status).toBe('submitted');
      expect(first.job?.submissions[0]?.confirmed).toBeUndefined();

      receipt = { status: 'success' };
      const second = await watcher.handleLog(hookReadyLog());
      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
      expect(second.job?.status).toBe('confirmed');
      const submissions = second.job?.submissions ?? [];
      expect(submissions).toHaveLength(2);
      expect(submissions[1]).toMatchObject({ signalIndex: 0, dryRun: false, txHash: TX_HASH, confirmed: true });
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('derives distinct default idempotency keys for distinct sources and stable keys across re-emitted events', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: createStateMachineHandlersFromConfig({
        handlers: {
          '*': {
            signals: [
              { source: 'slot-a', stageIdentifier: 'exec.main', signalName: 'cmp' },
              { source: 'slot-b', stageIdentifier: 'exec.main', signalName: 'cmp' },
            ],
          },
        },
      }),
    });

    const first = await watcher.handleLog(hookReadyLog());
    const keys = first.submissions.map((submission) =>
      submission.dryRun ? submission.request.args[5] : undefined);
    expect(keys[0]).not.toBe(keys[1]);

    const reEmitLog = { ...hookReadyLog(), transactionHash: `0x${'34'.repeat(32)}` as Hex, logIndex: 9 };
    const reEmit = await watcher.handleLog(reEmitLog);
    const reEmitKey = reEmit.submissions[0]?.dryRun ? reEmit.submissions[0].request.args[5] : undefined;
    expect(reEmitKey).toBe(keys[0]);

    const replay = await watcher.handleLog(hookReadyLog());
    expect(replay.submissions).toHaveLength(0);
  });

  it('converges a replayed dry-run job instead of replaying the handler and growing the audit trail', async () => {
    let handlerRuns = 0;
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: {
        '*': (event) => {
          handlerRuns += 1;
          return {
            planId: PLAN_ID,
            orderId: event.orderId,
            source: 'slot-a',
            signalName: 'exec.main.cmp',
            payloadHash: PAYLOAD_HASH,
          };
        },
      },
    });

    const first = await watcher.handleLog(hookReadyLog());
    expect(first.job?.status).toBe('matched');
    expect(first.job?.submissions).toHaveLength(1);
    expect(handlerRuns).toBe(1);

    const replay = await watcher.handleLog(hookReadyLog());
    expect(replay.status).toBe('ignored');
    expect(handlerRuns).toBe(1);
    expect(replay.job?.submissions).toHaveLength(1);

    const jobId = first.job?.id;
    if (!jobId) {
      throw new Error('expected job id');
    }
    const retried = await retryStateMachineJob(watcher, jobId, { operator: 'ops@example.com' });
    expect(handlerRuns).toBe(2);
    expect(retried.job?.submissions).toHaveLength(1);
  });

  it('converges a real-mode void-handler job to terminal completed and never re-runs it', async () => {
    let handlerRuns = 0;
    const store = new InMemoryStateMachineJobStore();
    const buildWatcher = (extra: Record<string, unknown> = {}) => createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      jobStore: store,
      artifact: artifactIndex(),
      handlers: {
        '*': () => {
          handlerRuns += 1;
        },
      },
      ...extra,
    });
    const watcher = buildWatcher();

    const first = await watcher.handleLog(hookReadyLog());
    expect(first.job?.status).toBe('completed');
    expect(handlerRuns).toBe(1);

    const rescan = await watcher.handleLog(hookReadyLog());
    expect(rescan.status).toBe('ignored');
    expect(handlerRuns).toBe(1);

    const restarted = buildWatcher({
      fromBlock: 20,
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 22n;
        },
        async getLogs() {
          return [];
        },
      },
    });
    const poll = await restarted.pollOnce();
    expect(poll.results).toHaveLength(0);
    expect(handlerRuns).toBe(1);

    const jobId = first.job?.id;
    if (!jobId) {
      throw new Error('expected job id');
    }
    const retried = await retryStateMachineJob(watcher, jobId, { operator: 'ops@example.com' });
    expect(handlerRuns).toBe(2);
    expect(retried.job?.status).toBe('completed');
  });

  it('skips a concluded dry-run void pass without re-running the handler, and a real pass still runs it', async () => {
    let handlerRuns = 0;
    const store = new InMemoryStateMachineJobStore();
    const buildWatcher = (dryRun?: boolean) => createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      jobStore: store,
      artifact: artifactIndex(),
      handlers: {
        '*': () => {
          handlerRuns += 1;
        },
      },
      ...(dryRun ? { dryRun: true } : {}),
    });

    const dryRun = buildWatcher(true);
    const first = await dryRun.handleLog(hookReadyLog());
    expect(first.job?.status).toBe('matched');
    expect(handlerRuns).toBe(1);
    const replay = await dryRun.handleLog(hookReadyLog());
    expect(replay.status).toBe('ignored');
    expect(handlerRuns).toBe(1);

    const real = buildWatcher();
    const realRun = await real.handleLog(hookReadyLog());
    expect(realRun.job?.status).toBe('completed');
    expect(handlerRuns).toBe(2);
  });

  it('re-runs a dry-run job left by a crashed conclusive write instead of skipping it forever', async () => {
    let handlerRuns = 0;
    const inner = new InMemoryStateMachineJobStore();
    let updateCalls = 0;
    const failUpdates = new Set<number>([3]);
    const store: StateMachineJobStore = {
      kind: 'memory+fault',
      upsertDetected: (event, options) => inner.upsertDetected(event, options),
      get: (jobId) => inner.get(jobId),
      list: () => inner.list(),
      update: async (jobId, patch) => {
        updateCalls += 1;
        if (failUpdates.has(updateCalls)) {
          throw new Error('simulated store fault during the conclusive write');
        }
        return inner.update(jobId, patch);
      },
    };
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      jobStore: store,
      artifact: artifactIndex(),
      handlers: {
        '*': () => {
          handlerRuns += 1;
        },
      },
    });

    await expect(watcher.handleLog(hookReadyLog())).rejects.toThrow(/simulated store fault/);
    expect(handlerRuns).toBe(1);
    const [stranded] = await store.list();
    expect(stranded?.status).toBe('matched');
    expect(stranded?.claim).toBeUndefined();
    expect(stranded?.submissions).toHaveLength(0);
    expect(stranded?.dryRunConcludedAt).toBeUndefined();

    const recovery = await watcher.handleLog(hookReadyLog());
    expect(recovery.status).toBe('handled');
    expect(handlerRuns).toBe(2);
    expect(recovery.job?.status).toBe('matched');
    expect(recovery.job?.dryRunConcludedAt).toBeDefined();

    const replay = await watcher.handleLog(hookReadyLog());
    expect(replay.status).toBe('ignored');
    expect(handlerRuns).toBe(2);
  });

  it('records handler-context submitSignal broadcasts in the job audit trail', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: fakeReceiptClient(31_337, { status: 'success' }),
        artifact: artifactIndex(),
        handlers: {
          '*': async (event, context) => {
            await context.submitSignal({
              planId: PLAN_ID,
              orderId: event.orderId,
              source: 'slot-a',
              signalName: 'exec.main.cmp',
              payloadHash: PAYLOAD_HASH,
            });
          },
        },
      });

      const result = await watcher.handleLog(hookReadyLog());

      expect(stub.methods).toContain('eth_sendRawTransaction');
      const submissions = result.job?.submissions ?? [];
      expect(submissions).toHaveLength(1);
      expect(submissions[0]?.signalIndex).toBe(-1);
      expect(submissions[0]?.txHash).toBe(TX_HASH);
      expect(submissions[0]?.confirmed).toBe(true);
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('resolves the planId per signal so a sibling pin never leaks into unpinned signals', async () => {
    const pinnedPlanId = `0x${'99'.repeat(32)}` as Hex;
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: {
        '*': (event) => ([
          { planId: pinnedPlanId, orderId: event.orderId, source: 'slot-a', signalName: 'exec.main.cmp' },
          { orderId: event.orderId, source: 'slot-b', signalName: 'exec.main.cmp' },
        ]),
      },
    });

    const result = await watcher.handleLog(hookReadyLog());
    const planIds = result.submissions.map((submission) =>
      submission.dryRun ? submission.request.args[0] : undefined);
    expect(planIds).toEqual([pinnedPlanId, PLAN_ID]);
    expect(result.job?.planId).toBe(PLAN_ID);
  });

  it('refutes a reverted handler-context broadcast on a later scan instead of leaving it open forever', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      let receipt: { readonly status?: string } | null = null;
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        waitForReceipt: false,
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 12n;
          },
          async getLogs() {
            return [];
          },
          async getTransactionReceipt() {
            return receipt;
          },
        },
        artifact: artifactIndex(),
        handlers: {
          '*': async (event, context) => {
            await context.submitSignal({
              planId: PLAN_ID,
              orderId: event.orderId,
              source: 'slot-a',
              signalName: 'exec.main.cmp',
              payloadHash: PAYLOAD_HASH,
            });
          },
        },
      });

      const first = await watcher.handleLog(hookReadyLog());
      expect(first.job?.status).toBe('submitted');
      expect(first.job?.submissions[0]?.signalIndex).toBe(-1);

      receipt = { status: 'reverted' };
      const second = await watcher.handleLog(hookReadyLog());
      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
      expect(second.job?.status).toBe('dead_letter');
      expect(second.error?.message).toContain('submitSignal transaction receipt status reverted');
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('adopts a confirmed handler-context broadcast on a later scan and finishes the job', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      let receipt: { readonly status?: string } | null = null;
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        waitForReceipt: false,
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 12n;
          },
          async getLogs() {
            return [];
          },
          async getTransactionReceipt() {
            return receipt;
          },
        },
        artifact: artifactIndex(),
        handlers: {
          '*': async (event, context) => {
            await context.submitSignal({
              planId: PLAN_ID,
              orderId: event.orderId,
              source: 'slot-a',
              signalName: 'exec.main.cmp',
              payloadHash: PAYLOAD_HASH,
            });
          },
        },
      });

      const first = await watcher.handleLog(hookReadyLog());
      expect(first.job?.status).toBe('submitted');

      receipt = { status: 'success' };
      const second = await watcher.handleLog(hookReadyLog());
      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
      expect(second.job?.status).toBe('confirmed');
      const submissions = second.job?.submissions ?? [];
      expect(submissions).toHaveLength(2);
      expect(submissions[1]).toMatchObject({ signalIndex: -1, dryRun: false, txHash: TX_HASH, confirmed: true });
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('keeps a job open when a later-scan receipt carries an unrecognized status instead of clipping it to reverted', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      let receipt: { readonly status?: string } | null = null;
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        waitForReceipt: false,
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 12n;
          },
          async getLogs() {
            return [];
          },
          async getTransactionReceipt() {
            return receipt;
          },
        },
        artifact: artifactIndex(),
        handlers: {
          '*': async (event, context) => {
            await context.submitSignal({
              planId: PLAN_ID,
              orderId: event.orderId,
              source: 'slot-a',
              signalName: 'exec.main.cmp',
              payloadHash: PAYLOAD_HASH,
            });
          },
        },
      });

      const first = await watcher.handleLog(hookReadyLog());
      expect(first.job?.status).toBe('submitted');

      receipt = { status: '0xout-of-vocabulary' };
      const second = await watcher.handleLog(hookReadyLog());
      expect(second.job?.status).toBe('submitted');
      expect(second.error).toBeUndefined();
      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('resubmits a delivered handler-context signal when the manual retry declares the confirmation invalid', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      let handlerRuns = 0;
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: fakeReceiptClient(31_337, { status: 'success' }),
        artifact: artifactIndex(),
        handlers: {
          '*': async (event, context) => {
            handlerRuns += 1;
            await context.submitSignal({
              planId: PLAN_ID,
              orderId: event.orderId,
              source: 'slot-a',
              signalName: 'exec.main.cmp',
              payloadHash: PAYLOAD_HASH,
            });
          },
        },
      });

      const first = await watcher.handleLog(hookReadyLog());
      expect(first.job?.status).toBe('confirmed');

      const retried = await retryStateMachineJob(watcher, first.job!.id, { operator: 'ops@example.com' });
      expect(handlerRuns).toBe(2);
      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(2);
      expect(retried.job?.status).toBe('confirmed');
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('continues context signal numbering across runs so a re-run signal never inherits a prior signal slot', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      let receiptLookups = 0;
      let payload = PAYLOAD_HASH;
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        waitForReceipt: false,
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 12n;
          },
          async getLogs() {
            return [];
          },
          async getTransactionReceipt() {
            receiptLookups += 1;
            return receiptLookups === 1 ? { status: 'success' } : null;
          },
        },
        artifact: artifactIndex(),
        handlers: {
          '*': async (event, context) => {
            await context.submitSignal({
              planId: PLAN_ID,
              orderId: event.orderId,
              source: 'slot-a',
              signalName: 'exec.main.cmp',
              payloadHash: payload,
            });
          },
        },
      });

      const first = await watcher.handleLog(hookReadyLog());
      expect(first.job?.status).toBe('confirmed');
      expect(first.job?.submissions.map((submission) => submission.signalIndex)).toEqual([-1, -1]);

      payload = `0x${'45'.repeat(32)}` as Hex;
      const retried = await retryStateMachineJob(watcher, first.job!.id, { operator: 'ops@example.com' });
      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(2);
      const indexes = retried.job?.submissions.map((submission) => submission.signalIndex) ?? [];
      expect(indexes).toEqual([-1, -1, -2]);
      expect(retried.job?.status).toBe('submitted');
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('finishes a receipt-confirmed handler-context run as terminal confirmed instead of looping', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      let handlerRuns = 0;
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: fakeReceiptClient(31_337, { status: 'success' }),
        artifact: artifactIndex(),
        handlers: {
          '*': async (event, context) => {
            handlerRuns += 1;
            await context.submitSignal({
              planId: PLAN_ID,
              orderId: event.orderId,
              source: 'slot-a',
              signalName: 'exec.main.cmp',
              payloadHash: PAYLOAD_HASH,
            });
          },
        },
      });

      const first = await watcher.handleLog(hookReadyLog());
      expect(first.job?.status).toBe('confirmed');
      expect(handlerRuns).toBe(1);

      const rescan = await watcher.handleLog(hookReadyLog());
      expect(rescan.status).toBe('ignored');
      expect(handlerRuns).toBe(1);
      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('applies the resend backoff and receipt consult to handler-context rebroadcasts', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      const anchorAt = Date.parse('2026-04-28T00:00:00.000Z');
      let clockMs = anchorAt;
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        waitForReceipt: false,
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 12n;
          },
          async getLogs() {
            return [];
          },
          async getTransactionReceipt() {
            return null;
          },
        },
        artifact: artifactIndex(),
        resendBackoff: { baseDelayMs: 30_000, maxDelayMs: 60_000 },
        now: () => new Date(clockMs).toISOString(),
        nowMs: () => clockMs,
        handlers: {
          '*': async (event, context) => {
            const result = await context.submitSignal({
              planId: PLAN_ID,
              orderId: event.orderId,
              source: 'slot-a',
              signalName: 'exec.main.cmp',
              payloadHash: PAYLOAD_HASH,
            });
            expect('deferredBroadcast' in result || 'txHash' in result).toBe(true);
          },
        },
      });

      const first = await watcher.handleLog(hookReadyLog());
      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
      expect(first.job?.status).toBe('submitted');

      clockMs = anchorAt + 1_000;
      const deferred = await watcher.handleLog(hookReadyLog());
      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
      expect(deferred.job?.status).toBe('submitted');

      clockMs = anchorAt + 30_001;
      const resent = await watcher.handleLog(hookReadyLog());
      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(2);
      expect(resent.job?.status).toBe('submitted');
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('defers a handler-context broadcast whose receipt wait failed instead of inviting an immediate rebroadcast', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      let handlerRuns = 0;
      let sawDeferredMarker = false;
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 12n;
          },
          async getLogs() {
            return [];
          },
          async waitForTransactionReceipt() {
            throw new Error('Request timed out.');
          },
          async getTransactionReceipt() {
            return null;
          },
        },
        artifact: artifactIndex(),
        retry: { maxAttempts: 3, baseDelayMs: 0 },
        handlers: {
          '*': async (event, context) => {
            handlerRuns += 1;
            const result = await context.submitSignal({
              planId: PLAN_ID,
              orderId: event.orderId,
              source: 'slot-a',
              signalName: 'exec.main.cmp',
              payloadHash: PAYLOAD_HASH,
            });
            sawDeferredMarker = 'deferredBroadcast' in result;
          },
        },
      });

      const result = await watcher.handleLog(hookReadyLog());

      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
      expect(handlerRuns).toBe(1);
      expect(sawDeferredMarker).toBe(true);
      expect(result.job?.status).toBe('submitted');
      expect(result.job?.lastError?.kind).toBe('rpc_network');
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('keeps a job with unresolved broadcasts in the open lane when the handler stops emitting signals', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      let emitSignals = true;
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        waitForReceipt: false,
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 12n;
          },
          async getLogs() {
            return [];
          },
          async getTransactionReceipt() {
            return null;
          },
        },
        artifact: artifactIndex(),
        handlers: {
          '*': (event) => emitSignals
            ? {
              planId: PLAN_ID,
              orderId: event.orderId,
              source: 'slot-a',
              signalName: 'exec.main.cmp',
              payloadHash: PAYLOAD_HASH,
            }
            : undefined,
        },
      });

      const first = await watcher.handleLog(hookReadyLog());
      expect(first.job?.status).toBe('submitted');

      emitSignals = false;
      const rescan = await watcher.handleLog(hookReadyLog());
      expect(rescan.job?.status).toBe('submitted');
      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('terminally converges an incremental empty return once every signal is delivered', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      let pendingOnly = false;
      let handlerRuns = 0;
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        waitForReceipt: false,
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 12n;
          },
          async getLogs() {
            return [];
          },
          async getTransactionReceipt() {
            return pendingOnly ? { status: 'success' } : null;
          },
        },
        artifact: artifactIndex(),
        handlers: {
          '*': (event) => {
            handlerRuns += 1;
            return pendingOnly
              ? []
              : ([
                { planId: PLAN_ID, orderId: event.orderId, source: 'slot-a', signalName: 'exec.main.cmp', payloadHash: PAYLOAD_HASH },
                { planId: PLAN_ID, orderId: event.orderId, source: 'slot-b', signalName: 'exec.main.cmp', payloadHash: PAYLOAD_HASH },
              ]);
          },
        },
      });

      const first = await watcher.handleLog(hookReadyLog());
      expect(first.job?.status).toBe('submitted');
      expect(handlerRuns).toBe(1);

      pendingOnly = true;
      const second = await watcher.handleLog(hookReadyLog());
      expect(handlerRuns).toBe(2);
      expect(second.job?.status).toBe('confirmed');
      expect(second.job?.lastError).toBeUndefined();

      const third = await watcher.handleLog(hookReadyLog());
      expect(third.status).toBe('ignored');
      expect(handlerRuns).toBe(2);
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('terminally converges a context signal whose resend confirmed while the original receipt stays unknown', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub({
      sendRawTransactionTxHashes: [TX_HASH, TX_HASH_2],
    });
    try {
      let handlerRuns = 0;
      let receiptForSecondBroadcast = false;
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        waitForReceipt: false,
        resendBackoff: { baseDelayMs: 0, maxDelayMs: 0 },
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 12n;
          },
          async getLogs() {
            return [];
          },
          async getTransactionReceipt({ hash }) {
            if (hash === TX_HASH_2) {
              return receiptForSecondBroadcast ? { status: 'success' } : null;
            }
            return null;
          },
        },
        artifact: artifactIndex(),
        handlers: {
          '*': async (event, context) => {
            handlerRuns += 1;
            await context.submitSignal({
              planId: PLAN_ID,
              orderId: event.orderId,
              source: 'slot-a',
              signalName: 'exec.main.cmp',
              payloadHash: PAYLOAD_HASH,
            });
          },
        },
      });

      const first = await watcher.handleLog(hookReadyLog());
      expect(first.job?.status).toBe('submitted');
      expect(handlerRuns).toBe(1);
      const firstSubmissions = first.job?.submissions ?? [];
      expect(firstSubmissions.map((submission) => submission.signalIndex)).toEqual([-1]);

      const second = await watcher.handleLog(hookReadyLog());
      expect(handlerRuns).toBe(2);
      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(2);
      expect(second.job?.status).toBe('submitted');
      expect(second.job?.submissions.map((submission) => submission.signalIndex)).toEqual([-1, -2]);

      receiptForSecondBroadcast = true;
      const third = await watcher.handleLog(hookReadyLog());
      expect(handlerRuns).toBe(3);
      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(2);
      expect(third.job?.status).toBe('confirmed');

      const fourth = await watcher.handleLog(hookReadyLog());
      expect(fourth.status).toBe('ignored');
      expect(handlerRuns).toBe(3);
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('keeps dry-run submissions off the resend backoff anchor', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: {
        '*': (event) => ({
          planId: PLAN_ID,
          orderId: event.orderId,
          source: 'slot-a',
          signalName: 'exec.main.cmp',
          payloadHash: PAYLOAD_HASH,
        }),
      },
    });

    const result = await watcher.handleLog(hookReadyLog());

    expect(result.job?.submissions).toHaveLength(1);
    expect(result.job?.submissions[0]?.dryRun).toBe(true);
    expect(result.job?.lastSignalAttemptAt).toBeUndefined();
  });

  it('resends immediately when the backoff anchor is missing instead of starving the signal', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      const at = Date.parse('2026-04-28T00:00:00.000Z');
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: fakeReceiptClient(31_337, { status: 'success' }),
        artifact: artifactIndex(),
        retry: { maxAttempts: 3, baseDelayMs: 0 },
        resendBackoff: { baseDelayMs: 30_000, maxDelayMs: 60_000 },
        now: () => new Date(at).toISOString(),
        nowMs: () => at,
        handlers: {
          '*': (event) => ({
            planId: PLAN_ID,
            orderId: event.orderId,
            source: 'slot-a',
            signalName: 'exec.main.cmp',
            payloadHash: PAYLOAD_HASH,
          }),
        },
      });
      const event = decodeHookReadyLog(hookReadyLog(), artifactIndex())!;
      const seeded = await watcher.config.jobStore.upsertDetected(event, {
        now: new Date(at).toISOString(),
        maxAttempts: 3,
      });
      await watcher.config.jobStore.update(seeded.id, {
        status: 'submitted',
        updatedAt: new Date(at).toISOString(),
        submissions: [
          {
            signalIndex: 0,
            attempt: 1,
            dryRun: false,
            txHash: TX_HASH,
            request: seedRequest('slot-a', PAYLOAD_HASH),
            error: { kind: 'rpc_network', message: 'Request timed out.', retryable: true },
          },
        ],
      });

      const result = await watcher.handleLog(hookReadyLog());
      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
      expect(result.job?.status).toBe('confirmed');
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('retries the cursor restore on the next poll after a transient store failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-watcher-cursor-load-fail-'));
    const errors: unknown[] = [];
    try {
      const cursorFile = join(dir, 'cursor.json');
      await writeFile(cursorFile, `${JSON.stringify({
        version: 2,
        nextBlock: '16',
        blockHash: `0x${'10'.repeat(32)}`,
        checkpoints: [{ blockNumber: '15', blockHash: `0x${'0f'.repeat(32)}` }],
        chainId: 31_337,
        stateMachines: [STATE_MACHINE],
      })}\n`);
      let loadFails = true;
      const client: StateMachinePublicClient = {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 20n;
        },
        async getLogs() {
          return [];
        },
        async getBlock(args: { readonly blockNumber: bigint }) {
          return { hash: args.blockNumber === 15n ? `0x${'0f'.repeat(32)}` : `0x${Number(args.blockNumber + 1n).toString(16).padStart(64, '0')}` };
        },
      };
      const buildWatcher = () => createStateMachineWatcher({
        rpcUrl: 'http://127.0.0.1:8545',
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        walletAddress: WALLET_ADDRESS,
        fromBlock: 10,
        dryRun: true,
        handlers: { '*': () => undefined },
        onError: (error: unknown) => {
          errors.push(error);
        },
        cursorStore: {
          kind: 'file',
          async load(context) {
            if (loadFails) {
              throw new Error('transient fs fault');
            }
            return new FileStateMachineCursorStore(cursorFile).load(context);
          },
          async save(state, context) {
            return new FileStateMachineCursorStore(cursorFile).save(state, context);
          },
        },
        publicClient: client,
      });

      const first = buildWatcher();
      await expect(first.pollOnce()).rejects.toThrow(/transient fs fault/);

      loadFails = false;
      const second = buildWatcher();
      const poll = await second.pollOnce();
      expect(poll.fromBlock).toBe(16n);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not commit in-memory cursor anchors when persistence fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-watcher-cursor-save-fail-'));
    const errors: unknown[] = [];
    try {
      const cursorFile = join(dir, 'cursor.json');
      const realStore = new FileStateMachineCursorStore(cursorFile);
      let saveFails = false;
      const hashAt = (height: bigint): string => `0x${(Number(height) + 1).toString(16).padStart(64, '0')}`;
      let head = 12n;
      const buildWatcher = () => createStateMachineWatcher({
        rpcUrl: 'http://127.0.0.1:8545',
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        walletAddress: WALLET_ADDRESS,
        fromBlock: 10,
        dryRun: true,
        handlers: { '*': () => undefined },
        onError: (error: unknown) => {
          errors.push(error);
        },
        cursorStore: {
          kind: 'file',
          async load(context) {
            return realStore.load(context);
          },
          async save(state, context) {
            if (saveFails) {
              throw new Error('disk full');
            }
            return realStore.save(state, context);
          },
        },
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return head;
          },
          async getLogs() {
            return [];
          },
          async getBlock(args: { readonly blockNumber: bigint }) {
            return { hash: hashAt(args.blockNumber) };
          },
        },
      });

      await buildWatcher().pollOnce();
      let stored = JSON.parse(await readFile(cursorFile, 'utf8')) as { nextBlock?: string };
      expect(stored).toMatchObject({ nextBlock: '12' });

      saveFails = true;
      head = 14n;
      const failing = buildWatcher();
      await expect(failing.pollOnce()).rejects.toThrow(/disk full/);

      saveFails = false;
      head = 16n;
      const poll = await buildWatcher().pollOnce();
      expect(poll.fromBlock).toBe(12n);
      stored = JSON.parse(await readFile(cursorFile, 'utf8')) as { nextBlock?: string };
      expect(stored).toMatchObject({ nextBlock: '16' });
      expect(errors).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('clears stale adopted anchors when the overshoot correction rewinds to fromBlock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-watcher-overshoot-'));
    const errors: unknown[] = [];
    try {
      const cursorFile = join(dir, 'cursor.json');
      await writeFile(cursorFile, `${JSON.stringify({
        version: 2,
        nextBlock: '50',
        blockHash: `0x${'31'.repeat(32)}`,
        checkpoints: [
          { blockNumber: '47', blockHash: `0x${'2e'.repeat(32)}` },
          { blockNumber: '49', blockHash: `0x${'30'.repeat(32)}` },
        ],
        chainId: 31_337,
        stateMachines: [STATE_MACHINE],
      })}\n`);
      let head = 12n;
      const buildWatcher = () => createStateMachineWatcher({
        rpcUrl: 'http://127.0.0.1:8545',
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        walletAddress: WALLET_ADDRESS,
        fromBlock: 10,
        dryRun: true,
        handlers: { '*': () => undefined },
        onError: (error: unknown) => {
          errors.push(error);
        },
        cursorStore: new FileStateMachineCursorStore(cursorFile),
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return head;
          },
          async getLogs() {
            return [];
          },
          async getBlock(args: { readonly blockNumber: bigint }) {
            return { hash: `0x${(Number(args.blockNumber) + 1).toString(16).padStart(64, '0')}` };
          },
        },
      });

      const first = buildWatcher();
      const poll1 = await first.pollOnce();
      expect(poll1.fromBlock).toBe(10n);
      expect(errors).toHaveLength(1);
      expect(String(errors[0])).toContain('beyond the chain head');

      head = 16n;
      const poll2 = await first.pollOnce();
      expect(poll2.fromBlock).toBe(12n);
      expect(errors).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent file-store writers so no update is silently lost', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-watcher-jobs-lock-'));
    try {
      const jobsFile = join(dir, 'jobs.json');
      const storeA = new FileStateMachineJobStore(jobsFile);
      const storeB = new FileStateMachineJobStore(jobsFile);
      const eventA = decodeHookReadyLog(hookReadyLog(), artifactIndex())!;
      const eventB = decodeHookReadyLog({ ...hookReadyLog(), transactionHash: `0x${'35'.repeat(32)}` as Hex, logIndex: 8 }, artifactIndex())!;

      await Promise.all([
        storeA.upsertDetected(eventA, { now: '2026-04-28T00:00:00.000Z', maxAttempts: 3 }),
        storeB.upsertDetected(eventB, { now: '2026-04-28T00:00:00.000Z', maxAttempts: 3 }),
      ]);

      const jobs = await storeA.list();
      expect(new Set(jobs.map((job) => job.id)).size).toBe(2);

      const lockPath = `${jobsFile}.lock`;
      await writeFile(lockPath, '999999\n');
      const oneHourAgo = new Date(Date.now() - 3_600_000);
      await utimes(lockPath, oneHourAgo, oneHourAgo);
      const patched = await storeB.update(jobs[0]!.id, {
        status: 'dead_letter',
        updatedAt: '2026-04-28T00:01:00.000Z',
      });
      expect(patched?.status).toBe('dead_letter');
      expect((await readdir(dir)).filter((name) => name.endsWith('.lock'))).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never preempts a live jobs-lock holder however old the marker reads (pid+age)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-watcher-jobs-lock-live-'));
    try {
      const jobsFile = join(dir, 'jobs.json');
      const store = new FileStateMachineJobStore(jobsFile);
      const event = decodeHookReadyLog(hookReadyLog(), artifactIndex())!;
      const created = await store.upsertDetected(event, { now: '2026-04-28T00:00:00.000Z', maxAttempts: 3 });

      const lockPath = `${jobsFile}.lock`;
      await writeFile(lockPath, `${process.pid}\n`);
      const oneHourAgo = new Date(Date.now() - 3_600_000);
      await utimes(lockPath, oneHourAgo, oneHourAgo);

      await expect(store.update(created.id, {
        status: 'dead_letter',
        updatedAt: '2026-04-28T00:01:00.000Z',
      })).rejects.toThrow(new RegExp(`holder pid ${process.pid} reads alive`, 'u'));
      expect((await store.get(created.id))?.status).toBe('detected');
      expect((await readdir(dir)).filter((name) => name.endsWith('.lock'))).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('racing breakers of the same stale jobs lock cannot double-hold it (no lost updates)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-watcher-jobs-lock-race-'));
    try {
      const jobsFile = join(dir, 'jobs.json');
      const stores = Array.from({ length: 6 }, () => new FileStateMachineJobStore(jobsFile));
      const events = Array.from({ length: stores.length }, (_, index) => decodeHookReadyLog(
        { ...hookReadyLog(), transactionHash: `0x${(0x36 + index).toString(16).repeat(32)}` as Hex, logIndex: 7 + index },
        artifactIndex(),
      )!);
      for (const event of events) {
        await stores[0]!.upsertDetected(event, { now: '2026-04-28T00:00:00.000Z', maxAttempts: 3 });
      }
      const jobs = await stores[0]!.list();
      expect(jobs).toHaveLength(stores.length);

      const lockPath = `${jobsFile}.lock`;
      await writeFile(lockPath, '999999\n');
      const oneHourAgo = new Date(Date.now() - 3_600_000);
      await utimes(lockPath, oneHourAgo, oneHourAgo);

      await Promise.all(stores.map((store, index) => store.update(jobs[index]!.id, {
        status: 'dead_letter',
        updatedAt: '2026-04-28T00:01:00.000Z',
      })));

      const after = await stores[0]!.list();
      expect(after.filter((job) => job.status === 'dead_letter')).toHaveLength(stores.length);
      const leftovers = (await readdir(dir))
        .filter((name) => name.endsWith('.lock') || name.includes('.contend-') || name.endsWith('.broken'));
      expect(leftovers).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a signal without source attribution instead of hashing the empty string', async () => {
    expect(() => buildSubmitStateMachineSignalCall({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
    }, {
      planId: PLAN_ID,
      orderId: ORDER_ID,
      signalName: 'exec.main.cmp',
    })).toThrow(/signal\.source/);
  });

  it('trims stored reorg checkpoints to the reorg window instead of growing forever', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-watcher-checkpoint-trim-'));
    try {
      const cursorFile = join(dir, 'cursor.json');
      let head = 12n;
      const watcher = createStateMachineWatcher({
        rpcUrl: 'http://127.0.0.1:8545',
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        walletAddress: WALLET_ADDRESS,
        fromBlock: 1,
        reorgWindow: 4,
        dryRun: true,
        handlers: { '*': () => undefined },
        cursorStore: new FileStateMachineCursorStore(cursorFile),
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return head;
          },
          async getLogs() {
            return [];
          },
          async getBlock(args: { readonly blockNumber: bigint }) {
            return { hash: `0x${(Number(args.blockNumber) + 1).toString(16).padStart(64, '0')}` };
          },
        },
      });
      for (let round = 0; round < 8; round += 1) {
        head += 2n;
        await watcher.pollOnce();
      }
      const stored = JSON.parse(await readFile(cursorFile, 'utf8')) as { checkpoints?: Array<{ blockNumber: string }> };
      expect(stored.checkpoints?.length).toBeLessThanOrEqual(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats a failed toBlock hash read as no evidence instead of saving a stale hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-watcher-hash-read-fail-'));
    const errors: unknown[] = [];
    try {
      const cursorFile = join(dir, 'cursor.json');
      let blockReadsFail = false;
      const hashAt = (height: bigint): string => `0x${(Number(height) + 1).toString(16).padStart(64, '0')}`;
      let head = 12n;
      const buildWatcher = () => createStateMachineWatcher({
        rpcUrl: 'http://127.0.0.1:8545',
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        walletAddress: WALLET_ADDRESS,
        fromBlock: 10,
        dryRun: true,
        handlers: { '*': () => undefined },
        onError: (error: unknown) => {
          errors.push(error);
        },
        cursorStore: new FileStateMachineCursorStore(cursorFile),
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return head;
          },
          async getLogs() {
            return [];
          },
          async getBlock(args: { readonly blockNumber: bigint }) {
            if (blockReadsFail) {
              throw new Error('rpc down');
            }
            return { hash: hashAt(args.blockNumber) };
          },
        },
      });

      await buildWatcher().pollOnce();
      let stored = JSON.parse(await readFile(cursorFile, 'utf8')) as { nextBlock?: string; blockHash?: string };
      expect(stored).toMatchObject({ nextBlock: '12', blockHash: hashAt(11n) });

      blockReadsFail = true;
      head = 14n;
      await buildWatcher().pollOnce();
      stored = JSON.parse(await readFile(cursorFile, 'utf8')) as { nextBlock?: string; blockHash?: string };
      expect(stored).toMatchObject({ nextBlock: '14' });
      expect(stored.blockHash).toBeUndefined();

      blockReadsFail = false;
      errors.length = 0;
      head = 16n;
      const poll = await buildWatcher().pollOnce();
      expect(poll.fromBlock).toBe(14n);
      expect(errors).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('state machine callback tx helper', () => {
  it('generates submitSignal call args in dry-run mode', async () => {
    const result = await submitStateMachineSignal({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: '31337',
      walletAddress: WALLET_ADDRESS,
      privateKeyEnv: 'UVP_TEST_PRIVATE_KEY',
      dryRun: true,
    }, {
      planId: PLAN_ID,
      orderId: ORDER_ID,
      source: 'slot-b',
      signalName: 'ship.pickup.done',
      payloadHash: PAYLOAD_HASH,
      idempotencyKey: 'order-1:pickup:done',
    });

    if (!result.dryRun) {
      throw new Error('expected dry-run result');
    }

    expect(result.request.address).toBe(STATE_MACHINE);
    expect(result.request.from).toBe(WALLET_ADDRESS);
    expect(result.request.chainId).toBe(31_337);
    expect(result.request.functionName).toBe('submitSignal');
    expect(result.request.data.slice(0, 10)).toBe(STATE_MACHINE_FIXTURE.functions.submitSignal.selector);
    expect(result.request.args.slice(0, 5)).toEqual([
      PLAN_ID,
      ORDER_ID,
      keccak256(stringToBytes('slot-b')),
      keccak256(stringToBytes('ship.pickup.done')),
      PAYLOAD_HASH,
    ]);
    expect(result.request.data).toMatch(/^0x[0-9a-f]+$/);
  });

  it('does not call the network or require a private key in dry-run mode', async () => {
    const result = await submitStateMachineSignal({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: '31337',
      walletAddress: WALLET_ADDRESS,
      privateKeyEnv: 'UVP_TEST_PRIVATE_KEY_NOT_SET',
      dryRun: true,
      publicClient: {
        async getChainId() {
          throw new Error('dry-run should not read chain id');
        },
        async getBlockNumber() {
          throw new Error('dry-run should not read block number');
        },
        async getLogs() {
          throw new Error('dry-run should not read logs');
        },
      },
    }, {
      planId: PLAN_ID,
      orderId: ORDER_ID,
      source: 'slot-b',
      signalName: 'ship.pickup.done',
      payloadHash: PAYLOAD_HASH,
    });

    expect(result.dryRun).toBe(true);
  });

  it('refuses to build a submitSignal tx when the signal has no plan id', async () => {
    for (const broken of [
      {},
      { planId: `0x${'00'.repeat(32)}` as Hex },
    ]) {
      await expect(submitStateMachineSignal({
        rpcUrl: 'http://127.0.0.1:8545',
        stateMachineAddress: STATE_MACHINE,
        chainId: '31337',
        walletAddress: WALLET_ADDRESS,
        privateKeyEnv: 'UVP_TEST_PRIVATE_KEY',
        dryRun: true,
      }, {
        orderId: ORDER_ID,
        source: 'slot-b',
        signalName: 'ship.pickup.done',
        payloadHash: PAYLOAD_HASH,
        ...broken,
      })).rejects.toThrow(/planId/);
    }
    expect(() => buildSubmitStateMachineSignalCall({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
    }, {
      orderId: ORDER_ID,
      source: 'slot-b',
      signalName: 'ship.pickup.done',
    })).toThrow(/planId is required/);
  });

  it('fails the job instead of submitting when the event, handler, and job all lack a plan id', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: {
        '*': (event) => ({
          orderId: event.orderId,
          source: 'slot-a',
          signalName: 'exec.main.cmp',
          payloadHash: PAYLOAD_HASH,
        }),
      },
    });

    const result = await watcher.handleLog(hookReadyLog(STATE_MACHINE, `0x${'00'.repeat(32)}` as Hex));

    expect(result.submissions).toHaveLength(0);
    expect(result.job?.status).toBe('dead_letter');
    expect(result.error?.message).toContain('planId is required');
  });

  it('feeds the HookReady event planId into config-driven signals and persists it on the job', async () => {
    const store = new InMemoryStateMachineJobStore();
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      jobStore: store,
      handlers: createStateMachineHandlersFromConfig({
        handlers: {
          '*': { signals: [{ source: 'slot-a', stageIdentifier: 'exec.main', signalName: 'cmp' }] },
        },
      }),
    });

    const result = await watcher.handleLog(hookReadyLog());
    const submission = result.submissions[0];
    if (!submission || !submission.dryRun) {
      throw new Error('expected a dry-run submission');
    }

    expect(result.status).toBe('handled');
    expect(result.job?.status).toBe('matched');
    expect(submission.request.args[0]).toBe(PLAN_ID);
    expect((await store.get(result.job!.id))?.planId).toBe(PLAN_ID);
  });

  it('prefers an explicit config signal planId over the event planId', async () => {
    const configPlanId = `0x${'88'.repeat(32)}` as Hex;
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: createStateMachineHandlersFromConfig({
        handlers: {
          '*': { signals: [{ source: 'slot-a', stageIdentifier: 'exec.main', signalName: 'cmp', planId: configPlanId }] },
        },
      }),
    });

    const result = await watcher.handleLog(hookReadyLog());
    const submission = result.submissions[0];
    if (!submission || !submission.dryRun) {
      throw new Error('expected a dry-run submission');
    }
    expect(submission.request.args[0]).toBe(configPlanId);
    expect(result.job?.planId).toBe(PLAN_ID);
  });
});

describe('state machine executor config', () => {
  it('normalizes the state-machine handler config shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-state-machine-config-'));
    const configPath = join(dir, 'executor.json');
    try {
      await writeFile(configPath, JSON.stringify({
        supplierId: 'role-a',
        executorId: 'role-a',
        walletAddress: WALLET_ADDRESS,
        chainId: 84_532,
        stateMachineAddress: STATE_MACHINE,
        stateMachines: [
          { stateMachineAddress: STATE_MACHINE, deploymentId: `0x${'01'.repeat(32)}`, status: 'deprecated' },
          { stateMachineAddress: STATE_MACHINE_V2, deploymentId: `0x${'02'.repeat(32)}`, status: 'active' },
        ],
        dryRun: true,
        retry: {
          maxAttempts: 4,
          baseDelayMs: 0,
        },
        handlers: {
          'stage-a#START': {
            signals: [
              {
                source: 'role-a',
                stageIdentifier: 'stage-a',
                signalName: 'cmp',
              },
            ],
          },
        },
      }));

      const config = await loadStateMachineHandlerConfig(configPath);

      expect(config).toMatchObject({
        supplierId: 'role-a',
        executorId: 'role-a',
        walletAddress: WALLET_ADDRESS,
        chainId: 84_532,
        stateMachineAddress: STATE_MACHINE,
        stateMachines: [
          { stateMachineAddress: STATE_MACHINE, deploymentId: `0x${'01'.repeat(32)}`, status: 'deprecated' },
          { stateMachineAddress: STATE_MACHINE_V2, deploymentId: `0x${'02'.repeat(32)}`, status: 'active' },
        ],
        dryRun: true,
        retry: {
          maxAttempts: 4,
          baseDelayMs: 0,
        },
      });
      expect(config.handlers['stage-a#START']?.signals[0]).toMatchObject({
        source: 'role-a',
        stageIdentifier: 'stage-a',
        signalName: 'cmp',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects short signal names without a stage identifier', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-state-machine-config-'));
    const configPath = join(dir, 'executor.json');
    try {
      await writeFile(configPath, JSON.stringify({
        handlers: {
          'stage-a#START': {
            signals: [
              {
                source: 'role-a',
                signalName: 'cmp',
              },
            ],
          },
        },
      }));

      await expect(loadStateMachineHandlerConfig(configPath))
        .rejects.toThrow('stageIdentifier is required');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('executor error classification', () => {
  it('honors explicit error codes before any text matching', () => {
    expect(classifyExecutorKitError(new CodedExecutorKitError('UNAUTHORIZED', 'AccessControlUnauthorizedAccount submitter')))
      .toMatchObject({ kind: 'unauthorized', retryable: false, code: 'UNAUTHORIZED' });
    expect(classifyExecutorKitError(new CodedExecutorKitError('DUPLICATE_SIGNAL', 'SignalAlreadySubmitted')))
      .toMatchObject({ kind: 'duplicate_signal', retryable: false, code: 'DUPLICATE_SIGNAL' });
    expect(classifyExecutorKitError(new CodedExecutorKitError('RPC_NETWORK', 'fetch failed ECONNREFUSED')))
      .toMatchObject({ kind: 'rpc_network', retryable: true, code: 'RPC_NETWORK' });
    expect(classifyExecutorKitError(new CodedExecutorKitError('MISSING_HANDLER')))
      .toMatchObject({ kind: 'missing_handler', retryable: false, code: 'MISSING_HANDLER' });

    const wrapped = new Error('submission failed', { cause: new CodedExecutorKitError('RPC_NETWORK', 'timeout') });
    expect(classifyExecutorKitError(wrapped)).toMatchObject({ kind: 'rpc_network', retryable: true, code: 'RPC_NETWORK' });
  });

  it('classifies real viem and ethereum error texts without explicit codes', () => {
    expect(classifyExecutorKitError(new Error('Call revert exception: execution reverted: SignalAlreadyExists()')))
      .toMatchObject({ kind: 'duplicate_signal', retryable: false });
    expect(classifyExecutorKitError(new Error('execution reverted: 0xa2e92828')))
      .toMatchObject({ kind: 'duplicate_signal', retryable: false });
    expect(classifyExecutorKitError(new Error('AccessControlUnauthorizedAccount submitter')))
      .toMatchObject({ kind: 'unauthorized', retryable: false });
    expect(classifyExecutorKitError(new Error('insufficient funds for gas * price + value')))
      .toMatchObject({ kind: 'insufficient_funds', retryable: true });
    expect(classifyExecutorKitError(new Error('nonce too low')))
      .toMatchObject({ kind: 'nonce_conflict', retryable: true });
    expect(classifyExecutorKitError(new Error('nonce has already been used')))
      .toMatchObject({ kind: 'nonce_conflict', retryable: true });
    expect(classifyExecutorKitError(new Error('connect ECONNREFUSED 127.0.0.1:8545')))
      .toMatchObject({ kind: 'rpc_network', retryable: true });
    expect(classifyExecutorKitError(new Error('HTTP request failed with status 429: Too Many Requests')))
      .toMatchObject({ kind: 'rpc_network', retryable: true });
    expect(classifyExecutorKitError(new Error('Request timed out.')))
      .toMatchObject({ kind: 'rpc_network', retryable: true });
    expect(classifyExecutorKitError(new Error('fetch failed')))
      .toMatchObject({ kind: 'rpc_network', retryable: true });
    expect(classifyExecutorKitError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8545'), { code: 'ECONNREFUSED' })))
      .toMatchObject({ kind: 'rpc_network', retryable: true });
    const wrapped = new Error('submission failed', { cause: new Error('fetch failed: socket hang up') });
    expect(classifyExecutorKitError(wrapped)).toMatchObject({ kind: 'rpc_network', retryable: true });
  });

  it('keeps unrecognized failures conservatively non-retryable for human review', () => {
    expect(classifyExecutorKitError(new Error('handler exploded in a way no pattern matches'))).toEqual({
      kind: 'unknown',
      message: 'handler exploded in a way no pattern matches',
      retryable: false,
    });

    expect(classifyExecutorKitError(new ValidationError('payloadHash must be a 32-byte hex value')))
      .toMatchObject({ kind: 'validation_failure', retryable: false });
  });
});

describe('submitSignal receipt visibility', () => {
  const SIGNAL = {
    planId: PLAN_ID,
    orderId: ORDER_ID,
    source: 'slot-a',
    signalName: 'exec.main.cmp',
    payloadHash: PAYLOAD_HASH,
  };

  it('defaults waitForReceipt to true while still honoring an explicit false', () => {
    const base = {
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      handlers: {},
    };
    expect(createStateMachineWatcher(base).config.waitForReceipt).toBe(true);
    expect(createStateMachineWatcher({ ...base, waitForReceipt: false }).config.waitForReceipt).toBe(false);
  });

  it('throws loudly when the submitSignal transaction receipt reverts', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      await expect(submitStateMachineSignal({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: fakeReceiptClient(31_337, { status: 'reverted' }),
      }, SIGNAL)).rejects.toThrow(/submitSignal transaction receipt status reverted/);
      expect(stub.methods).toContain('eth_sendRawTransaction');
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('carries the broadcast txHash on the error when the receipt reverts', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      const error = await submitStateMachineSignal({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: fakeReceiptClient(31_337, { status: 'reverted' }),
      }, SIGNAL).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SubmitSignalReceiptError);
      expect((error as SubmitSignalReceiptError).txHash).toBe(TX_HASH);
      expect((error as Error).message).toContain('submitSignal transaction receipt status reverted');
      expect(stub.methods).toContain('eth_sendRawTransaction');
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('carries the broadcast txHash when waiting for the receipt itself fails', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      const error = await submitStateMachineSignal({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 12n;
          },
          async getLogs() {
            return [];
          },
          async waitForTransactionReceipt() {
            throw new Error('Request timed out.');
          },
        },
      }, SIGNAL).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SubmitSignalReceiptError);
      expect((error as SubmitSignalReceiptError).txHash).toBe(TX_HASH);
      expect(classifyExecutorKitError(error)).toMatchObject({ kind: 'rpc_network', retryable: true });
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('keeps a broadcast-but-reverted tx in the job audit trail instead of dropping it', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: fakeReceiptClient(31_337, { status: 'reverted' }),
        artifact: artifactIndex(),
        handlers: {
          '*': (event) => ({
            planId: PLAN_ID,
            orderId: event.orderId,
            source: 'slot-a',
            signalName: 'exec.main.cmp',
            payloadHash: PAYLOAD_HASH,
          }),
        },
      });

      const result = await watcher.handleLog(hookReadyLog());

      expect(result.job?.status).toBe('dead_letter');
      const submission = result.job?.submissions[0];
      expect(submission?.txHash).toBe(TX_HASH);
      expect(submission?.error?.message).toContain('receipt status reverted');
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('defers instead of blind-rebroadcasting when the broadcast receipt cannot be checked', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 12n;
          },
          async getLogs() {
            return [];
          },
          async waitForTransactionReceipt() {
            throw new Error('Request timed out.');
          },
        },
        artifact: artifactIndex(),
        retry: { maxAttempts: 2, baseDelayMs: 0 },
        handlers: {
          '*': (event) => ({
            planId: PLAN_ID,
            orderId: event.orderId,
            source: 'slot-a',
            signalName: 'exec.main.cmp',
            payloadHash: PAYLOAD_HASH,
          }),
        },
      });

      const result = await watcher.handleLog(hookReadyLog());

      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
      expect(result.job?.status).toBe('submitted');
      const submissions = result.job?.submissions ?? [];
      expect(submissions).toHaveLength(1);
      expect(submissions[0]?.txHash).toBe(TX_HASH);
      expect(submissions[0]?.error?.kind).toBe('rpc_network');
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('treats a real SignalAlreadyExists revert on replay as delivered instead of failing the job', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub({
      estimateGasError: { code: 3, message: 'execution reverted: SignalAlreadyExists()' },
    });
    try {
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: fakeReceiptClient(31_337, { status: 'success' }),
        artifact: artifactIndex(),
        retry: { maxAttempts: 3 },
        handlers: {
          '*': (event) => ({
            planId: PLAN_ID,
            orderId: event.orderId,
            source: 'slot-a',
            signalName: 'exec.main.cmp',
            payloadHash: PAYLOAD_HASH,
          }),
        },
      });

      const result = await watcher.handleLog(hookReadyLog());

      expect(result.status).toBe('handled');
      expect(result.job?.status).toBe('confirmed');
      expect(result.error).toBeUndefined();
      expect(result.job?.lastError).toBeUndefined();
      const submissions = result.job?.submissions ?? [];
      expect(submissions[submissions.length - 1]?.error).toMatchObject({
        kind: 'duplicate_signal',
        retryable: false,
      });
      expect(submissions[submissions.length - 1]?.error?.message).toContain('SignalAlreadyExists');

      const rescan = await watcher.handleLog(hookReadyLog());
      expect(rescan.status).toBe('ignored');
      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(0);
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('consults the receipt before rebroadcasting after a retryable broadcast failure', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 12n;
          },
          async getLogs() {
            return [];
          },
          async waitForTransactionReceipt() {
            throw new Error('Request timed out.');
          },
          async getTransactionReceipt() {
            return { status: 'success' };
          },
        },
        artifact: artifactIndex(),
        retry: { maxAttempts: 3, baseDelayMs: 0 },
        handlers: {
          '*': (event) => ({
            planId: PLAN_ID,
            orderId: event.orderId,
            source: 'slot-a',
            signalName: 'exec.main.cmp',
            payloadHash: PAYLOAD_HASH,
          }),
        },
      });

      const result = await watcher.handleLog(hookReadyLog());

      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
      expect(result.job?.status).toBe('confirmed');
      expect(result.job?.lastError).toBeUndefined();
      const submissions = result.job?.submissions ?? [];
      expect(submissions).toHaveLength(2);
      expect(submissions[0]?.error?.kind).toBe('rpc_network');
      expect(submissions[0]?.txHash).toBe(TX_HASH);
      expect(submissions[1]).toMatchObject({ signalIndex: 0, dryRun: false, txHash: TX_HASH });
      expect(submissions[1]?.error).toBeUndefined();
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('keeps the operator dead-letter reason when the recovery clear lands on a terminal job', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      let verdictLanded = false;
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 12n;
          },
          async getLogs() {
            return [];
          },
          async waitForTransactionReceipt() {
            throw new Error('Request timed out.');
          },
          async getTransactionReceipt() {
            if (!verdictLanded) {
              verdictLanded = true;
              await watcher.config.jobStore.update(
                stateMachineJobId(decodeHookReadyLog(hookReadyLog(), artifactIndex())!),
                {
                  status: 'dead_letter',
                  updatedAt: new Date().toISOString(),
                  lastError: { kind: 'unknown', message: 'operator verdict', retryable: false },
                  claim: null,
                },
              );
            }
            return { status: 'success' };
          },
        },
        artifact: artifactIndex(),
        retry: { maxAttempts: 3, baseDelayMs: 0 },
        handlers: {
          '*': (event) => ({
            planId: PLAN_ID,
            orderId: event.orderId,
            source: 'slot-a',
            signalName: 'exec.main.cmp',
            payloadHash: PAYLOAD_HASH,
          }),
        },
      });

      const result = await watcher.handleLog(hookReadyLog());

      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
      const submissions = result.job?.submissions ?? [];
      expect(submissions[submissions.length - 1]).toMatchObject({ dryRun: false, txHash: TX_HASH, confirmed: true });
      expect(result.job?.status).toBe('dead_letter');
      expect(result.job?.lastError?.message).toBe('operator verdict');
      const stored = await watcher.config.jobStore.get(
        stateMachineJobId(decodeHookReadyLog(hookReadyLog(), artifactIndex())!),
      );
      expect(stored?.lastError?.message).toBe('operator verdict');
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('throws the receipt error and never rebroadcasts when the recovered receipt reverted', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 12n;
          },
          async getLogs() {
            return [];
          },
          async waitForTransactionReceipt() {
            throw new Error('Request timed out.');
          },
          async getTransactionReceipt() {
            return { status: 'reverted' };
          },
        },
        artifact: artifactIndex(),
        retry: { maxAttempts: 3, baseDelayMs: 0 },
        handlers: {
          '*': (event) => ({
            planId: PLAN_ID,
            orderId: event.orderId,
            source: 'slot-a',
            signalName: 'exec.main.cmp',
            payloadHash: PAYLOAD_HASH,
          }),
        },
      });

      const recovery = watcher as unknown as {
        recoverBroadcastSubmission(config: unknown, signal: unknown, txHash: Hex): Promise<unknown>;
      };
      await expect(recovery.recoverBroadcastSubmission(watcher.config, SIGNAL, TX_HASH))
        .rejects.toBeInstanceOf(SubmitSignalReceiptError);

      const result = await watcher.handleLog(hookReadyLog());

      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
      expect(result.job?.status).toBe('dead_letter');
      expect(result.error?.retryable).toBe(false);
      expect(result.error?.message).toContain('submitSignal transaction receipt status reverted');
      const submissions = result.job?.submissions ?? [];
      expect(submissions[submissions.length - 1]?.txHash).toBe(TX_HASH);
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('defers an unconfirmed broadcast to later scans when the receipt is not available', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 12n;
          },
          async getLogs() {
            return [];
          },
          async waitForTransactionReceipt() {
            throw new Error('Request timed out.');
          },
          async getTransactionReceipt() {
            return null;
          },
        },
        artifact: artifactIndex(),
        retry: { maxAttempts: 3, baseDelayMs: 0 },
        handlers: {
          '*': (event) => ({
            planId: PLAN_ID,
            orderId: event.orderId,
            source: 'slot-a',
            signalName: 'exec.main.cmp',
            payloadHash: PAYLOAD_HASH,
          }),
        },
      });

      const result = await watcher.handleLog(hookReadyLog());

      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
      expect(result.job?.status).toBe('submitted');
      expect(result.job?.submissions).toHaveLength(1);
      expect(result.job?.submissions[0]?.txHash).toBe(TX_HASH);
      expect(result.job?.lastError?.kind).toBe('rpc_network');

      const rescan = await watcher.handleLog(hookReadyLog());
      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
      expect(rescan.job?.status).toBe('submitted');
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('keeps a job with an unknown-outcome broadcast open instead of dead-lettering it on an unclassifiable receipt failure', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 12n;
          },
          async getLogs() {
            return [];
          },
          async waitForTransactionReceipt() {
            throw new Error('provider halted unexpectedly');
          },
        },
        artifact: artifactIndex(),
        retry: { maxAttempts: 3, baseDelayMs: 0 },
        handlers: {
          '*': (event) => ({
            planId: PLAN_ID,
            orderId: event.orderId,
            source: 'slot-a',
            signalName: 'exec.main.cmp',
            payloadHash: PAYLOAD_HASH,
          }),
        },
      });

      const result = await watcher.handleLog(hookReadyLog());

      expect(stub.methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
      expect(result.job?.status).toBe('submitted');
      expect(result.job?.lastError?.kind).toBe('unknown');
      expect(result.job?.submissions[0]?.txHash).toBe(TX_HASH);
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('reports confirmed:true only after a successful receipt', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      const result = await submitStateMachineSignal({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: fakeReceiptClient(31_337, { status: 'success' }),
      }, SIGNAL);
      if (result.dryRun) {
        throw new Error('expected a broadcast result');
      }
      expect(result.txHash).toBe(TX_HASH);
      expect(result.confirmed).toBe(true);
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('leaves the submission unconfirmed when no receipt can be waited for instead of claiming success', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      const result = await submitStateMachineSignal({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 12n;
          },
          async getLogs() {
            return [];
          },
        },
      }, SIGNAL);
      if (result.dryRun) {
        throw new Error('expected a broadcast result');
      }
      expect(result.txHash).toBe(TX_HASH);
      expect(result.confirmed).toBeUndefined();
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });
});

describe('run terminal-status computation', () => {
  const slotARequest = seedRequest('slot-a', PAYLOAD_HASH);
  const slotBRequest = seedRequest('slot-b', PAYLOAD_HASH);

  it('confirms the incremental empty return when every recorded signal is delivered', () => {
    const status = statusForCompletedRun({
      dryRun: false,
      identityDatas: [],
      jobSubmissions: [
        { signalIndex: 0, attempt: 1, dryRun: false, txHash: TX_HASH, request: slotARequest, confirmed: true },
        { signalIndex: 1, attempt: 1, dryRun: false, txHash: TX_HASH_2, request: slotBRequest, confirmed: true },
      ],
    });
    expect(status).toBe('confirmed');
  });

  it('keeps the zero-history void run terminal completed', () => {
    expect(statusForCompletedRun({
      dryRun: false,
      identityDatas: [],
      jobSubmissions: [],
    })).toBe('completed');
    expect(statusForCompletedRun({
      dryRun: false,
      identityDatas: [],
      jobSubmissions: [
        { signalIndex: 0, attempt: 1, request: slotARequest, error: { kind: 'rpc_network', message: 'fetch failed', retryable: true } },
      ],
    })).toBe('completed');
  });

  it('keeps dry-run passes non-terminal', () => {
    expect(statusForCompletedRun({
      dryRun: true,
      identityDatas: [slotARequest.data],
      jobSubmissions: [{ signalIndex: 0, attempt: 1, dryRun: true, request: slotARequest }],
    })).toBe('matched');
  });

  it('completes a context signal by content identity when its resend confirmed on another index', () => {
    const status = statusForCompletedRun({
      dryRun: false,
      identityDatas: [],
      jobSubmissions: [
        { signalIndex: -1, attempt: 1, dryRun: false, txHash: TX_HASH, request: slotARequest },
        { signalIndex: -2, attempt: 1, dryRun: false, txHash: TX_HASH_2, request: slotARequest, confirmed: true },
      ],
    });
    expect(status).toBe('confirmed');
  });

  it('keeps a distinct undelivered context signal open regardless of index arithmetic', () => {
    const contextProbe = (submissions: readonly StateMachineJobSubmission[]): string => statusForCompletedRun({
      dryRun: false,
      identityDatas: [],
      jobSubmissions: submissions,
    });
    expect(contextProbe([
      { signalIndex: -1, attempt: 1, dryRun: false, txHash: TX_HASH, request: slotARequest, confirmed: true },
      { signalIndex: -2, attempt: 1, dryRun: false, txHash: TX_HASH_2, request: slotBRequest },
    ])).toBe('submitted');
    expect(contextProbe([
      { signalIndex: -1, attempt: 1, dryRun: false, txHash: TX_HASH, request: slotARequest, confirmed: true },
      { signalIndex: -2, attempt: 1, dryRun: false, txHash: TX_HASH_2, request: slotBRequest, confirmed: true },
    ])).toBe('confirmed');
  });
});

function hookReadyLog(address = STATE_MACHINE, planId: Hex = PLAN_ID): StateMachineRawLog {
  return {
    address,
    data: encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [STAGE_ID, HOOK_NAME_ID],
    ),
    topics: [
      keccak256(stringToHex(STATE_MACHINE_FIXTURE.events.HookReady.signature)),
      planId,
      ORDER_ID,
      HOOK_ID,
    ],
    blockNumber: 12n,
    transactionHash: TX_HASH,
    logIndex: 7,
  };
}

function artifactIndex() {
  return {
    hooksByHookId: {
      [HOOK_ID]: {
        stageIdentifier: 'exec.main',
        hookName: 'START',
      },
    },
  };
}

function capabilityArtifact() {
  const otherSourceId = keccak256(stringToBytes('someone-else'));
  const otherSignalId = keccak256(stringToBytes('exec.other.done'));
  return {
    ...artifactIndex(),
    selectorBindings: [
      { selectorStageId: `0x${'66'.repeat(32)}`, targetStageId: STAGE_ID },
    ],
    signalCapabilities: [
      { stageId: STAGE_ID, targetSourceId: otherSourceId, signalId: otherSignalId, relation: 1 as const },
      { stageId: STAGE_ID, targetSourceId: SLOT_A_SOURCE_ID, signalId: EXEC_MAIN_CMP_ID, relation: 0 as const },
    ],
  };
}

function seedRequest(source: 'slot-a' | 'slot-b', payloadHash?: Hex) {
  return buildSubmitStateMachineSignalCall(
    { rpcUrl: 'http://127.0.0.1:8545', stateMachineAddress: STATE_MACHINE, chainId: 31_337 },
    {
      planId: PLAN_ID,
      orderId: ORDER_ID,
      source,
      signalName: 'exec.main.cmp',
      ...(payloadHash !== undefined ? { payloadHash } : {}),
    },
  );
}

type JsonRpcRequest = { readonly id?: unknown; readonly method?: string };

async function startJsonRpcStub(options: {
  readonly estimateGasError?: { readonly code: number; readonly message: string; readonly times?: number };
  readonly sendRawTransactionErrors?: readonly number[];
  readonly sendRawTransactionTxHashes?: readonly Hex[];
} = {}): Promise<{
  readonly url: string;
  readonly methods: string[];
  close(): Promise<void>;
}> {
  const methods: string[] = [];
  let estimateGasErrors = 0;
  const estimateGasErrorLimit = options.estimateGasError?.times ?? Number.POSITIVE_INFINITY;
  let sendRawCalls = 0;
  const handlers: Record<string, () => unknown> = {
    eth_call: () => '0x',
    eth_estimateGas: () => '0x5208',
    eth_gasPrice: () => '0x3b9aca00',
    eth_getTransactionCount: () => '0x0',
    eth_sendRawTransaction: () => options.sendRawTransactionTxHashes?.[sendRawCalls - 1] ?? TX_HASH,
    eth_blockNumber: () => '0xc',
    eth_chainId: () => '0x7a69',
    eth_maxPriorityFeePerGas: () => '0x3b9aca00',
    eth_getBlockByNumber: () => ({
      number: '0xc',
      hash: TX_HASH,
      parentHash: `0x${'00'.repeat(32)}`,
      nonce: `0x${'00'.repeat(8)}`,
      sha3Uncles: `0x${'00'.repeat(32)}`,
      logsBloom: `0x${'00'.repeat(256)}`,
      transactionsRoot: `0x${'00'.repeat(32)}`,
      stateRoot: `0x${'00'.repeat(32)}`,
      receiptsRoot: `0x${'00'.repeat(32)}`,
      miner: '0x0000000000000000000000000000000000000000',
      difficulty: '0x0',
      totalDifficulty: '0x0',
      extraData: '0x',
      size: '0x0',
      gasLimit: '0x1c9c380',
      gasUsed: '0x0',
      timestamp: '0x5f5e100',
      transactions: [],
      uncles: [],
    }),
  };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as JsonRpcRequest | readonly JsonRpcRequest[];
      const respondOne = (body: JsonRpcRequest, id: unknown) => {
        methods.push(body.method ?? '');
        if (
          body.method === 'eth_estimateGas'
          && options.estimateGasError
          && estimateGasErrors < estimateGasErrorLimit
        ) {
          estimateGasErrors += 1;
          return {
            jsonrpc: '2.0',
            id: body.id ?? id ?? 1,
            error: options.estimateGasError,
          };
        }
        if (body.method === 'eth_sendRawTransaction') {
          sendRawCalls += 1;
          if (options.sendRawTransactionErrors?.includes(sendRawCalls)) {
            return {
              jsonrpc: '2.0',
              id: body.id ?? id ?? 1,
              error: { code: -32603, message: 'Request timed out.' },
            };
          }
        }
        return {
          jsonrpc: '2.0',
          id: body.id ?? id ?? 1,
          result: (handlers[body.method ?? ''] ?? (() => null))(),
        };
      };
      const payload = Array.isArray(parsed)
        ? parsed.map((entry, index) => respondOne(entry, index + 1))
        : [respondOne(parsed, 1)];
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(Array.isArray(parsed) ? payload : payload[0]));
    })().catch(() => {
      response.statusCode = 500;
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('json-rpc stub did not bind to a TCP address');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    methods,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function fakeReceiptClient(chainId: number, receipt: { readonly status?: string }): StateMachinePublicClient {
  return {
    async getChainId() {
      return chainId;
    },
    async getBlockNumber() {
      return 12n;
    },
    async getLogs() {
      return [];
    },
    async waitForTransactionReceipt() {
      return receipt;
    },
  };
}

describe('watcher finality runtime-environment gate', () => {
  it('keeps the silent default 1 confirmations for local and undeclared runtime environments', () => {
    const localWatcher = createStateMachineWatcher({ ...gateBaseConfig(), runtimeEnvironment: 'local' });
    const undeclaredWatcher = createStateMachineWatcher(gateBaseConfig());

    expect(localWatcher.describe().confirmations).toBe(1);
    expect(undeclaredWatcher.describe().confirmations).toBe(1);
  });

  it('requires an explicit positive confirmations outside local (chain-services caliber)', () => {
    for (const runtimeEnvironment of ['testnet', 'staging', 'production'] as const) {
      expect(() => createStateMachineWatcher({ ...gateBaseConfig(), runtimeEnvironment }))
        .toThrow(ValidationError);
      expect(() => createStateMachineWatcher({ ...gateBaseConfig(), runtimeEnvironment }))
        .toThrow(/confirmations must be explicitly configured/);
      expect(() => createStateMachineWatcher({ ...gateBaseConfig(), runtimeEnvironment, confirmations: 0 }))
        .toThrow(/must be a positive integer/);
      const watcher = createStateMachineWatcher({ ...gateBaseConfig(), runtimeEnvironment, confirmations: 5 });
      expect(watcher.describe().confirmations).toBe(5);
      expect(watcher.describe().runtimeEnvironment).toBe(runtimeEnvironment);
    }
  });

  it('rejects unknown runtimeEnvironment values instead of guessing', () => {
    expect(() => createStateMachineWatcher({ ...gateBaseConfig(), runtimeEnvironment: 'dev' as never }))
      .toThrow(/runtimeEnvironment must be local, testnet, staging, or production/);
  });

  function gateBaseConfig() {
    return {
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      privateKeyEnv: 'UVP_TEST_PRIVATE_KEY',
      handlers: {},
    };
  }
});

describe('watcher run-claim release retry', () => {
  it('alerts on a failed claim release and frees the job on a later poll round', async () => {
    const inner = new InMemoryStateMachineJobStore();
    let failRelease = true;
    const store: StateMachineJobStore = {
      kind: 'flaky-memory',
      upsertDetected: (event, options) => inner.upsertDetected(event, options),
      async update(jobId, patch) {
        if (patch.claim === null && patch.status === undefined && failRelease) {
          throw new Error('EACCES: jobs store unavailable');
        }
        return await inner.update(jobId, patch);
      },
      get: (jobId) => inner.get(jobId),
      list: () => inner.list(),
    };
    const errors: string[] = [];
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      privateKeyEnv: 'UVP_TEST_PRIVATE_KEY',
      dryRun: true,
      artifact: artifactIndex(),
      jobStore: store,
      handlers: {
        '*': () => undefined,
      },
      onError: (error) => {
        errors.push(error instanceof Error ? error.message : String(error));
      },
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 12n;
        },
        async getLogs() {
          return [];
        },
      },
    });

    const result = await watcher.handleLog(hookReadyLog());
    const jobId = result.job?.id;
    if (!jobId) {
      throw new Error('expected a processed job');
    }
    const stuck = await store.get(jobId);
    expect(stuck?.claim?.pid).toBe(process.pid);
    expect(errors.some((message) => message.includes('failed to release the run claim'))).toBe(true);

    failRelease = false;
    await watcher.pollOnce();
    const released = await store.get(jobId);
    expect(released?.claim).toBeUndefined();
  });
});

describe('dry-run submission record dedupe', () => {
  it('dedupes replayed dry-run records by request content across indexes', () => {
    const request: SubmitStateMachineSignalCall = seedRequest('slot-a');
    const submissions: StateMachineJobSubmission[] = [];
    appendJobSubmission(submissions, { signalIndex: -1, attempt: 1, dryRun: true, request });
    appendJobSubmission(submissions, { signalIndex: -2, attempt: 1, dryRun: true, request });
    expect(submissions).toHaveLength(1);

    appendJobSubmission(submissions, {
      signalIndex: -3,
      attempt: 1,
      dryRun: true,
      request: seedRequest('slot-b'),
    });
    expect(submissions).toHaveLength(2);

    appendJobSubmission(submissions, { signalIndex: -1, attempt: 2, dryRun: false, txHash: TX_HASH, request });
    expect(submissions).toHaveLength(3);
  });

  it('keeps a replayed dry-run context submission at one audit record across manual re-runs', async () => {
    const store = new InMemoryStateMachineJobStore();
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      privateKeyEnv: 'UVP_TEST_PRIVATE_KEY',
      dryRun: true,
      artifact: artifactIndex(),
      jobStore: store,
      handlers: {
        '*': async (event, context) => {
          await context.submitSignal({
            planId: PLAN_ID,
            orderId: event.orderId,
            source: 'slot-a',
            signalName: 'exec.main.cmp',
            payloadHash: PAYLOAD_HASH,
          });
        },
      },
    });

    const first = await watcher.handleLog(hookReadyLog());
    const jobId = first.job?.id;
    if (!jobId) {
      throw new Error('expected a processed job');
    }
    expect(first.job?.submissions).toHaveLength(1);
    expect(first.job?.submissions[0]?.signalIndex).toBe(-1);

    const retried = await retryStateMachineJob(watcher, jobId, {
      operator: 'ops@example.com',
    });
    expect(retried.job?.submissions).toHaveLength(1);
    expect(retried.job?.submissions[0]?.signalIndex).toBe(-1);
  });
});

describe('watcher held foreign claim alert', () => {
  it('alerts once when a live-looking foreign claim persists across poll rounds and points at the manual override', async () => {
    const store = new InMemoryStateMachineJobStore();
    const errors: string[] = [];
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      privateKeyEnv: 'UVP_TEST_PRIVATE_KEY',
      dryRun: true,
      artifact: artifactIndex(),
      jobStore: store,
      handlers: { '*': () => undefined },
      onError: (error) => {
        errors.push(error instanceof Error ? error.message : String(error));
      },
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 20n;
        },
        async getLogs() {
          return [];
        },
      },
    });

    const event = decodeHookReadyLog(hookReadyLog(), artifactIndex());
    if (!event) {
      throw new Error('expected a decoded HookReady event');
    }
    const foreignPid = process.ppid ?? 1;
    if (foreignPid === process.pid) {
      throw new Error('test requires a foreign pid');
    }
    const detected = await store.upsertDetected(event, { now: '2026-04-28T00:00:00.000Z', maxAttempts: 3 });
    const claimed = await store.update(detected.id, {
      updatedAt: '2026-04-28T00:00:01.000Z',
      status: 'matched',
      matchedKey: '*',
      claim: { pid: foreignPid, at: '2026-04-28T00:00:01.000Z' },
    });
    if (!claimed) {
      throw new Error('expected the claim write to apply');
    }

    for (let round = 0; round < HELD_FOREIGN_CLAIM_ALERT_ROUNDS - 1; round += 1) {
      await watcher.pollOnce();
    }
    expect(errors).toHaveLength(0);

    await watcher.pollOnce();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`pid ${foreignPid}`);
    expect(errors[0]).toContain('deadLetterStateMachineJob');
    expect(errors[0]).toContain('force: true');

    await watcher.pollOnce();
    await watcher.pollOnce();
    expect(errors).toHaveLength(1);
  });

  it('re-arms the alert after a streak ends: a release clears the counters, a new persistent hold alerts again', async () => {
    const store = new InMemoryStateMachineJobStore();
    const errors: string[] = [];
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      privateKeyEnv: 'UVP_TEST_PRIVATE_KEY',
      dryRun: true,
      artifact: artifactIndex(),
      jobStore: store,
      handlers: { '*': () => undefined },
      onError: (error) => {
        errors.push(error instanceof Error ? error.message : String(error));
      },
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 20n;
        },
        async getLogs() {
          return [];
        },
      },
    });

    const event = decodeHookReadyLog(hookReadyLog(), artifactIndex());
    if (!event) {
      throw new Error('expected a decoded HookReady event');
    }
    const foreignPid = process.ppid ?? 1;
    if (foreignPid === process.pid) {
      throw new Error('test requires a foreign pid');
    }
    const detected = await store.upsertDetected(event, { now: '2026-04-28T00:00:00.000Z', maxAttempts: 3 });
    const hold = () => store.update(detected.id, {
      updatedAt: '2026-04-28T00:00:01.000Z',
      status: 'matched',
      matchedKey: '*',
      claim: { pid: foreignPid, at: '2026-04-28T00:00:01.000Z' },
    });

    await hold();
    for (let round = 0; round < HELD_FOREIGN_CLAIM_ALERT_ROUNDS; round += 1) {
      await watcher.pollOnce();
    }
    expect(errors).toHaveLength(1);

    await store.update(detected.id, {
      updatedAt: '2026-04-28T00:02:00.000Z',
      claim: null,
      expectStatus: 'matched',
    });
    await watcher.pollOnce();
    expect(errors).toHaveLength(1);

    await hold();
    for (let round = 0; round < HELD_FOREIGN_CLAIM_ALERT_ROUNDS - 1; round += 1) {
      await watcher.pollOnce();
    }
    expect(errors).toHaveLength(1);
    await watcher.pollOnce();
    expect(errors).toHaveLength(2);
    expect(errors[1]).toContain(`pid ${foreignPid}`);
  });

  it('observes held foreign claims on cursor-overshoot early-return rounds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-watcher-overshoot-alert-'));
    const errors: string[] = [];
    try {
      const cursorFile = join(dir, 'cursor.json');
      await writeFile(cursorFile, `${JSON.stringify({
        version: 2,
        nextBlock: '50',
        chainId: 31_337,
        stateMachines: [STATE_MACHINE],
      })}\n`);
      const store = new InMemoryStateMachineJobStore();
      const watcher = createStateMachineWatcher({
        rpcUrl: 'http://127.0.0.1:8545',
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        walletAddress: WALLET_ADDRESS,
        dryRun: true,
        artifact: artifactIndex(),
        jobStore: store,
        handlers: { '*': () => undefined },
        onError: (error) => {
          errors.push(error instanceof Error ? error.message : String(error));
        },
        cursorStore: new FileStateMachineCursorStore(cursorFile),
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 12n;
          },
          async getLogs() {
            return [];
          },
        },
      });

      const event = decodeHookReadyLog(hookReadyLog(), artifactIndex());
      if (!event) {
        throw new Error('expected a decoded HookReady event');
      }
      const foreignPid = process.ppid ?? 1;
      const detected = await store.upsertDetected(event, { now: '2026-04-28T00:00:00.000Z', maxAttempts: 3 });
      const claimed = await store.update(detected.id, {
        updatedAt: '2026-04-28T00:00:01.000Z',
        status: 'matched',
        matchedKey: '*',
        claim: { pid: foreignPid, at: '2026-04-28T00:00:01.000Z' },
      });
      if (!claimed) {
        throw new Error('expected the claim write to apply');
      }

      for (let round = 0; round < HELD_FOREIGN_CLAIM_ALERT_ROUNDS; round += 1) {
        const poll = await watcher.pollOnce();
        expect(poll.scannedLogs).toBe(0);
        expect(poll.results).toHaveLength(0);
      }
      expect(errors).toHaveLength(HELD_FOREIGN_CLAIM_ALERT_ROUNDS + 1);
      expect(errors[0]).toContain('beyond the chain head');
      expect(errors.at(-1)).toContain(`pid ${foreignPid}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('jobs dead-letter force', () => {
  it('refuses a live-looking claim without --force and overrides it with the operator on record', async () => {
    const store = new InMemoryStateMachineJobStore();
    const event = decodeHookReadyLog(hookReadyLog(), artifactIndex());
    if (!event) {
      throw new Error('expected a decoded HookReady event');
    }
    const foreignPid = process.ppid ?? 1;
    const detected = await store.upsertDetected(event, { now: '2026-04-28T00:00:00.000Z', maxAttempts: 3 });
    const claimed = await store.update(detected.id, {
      updatedAt: '2026-04-28T00:00:01.000Z',
      status: 'matched',
      matchedKey: '*',
      claim: { pid: foreignPid, at: '2026-04-28T00:00:01.000Z' },
    });
    if (!claimed) {
      throw new Error('expected the claim write to apply');
    }

    await expect(deadLetterStateMachineJob(store, detected.id, {
      operator: 'ops@example.com',
      reason: 'stuck claim',
    })).rejects.toThrow(/is being processed by executor pid/);

    const forced = await deadLetterStateMachineJob(store, detected.id, {
      operator: 'ops@example.com',
      reason: 'holder pid verified reused; executor crashed',
      force: true,
      now: () => '2026-04-28T00:00:05.000Z',
    });
    expect(forced.status).toBe('dead_letter');
    expect(forced.claim).toBeUndefined();
    expect(forced.manualActions?.[0]).toMatchObject({
      action: 'dead_letter',
      operator: 'ops@example.com',
      reason: 'holder pid verified reused; executor crashed',
      forced: true,
    });

    const quietEvent = decodeHookReadyLog(
      { ...hookReadyLog(), transactionHash: `0x${'36'.repeat(32)}` as Hex, logIndex: 9 },
      artifactIndex(),
    );
    if (!quietEvent) {
      throw new Error('expected a decoded HookReady event');
    }
    const quiet = await store.upsertDetected(quietEvent, { now: '2026-04-28T00:00:06.000Z', maxAttempts: 3 });
    const unforced = await deadLetterStateMachineJob(store, quiet.id, {
      operator: 'ops@example.com',
      reason: 'not stuck',
      now: () => '2026-04-28T00:00:07.000Z',
    });
    expect(unforced.manualActions?.[0]?.forced).toBeUndefined();
  });
});
