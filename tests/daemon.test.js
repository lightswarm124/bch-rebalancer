import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDaemonState,
  daemonDescribe,
  daemonMarkBroadcastSuccess,
  daemonMarkCycleBlocked,
  daemonMarkCycleFailure,
  daemonMarkCycleSuccess,
  daemonPause,
  daemonResume,
  daemonShouldAttempt,
} from '../src/domain/daemon.js';

test('daemon state transitions cover pause, resume, and toggles', () => {
  const initial = createDaemonState({
    pollMs: 5_000,
    backoffMs: 1_000,
    maxBackoffMs: 8_000,
  });

  assert.equal(initial.running, true);
  assert.equal(initial.paused, false);

  const paused = daemonPause(initial, { now: 1_000 });
  assert.equal(paused.paused, true);
  assert.equal(paused.stage, 'paused');
  assert.equal(paused.nextAttemptAt, null);
  assert.equal(daemonShouldAttempt(paused, 1_000), false);

  const resumed = daemonResume(paused, { now: 2_000 });
  assert.equal(resumed.paused, false);
  assert.equal(resumed.stage, 'idle');
  assert.equal(resumed.nextAttemptAt, 2_000);
  assert.equal(daemonShouldAttempt(resumed, 2_000), true);
});

test('daemon state tracks success, blocked, and failure backoff', () => {
  const base = createDaemonState({
    pollMs: 5_000,
    backoffMs: 1_000,
    maxBackoffMs: 8_000,
  });

  const success = daemonMarkCycleSuccess(base, {
    now: 10_000,
    lastDecision: 'monitor',
    lastBlocker: 'No rebalance required',
    lastRoutePoolCount: 2,
    lastRouteSlippageBps: 12,
    lastQuoteAmountOut: 1234n,
  });
  assert.equal(success.failureCount, 0);
  assert.equal(success.stage, 'idle');
  assert.equal(success.lastDecision, 'monitor');
  assert.equal(success.lastBlocker, 'No rebalance required');
  assert.equal(success.lastRoutePoolCount, 2);
  assert.equal(success.lastRouteSlippageBps, 12);
  assert.equal(success.lastQuoteAmountOut, 1234n);
  assert.equal(success.nextAttemptAt, 15_000);

  const blocked = daemonMarkCycleBlocked(success, {
    now: 20_000,
    blocker: 'Outside target bands',
    lastRoutePoolCount: 1,
    lastRouteSlippageBps: 25,
    lastQuoteAmountOut: 5678n,
  });
  assert.equal(blocked.failureCount, 0);
  assert.equal(blocked.lastDecision, 'blocked');
  assert.equal(blocked.lastBlocker, 'Outside target bands');
  assert.equal(blocked.nextAttemptAt, 25_000);
  assert.equal(blocked.lastQuoteAmountOut, 5678n);

  const firstFailure = daemonMarkCycleFailure(blocked, {
    now: 30_000,
    error: new Error('network down'),
    blocker: 'Indexer unavailable',
  });
  assert.equal(firstFailure.failureCount, 1);
  assert.equal(firstFailure.stage, 'backoff');
  assert.equal(firstFailure.lastError, 'network down');
  assert.equal(firstFailure.lastBlocker, 'Indexer unavailable');
  assert.equal(firstFailure.currentBackoffMs, 1_000);
  assert.equal(firstFailure.nextAttemptAt, 31_000);

  const secondFailure = daemonMarkCycleFailure(firstFailure, {
    now: 40_000,
    error: 'retry failed',
  });
  assert.equal(secondFailure.failureCount, 2);
  assert.equal(secondFailure.currentBackoffMs, 2_000);
  assert.equal(secondFailure.nextAttemptAt, 42_000);

  const broadcasted = daemonMarkBroadcastSuccess(secondFailure, {
    now: 50_000,
    txid: 'tx123',
    lastRoutePoolCount: 3,
    lastRouteSlippageBps: 7,
  });
  assert.equal(broadcasted.failureCount, 0);
  assert.equal(broadcasted.stage, 'idle');
  assert.equal(broadcasted.lastBroadcastTxid, 'tx123');
  assert.equal(broadcasted.lastRoutePoolCount, 3);
  assert.equal(broadcasted.lastRouteSlippageBps, 7);
  assert.equal(broadcasted.nextAttemptAt, 55_000);

  const summary = daemonDescribe(broadcasted, { now: 50_000 });
  assert.equal(summary.nextAttemptInMs, 5_000);
});
