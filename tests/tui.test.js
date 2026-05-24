import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTuiFrame } from '../src/tui/render.js';

test('renderTuiFrame includes the key sections', () => {
  const text = renderTuiFrame({
    indexerHealth: {
      ok: true,
      payload: { chain_tip: 302432, indexed_height: 302432, version: '0.2.0' },
    },
    oracle: { source: 'fallback', priceValue: 100 },
    market: {
      tokenId: 'token-id',
      tokenRow: {
        display_name: 'ParyonUSD (chipnet-16)',
        display_symbol: 'PUSDTEST',
        price_now_usd: 1.86,
        price_24h_usd: 1.81,
        price_7d_usd: 1.79,
        apy_30d_bp: 301,
        tvl_sats: 4_945_148_590,
        decimals: 2,
        trade_count: 19,
        score_rank: 1,
        bcmr: {
          name: 'ParyonUSD',
          token: { symbol: 'PUSDTEST' },
          uris: {
            web: 'https://example.com',
            icon: 'https://example.com/icon.png',
          },
        },
      },
      priceRaw: 4940.553874896346,
      aggregatedApy: { apy: '3.0139' },
      poolIds: ['pool-1', 'pool-2'],
      pools: [
        {
          pool_id: 'pool-1',
          sats: 2_500_000_000,
          tokens: 500_000,
          owner_p2pkh_addr: 'bchtest:qqexamplepoolone',
          txid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          tx_pos: 0,
          locking_bytecode: '76a914abcdef0123456789abcdef0123456789abcdef0188ac',
        },
        {
          pool_id: 'pool-2',
          sats: 2_445_148_590,
          tokens: 500_930,
          owner_p2pkh_addr: 'bchtest:qqexamplepooltwo',
          txid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          tx_pos: 1,
          locking_bytecode: '76a9140123456789abcdef0123456789abcdef0123456788ac',
        },
      ],
    },
    portfolio: {
      ok: true,
      health: { payload: { status: 'healthy' } },
      contract: {
        utxoCount: 2,
        bchSats: 100_000_000n,
        stablecoinTokens: 100n,
      },
      treasury: {
        utxoCount: 2,
        bchSats: 25_000_000n,
        stablecoinTokens: 20n,
        nftCount: 1,
      },
      totals: {
        totalBchSats: 125_000_000n,
        totalStablecoinTokens: 120n,
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
    preflight: {
      readyToExecute: true,
      canBroadcast: false,
      broadcastBlocker: 'Broadcast execution is not implemented yet',
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
      lastBroadcastTxid: 'tx123',
    },
    rebalance: {
      bchUsd: 10_000n,
      stablecoinUsd: 12_000n,
      totalUsd: 22_000n,
      targetUsd: 11_000n,
      bchWeightBps: 4545n,
      stableWeightBps: 5454n,
      formatted: {
        headline: 'Sell stablecoin for BCH',
        details: 'Trade: 10.00 stable | Expected BCH out: 10,000,000 sats | Imbalance: $100.00 -> $50.00 | Slippage cap: 150 bps',
      },
      reason: 'Stablecoin is overweight versus BCH',
    },
    status: 'ok',
    tick: 1,
    uiState: { view: 'overview' },
  });

  assert.match(text, /BCH Rebalancer/);
  assert.match(text, /Tabs:.*\[overview\]/);
  assert.match(text, /^Overview$/m);
  assert.match(text, /Balance:/);
  assert.match(text, /Opportunity:/);
  assert.match(text, /Trade:/);
  assert.match(text, /Tx:/);
  assert.doesNotMatch(text, /Selection:/);
  assert.doesNotMatch(text, /^Pools$/m);

  const historyText = renderTuiFrame({
    indexerHealth: {
      ok: true,
      payload: { chain_tip: 302432, indexed_height: 302432, version: '0.2.0' },
    },
    oracle: { source: 'fallback', priceValue: 100 },
    market: {
      tokenId: 'token-id',
      tokenRow: {
        display_name: 'ParyonUSD (chipnet-16)',
        display_symbol: 'PUSDTEST',
        price_now_usd: 1.86,
        price_24h_usd: 1.81,
        price_7d_usd: 1.79,
        apy_30d_bp: 301,
        tvl_sats: 4_945_148_590,
        decimals: 2,
        trade_count: 19,
        score_rank: 1,
        bcmr: {
          name: 'ParyonUSD',
          token: { symbol: 'PUSDTEST' },
          uris: {
            web: 'https://example.com',
            icon: 'https://example.com/icon.png',
          },
        },
      },
      priceRaw: 4940.553874896346,
      aggregatedApy: { apy: '3.0139' },
      poolIds: ['pool-1', 'pool-2'],
      pools: [
        {
          pool_id: 'pool-1',
          sats: 2_500_000_000,
          tokens: 500_000,
          owner_p2pkh_addr: 'bchtest:qqexamplepoolone',
          txid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          tx_pos: 0,
          locking_bytecode: '76a914abcdef0123456789abcdef0123456789abcdef0188ac',
        },
      ],
    },
    portfolio: {
      ok: true,
      health: { payload: { status: 'healthy' } },
      contract: { utxoCount: 2, bchSats: 100_000_000n, stablecoinTokens: 100n },
      treasury: { utxoCount: 2, bchSats: 25_000_000n, stablecoinTokens: 20n, nftCount: 1 },
      totals: { totalBchSats: 125_000_000n, totalStablecoinTokens: 120n },
      historySummary: {
        points: 12,
        trades: 2,
        startUsd: 20_000n,
        latestUsd: 24_000n,
        deltaUsd: 4_000n,
        deltaPct: 20,
        lastTrade: { txid: 'tx123', type: 'broadcast' },
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
    preflight: {
      readyToExecute: true,
      canBroadcast: false,
      broadcastBlocker: 'Broadcast execution is not implemented yet',
      plan: { headline: 'Sell stablecoin for BCH', details: 'Trade: 10.00 stable' },
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
      lastBroadcastTxid: 'tx123',
    },
    rebalance: {
      bchUsd: 10_000n,
      stablecoinUsd: 12_000n,
      totalUsd: 22_000n,
      targetUsd: 11_000n,
      bchWeightBps: 4545n,
      stableWeightBps: 5454n,
      formatted: {
        headline: 'Sell stablecoin for BCH',
        details: 'Trade: 10.00 stable | Expected BCH out: 10,000,000 sats | Imbalance: $100.00 -> $50.00 | Slippage cap: 150 bps',
      },
      reason: 'Stablecoin is overweight versus BCH',
    },
    status: 'ok',
    tick: 1,
    uiState: { view: 'history' },
  });
  assert.match(historyText, /Tabs:.*\[history\]/);
  assert.match(historyText, /^History$/m);
  assert.match(historyText, /Tx history/);
  assert.match(historyText, /Recent:\s+1\. tx123/);
  assert.doesNotMatch(historyText, /Selection:/);

  const poolsText = renderTuiFrame({
    indexerHealth: {
      ok: true,
      payload: { chain_tip: 302432, indexed_height: 302432, version: '0.2.0' },
    },
    oracle: { source: 'fallback', priceValue: 100 },
    market: {
      tokenId: 'token-id',
      tokenRow: {
        display_name: 'ParyonUSD (chipnet-16)',
        display_symbol: 'PUSDTEST',
        price_now_usd: 1.86,
        price_24h_usd: 1.81,
        price_7d_usd: 1.79,
        apy_30d_bp: 301,
        tvl_sats: 4_945_148_590,
        decimals: 2,
        trade_count: 19,
        score_rank: 1,
        bcmr: {
          name: 'ParyonUSD',
          token: { symbol: 'PUSDTEST' },
          uris: {
            web: 'https://example.com',
            icon: 'https://example.com/icon.png',
          },
        },
      },
      priceRaw: 4940.553874896346,
      aggregatedApy: { apy: '3.0139' },
      poolIds: ['pool-1', 'pool-2'],
      pools: [
        {
          pool_id: 'pool-1',
          sats: 2_500_000_000,
          tokens: 500_000,
          owner_p2pkh_addr: 'bchtest:qqexamplepoolone',
          txid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          tx_pos: 0,
          locking_bytecode: '76a914abcdef0123456789abcdef0123456789abcdef0188ac',
        },
        {
          pool_id: 'pool-2',
          sats: 2_445_148_590,
          tokens: 500_930,
          owner_p2pkh_addr: 'bchtest:qqexamplepooltwo',
          txid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          tx_pos: 1,
          locking_bytecode: '76a9140123456789abcdef0123456789abcdef0123456788ac',
        },
      ],
    },
    portfolio: {
      ok: true,
      health: { payload: { status: 'healthy' } },
      contract: {
        utxoCount: 2,
        bchSats: 100_000_000n,
        stablecoinTokens: 100n,
      },
      treasury: {
        utxoCount: 2,
        bchSats: 25_000_000n,
        stablecoinTokens: 20n,
        nftCount: 1,
      },
      totals: {
        totalBchSats: 125_000_000n,
        totalStablecoinTokens: 120n,
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
    preflight: {
      readyToExecute: true,
      canBroadcast: false,
      broadcastBlocker: 'Broadcast execution is not implemented yet',
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
      lastBroadcastTxid: 'tx123',
    },
    rebalance: {
      bchUsd: 10_000n,
      stablecoinUsd: 12_000n,
      totalUsd: 22_000n,
      targetUsd: 11_000n,
      bchWeightBps: 4545n,
      stableWeightBps: 5454n,
      formatted: {
        headline: 'Sell stablecoin for BCH',
        details: 'Trade: 10.00 stable | Expected BCH out: 10,000,000 sats | Imbalance: $100.00 -> $50.00 | Slippage cap: 150 bps',
      },
      reason: 'Stablecoin is overweight versus BCH',
    },
    status: 'ok',
    tick: 1,
    uiState: { view: 'pools' },
  });
  assert.match(poolsText, /Tabs:.*\[pools\]/);
  assert.match(poolsText, /^Pools$/m);
  assert.doesNotMatch(poolsText, /Selection:/);
  assert.doesNotMatch(poolsText, /Focused:/);
  assert.match(poolsText, /routing automatic/);
  assert.doesNotMatch(poolsText, /arrows\/jk select pool/);
});
