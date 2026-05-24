import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTuiModel } from '../src/tui/model.js';

test('buildTuiModel builds a compact dashboard model', () => {
  const model = buildTuiModel({
    snapshot: {
      indexerHealth: {
        ok: true,
        payload: { chain_tip: 302432, indexed_height: 302432, version: '0.2.0' },
      },
      oracle: { source: 'fallback', priceValue: 100, priceRaw: 12345n },
      market: {
        tokenId: 'token-id',
        tokenRow: {
          display_name: 'ParyonUSD (chipnet-16)',
          display_symbol: 'PUSDTEST',
          price_now_usd: 1.86,
          apy_30d_bp: 301,
          tvl_sats: 4_945_148_590,
        },
        pools: [
          {
            pool_id: 'pool-1',
            sats: 2_500_000_000,
            tokens: 500_000,
            owner_p2pkh_addr: 'bchtest:qqexamplepoolone',
          },
          {
            pool_id: 'pool-2',
            sats: 2_445_148_590,
            tokens: 500_930,
            owner_p2pkh_addr: 'bchtest:qqexamplepooltwo',
          },
        ],
      },
      portfolio: {
        wallet: {
          derivationPath: "m/44'/1'/0'/0/0",
          primaryAddress: 'bchtest:qqqsg7fpq3c4xz3pgc6algdm8tjst4x5jygfj4vfyw',
          primaryTokenAddress: 'bchtest:zqqsg7fpq3c4xz3pgc6algdm8tjst4x5jy0rptz0ma',
          utxoCount: 2,
          bchSats: 100_000_000n,
          stablecoinTokens: 100n,
          nftCount: 1,
          discoveredPairs: ['hit-1'],
        },
        totals: {
          totalBchSats: 125_000_000n,
          totalStablecoinTokens: 120n,
        },
        scannedPairs: 1,
      },
      portfolioSnapshot: {
        wallet: {
          derivationPath: "m/44'/1'/0'/0/0",
          primaryAddress: 'bchtest:qqqsg7fpq3c4xz3pgc6algdm8tjst4x5jygfj4vfyw',
          primaryTokenAddress: 'bchtest:zqqsg7fpq3c4xz3pgc6algdm8tjst4x5jy0rptz0ma',
          utxoCount: 2,
          bchSats: 100_000_000n,
          stablecoinTokens: 100n,
          nftCount: 1,
          discoveredPairs: ['hit-1'],
        },
        totals: {
          totalBchSats: 125_000_000n,
          totalStablecoinTokens: 120n,
        },
        scannedPairs: 1,
      },
      historySummary: {
        points: 12,
        trades: 2,
        startUsd: 20_000n,
        latestUsd: 24_000n,
        deltaUsd: 4_000n,
        deltaPct: 20,
        lastTrade: {
          txid: 'tx123',
          type: 'broadcast',
        },
      },
      tradeLedger: [
        {
          txid: 'tx123',
          direction: 'sell-stablecoin',
          tradeTokens: 1_000n,
          preUsd: 20_000n,
          postUsd: 24_000n,
          deltaUsd: 4_000n,
          chainStatus: 'confirmed',
          status: 'confirmed',
          estimatedFeeSats: 1_526n,
        },
      ],
      rebalance: {
        formatted: {
          headline: 'Sell stablecoin for BCH',
          details: 'Trade: 10.00 stable',
        },
        reason: 'Stablecoin is overweight versus BCH',
      },
      preflight: {
        readyToExecute: true,
        canBroadcast: false,
        plan: {
          headline: 'Sell stablecoin for BCH',
          details: 'Trade: 10.00 stable',
        },
        quote: { slippageBps: 15 },
        route: { ok: true, poolCount: 1, slippageBps: 15 },
      },
      dryRun: {
        setupReady: true,
        marketReady: true,
        blockers: [],
        route: { ok: true, poolCount: 1, slippageBps: 15 },
      },
      daemon: {
        running: true,
        paused: false,
        stage: 'idle',
        nextAttemptInMs: 5_000,
        lastBlocker: 'No rebalance required',
        lastBroadcastTxid: 'tx123',
      },
    },
    status: 'ok',
    tick: 1,
    refreshMode: 'manual',
    uiState: { view: 'pools' },
  });

  assert.equal(model.activeView, 'pools');
  assert.match(model.tabs, /overview/);
  assert.match(model.tabs, /\[pools\]/);
  assert.match(model.headerLines.join('\n'), /Tabs/);
  assert.ok(model.pools.length > 0);
  assert.match(model.overviewLines.join('\n'), /Price/);
  assert.match(model.overviewLines.join('\n'), /Balance/);
  assert.match(model.overviewLines.join('\n'), /Tx/);
  assert.match(model.overviewLines.join('\n'), /History/);
  assert.match(model.overviewLines.join('\n'), /Ledger/);
  assert.match(model.overviewLines.join('\n'), /P\/L/);
  assert.match(model.portfolioLines.join('\n'), /Wallet path/);
  assert.match(model.tokenLines.join('\n'), /ParyonUSD/);
  assert.match(model.selectedPoolLines.join('\n'), /routing across all pools/);
  assert.match(model.selectedPoolLines.join('\n'), /Route/);
  assert.match(model.portfolioLines.join('\n'), /Opportunity/);
  assert.match(model.overviewLines.join('\n'), /press Trade now or b to review and confirm trade/);
  assert.match(model.selectedPoolLines.join('\n'), /routing across all pools/);
  assert.match(model.portfolioLines.join('\n'), /Recent: 1\. tx123/);
  assert.match(model.historyLines.join('\n'), /Tx history/);
  assert.match(model.historyLines.join('\n'), /Recent: 1\. tx123/);
  assert.match(model.helpLines.join('\n'), /routing is automatic/);
  assert.doesNotMatch(model.helpLines.join('\n'), /move the pool selection/);
});

test('buildTuiModel keeps pool controls scoped to the pools tab', () => {
  const model = buildTuiModel({
    snapshot: {
      market: { pools: [{ pool_id: 'pool-1' }, { pool_id: 'pool-2' }] },
      portfolioSnapshot: {},
    },
    status: 'ok',
    tick: 1,
    refreshMode: 'manual',
    uiState: { view: 'overview' },
  });

  assert.equal(model.activeView, 'overview');
  assert.doesNotMatch(model.helpLines.join('\n'), /pool selection/);
});
