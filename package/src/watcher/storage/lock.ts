import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ExecutorKitError, ValidationError } from '../../validation.js';
import { delay, isNodeError, isProcessAlive } from '../internal.js';

/**
 * Cross-process exclusion for the jobs-file read-modify-write cycle. The whole
 * file is the store, so two processes (or two concurrent CLI invocations, e.g
 * `jobs retry` against a running watcher) reading the same base and writing
 * their own view would silently drop each other's updates — including
 * broadcasts the audit trail would then lack. The lock is an O_EXCL marker file
 * broken by pid+age (same paradigm as the state-dir lock below): a live holder
 * is never preempted however slow it is; only a dead holder (crashed) or an
 * unattributable marker aged past the stale window is taken over.
 */
const LOCK_MARKER_STALE_MS = 10_000;
const JOBS_FILE_LOCK_POLL_MS = 25;
const JOBS_FILE_LOCK_TIMEOUT_MS = 5_000;
/**
 * 获取后的静置复核窗口：被挪走/替换的占位须在进入临界区前暴露。窗口只需
 * 覆盖一次「挪走→复核→放回」的文件系统往返，取 10ms 足够且远小于锁的
 * 陈旧阈值。
 */
const LOCK_MARKER_SETTLE_MS = 10;

/** dev+ino pair: the only portable identity of "the exact file I observed". */
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
      // 观测在 stat 与读取之间被并发易主打断（inode 已变）：三元组不再
      // 描述同一把锁，作废本次观测重走循环，而不是拿着撕裂的结果去定性。
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

/**
 * 原子锁接管协议。获取走「唯一竞争文件 + link」：link 只在 lockPath 不存在
 * 时成功，不覆盖任何现存占位，也不需要先删后建的窗口。破除陈旧锁走
 * 「rename 挪走 + inode 复核」：先 rm 再 wx 的两步里，两个同时判陈旧的进程
 * 会互删对方刚建的新锁而双双持锁；rename 之后 stat 挪入的文件，inode 与判
 * 陈旧时所记一致才继续抢占，不一致（或 rename 落空 ENOENT，他人已先破）说
 * 明 lockPath 已易主——把挪走的活锁原样 link 放回（lockPath 上若有更新锁则
 * 让位，不覆盖）。三方微秒级交错的兜底：获取后静置复核一次，复核失败的
 * 占位视为被挪走，放弃并销毁自己 inode 的残余（坟场/被放回的鬼锁）。释放
 * 同样只删自己记录的 inode：被协议挪开过的持有者不会误删接管者的新锁。
 */
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
        // contender 与 lockPath 此刻同 inode；从 contender 取身份可避开
        // lockPath 上并发的易主。
        const identity = await identityOf(contenderPath);
        const atLock = await identityOf(lockPath);
        if (identity && atLock && sameLockMarkerIdentity(identity, atLock)) {
          // 静置复核：破锁方「挪走→复核→放回」若发生在此窗口内，此处能看
          // 到；仍匹配才真正持有。
          await delay(LOCK_MARKER_SETTLE_MS);
          const settled = await identityOf(lockPath);
          if (settled && sameLockMarkerIdentity(settled, identity)) {
            return () => releaseLockMarker(lockPath, identity);
          }
        }
        if (identity) {
          // link 后任一复核失败：占位已被挪走或替换。放弃本次占位并清掉
          // 自己 inode 的残余，不让破锁方稍后的放回把它变成无主鬼锁。
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
      // rename 前的最后一次复核：观察之后锁可能已被他人破除重立，此时挪走
      // 的是一把新活锁。复核与 rename 只隔一个 await，窗口收敛到相邻系统
      // 调用；万一仍被抢先，下面的挪入 inode 复核会兜底放回。
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
        // 挪走的正是判过陈旧的那把锁：清掉，回到 link 抢占。
        await rm(gravePath, { force: true }).catch(() => undefined);
        continue;
      }
      // 挪走的是易主后的活锁：放回（不覆盖任何已落位的新锁），再重走竞争。
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
  // 释放时占位已非自己：静置复核后被挪走的残余（坟场/被放回的鬼锁）由
  // 持有者自己收尾，避免无主占位永久堵住后来的竞争者。
  await cleanupDisplacedMarker(lockPath, identity);
}

/**
 * 把 rename 挪进坟场的他人活锁放回 lockPath：link 的 create-if-absent 语义
 * 天然让位，不覆盖任何已落位的新锁。放回成功才清掉坟场名（此刻它只是同一
 * inode 的多余硬链接）；放回失败时坟场条目必须保留——它是这把被挪活锁的
 * 最后一份存置，销毁等于凭空注销他人仍持着的锁（持有者还在临界区，锁位却
 * 已空置，后来者随即蜂拥而入）。保留下来的条目由原持有者的收尾路径按
 * inode 认领清理。
 */
export async function putBackDisplacedMarker(gravePath: string, lockPath: string): Promise<void> {
  try {
    await link(gravePath, lockPath);
  } catch {
    return;
  }
  await rm(gravePath, { force: true }).catch(() => undefined);
}

/**
 * 被挪走的持有者放弃/收尾时销毁仍挂着本 inode 的协议残余：坟场文件，以及
 * 被破锁方放回 lockPath 的鬼锁（持有者已不在，放回只会挡住后来者）。
 */
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
  // The jobs file may not exist yet on a first write; its directory must exist
  // before the lock marker can be created beside it.
  await mkdir(dirname(filePath), { recursive: true });
  const deadline = Date.now() + JOBS_FILE_LOCK_TIMEOUT_MS;
  let holderPid: number | undefined;
  let holderReadsAlive = false;
  const release = await acquireLockMarker(
    lockPath,
    (observed) => {
      holderPid = observed.pid;
      holderReadsAlive = observed.pid !== undefined && isProcessAlive(observed.pid);
      // pid+age（state-dir 锁同范式）：活写者不夺——暂停/慢盘超过陈旧阈值
      // 也不破锁；pid 已死即崩溃残留，立即接管；无 pid 可读退回按年龄判
      // 陈旧。等不到就由超时路径响亮失败。
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
  /** Release is idempotent: a second call is a no-op. */
  release(): Promise<void>;
}

/**
 * 进程级互斥：jobs 文件锁只串行化单次读改写，挡不住两个 watcher 进程共用同一
 * state-dir 时交错扫描与推进同一 cursor（丢事件/回绕扫描）。启动锁是 O_EXCL
 * 标记文件 + pid 存活判定：既有锁的 pid 存活即启动拒绝（报出持有者），
 * pid 不存活即崩溃残留，接管重写；无 pid 可读时退回按文件年龄判陈旧。接管
 * 本身走 acquireLockMarker 的原子协议，两个进程同时判同一把锁陈旧也只有
 * 一个能落到新锁上。
 */
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
      // 崩溃残留（pid 已死），或锁无 pid 且已老化到可判定为残留：接管重写。
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
      // 启动锁不等待：占位一律立即定性（拒绝或接管），没有轮询路径。
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
