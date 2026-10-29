// Chain-read HTTP client and bigint projection decoders: failures stay typed
// (timeout/transport/HTTP/not_found/invalid_response), never empty lists, and
// wire block numbers revive to bigint. Fake fetcher only — no network.
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  ChainReadError,
  createChainReadClient,
  decodeOrderProjection,
  decodeSnapshotProjection,
  decodeSyncStateProjection,
  decodeTaskProjection,
  type ChainOrderProjection,
  type ChainProof,
  type ChainProjectionSnapshot,
  type ChainProvenance,
  type ChainReadFetcher,
  type ChainSyncState,
  type ChainTaskProjection,
} from '../../src/chain-read/index.js';

const address = (digit: string): Address => `0x${digit.repeat(40)}` as Address;
const bytes32 = (digit: string): Hex => `0x${digit.repeat(64)}` as Hex;

const CHAIN_ID = 31337;
const STATE_MACHINE = address('1');
const ORDER_ID = bytes32('a');
const PLAN_ID = bytes32('b');
const PLAN_HASH = bytes32('f');
const HOOK_ID = bytes32('c');
const STAGE_ID = bytes32('d');
const TX_HASH = bytes32('e');
const DEPLOYMENT_ID = bytes32('1');
const DOCK_ID = bytes32('2');
const WALLET = address('2');
const BASE_URL = 'http://chain.test:8787';

const PROVENANCE: ChainProvenance = {
  chainId: CHAIN_ID,
  contractAddress: STATE_MACHINE,
  blockNumber: '10',
  transactionHash: TX_HASH,
  logIndex: 0,
};

const PROOF: ChainProof = {
  ...PROVENANCE,
  eventId: 'event-1',
  eventName: 'HookReady',
  args: { hookId: HOOK_ID },
};

const ORDER: ChainOrderProjection = {
  orderId: ORDER_ID,
  chainId: CHAIN_ID,
  contractAddress: STATE_MACHINE,
  planId: PLAN_ID,
  status: 'registered',
  currentStage: STAGE_ID,
  creator: WALLET,
  authorizations: {},
  signals: {},
  derivedSignals: {},
  stageMaterializations: {},
  stageExecutorOverlays: {},
  stageResourceOverlays: {},
  hooks: {},
  tasks: {},
  timeline: [],
  proof: [PROOF],
  registeredAt: PROVENANCE,
  updatedAt: PROVENANCE,
};

const TASK: ChainTaskProjection = {
  taskId: 'task-1',
  orderId: ORDER_ID,
  stateMachineAddress: STATE_MACHINE,
  planId: PLAN_ID,
  hookId: HOOK_ID,
  stageIdentifier: STAGE_ID,
  hookName: HOOK_ID,
  assigneeRole: 'performer',
  assigneeWallet: WALLET,
  status: 'ready',
  submitSignals: [{ sourceId: STAGE_ID, signalId: HOOK_ID, source: 'authorization' }],
  createdAt: PROVENANCE,
  updatedAt: PROVENANCE,
  proof: PROOF,
};

function provenanceAt(blockNumber: number): ChainProvenance {
  return { ...PROVENANCE, blockNumber: String(blockNumber) };
}

function proofAt(blockNumber: number): ChainProof {
  return {
    ...provenanceAt(blockNumber),
    eventId: `event-${blockNumber.toString()}`,
    eventName: 'HookReady',
    args: { hookId: HOOK_ID },
  };
}

