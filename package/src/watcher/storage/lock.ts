import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ExecutorKitError, ValidationError } from '../../validation.js';
import { delay, isNodeError, isProcessAlive } from '../internal.js';

const LOCK_MARKER_STALE_MS = 10_000;
const JOBS_FILE_LOCK_POLL_MS = 25;
const JOBS_FILE_LOCK_TIMEOUT_MS = 5_000;
const LOCK_MARKER_SETTLE_MS = 10;

interface LockMarkerIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface ObservedLockMarker {
  readonly identity: LockMarkerIdentity;
  readonly mtimeMs: number;
  readonly pid: number | undefined;
}

type LockMarkerDecision =
  | { readonly kind: 'break' }
  | { readonly kind: 'wait' }
  | { readonly kind: 'refuse'; readonly error: Error };

async function identityOf(path: string): Promise<LockMarkerIdentity | undefined> {
  try {
    const info = await stat(path);
    return { dev: info.dev, ino: info.ino };
  } catch {
    return undefined;
  }
}

function sameLockMarkerIdentity(left: LockMarkerIdentity, right: LockMarkerIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function observeLockMarker(lockPath: string): Promise<ObservedLockMarker | undefined> {
  try {
    const info = await stat(lockPath);
    const pid = await readLockMarkerPid(lockPath);
    const after = await stat(lockPath);
    if (after.dev !== info.dev || after.ino !== info.ino) {
      return undefined;
    }
    return {
      identity: { dev: info.dev, ino: info.ino },
      mtimeMs: info.mtimeMs,
      pid,
    };
  } catch {
    return undefined;
  }
}

async function readLockMarkerPid(lockPath: string): Promise<number | undefined> {
  try {
    const content = await readFile(lockPath, 'utf8');
    const pid = Number.parseInt(content.trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function acquireLockMarker(
  lockPath: string,
  decide: (
    observed: ObservedLockMarker,
    contentionRounds: number,
  ) => Promise<LockMarkerDecision> | LockMarkerDecision,
  onContention: () => Promise<void>,
): Promise<() => Promise<void>> {
  const contenderPath = `${lockPath}.contend-${process.pid}-${randomUUID()}`;
  await writeFile(contenderPath, `${process.pid}\n`, { flag: 'wx' });
  try {
    let contentionRounds = 0;
    for (;;) {
      try {
        await link(contenderPath, lockPath);
        const identity = await identityOf(contenderPath);
        const atLock = await identityOf(lockPath);
        if (identity && atLock && sameLockMarkerIdentity(identity, atLock)) {
          await delay(LOCK_MARKER_SETTLE_MS);
          const settled = await identityOf(lockPath);
          if (settled && sameLockMarkerIdentity(settled, identity)) {
            return () => releaseLockMarker(lockPath, identity);
          }
        }
        if (identity) {
          await cleanupDisplacedMarker(lockPath, identity);
        }
        continue;
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') {
          throw error;
        }
      }
      const observed = await observeLockMarker(lockPath);
      if (!observed) {
        continue;
      }
      const decision = await decide(observed, contentionRounds);
      contentionRounds += 1;
      if (decision.kind === 'wait') {
        await onContention();
        continue;
      }
      if (decision.kind === 'refuse') {
        throw decision.error;
      }
      const gravePath = `${contenderPath}.broken`;
      const beforeRename = await identityOf(lockPath);
      if (!beforeRename || !sameLockMarkerIdentity(beforeRename, observed.identity)) {
        continue;
      }
      try {
        await rename(lockPath, gravePath);
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          continue;
        }
        throw error;
      }
      const moved = await identityOf(gravePath);
      if (moved && sameLockMarkerIdentity(moved, observed.identity)) {
        await rm(gravePath, { force: true }).catch(() => undefined);
        continue;
      }
      if (moved) {
        await putBackDisplacedMarker(gravePath, lockPath);
      }
    }
  } finally {
    await rm(contenderPath, { force: true }).catch(() => undefined);
  }
}

async function releaseLockMarker(lockPath: string, identity: LockMarkerIdentity): Promise<void> {
  const current = await identityOf(lockPath);
  if (current && sameLockMarkerIdentity(current, identity)) {
    await rm(lockPath, { force: true }).catch(() => undefined);
    return;
  }
  await cleanupDisplacedMarker(lockPath, identity);
}

export async function putBackDisplacedMarker(gravePath: string, lockPath: string): Promise<void> {
  try {
    await link(gravePath, lockPath);
  } catch {
    return;
  }
  await rm(gravePath, { force: true }).catch(() => undefined);
}

async function cleanupDisplacedMarker(lockPath: string, identity: LockMarkerIdentity): Promise<void> {
  const currentAtLock = await identityOf(lockPath);
  if (currentAtLock && sameLockMarkerIdentity(currentAtLock, identity)) {
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
  let names: readonly string[];
  try {
    names = await readdir(dirname(lockPath));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.includes('.contend-') || !name.endsWith('.broken')) {
      continue;
    }
    const gravePath = join(dirname(lockPath), name);
    const graveIdentity = await identityOf(gravePath);
    if (graveIdentity && sameLockMarkerIdentity(graveIdentity, identity)) {
      await rm(gravePath, { force: true }).catch(() => undefined);
    }
  }
}

export async function withJobsFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  await mkdir(dirname(filePath), { recursive: true });
  const deadline = Date.now() + JOBS_FILE_LOCK_TIMEOUT_MS;
  let holderPid: number | undefined;
  let holderReadsAlive = false;
  const release = await acquireLockMarker(
    lockPath,
    (observed) => {
      holderPid = observed.pid;
      holderReadsAlive = observed.pid !== undefined && isProcessAlive(observed.pid);
      if (holderReadsAlive) {
        return { kind: 'wait' };
      }
      const stale = observed.pid !== undefined || Date.now() - observed.mtimeMs > LOCK_MARKER_STALE_MS;
      return stale ? { kind: 'break' } : { kind: 'wait' };
    },
    async () => {
      if (Date.now() >= deadline) {
        throw new ExecutorKitError(
          `timed out acquiring the jobs file lock ${lockPath}: another process holds it`
            + (holderPid !== undefined ? ` (holder pid ${holderPid}${holderReadsAlive ? ' reads alive' : ''})` : '')
            + '; a live writer is never preempted — wait for it to finish or stop that process',
        );
      }
      await delay(JOBS_FILE_LOCK_POLL_MS);
    },
  );
  try {
    return await operation();
  } finally {
    await release();
  }
}

export const WATCHER_STATE_DIR_LOCK_FILE_NAME = 'watcher.lock';

export interface WatcherStateDirLock {
  readonly lockPath: string;
  readonly pid: number;
  release(): Promise<void>;
}

export async function acquireWatcherStateDirLock(stateDir: string): Promise<WatcherStateDirLock> {
  if (!stateDir || stateDir.trim().length === 0) {
    throw new ValidationError('state dir path is required');
  }
  await mkdir(stateDir, { recursive: true });
  const lockPath = join(stateDir, WATCHER_STATE_DIR_LOCK_FILE_NAME);
  let released = false;
  const releaseMarker = await acquireLockMarker(
    lockPath,
    (observed, contentionRounds) => {
      if (contentionRounds >= 3) {
        return { kind: 'refuse', error: new ExecutorKitError(
          `timed out acquiring the watcher state dir lock ${lockPath}: the existing lock could not be taken over`,
        ) };
      }
      if (observed.pid !== undefined && isProcessAlive(observed.pid)) {
        return { kind: 'refuse', error: new ExecutorKitError(
          `watcher state dir ${stateDir} is locked by running process ${observed.pid} (${lockPath});`
          + ' concurrent watchers must not share one state dir, stop the holder first',
        ) };
      }
      const takeOver = observed.pid !== undefined || Date.now() - observed.mtimeMs > LOCK_MARKER_STALE_MS;
      if (!takeOver) {
        return { kind: 'refuse', error: new ExecutorKitError(
          `watcher state dir lock ${lockPath} holds no readable pid and is not stale yet;`
          + ' after confirming no watcher is running, remove the file and retry',
        ) };
      }
      return { kind: 'break' };
    },
    async () => {
      throw new ExecutorKitError(
        `timed out acquiring the watcher state dir lock ${lockPath}: another watcher contended for it`,
      );
    },
  );
  return {
    lockPath,
    pid: process.pid,
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      await releaseMarker();
    },
  };
}
