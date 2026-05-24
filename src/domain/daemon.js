function toBigInt(value, fallback = 0n) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value.trim()) {
    try {
      return BigInt(value.trim());
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function normalizePositiveMs(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.floor(numeric);
}

function clampBackoffMs(value, maxBackoffMs, fallback) {
  const normalized = normalizePositiveMs(value, fallback);
  return Math.min(normalized, maxBackoffMs);
}

function nowMs(now = Date.now()) {
  return Number.isFinite(now) ? Math.floor(now) : Date.now();
}

export function createDaemonState({
  pollMs = 15_000,
  backoffMs = 5_000,
  maxBackoffMs = 300_000,
} = {}) {
  const normalizedPollMs = normalizePositiveMs(pollMs, 15_000);
  const normalizedBackoffMs = normalizePositiveMs(backoffMs, 5_000);
  const normalizedMaxBackoffMs = Math.max(
    normalizedBackoffMs,
    normalizePositiveMs(maxBackoffMs, 300_000)
  );

  return {
    running: true,
    paused: false,
    pollMs: normalizedPollMs,
    backoffMs: normalizedBackoffMs,
    maxBackoffMs: normalizedMaxBackoffMs,
    stage: 'idle',
    busy: false,
    failureCount: 0,
    currentBackoffMs: normalizedBackoffMs,
    nextAttemptAt: Date.now(),
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastCheckAt: null,
    lastBroadcastAt: null,
    lastBroadcastTxid: null,
    lastBlocker: null,
    lastError: null,
    lastDecision: 'idle',
    lastRoutePoolCount: 0,
    lastRouteSlippageBps: null,
    lastQuoteAmountOut: null,
  };
}

export function daemonShouldAttempt(state, now = Date.now()) {
  const currentNow = nowMs(now);
  return Boolean(
    state?.running &&
      !state?.paused &&
      !state?.busy &&
      currentNow >= Number(state?.nextAttemptAt ?? 0)
  );
}

export function daemonStartCycle(state, { now = Date.now(), stage = 'snapshot' } = {}) {
  const currentNow = nowMs(now);
  return {
    ...state,
    stage,
    busy: true,
    lastAttemptAt: currentNow,
    lastError: null,
  };
}

export function daemonPause(state, { now = Date.now() } = {}) {
  const currentNow = nowMs(now);
  return {
    ...state,
    paused: true,
    busy: false,
    stage: 'paused',
    nextAttemptAt: null,
    lastDecision: 'paused',
    lastAttemptAt: currentNow,
  };
}

export function daemonResume(state, { now = Date.now() } = {}) {
  const currentNow = nowMs(now);
  return {
    ...state,
    paused: false,
    stage: 'idle',
    nextAttemptAt: currentNow,
    lastDecision: 'resumed',
  };
}

export function daemonMarkCycleSuccess(
  state,
  {
    now = Date.now(),
    nextAttemptAt,
    lastDecision = 'monitor',
    lastBlocker = null,
    lastRoutePoolCount = 0,
    lastRouteSlippageBps = null,
    lastQuoteAmountOut = null,
  } = {}
) {
  const currentNow = nowMs(now);
  const pollDelay = normalizePositiveMs(nextAttemptAt ?? state?.pollMs ?? 15_000, state?.pollMs ?? 15_000);
  return {
    ...state,
    busy: false,
    stage: state?.paused ? 'paused' : 'idle',
    failureCount: 0,
    currentBackoffMs: state?.backoffMs ?? 5_000,
    nextAttemptAt: state?.paused ? null : currentNow + pollDelay,
    lastSuccessAt: currentNow,
    lastCheckAt: currentNow,
    lastDecision,
    lastBlocker,
    lastError: null,
    lastRoutePoolCount: Number(lastRoutePoolCount ?? 0),
    lastRouteSlippageBps:
      lastRouteSlippageBps === null || lastRouteSlippageBps === undefined
        ? null
        : Number(lastRouteSlippageBps),
    lastQuoteAmountOut:
      lastQuoteAmountOut === null || lastQuoteAmountOut === undefined
        ? null
        : toBigInt(lastQuoteAmountOut),
  };
}

export function daemonMarkBroadcastSuccess(
  state,
  { now = Date.now(), txid = null, lastRoutePoolCount = 0, lastRouteSlippageBps = null } = {}
) {
  const currentNow = nowMs(now);
  return {
    ...state,
    busy: false,
    stage: state?.paused ? 'paused' : 'idle',
    failureCount: 0,
    currentBackoffMs: state?.backoffMs ?? 5_000,
    nextAttemptAt: state?.paused ? null : currentNow + (state?.pollMs ?? 15_000),
    lastSuccessAt: currentNow,
    lastCheckAt: currentNow,
    lastDecision: 'broadcasted',
    lastBlocker: null,
    lastError: null,
    lastBroadcastAt: currentNow,
    lastBroadcastTxid: txid ?? state?.lastBroadcastTxid ?? null,
    lastRoutePoolCount: Number(lastRoutePoolCount ?? state?.lastRoutePoolCount ?? 0),
    lastRouteSlippageBps:
      lastRouteSlippageBps === null || lastRouteSlippageBps === undefined
        ? state?.lastRouteSlippageBps ?? null
        : Number(lastRouteSlippageBps),
  };
}

export function daemonMarkCycleBlocked(
  state,
  {
    now = Date.now(),
    blocker = null,
    lastDecision = 'blocked',
    lastRoutePoolCount = 0,
    lastRouteSlippageBps = null,
    lastQuoteAmountOut = null,
  } = {}
) {
  const currentNow = nowMs(now);
  return {
    ...state,
    busy: false,
    stage: state?.paused ? 'paused' : 'idle',
    failureCount: 0,
    currentBackoffMs: state?.backoffMs ?? 5_000,
    nextAttemptAt: state?.paused ? null : currentNow + (state?.pollMs ?? 15_000),
    lastSuccessAt: currentNow,
    lastCheckAt: currentNow,
    lastDecision,
    lastBlocker: blocker,
    lastError: null,
    lastRoutePoolCount: Number(lastRoutePoolCount ?? 0),
    lastRouteSlippageBps:
      lastRouteSlippageBps === null || lastRouteSlippageBps === undefined
        ? null
        : Number(lastRouteSlippageBps),
    lastQuoteAmountOut:
      lastQuoteAmountOut === null || lastQuoteAmountOut === undefined
        ? null
        : toBigInt(lastQuoteAmountOut),
  };
}

export function daemonMarkCycleFailure(
  state,
  {
    now = Date.now(),
    error = 'Unknown daemon failure',
    lastDecision = 'failure',
    blocker = null,
  } = {}
) {
  const currentNow = nowMs(now);
  const currentBackoff = clampBackoffMs(
    state?.failureCount > 0
      ? Number(state.currentBackoffMs ?? state.backoffMs ?? 5_000) * 2
      : Number(state?.backoffMs ?? 5_000),
    state?.maxBackoffMs ?? 300_000,
    state?.backoffMs ?? 5_000
  );
  return {
    ...state,
    busy: false,
    stage: state?.paused ? 'paused' : 'backoff',
    failureCount: Number(state?.failureCount ?? 0) + 1,
    currentBackoffMs: currentBackoff,
    nextAttemptAt: state?.paused ? null : currentNow + currentBackoff,
    lastAttemptAt: currentNow,
    lastCheckAt: currentNow,
    lastDecision,
    lastBlocker: blocker,
    lastError: error instanceof Error ? error.message : String(error ?? 'Unknown daemon failure'),
  };
}

export function daemonDescribe(state, { now = Date.now() } = {}) {
  const currentNow = nowMs(now);
  const nextAttemptInMs =
    typeof state?.nextAttemptAt === 'number' ? Math.max(0, state.nextAttemptAt - currentNow) : null;
  return {
    running: Boolean(state?.running),
    paused: Boolean(state?.paused),
    stage: state?.stage ?? 'idle',
    busy: Boolean(state?.busy),
    failureCount: Number(state?.failureCount ?? 0),
    nextAttemptAt: state?.nextAttemptAt ?? null,
    nextAttemptInMs,
    lastAttemptAt: state?.lastAttemptAt ?? null,
    lastSuccessAt: state?.lastSuccessAt ?? null,
    lastCheckAt: state?.lastCheckAt ?? null,
    lastBroadcastAt: state?.lastBroadcastAt ?? null,
    lastBroadcastTxid: state?.lastBroadcastTxid ?? null,
    lastBlocker: state?.lastBlocker ?? null,
    lastError: state?.lastError ?? null,
    lastDecision: state?.lastDecision ?? 'idle',
    lastRoutePoolCount: Number(state?.lastRoutePoolCount ?? 0),
    lastRouteSlippageBps: state?.lastRouteSlippageBps ?? null,
    lastQuoteAmountOut: state?.lastQuoteAmountOut ?? null,
  };
}
