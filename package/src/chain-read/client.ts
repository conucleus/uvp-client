// Typed HTTP client for chain-services' generic `/chain/*` projection reads.
// Wire DTOs and runtime decoding are owned by @uvp-eth/chain-read-contract; the
// client surfaces every failure as a ChainReadError instead of an empty
// fallback and imports no chain-services source.

import {
  ChainReadContractError,
  parseOrdersResponse,
  parsePlanAdmissionsResponse,
  parseSnapshotResponse,
  parseSyncStateResponse,
  parseTaskResponse,
  parseTasksResponse,
  type ChainOrderProjection,
  type ChainPlanAdmission,
  type ChainPlanAdmissionsResponse,
  type ChainProjectionSnapshot,
  type ChainSyncState,
  type ChainTaskProjection,
} from "@uvp-eth/chain-read-contract";

export type {
  ChainContractGovernanceProjection,
  ChainDeploymentProjection,
  ChainDeploymentStatus,
  ChainDerivedSignal,
  ChainDockInputDelivery,
  ChainDockMode,
  ChainDockOutputDelivery,
  ChainDockProjection,
  ChainExecutorCandidate,
  ChainHook,
  ChainHookStatus,
  ChainModuleProjection,
  ChainOrderFork,
  ChainOrderProjection,
  ChainOrderStatus,
  ChainOrderTriggerLink,
  ChainPlanAdmission,
  ChainPlanAdmissionsResponse,
  ChainPlanProjection,
  ChainProjectionSnapshot,
  ChainProof,
  ChainProofArg,
  ChainProvenance,
  ChainRebuildMetadata,
  ChainRebuildStatus,
  ChainSignal,
  ChainSignalAuthorization,
  ChainSignalCapability,
  ChainSignalTargetRelation,
  ChainStageExecutorOverlay,
  ChainStageExecutorPatchMode,
  ChainStageMaterialization,
  ChainStageResourceOverlay,
  ChainStageSelectorBinding,
  ChainSubmitSignal,
  ChainSyncDiagnosticsCounts,
  ChainSyncState,
  ChainSyncStatus,
  ChainTaskProjection,
  ChainTaskStatus,
  ChainTimelineEvent,
} from "@uvp-eth/chain-read-contract";

const DEFAULT_TIMEOUT_MS = 5_000;

export type ChainReadErrorCode =
  | "invalid_config"
  | "invalid_response"
  | "timeout"
  | "transport"
  | "http"
  | "not_found";

