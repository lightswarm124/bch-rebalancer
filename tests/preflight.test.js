import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLiveRebalancePreflight } from '../src/domain/preflight.js';
import { buildBestPoolTradeRoute, selectBestPoolQuote } from '../src/domain/swap.js';

test('buildLiveRebalancePreflight blocks execution when the live quote breaches slippage caps', () => {
  const preflight = buildLiveRebalancePreflight({
    portfolioSnapshot: {
      ok: true,
      wallet: {
        derivationPath: "m/44'/1'/0'/0/0",
        primaryAddress: 'bchtest:qqqsg7fpq3c4xz3pgc6algdm8tjst4x5jygfj4vfyw',
        primaryTokenAddress: 'bchtest:zqqsg7fpq3c4xz3pgc6algdm8tjst4x5jy0rptz0ma',
        bchSats: 5_000_000n,
        stablecoinTokens: 1_000n,
        addressPairs: [
          {
            path: "m/44'/1'/0'/0/0",
            address: 'bchtest:qqqsg7fpq3c4xz3pgc6algdm8tjst4x5jygfj4vfyw',
            tokenAddress: 'bchtest:zqqsg7fpq3c4xz3pgc6algdm8tjst4x5jy0rptz0ma',
          },
        ],
      },
      totals: {
        totalBchSats: 5_000_000n,
        totalStablecoinTokens: 1_000n,
      },
    },
    marketSnapshot: {
      ok: true,
      tokenId: 'stable-token',
      pools: [
        {
          pool_id: 'pool-1',
          poolAddress: 'bchtest:pool',
          sats: 100_000_000n,
          tokens: 1_000n,
          token_id: 'stable-token',
        },
      ],
    },
    oraclePriceRaw: 10_000n,
  });

  assert.equal(preflight.ok, false);
  assert.equal(preflight.readyToExecute, false);
  assert.equal(preflight.canBroadcast, false);
  assert.equal(preflight.broadcastBlocker, 'Broadcast execution is not implemented yet');
  assert.equal(preflight.wallet?.primaryAddress, 'bchtest:qqqsg7fpq3c4xz3pgc6algdm8tjst4x5jygfj4vfyw');
  assert.equal(preflight.market?.poolId, 'pool-1');
  assert.equal(preflight.plan?.headline, 'Sell stablecoin for BCH');
  assert.ok(
    preflight.blockers.some((entry) => entry.includes('Pool slippage')),
    'expected a slippage blocker'
  );
  assert.equal(preflight.quoteCandidates?.length, 1);
  assert.equal(preflight.quoteCandidates?.[0]?.poolId, 'pool-1');
  assert.ok(preflight.quote);
});

test('buildLiveRebalancePreflight blocks tiny trades that do not clear the minimum net benefit after fees', () => {
  const preflight = buildLiveRebalancePreflight({
    portfolioSnapshot: {
      ok: true,
      wallet: {
        derivationPath: "m/44'/1'/0'/0/0",
        primaryAddress: 'bchtest:qqqsg7fpq3c4xz3pgc6algdm8tjst4x5jygfj4vfyw',
        primaryTokenAddress: 'bchtest:zqqsg7fpq3c4xz3pgc6algdm8tjst4x5jy0rptz0ma',
        bchSats: 10_000n,
        stablecoinTokens: 15n,
        addressPairs: [
          {
            path: "m/44'/1'/0'/0/0",
            address: 'bchtest:qqqsg7fpq3c4xz3pgc6algdm8tjst4x5jygfj4vfyw',
            tokenAddress: 'bchtest:zqqsg7fpq3c4xz3pgc6algdm8tjst4x5jy0rptz0ma',
          },
        ],
      },
      totals: {
        totalBchSats: 10_000n,
        totalStablecoinTokens: 15n,
      },
    },
    marketSnapshot: {
      ok: true,
      tokenId: 'stable-token',
      pools: [
        {
          pool_id: 'pool-1',
          poolAddress: 'bchtest:pool',
          sats: 100_000_000n,
          tokens: 1_000_000n,
          token_id: 'stable-token',
        },
      ],
    },
    oraclePriceRaw: 10_000n,
    maxSlippageBps: 10_000,
  });

  assert.equal(preflight.readyToExecute, false);
  assert.equal(preflight.canBroadcast, false);
  assert.ok(
    preflight.blockers.some((entry) => entry.includes('minimum')),
    `expected minimum-net-benefit blocker, got ${preflight.blockers.join('; ')}`
  );
  assert.ok(preflight.economics);
  assert.ok(BigInt(preflight.economics.netBenefitCents) < BigInt(preflight.economics.minimumNetBenefitCents));
});

test('selectBestPoolQuote prefers the pool with the best output for the trade direction', () => {
  const best = selectBestPoolQuote({
    pools: [
      {
        pool_id: 'pool-a',
        sats: 100_000_000n,
        tokens: 1_000n,
      },
      {
        pool_id: 'pool-b',
        sats: 1_000_000_000n,
        tokens: 1_000n,
      },
    ],
    direction: 'sell-stablecoin',
    amountIn: 100n,
    oraclePriceRaw: 10_000n,
  });

  assert.equal(best?.poolId, 'pool-b');
  assert.ok(best?.quote.amountOut > 0n);
});

test('buildBestPoolTradeRoute chooses a multi-pool route when it improves execution', () => {
  const route = buildBestPoolTradeRoute({
    pools: [
      {
        pool_id: 'pool-a',
        txid: 'aa'.repeat(32),
        tx_pos: 0,
        owner_pkh: '00112233445566778899aabbccddeeff00112233',
        sats: 100_000_000n,
        tokens: 1_000n,
      },
      {
        pool_id: 'pool-b',
        txid: 'bb'.repeat(32),
        tx_pos: 1,
        owner_pkh: '00112233445566778899aabbccddeeff00112233',
        sats: 200_000_000n,
        tokens: 2_000n,
      },
    ],
    direction: 'sell-stablecoin',
    amountIn: 100n,
    targetStablecoinAmount: 100n,
    oraclePriceRaw: 10_000n,
    stablecoinCategory: 'stable-token',
    feeRate: 30n,
  });

  assert.equal(route?.ok, true);
  assert.equal(route?.poolCount, 2);
  assert.equal(route?.poolIds?.length, 2);
  assert.ok(route?.routeDemand > 0n);
});
