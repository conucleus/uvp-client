/**
 * Node-only server entry: the compiler surface the used-car dock relayer
 * orchestrates (single source @uvp-eth/compiler) plus file-based evidence
 * hashing. Browser/core entries must never import this module: it deliberately
 * reaches Node fs and the DSL compiler.
 */
import { readFile } from "node:fs/promises";
import { keccak256, toHex, type Hex } from "viem";
import {
  capabilityTablesOf,
  dockInstanceId,
  evmRuntimeDomain,
  factAttribution,
  interfaceNameKey,
  keccak256Hex,
  localOrderKey,
  merkleProof,
  onchainSignalId,
  onchainSourceId,
  onchainStageId,
  orderModesWord,
  portKey,
} from "@uvp-eth/compiler";

export {
  capabilityTablesOf,
  dockInstanceId,
  evmRuntimeDomain,
  factAttribution,
  interfaceNameKey,
  keccak256Hex,
  localOrderKey,
  merkleProof,
  onchainSignalId,
  onchainSourceId,
  onchainStageId,
  orderModesWord,
  portKey,
};

export interface EvidenceFileHashResult {
  readonly algorithm: "keccak256";
  readonly evidenceHash: Hex;
  readonly byteLength: number;
  readonly source: "file";
  readonly path: string;
}

export async function hashEvidenceFile(path: string): Promise<EvidenceFileHashResult> {
  const bytes = await readFile(path);
  return {
    algorithm: "keccak256",
    evidenceHash: keccak256(toHex(bytes)),
    byteLength: bytes.byteLength,
    source: "file",
    path,
  };
}