export interface ChainReadErrorOptions {
  readonly status?: number;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

export class ChainReadError extends Error {
  override readonly name = "ChainReadError";
  readonly code: ChainReadErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(
    code: ChainReadErrorCode,
    message: string,
    options: ChainReadErrorOptions,
  ) {
    super(message);
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export interface ChainReadRequestInit {
  readonly method: "GET";
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface ChainReadHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type ChainReadFetcher = (
  url: string,
  init: ChainReadRequestInit,
) => Promise<ChainReadHttpResponse>;

export interface CreateChainReadClientOptions {
  readonly baseUrl: string;
  readonly fetcher?: ChainReadFetcher;
  readonly timeoutMs?: number;
}

export interface ChainReadClient {
  listOrders(): Promise<readonly ChainOrderProjection[]>;
  getOrdersByOrderId(orderId: string): Promise<readonly ChainOrderProjection[]>;
  listTasks(): Promise<readonly ChainTaskProjection[]>;
  getTask(taskId: string): Promise<ChainTaskProjection>;
  listOrderTasks(orderId: string): Promise<readonly ChainTaskProjection[]>;
  getPlanAdmissions(planId: string, planHash: string): Promise<ChainPlanAdmissionsResponse>;
  getSyncState(): Promise<ChainSyncState>;
  getSnapshot(): Promise<ChainProjectionSnapshot>;
}

export function createChainReadClient(
  options: CreateChainReadClientOptions,
): ChainReadClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const fetcher = options.fetcher ?? fetchChainRead;

  async function request(pathname: string): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let response: ChainReadHttpResponse;
    try {
      response = await fetcher(`${baseUrl}${pathname}`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new ChainReadError(
          "timeout",
          `chain read timed out after ${timeoutMs}ms: GET ${pathname}`,
          { retryable: true, cause: error },
        );
      }
      throw new ChainReadError(
        "transport",
        `chain read transport failed: GET ${pathname}`,
        { retryable: true, cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 404) {
      throw new ChainReadError(
        "not_found",
        `chain read resource was not found: GET ${pathname}`,
        { status: 404, retryable: false },
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new ChainReadError(
        "transport",
        `chain read response body could not be read: GET ${pathname}`,
        { retryable: true, cause: error },
      );
    }

    if (!response.ok) {
      const serverError = serverErrorCode(text);
      throw new ChainReadError(
        "http",
        `chain read failed with HTTP ${response.status}` +
          `${serverError === undefined ? "" : ` (${serverError})`}: GET ${pathname}`,
        { status: response.status, retryable: response.status >= 500 },
      );
    }

    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new ChainReadError(
        "invalid_response",
        `chain read returned invalid JSON: GET ${pathname}`,
        { retryable: false, cause: error },
      );
    }
  }

  return {
    async listOrders() {
      return parseOrders(await request("/chain/orders"));
    },
    async getOrdersByOrderId(orderId) {
      return parseOrders(await request(`/chain/orders/${encodeURIComponent(orderId)}`));
    },
    async listTasks() {
      return parseTasks(await request("/chain/tasks"));
    },
    async getTask(taskId) {
      return parseTask(await request(`/chain/tasks/${encodeURIComponent(taskId)}`));
    },
    async listOrderTasks(orderId) {
      return parseTasks(await request(`/chain/orders/${encodeURIComponent(orderId)}/tasks`));
    },
    async getPlanAdmissions(planId, planHash) {
      return parsePlanAdmissions(
        await request(`/chain/plans/${encodeURIComponent(planId)}/${encodeURIComponent(planHash)}/admissions`),
      );
    },
    async getSyncState() {
      return parseSyncState(await request("/chain/sync-state"));
    },
    async getSnapshot() {
      return parseSnapshot(await request("/chain/snapshot"));
    },
  };
}

function parseOrders(body: unknown): readonly ChainOrderProjection[] {
  return parseWireResponse("orders", () => parseOrdersResponse(body));
}

function parseTasks(body: unknown): readonly ChainTaskProjection[] {
  return parseWireResponse("tasks", () => parseTasksResponse(body));
}

function parseTask(body: unknown): ChainTaskProjection {
  return parseWireResponse("task", () => parseTaskResponse(body));
}

function parsePlanAdmissions(body: unknown): ChainPlanAdmissionsResponse {
  return parseWireResponse("plan-admissions", () => parsePlanAdmissionsResponse(body));
}

function parseSnapshot(body: unknown): ChainProjectionSnapshot {
  return parseWireResponse("snapshot", () => parseSnapshotResponse(body));
}

function parseSyncState(body: unknown): ChainSyncState {
  return parseWireResponse("sync-state", () => parseSyncStateResponse(body));
}

function parseWireResponse<TValue>(
  description: string,
  parse: () => TValue,
): TValue {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ChainReadContractError) {
      throw new ChainReadError(
        "invalid_response",
        `chain read ${description} response does not match the wire contract: ${error.message}`,
        { retryable: false, cause: error },
      );
    }
    throw error;
  }
}

const fetchChainRead: ChainReadFetcher = (url, init) => fetch(url, init);

function normalizeBaseUrl(raw: string): string {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ChainReadError(
      "invalid_config",
      "chain read baseUrl must be an absolute http(s) URL",
      { retryable: false },
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new ChainReadError(
      "invalid_config",
      "chain read baseUrl must be an absolute http(s) URL without credentials, query, or fragment",
      { retryable: false },
    );
  }
  return value.replace(/\/+$/u, "");
}

function normalizeTimeout(raw: number | undefined): number {
  const value = raw ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ChainReadError(
      "invalid_config",
      "chain read timeoutMs must be a positive integer",
      { retryable: false },
    );
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serverErrorCode(text: string): string | undefined {
  try {
    const code = asRecord(JSON.parse(text) as unknown)?.["error"];
    return typeof code === "string" && /^[a-z0-9_]{1,64}$/u.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** Fail-closed client used when CHAIN_SERVICES_READ_URL is not configured. */
export function createMissingChainReadClient(): ChainReadClient {
  const unavailable = async (): Promise<never> => {
    throw new ChainReadError(
      "invalid_config",
      "CHAIN_SERVICES_READ_URL is not configured: chain facts cannot be read over HTTP",
      { retryable: false },
    );
  };
  return {
    listOrders: unavailable,
    getOrdersByOrderId: unavailable,
    listTasks: unavailable,
    getTask: unavailable,
    listOrderTasks: unavailable,
    getPlanAdmissions: unavailable,
    getSyncState: unavailable,
    getSnapshot: unavailable,
  };
}
