import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { portfolioUsdValue } from './rebalance.js';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const JOURNAL_PATH = resolve(PROJECT_ROOT, '.cache', 'bch-rebalancer', 'portfolio-history.json');
const DEFAULT_LIMIT = 90;

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

function normalizeRecord(record) {
  const timestamp = Number(record?.timestamp ?? record?.at ?? Date.now());
  const bchSats = toBigInt(record?.bchSats ?? 0n);
  const stablecoinTokens = toBigInt(record?.stablecoinTokens ?? 0n);
  const oraclePriceRaw = toBigInt(record?.oraclePriceRaw ?? 0n);
  const hasDerivedPortfolioInputs =
    record?.bchSats !== null &&
    record?.bchSats !== undefined &&
    record?.stablecoinTokens !== null &&
    record?.stablecoinTokens !== undefined &&
    record?.oraclePriceRaw !== null &&
    record?.oraclePriceRaw !== undefined;
  const totalUsd = hasDerivedPortfolioInputs
    ? portfolioUsdValue({ bchSats, stablecoinTokens, oraclePriceRaw })
    : toBigInt(record?.totalUsd ?? 0n);
  return {
    timestamp,
    type: String(record?.type ?? 'snapshot'),
    txid: record?.txid ? String(record.txid) : null,
    direction: record?.direction ? String(record.direction) : null,
    bchSats,
    stablecoinTokens,
    oraclePriceRaw,
    totalUsd,
    priceUsd: record?.priceUsd === null || record?.priceUsd === undefined ? null : Number(record.priceUsd),
    tradeTokens: record?.tradeTokens === null || record?.tradeTokens === undefined
      ? null
      : toBigInt(record.tradeTokens),
    poolCount: Number(record?.poolCount ?? 0),
    slippageBps: record?.slippageBps === null || record?.slippageBps === undefined
      ? null
      : Number(record.slippageBps),
    estimatedFeeSats: record?.estimatedFeeSats === null || record?.estimatedFeeSats === undefined
      ? null
      : toBigInt(record.estimatedFeeSats),
    status: record?.status ? String(record.status) : null,
  };
}

function serializeRecord(record) {
  return {
    ...record,
    bchSats: record?.bchSats?.toString?.() ?? String(record?.bchSats ?? '0'),
    stablecoinTokens: record?.stablecoinTokens?.toString?.() ?? String(record?.stablecoinTokens ?? '0'),
    oraclePriceRaw: record?.oraclePriceRaw?.toString?.() ?? String(record?.oraclePriceRaw ?? '0'),
    totalUsd: record?.totalUsd?.toString?.() ?? String(record?.totalUsd ?? '0'),
    tradeTokens:
      record?.tradeTokens === null || record?.tradeTokens === undefined
        ? null
        : record.tradeTokens.toString?.() ?? String(record.tradeTokens),
    estimatedFeeSats:
      record?.estimatedFeeSats === null || record?.estimatedFeeSats === undefined
        ? null
        : record.estimatedFeeSats.toString?.() ?? String(record.estimatedFeeSats),
  };
}

