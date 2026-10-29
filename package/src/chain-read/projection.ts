// Bigint projection view of the chain read wire contract: the HTTP client
// validates wire payloads with @uvp-eth/chain-read-contract, then these
// decoders re-check nested projection records and revive decimal block
// numbers to bigint. Field names and optionality stay owned by the contract.

import {
  ChainReadContractError,
  decodeContractGovernanceWire,
  decodeDeploymentWire,
  decodeDockWire,
  decodeModuleWire,
  decodeOrderWire,
  decodePlanWire,
  decodeSnapshotWire,
  decodeSyncStateWire,
  decodeTaskWire,
  type ChainContractGovernanceProjection,
  type ChainDeploymentProjection,
  type ChainDeploymentStatus,
  type ChainDerivedSignal,
  type ChainDockMode,
  type ChainDockProjection,
  type ChainHook,
  type ChainHookStatus,
  type ChainModuleProjection,
  type ChainOrderProjection,
  type ChainOrderStatus,
  type ChainPlanCapabilityEnrichmentStatus,
  type ChainPlanProjection,
  type ChainProjectionSnapshot,
  type ChainProof,
  type ChainProofArg,
  type ChainProvenance,
  type ChainRebuildMetadata,
  type ChainRebuildStatus,
  type ChainSignal,
  type ChainSignalAuthorization,
  type ChainSignalCapability,
  type ChainSignalTargetRelation,
  type ChainStageExecutorOverlay,
  type ChainStageExecutorPatchMode,
  type ChainStageMaterialization,
  type ChainStageResourceOverlay,
  type ChainStageSelectorBinding,
  type ChainSubmitSignal,
  type ChainSyncDiagnosticsCounts,
  type ChainSyncState,
  type ChainSyncStatus,
  type ChainTaskProjection,
  type ChainTaskStatus,
  type ChainTimelineEvent,
} from "@uvp-eth/chain-read-contract";
import { ChainReadError } from "./client.js";

/** Recursively turns provenance block numbers back into bigint. */
export type RevivedWire<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends readonly (infer TItem)[]
    ? readonly RevivedWire<TItem>[]
    : T extends { readonly blockNumber: string }
      ? { readonly [TKey in keyof T]: TKey extends "blockNumber" ? bigint : RevivedWire<T[TKey]> }
      : T extends object
        ? { readonly [TKey in keyof T]: RevivedWire<T[TKey]> }
        : T;

export type ProjectionProvenance = RevivedWire<ChainProvenance>;
export type EventProofArgs = Readonly<Record<string, ChainProofArg>>;
export type StateMachineProofProjection = RevivedWire<ChainProof>;
export type StateMachineTimelineEventProjection = RevivedWire<ChainTimelineEvent>;
export type StateMachineSignalAuthorizationProjection = RevivedWire<ChainSignalAuthorization>;
export type StateMachineSignalProjection = RevivedWire<ChainSignal>;
export type StateMachineDerivedSignalProjection = RevivedWire<ChainDerivedSignal>;
export type StateMachineStageMaterializationProjection = RevivedWire<ChainStageMaterialization>;
export type StateMachineStageExecutorOverlayProjection = RevivedWire<ChainStageExecutorOverlay>;
export type StateMachineStageResourceOverlayProjection = RevivedWire<ChainStageResourceOverlay>;
export type StateMachineHookProjection = RevivedWire<ChainHook>;
export type StateMachineTaskSubmitSignalProjection = RevivedWire<ChainSubmitSignal>;
export type StateMachineTaskProjection = RevivedWire<ChainTaskProjection>;
export type StateMachineOrderProjection = RevivedWire<ChainOrderProjection>;
export type StateMachinePlanProjection = RevivedWire<ChainPlanProjection>;
export type StateMachineStageSelectorBindingProjection = RevivedWire<ChainStageSelectorBinding>;
export type StateMachineSignalCapabilityProjection = RevivedWire<ChainSignalCapability>;
export type StateMachineModuleProjection = RevivedWire<ChainModuleProjection>;
export type StateMachineDeploymentProjection = RevivedWire<ChainDeploymentProjection>;
export type ContractGovernanceProjection = RevivedWire<ChainContractGovernanceProjection>;
export type StateMachineDockProjection = RevivedWire<ChainDockProjection>;
export type ProjectionSnapshot = RevivedWire<ChainProjectionSnapshot>;

export type ProjectionSyncStatus = ChainSyncStatus;
export type ProjectionRebuildStatus = ChainRebuildStatus;
export type ProjectionSyncDiagnosticsCounts = ChainSyncDiagnosticsCounts;
export type ProjectionRebuildMetadata =
  Omit<ChainRebuildMetadata, "deploymentBlock" | "fromBlock" | "toBlock"> & {
    readonly deploymentBlock?: bigint;
    readonly fromBlock?: bigint;
    readonly toBlock?: bigint;
  };
export type ProjectionSyncState =
  Omit<ChainSyncState, "latestIndexedBlock" | "finalizedBlock" | "rebuild"> & {
    readonly latestIndexedBlock?: bigint;
    readonly finalizedBlock?: bigint;
    readonly rebuild?: ProjectionRebuildMetadata;
  };

