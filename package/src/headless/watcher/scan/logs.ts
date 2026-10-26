import { ValidationError } from '../../../core/validation.js';
import type { StateMachineRawLog } from '../../../core/signal/decode.js';

export const DEFAULT_GET_LOGS_BLOCK_SPAN = 9_999;

export const DEFAULT_GET_LOGS_CONCURRENCY = 4;

export async function mapWithConcurrency<TIn, TOut>(
  items: readonly TIn[],
  limit: number,
  run: (item: TIn, index: number) => Promise<TOut>,
): Promise<readonly TOut[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new ValidationError('concurrency limit must be a positive integer');
  }
  const results = new Array<TOut>(items.length);
  let nextIndex = 0;
  let failed = false;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async (): Promise<void> => {
      while (!failed && nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = await run(items[index]!, index);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function compareRawLogs(left: StateMachineRawLog, right: StateMachineRawLog): number {
  const leftBlock = left.blockNumber ?? 0n;
  const rightBlock = right.blockNumber ?? 0n;
  if (leftBlock !== rightBlock) {
    return leftBlock < rightBlock ? -1 : 1;
  }
  const leftIndex = typeof left.logIndex === 'bigint' ? left.logIndex : BigInt(Number(left.logIndex ?? 0));
  const rightIndex = typeof right.logIndex === 'bigint' ? right.logIndex : BigInt(Number(right.logIndex ?? 0));
  if (leftIndex !== rightIndex) {
    return leftIndex < rightIndex ? -1 : 1;
  }
  return String(left.address ?? '').localeCompare(String(right.address ?? ''));
}

export function blockRanges(
  fromBlock: bigint,
  toBlock: bigint,
  maxSpan: bigint,
): readonly { readonly fromBlock: bigint; readonly toBlock: bigint }[] {
  if (maxSpan < 1n) {
    throw new ValidationError('getLogsBlockSpan must be a positive number of blocks');
  }
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  for (let start = fromBlock; start <= toBlock; start = start + maxSpan) {
    const end = start + maxSpan - 1n < toBlock ? start + maxSpan - 1n : toBlock;
    ranges.push({ fromBlock: start, toBlock: end });
  }
  return ranges;
}
