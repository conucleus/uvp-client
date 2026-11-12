/**
 * Node-only server entry: server-side compiler primitives (single source
 * @uvp-eth/compiler) plus file-based evidence hashing. Browser/core entries
 * must never import this module: it deliberately reaches Node fs and the DSL
 * compiler.
 */
import { readFile } from "node:fs/promises";
import { keccak256, toHex, type Hex } from "viem";
import {
  capabilityTablesOf,
  factAttribution,
  keccak256Hex,
  merkleProof,
  onchainSignalId,
  onchainSourceId,
  onchainStageId,
} from "@uvp-eth/compiler";

export {
  capabilityTablesOf,
  factAttribution,
  keccak256Hex,
  merkleProof,
  onchainSignalId,
  onchainSourceId,
  onchainStageId,
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