async function readRawHistory() {
  try {
    const raw = await readFile(JOURNAL_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeRawHistory(entries) {
  await mkdir(dirname(JOURNAL_PATH), { recursive: true });
  await writeFile(JOURNAL_PATH, `${JSON.stringify(entries.map(serializeRecord), null, 2)}\n`, 'utf8');
}

export function getPortfolioHistoryPath() {
  return JOURNAL_PATH;
}

export async function readPortfolioHistory({ limit = DEFAULT_LIMIT } = {}) {
  const raw = await readRawHistory();
  const normalized = raw.map(normalizeRecord);
  const safeLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : DEFAULT_LIMIT;
  return normalized.slice(-safeLimit);
}

function normalizeTxHistory(txHistory = []) {
  if (!Array.isArray(txHistory)) return [];
  return txHistory.map((entry) => ({
    address: entry?.address ? String(entry.address) : null,
    tx_hash: entry?.tx_hash ? String(entry.tx_hash) : '',
    height: Number.isFinite(Number(entry?.height)) ? Number(entry.height) : 0,
    status: entry?.status ? String(entry.status) : Number(entry?.height ?? 0) > 0 ? 'confirmed' : 'mempool',
  }));
}

export function buildPortfolioTradeLedger(history = [], { txHistory = [] } = {}) {
  if (!Array.isArray(history) || history.length === 0) {
    return [];
  }

  const normalized = history.map(normalizeRecord);
  const txHistoryByTxid = new Map(
    normalizeTxHistory(txHistory)
      .filter((entry) => entry.tx_hash)
      .map((entry) => [entry.tx_hash, entry])
  );
  const ledger = [];
  const seenTxids = new Set();
  let lastSnapshot = null;

  for (let index = 0; index < normalized.length; index += 1) {
    const entry = normalized[index];
    if (entry.type !== 'broadcast') {
      lastSnapshot = entry;
      continue;
    }

    if (entry.txid && seenTxids.has(entry.txid)) {
      lastSnapshot = entry;
      continue;
    }
    if (entry.txid) {
      seenTxids.add(entry.txid);
    }

    let nextSnapshot = null;
    for (let nextIndex = index + 1; nextIndex < normalized.length; nextIndex += 1) {
      const nextEntry = normalized[nextIndex];
      if (nextEntry.type !== 'broadcast') {
        nextSnapshot = nextEntry;
        break;
      }
    }

    const preUsd = lastSnapshot?.totalUsd ?? entry.totalUsd ?? null;
    const postUsd = nextSnapshot?.totalUsd ?? null;
    const deltaUsd =
      preUsd !== null && preUsd !== undefined && postUsd !== null && postUsd !== undefined
        ? postUsd - preUsd
        : null;
    const chainHistory = txHistoryByTxid.get(entry.txid) ?? null;

    ledger.push({
      timestamp: entry.timestamp,
      txid: entry.txid,
      direction: entry.direction,
      status: nextSnapshot ? 'confirmed' : 'pending',
      chainStatus: chainHistory?.status ?? (nextSnapshot ? 'confirmed' : 'pending'),
      chainHeight: chainHistory?.height ?? null,
      broadcastStatus: entry.status ?? 'broadcasted',
      tradeTokens: entry.tradeTokens,
      poolCount: entry.poolCount,
      slippageBps: entry.slippageBps,
      estimatedFeeSats: entry.estimatedFeeSats,
      preUsd,
      postUsd,
      deltaUsd,
      priceUsd: entry.priceUsd,
      confirmedAt: nextSnapshot?.timestamp ?? null,
    });
  }

  return ledger;
}

export function summarizePortfolioHistory(history = []) {
  if (!Array.isArray(history) || history.length === 0) {
    return {
      points: 0,
      trades: 0,
      confirmedTrades: 0,
      pendingTrades: 0,
      startUsd: null,
      latestUsd: null,
      deltaUsd: null,
      deltaPct: null,
      lastTrade: null,
      realizedDeltaUsd: null,
    };
  }

  const snapshots = history.filter((entry) => entry?.type !== 'broadcast');
  const tradeLedger = buildPortfolioTradeLedger(history);
  const first = snapshots[0] ?? history[0];
  const latest = snapshots[snapshots.length - 1] ?? history[history.length - 1];
  const startUsd = toBigInt(first?.totalUsd ?? 0n);
  const latestUsd = toBigInt(latest?.totalUsd ?? 0n);
  const deltaUsd = latestUsd - startUsd;
  const deltaPct = startUsd > 0n ? Number((deltaUsd * 10_000n) / startUsd) / 100 : null;
  const lastTrade = tradeLedger[tradeLedger.length - 1] ?? null;
  const confirmedTrades = tradeLedger.filter((entry) => entry.status === 'confirmed').length;
  const pendingTrades = tradeLedger.length - confirmedTrades;
  const realizedDeltaUsd = tradeLedger.reduce(
    (accumulator, entry) => accumulator + (entry.deltaUsd ?? 0n),
    0n
  );

  return {
    points: history.length,
    trades: tradeLedger.length,
    confirmedTrades,
    pendingTrades,
    startUsd,
    latestUsd,
    deltaUsd,
    deltaPct,
    lastTrade,
    realizedDeltaUsd,
  };
}

export async function appendPortfolioHistoryRecord(record) {
  const history = await readRawHistory();
  history.push(normalizeRecord(record));
  const trimmed = history.slice(-DEFAULT_LIMIT);
  await writeRawHistory(trimmed);
  return trimmed[trimmed.length - 1] ?? null;
}
