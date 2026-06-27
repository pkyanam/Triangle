import assert from 'node:assert/strict';
import test from 'node:test';
import { RunLockManager } from '../src/main/agent/locks.ts';

interface FakeReq {
  runId: string;
  prompt: string;
}

function req(runId: string): FakeReq {
  return { runId, prompt: 'do something' };
}

// --- tryAcquire ------------------------------------------------------------

test('tryAcquire succeeds for empty locks (no-op)', () => {
  const lm = new RunLockManager<FakeReq>();
  assert.equal(lm.tryAcquire('r1', []), true);
  assert.equal(lm.tryAcquire('r1', []), true);
});

test('tryAcquire acquires locks for a run', () => {
  const lm = new RunLockManager<FakeReq>();
  assert.equal(lm.tryAcquire('r1', ['cube', 'light']), true);
  // The same run re-acquiring its own locks is fine (idempotent).
  assert.equal(lm.tryAcquire('r1', ['cube']), true);
});

test('tryAcquire fails when a lock is held by another run', () => {
  const lm = new RunLockManager<FakeReq>();
  assert.equal(lm.tryAcquire('r1', ['cube']), true);
  assert.equal(lm.tryAcquire('r2', ['cube']), false);
  assert.equal(lm.tryAcquire('r2', ['cube', 'light']), false);
});

test('tryAcquire fails if any lock in the set is held', () => {
  const lm = new RunLockManager<FakeReq>();
  assert.equal(lm.tryAcquire('r1', ['cube']), true);
  // 'light' is free but 'cube' is held — the whole set fails.
  assert.equal(lm.tryAcquire('r2', ['light', 'cube']), false);
  // 'light' alone should still succeed for r2.
  assert.equal(lm.tryAcquire('r2', ['light']), true);
});

// --- findConflict ----------------------------------------------------------

test('findConflict returns the holder run id', () => {
  const lm = new RunLockManager<FakeReq>();
  lm.tryAcquire('r1', ['cube']);
  assert.equal(lm.findConflict(['cube']), 'r1');
  assert.equal(lm.findConflict(['light']), null);
  assert.equal(lm.findConflict(['cube', 'light']), 'r1');
});

// --- enqueue + release (queueing) -----------------------------------------

test('enqueue + release drains the queue and commences unblocked runs', () => {
  const lm = new RunLockManager<FakeReq>();
  // r1 holds 'cube'; r2 wants 'cube' — it's queued.
  lm.tryAcquire('r1', ['cube']);
  lm.enqueue(req('r2'), 'r2', ['cube']);
  assert.equal(lm.queuedCount, 1);
  assert.equal(lm.isQueued('r2'), true);

  // r1 releases — r2 should be commenced (locks re-acquired for r2).
  const commenced = lm.release('r1');
  assert.equal(commenced.length, 1);
  assert.equal(commenced[0].runId, 'r2');
  assert.equal(lm.queuedCount, 0);
  // r2 now holds 'cube'.
  assert.equal(lm.findConflict(['cube']), 'r2');
});

test('release keeps blocked runs queued when a different lock is still held', () => {
  const lm = new RunLockManager<FakeReq>();
  // r1 holds 'cube'; r2 holds 'light'; r3 wants both — it's queued.
  lm.tryAcquire('r1', ['cube']);
  lm.tryAcquire('r2', ['light']);
  lm.enqueue(req('r3'), 'r3', ['cube', 'light']);
  assert.equal(lm.queuedCount, 1);

  // r1 releases 'cube' — r3 is still blocked on 'light' (held by r2).
  const commenced1 = lm.release('r1');
  assert.equal(commenced1.length, 0);
  assert.equal(lm.queuedCount, 1);

  // r2 releases 'light' — r3 can now commence.
  const commenced2 = lm.release('r2');
  assert.equal(commenced2.length, 1);
  assert.equal(commenced2[0].runId, 'r3');
  assert.equal(lm.queuedCount, 0);
});

test('release drains multiple unblocked runs in FIFO order', () => {
  const lm = new RunLockManager<FakeReq>();
  // r1 holds 'cube'; r2 and r3 both want 'cube' — both queued.
  lm.tryAcquire('r1', ['cube']);
  lm.enqueue(req('r2'), 'r2', ['cube']);
  lm.enqueue(req('r3'), 'r3', ['cube']);
  assert.equal(lm.queuedCount, 2);

  // r1 releases — only r2 commences (it acquires 'cube'); r3 stays queued.
  const commenced = lm.release('r1');
  assert.equal(commenced.length, 1);
  assert.equal(commenced[0].runId, 'r2');
  assert.equal(lm.queuedCount, 1);
  assert.equal(lm.isQueued('r3'), true);

  // r2 releases — r3 commences.
  const commenced2 = lm.release('r2');
  assert.equal(commenced2.length, 1);
  assert.equal(commenced2[0].runId, 'r3');
  assert.equal(lm.queuedCount, 0);
});

test('release on a run with no locks returns empty (no queue effect)', () => {
  const lm = new RunLockManager<FakeReq>();
  const commenced = lm.release('r-nope');
  assert.deepEqual(commenced, []);
});

// --- cancelQueued ----------------------------------------------------------

test('cancelQueued removes a queued run and returns it', () => {
  const lm = new RunLockManager<FakeReq>();
  lm.tryAcquire('r1', ['cube']);
  lm.enqueue(req('r2'), 'r2', ['cube']);
  assert.equal(lm.isQueued('r2'), true);

  const cancelled = lm.cancelQueued('r2');
  assert.ok(cancelled);
  assert.equal(cancelled!.runId, 'r2');
  assert.equal(lm.queuedCount, 0);
  assert.equal(lm.isQueued('r2'), false);
});

test('cancelQueued returns null for a run that is not queued', () => {
  const lm = new RunLockManager<FakeReq>();
  assert.equal(lm.cancelQueued('r-nope'), null);
});

test('cancelled run is not commenced when the holder releases', () => {
  const lm = new RunLockManager<FakeReq>();
  lm.tryAcquire('r1', ['cube']);
  lm.enqueue(req('r2'), 'r2', ['cube']);
  lm.enqueue(req('r3'), 'r3', ['cube']);
  // Cancel r2 while queued.
  lm.cancelQueued('r2');
  assert.equal(lm.queuedCount, 1);

  // r1 releases — r3 (not r2) commences.
  const commenced = lm.release('r1');
  assert.equal(commenced.length, 1);
  assert.equal(commenced[0].runId, 'r3');
});

// --- backward compatibility ------------------------------------------------

test('runs without locks never interact with the lock manager', () => {
  const lm = new RunLockManager<FakeReq>();
  // No locks acquired, no queue entries — release is a no-op.
  assert.equal(lm.tryAcquire('r1', []), true);
  assert.equal(lm.queuedCount, 0);
  assert.deepEqual(lm.release('r1'), []);
});