export type StateMachineOrderStatus = ChainOrderStatus;
export type StateMachineTaskStatus = ChainTaskStatus;
export type StateMachineHookStatus = ChainHookStatus;
export type StateMachineStageExecutorPatchMode = ChainStageExecutorPatchMode;
export type StateMachineSignalTargetRelation = ChainSignalTargetRelation;
export type PlanCapabilityEnrichmentStatus = ChainPlanCapabilityEnrichmentStatus;
export type StateMachineDeploymentStatus = ChainDeploymentStatus;
export type StateMachineDockMode = ChainDockMode;

export function decodeOrderProjection(raw: unknown): StateMachineOrderProjection {
  return reviveChainProvenance(decodeContract(decodeOrderWire, raw, "order"));
}

export function decodeTaskProjection(raw: unknown): StateMachineTaskProjection {
  return reviveChainProvenance(decodeContract(decodeTaskWire, raw, "task"));
}

export function decodeSnapshotProjection(raw: ChainProjectionSnapshot): ProjectionSnapshot {
  try {
    const snapshot = decodeSnapshotWire(raw);
    const decoded: ChainProjectionSnapshot = {
      ...snapshot,
      stateMachineDeployments: decodeRecord(
        snapshot.stateMachineDeployments,
        "snapshot.stateMachineDeployments",
        decodeDeploymentWire,
      ),
      stateMachineModules: decodeRecord(
        snapshot.stateMachineModules,
        "snapshot.stateMachineModules",
        decodeModuleWire,
      ),
      contractGovernance: decodeRecord(
        snapshot.contractGovernance,
        "snapshot.contractGovernance",
        decodeContractGovernanceWire,
      ),
      stateMachinePlans: decodeRecord(
        snapshot.stateMachinePlans,
        "snapshot.stateMachinePlans",
        decodePlanWire,
      ),
      stateMachineOrders: decodeRecord(
        snapshot.stateMachineOrders,
        "snapshot.stateMachineOrders",
        decodeOrderWire,
      ),
      stateMachineDocks: decodeRecord(
        snapshot.stateMachineDocks,
        "snapshot.stateMachineDocks",
        decodeDockWire,
      ),
      stateMachineTasks: decodeRecord(
        snapshot.stateMachineTasks,
        "snapshot.stateMachineTasks",
        decodeTaskWire,
      ),
    };
    return reviveChainProvenance(decoded);
  } catch (error) {
    throw invalidProjection("projection snapshot", error);
  }
}

export function decodeSyncStateProjection(raw: unknown): ProjectionSyncState {
  const syncState = decodeContract(decodeSyncStateWire, raw, "sync state");
  const {
    latestIndexedBlock,
    finalizedBlock,
    rebuild,
    ...rest
  } = syncState;
  return {
    ...rest,
    ...(latestIndexedBlock !== undefined
      ? { latestIndexedBlock: BigInt(latestIndexedBlock) }
      : {}),
    ...(finalizedBlock !== undefined ? { finalizedBlock: BigInt(finalizedBlock) } : {}),
    ...(rebuild !== undefined ? { rebuild: reviveRebuild(rebuild) } : {}),
  };
}

function decodeRecord<TValue>(
  record: Readonly<Record<string, unknown>>,
  path: string,
  decode: (value: unknown, path?: string) => TValue,
): Readonly<Record<string, TValue>> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, decode(value, `${path}.${key}`)]),
  );
}

function decodeContract<TValue>(
  decode: (value: unknown) => TValue,
  value: unknown,
  kind: string,
): TValue {
  try {
    return decode(value);
  } catch (error) {
    throw invalidProjection(kind, error);
  }
}

function invalidProjection(kind: string, error: unknown): ChainReadError {
  if (error instanceof ChainReadError) {
    return error;
  }
  const detail = error instanceof ChainReadContractError
    ? error.message
    : String(error);
  return new ChainReadError(
    "invalid_response",
    `chain read ${kind} projection is malformed: ${detail}`,
    { retryable: false, cause: error },
  );
}

function reviveRebuild(rebuild: ChainRebuildMetadata): ProjectionRebuildMetadata {
  const { deploymentBlock, fromBlock, toBlock, ...rest } = rebuild;
  return {
    ...rest,
    ...(deploymentBlock !== undefined
      ? { deploymentBlock: BigInt(deploymentBlock) }
      : {}),
    ...(fromBlock !== undefined ? { fromBlock: BigInt(fromBlock) } : {}),
    ...(toBlock !== undefined ? { toBlock: BigInt(toBlock) } : {}),
  };
}

/** Chain JSON serializes provenance block numbers as decimal strings. */
function reviveChainProvenance<TValue>(value: TValue): RevivedWire<TValue> {
  if (Array.isArray(value)) {
    return value.map((entry) => reviveChainProvenance(entry)) as unknown as RevivedWire<TValue>;
  }
  if (!isRecord(value)) {
    return value as unknown as RevivedWire<TValue>;
  }
  if (isProvenanceLike(value)) {
    return { ...value, blockNumber: BigInt(value["blockNumber"]) } as unknown as RevivedWire<TValue>;
  }
  const revived: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      revived[key] = reviveChainProvenance(entry);
    }
  }
  return revived as unknown as RevivedWire<TValue>;
}

function isProvenanceLike(value: Record<string, unknown>): value is Record<string, string> & {
  blockNumber: string;
} {
  return (
    typeof value["chainId"] === "number" &&
    typeof value["contractAddress"] === "string" &&
    typeof value["blockNumber"] === "string" &&
    /^[0-9]+$/u.test(value["blockNumber"]) &&
    typeof value["transactionHash"] === "string" &&
    typeof value["logIndex"] === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