const SNAPSHOT: ChainProjectionSnapshot = {
  rebuildable: true,
  eventCount: 15,
  activeStateMachineDeploymentId: DEPLOYMENT_ID,
  stateMachineDeployments: {
    [DEPLOYMENT_ID]: {
      deploymentId: DEPLOYMENT_ID,
      stateMachineAddress: STATE_MACHINE,
      artifactHash: `0x${'3'.repeat(64)}`,
      abiHash: `0x${'4'.repeat(64)}`,
      deploymentBlock: '4',
      metadataURI: 'ipfs://deployment',
      status: 'active',
      registeredAt: provenanceAt(4),
      updatedAt: provenanceAt(5),
      proof: proofAt(4),
    },
  },
  stateMachineModules: {
    module: {
      chainId: CHAIN_ID,
      stateMachineAddress: STATE_MACHINE,
      moduleId: `0x${'5'.repeat(64)}`,
      previousModule: WALLET,
      moduleAddress: STATE_MACHINE,
      updatedAt: provenanceAt(6),
      proof: proofAt(6),
    },
  },
  contractGovernance: {
    governance: {
      chainId: CHAIN_ID,
      contractAddress: STATE_MACHINE,
      owner: WALLET,
      ownerUpdatedAt: provenanceAt(7),
      ownerProof: proofAt(7),
    },
  },
  stateMachinePlans: {
    [PLAN_ID]: {
      planId: PLAN_ID,
      stateMachineAddress: STATE_MACHINE,
      planHash: PLAN_HASH,
      hookCount: '0',
      selectorBindings: [],
      signalCapabilities: [],
      executorCandidates: [],
      registeredAt: provenanceAt(8),
      updatedAt: provenanceAt(8),
      proof: proofAt(8),
      commitProof: proofAt(8),
    },
  },
  stateMachineOrders: { [ORDER_ID]: ORDER },
  stateMachineDocks: {
    [DOCK_ID]: {
      dockInstanceId: DOCK_ID,
      chainId: CHAIN_ID,
      stateMachineAddress: STATE_MACHINE,
      mode: 'new',
      localPlanId: PLAN_ID,
      localOrderId: ORDER_ID,
      routeId: `0x${'6'.repeat(64)}`,
      routeHash: `0x${'7'.repeat(64)}`,
      interfaceNameId: `0x${'8'.repeat(64)}`,
      targetPlanId: PLAN_ID,
      linkedOrderId: ORDER_ID,
      depth: 1,
      inputDeliveries: {
        delivery: {
          inputBindingHash: `0x${'9'.repeat(64)}`,
          localPlanId: PLAN_ID,
          localOrderId: ORDER_ID,
          targetPlanId: PLAN_ID,
          linkedOrderId: ORDER_ID,
          targetSignalId: HOOK_ID,
          payloadHash: `0x${'a'.repeat(64)}`,
          submitter: WALLET,
          deliveredAt: provenanceAt(14),
          proof: proofAt(14),
        },
      },
      outputDeliveries: {},
      openedAt: provenanceAt(14),
      updatedAt: provenanceAt(14),
      proof: proofAt(14),
    },
  },
  stateMachineDocksByTargetOrder: {},
  stateMachineOrderDockChainDepth: {},
  stateMachineTasks: { [TASK.taskId]: TASK },
  lastEvent: provenanceAt(15),
  unresolvedModuleOrderEventCount: 0,
  unresolvedDockEventCount: 2,
  unresolvedStageActivationEventCount: 0,
  unresolvedDockTargetDeploymentCount: 0,
  capabilityEnrichmentMismatchCount: 0,
  unknownEventCount: 0,
};

