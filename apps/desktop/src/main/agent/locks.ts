/**
 * V5 (ADR 0032) — Object-level run locks + queue.
 *
 * A pure, Electron-free lock manager that tracks which scene objects are held
 * by which active run. When a run requests locks that are already held, it's
 * queued; when a run releases its locks, the queue is drained and any
 * now-runnable runs are reported back so the caller can commence them.
 *
 * Extracted from `AgentManager` so the lock/queue logic is unit-testable
 * without an Electron or agent harness.
 */

/** A queued run waiting for object locks to be released. */
export interface QueuedRun<R> {
  /** The run request (opaque to the lock manager). */
  req: R;
  /** The run id (extracted from `req` by the caller's key function). */
  runId: string;
  /** The object locks the run is waiting for. */
  locks: string[];
}

/**
 * Manages object-level locks for concurrent agent runs. A run acquires locks
 * on scene objects it intends to edit; if any lock is already held, the run is
 * queued. When a run releases its locks, the queue is drained and any
 * now-runnable runs are returned so the caller can commence them.
 *
 * Runs without locks bypass the manager entirely (backward-compatible).
 */
export class RunLockManager<R> {
  /** Object id -> run id currently holding the lock. */
  private readonly held = new Map<string, string>();
  /** Runs waiting for locks to be released (FIFO). */
  private readonly queue: QueuedRun<R>[] = [];

  /**
   * Try to acquire `locks` for `runId`. Returns `true` if all locks were
   * acquired (or `locks` is empty); returns `false` if any lock is already
   * held by a *different* run (the run should be queued). A run re-acquiring
   * its own locks is a no-op success (idempotent).
   */
  tryAcquire(runId: string, locks: string[]): boolean {
    if (locks.length === 0) return true;
    const conflict = this.findConflict(locks);
    if (conflict && conflict !== runId) return false;
    for (const lock of locks) this.held.set(lock, runId);
    return true;
  }

  /**
   * Find the first run holding any of `locks`. Returns the conflicting run id,
   * or `null` when there is no conflict.
   */
  findConflict(locks: string[]): string | null {
    for (const lock of locks) {
      const holder = this.held.get(lock);
      if (holder) return holder;
    }
    return null;
  }

  /** Queue a run waiting for its locks to become available. */
  enqueue(req: R, runId: string, locks: string[]): void {
    this.queue.push({ req, runId, locks });
  }

  /** Remove a queued run by id (e.g. on cancel). Returns true if it was found. */
  cancelQueued(runId: string): QueuedRun<R> | null {
    const idx = this.queue.findIndex((q) => q.runId === runId);
    if (idx < 0) return null;
    const [removed] = this.queue.splice(idx, 1);
    return removed ?? null;
  }

  /** Number of runs currently queued. */
  get queuedCount(): number {
    return this.queue.length;
  }

  /** Whether a run id is currently queued. */
  isQueued(runId: string): boolean {
    return this.queue.some((q) => q.runId === runId);
  }

  /**
   * Release all locks held by `runId`. Returns the list of queued runs that
   * can now commence (their locks are now acquirable), in FIFO order. The
   * caller commences each returned run; runs still blocked remain in the queue.
   */
  release(runId: string): QueuedRun<R>[] {
    for (const [lock, holder] of this.held) {
      if (holder === runId) this.held.delete(lock);
    }
    return this.drainQueue();
  }

  /**
   * Scan the queue and commence any runs whose locks are now acquirable.
   * Acquires the locks for each commenced run. Runs still blocked remain
   * queued. Returns the list of runs that were commenced (in FIFO order).
   */
  private drainQueue(): QueuedRun<R>[] {
    if (this.queue.length === 0) return [];
    const remaining: QueuedRun<R>[] = [];
    const commenced: QueuedRun<R>[] = [];
    for (const queued of this.queue) {
      const conflict = queued.locks.length > 0 ? this.findConflict(queued.locks) : null;
      if (conflict) {
        remaining.push(queued);
      } else {
        // Acquire the locks + mark as commenced.
        for (const lock of queued.locks) this.held.set(lock, queued.runId);
        commenced.push(queued);
      }
    }
    this.queue.length = 0;
    this.queue.push(...remaining);
    return commenced;
  }
}
