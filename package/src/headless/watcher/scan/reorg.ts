import type { StateMachinePublicClient } from '../../../core/signal/build.js';
import type { StateMachineCursorCheckpoint } from '../storage/cursor.js';

export const DEFAULT_FINALITY_CONFIRMATIONS = 1;
export const DEFAULT_REORG_WINDOW_BLOCKS = 64;

export async function tryGetBlockHash(client: StateMachinePublicClient, blockNumber: bigint): Promise<string | undefined> {
  if (!client.getBlock) {
    return undefined;
  }
  try {
    const block = await client.getBlock({ blockNumber });
    const hash = block?.hash;
    return typeof hash === 'string' && hash.length > 0 ? hash.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export function sameBlockHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function recordCheckpoint(
  checkpoints: StateMachineCursorCheckpoint[],
  blockNumber: bigint,
  blockHash: string,
  reorgWindow: number,
): void {
  const filtered = checkpoints.filter((checkpoint) => checkpoint.blockNumber !== blockNumber);
  filtered.push({ blockNumber, blockHash });
  filtered.sort((left, right) => (left.blockNumber < right.blockNumber ? -1 : left.blockNumber > right.blockNumber ? 1 : 0));
  const trimmed = filtered.slice(-reorgWindow);
  checkpoints.length = 0;
  checkpoints.push(...trimmed);
}

export function checkpointAnchorHeights(fromBlock: bigint, toBlock: bigint, reorgWindow: number): readonly bigint[] {
  const heights: bigint[] = [];
  for (let gap = 0n; gap <= BigInt(reorgWindow); gap = gap * 2n + 1n) {
    const height = toBlock - gap;
    if (height < fromBlock) {
      break;
    }
    heights.push(height);
  }
  return heights;
}