describe('chain read client', () => {
  it('maps orders and tasks from the documented endpoints', async () => {
    const requests: string[] = [];
    const fetcher: ChainReadFetcher = async (url, init) => {
      const pathname = new URL(url).pathname;
      requests.push(`${init.method} ${pathname}`);
      const body = pathname === '/chain/orders'
        ? { orders: [ORDER] }
        : pathname === `/chain/orders/${ORDER_ID}`
          ? { orders: [ORDER] }
          : pathname === `/chain/orders/${ORDER_ID}/tasks`
            ? { tasks: [TASK] }
            : pathname === '/chain/tasks'
              ? { tasks: [TASK] }
              : pathname === `/chain/tasks/${TASK.taskId}`
                ? { task: TASK }
                : undefined;
      if (body === undefined) {
        throw new Error(`unexpected chain read path: ${pathname}`);
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const client = createChainReadClient({ baseUrl: BASE_URL, fetcher });

    await expect(client.listOrders()).resolves.toEqual([ORDER]);
    await expect(client.getOrdersByOrderId(ORDER_ID)).resolves.toEqual([ORDER]);
    await expect(client.listTasks()).resolves.toEqual([TASK]);
    await expect(client.getTask(TASK.taskId)).resolves.toEqual(TASK);
    await expect(client.listOrderTasks(ORDER_ID)).resolves.toEqual([TASK]);
    expect(requests).toEqual([
      'GET /chain/orders',
      `GET /chain/orders/${ORDER_ID}`,
      'GET /chain/tasks',
      `GET /chain/tasks/${TASK.taskId}`,
      `GET /chain/orders/${ORDER_ID}/tasks`,
    ]);
  });

  it('maps a 404 to a typed not_found error instead of an empty list', async () => {
    const client = createChainReadClient({
      baseUrl: BASE_URL,
      fetcher: async () => ({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: 'chain_order_not_found' }),
      }),
    });

    await expect(client.getOrdersByOrderId(ORDER_ID)).rejects.toMatchObject({
      name: 'ChainReadError',
      code: 'not_found',
      status: 404,
      retryable: false,
    });
  });

  it('keeps timeout, transport, and HTTP failures distinct', async () => {
    const timeoutClient = createChainReadClient({
      baseUrl: BASE_URL,
      timeoutMs: 10,
      fetcher: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            'abort',
            () => reject(new Error('request aborted')),
            { once: true },
          );
        }),
    });
    await expect(timeoutClient.listOrders()).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    });

    const transportClient = createChainReadClient({
      baseUrl: BASE_URL,
      fetcher: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(transportClient.listOrders()).rejects.toMatchObject({
      code: 'transport',
      retryable: true,
    });

    const unavailableClient = createChainReadClient({
      baseUrl: BASE_URL,
      fetcher: async () => ({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ error: 'chain_read_unavailable' }),
      }),
    });
    await expect(unavailableClient.listOrders()).rejects.toMatchObject({
      code: 'http',
      status: 503,
      retryable: true,
    });

    const rejectedClient = createChainReadClient({
      baseUrl: BASE_URL,
      fetcher: async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'invalid_path_parameter' }),
      }),
    });
    await expect(rejectedClient.listOrders()).rejects.toMatchObject({
      code: 'http',
      status: 400,
      retryable: false,
    });
  });

  it('rejects malformed responses and invalid client configuration', async () => {
    const invalidJsonClient = createChainReadClient({
      baseUrl: BASE_URL,
      fetcher: async () => ({
        ok: true,
        status: 200,
        text: async () => '<html>not json</html>',
      }),
    });
    await expect(invalidJsonClient.listOrders()).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });

    const invalidShapeClient = createChainReadClient({
      baseUrl: BASE_URL,
      fetcher: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ orders: 'not-an-array' }),
      }),
    });
    await expect(invalidShapeClient.listOrders()).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });

    let caught: unknown;
    try {
      createChainReadClient({ baseUrl: 'postgres://chain.test/read' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChainReadError);
    expect((caught as ChainReadError).code).toBe('invalid_config');
  });

  it('reads the projection sync state and maps missing or malformed states to typed errors', async () => {
    const syncState: ChainSyncState = {
      chainId: CHAIN_ID,
      contractAddress: STATE_MACHINE,
      syncStatus: 'indexed',
      latestIndexedBlock: '42',
      finalizedBlock: '40',
      confirmationDepth: 2,
      eventCount: 7,
      rebuild: {
        status: 'completed',
        fromBlock: '38',
        toBlock: '42',
        eventCount: 7,
        removedLogsFiltered: true,
      },
      updatedAt: '2026-10-27T00:00:00.000Z',
    };
    let requestedPath: string | undefined;
    const present = createChainReadClient({
      baseUrl: BASE_URL,
      fetcher: async (url) => {
        requestedPath = new URL(url).pathname;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ syncState }),
        };
      },
    });
    await expect(present.getSyncState()).resolves.toEqual(syncState);
    expect(requestedPath).toBe('/chain/sync-state');

    const absent = createChainReadClient({
      baseUrl: BASE_URL,
      fetcher: async () => ({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: 'chain_sync_state_not_found' }),
      }),
    });
    await expect(absent.getSyncState()).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
      retryable: false,
    });

    const malformed = createChainReadClient({
      baseUrl: BASE_URL,
      fetcher: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ syncState: { chainId: CHAIN_ID } }),
      }),
    });
    await expect(malformed.getSyncState()).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });
  });

  it('reads the projection snapshot and revives nested block numbers to bigint', async () => {
    const requestedPaths: string[] = [];
    const fetcher: ChainReadFetcher = async (url) => {
      requestedPaths.push(new URL(url).pathname);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ snapshot: SNAPSHOT }),
      };
    };
    const client = createChainReadClient({ baseUrl: BASE_URL, fetcher });

    await expect(client.getSnapshot()).resolves.toEqual(SNAPSHOT);
    expect(requestedPaths).toEqual(['/chain/snapshot']);

    const snapshot = decodeSnapshotProjection(SNAPSHOT);
    expect(snapshot.stateMachineDeployments[DEPLOYMENT_ID]?.registeredAt.blockNumber).toBe(4n);
    expect(snapshot.stateMachinePlans[PLAN_ID]?.commitProof?.blockNumber).toBe(8n);
    expect(snapshot.stateMachineOrders[ORDER_ID]?.registeredAt?.blockNumber).toBe(10n);
    expect(
      snapshot.stateMachineDocks[DOCK_ID]?.inputDeliveries['delivery']?.proof.blockNumber,
    ).toBe(14n);
    expect(snapshot.lastEvent?.blockNumber).toBe(15n);
  });

  it('decodes order, task, and sync-state wire payloads with bigint provenance', () => {
    expect(decodeOrderProjection(ORDER).registeredAt?.blockNumber).toBe(10n);
    expect(decodeOrderProjection(ORDER).proof[0]?.blockNumber).toBe(10n);
    expect(decodeTaskProjection(TASK).createdAt.blockNumber).toBe(10n);
    expect(decodeTaskProjection(TASK).proof.blockNumber).toBe(10n);
    const syncState = decodeSyncStateProjection({
      chainId: CHAIN_ID,
      contractAddress: STATE_MACHINE,
      syncStatus: 'indexed',
      latestIndexedBlock: '42',
      finalizedBlock: '40',
      confirmationDepth: 2,
      eventCount: 7,
      rebuild: {
        status: 'completed',
        deploymentBlock: '30',
        fromBlock: '38',
        toBlock: '42',
        eventCount: 7,
        removedLogsFiltered: true,
      },
      updatedAt: '2026-10-27T00:00:00.000Z',
    });
    expect(syncState.latestIndexedBlock).toBe(42n);
    expect(syncState.finalizedBlock).toBe(40n);
    expect(syncState.rebuild?.deploymentBlock).toBe(30n);
    expect(syncState.rebuild?.fromBlock).toBe(38n);
    expect(syncState.rebuild?.toBlock).toBe(42n);
  });

  it('rejects a malformed projection snapshot response', async () => {
    const client = createChainReadClient({
      baseUrl: BASE_URL,
      fetcher: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ snapshot: { rebuildable: true, eventCount: 1 } }),
      }),
    });

    await expect(client.getSnapshot()).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });
  });
});
