import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPortfolioTradeLedger,
  summarizePortfolioHistory,
} from '../src/domain/portfolioJournal.js';

test('summarizePortfolioHistory computes a simple P/L track record', () => {
  const summary = summarizePortfolioHistory([
    {
      type: 'snapshot',
      totalUsd: 20_000n,
    },
    {
      type: 'snapshot',
      totalUsd: 24_000n,
    },
    {
      type: 'broadcast',
      txid: 'tx123',
      totalUsd: 24_000n,
    },
  ]);

  assert.equal(summary.points, 3);
  assert.equal(summary.trades, 1);
  assert.equal(summary.startUsd, 20_000n);
  assert.equal(summary.latestUsd, 24_000n);
  assert.equal(summary.deltaUsd, 4_000n);
  assert.equal(summary.lastTrade?.txid, 'tx123');
});

test('buildPortfolioTradeLedger reconstructs per-trade deltas from history', () => {
  const history = [
    {
      type: 'snapshot',
      timestamp: 1,
      totalUsd: 20_000n,
    },
    {
      type: 'broadcast',
      timestamp: 2,
      txid: 'tx123',
      direction: 'sell-stablecoin',
      tradeTokens: 50n,
      totalUsd: 20_000n,
      status: 'broadcasted',
    },
    {
      type: 'snapshot',
      timestamp: 3,
      totalUsd: 22_000n,
    },
    {
      type: 'broadcast',
      timestamp: 4,
      txid: 'tx456',
      direction: 'buy-stablecoin',
      tradeTokens: 25n,
      totalUsd: 22_000n,
      status: 'broadcasted',
    },
    {
      type: 'snapshot',
      timestamp: 5,
      totalUsd: 21_000n,
    },
  ];

  const ledger = buildPortfolioTradeLedger(history, {
    txHistory: [
      { tx_hash: 'tx123', height: 10 },
      { tx_hash: 'tx456', height: 0 },
    ],
  });

  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].txid, 'tx123');
  assert.equal(ledger[0].status, 'confirmed');
  assert.equal(ledger[0].chainStatus, 'confirmed');
  assert.equal(ledger[0].preUsd, 20_000n);
  assert.equal(ledger[0].postUsd, 22_000n);
  assert.equal(ledger[0].deltaUsd, 2_000n);
  assert.equal(ledger[1].txid, 'tx456');
  assert.equal(ledger[1].status, 'confirmed');
  assert.equal(ledger[1].chainStatus, 'mempool');
  assert.equal(ledger[1].preUsd, 22_000n);
  assert.equal(ledger[1].postUsd, 21_000n);
  assert.equal(ledger[1].deltaUsd, -1_000n);
});
