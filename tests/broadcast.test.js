import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLiveCauldronBroadcastDraft, toCashscriptPoolUtxo } from '../src/domain/broadcast.js';

test('buildLiveCauldronBroadcastDraft caps the live trade for test isolation', () => {
  const ownerPkh = '00112233445566778899aabbccddeeff00112233';
  const draft = buildLiveCauldronBroadcastDraft({
    portfolioSnapshot: {
      ok: true,
      wallet: {
        derivationPath: "m/44'/1'/0'/0/0",
        primaryAddress: 'bchtest:qqqsg7fpq3c4xz3pgc6algdm8tjst4x5jygfj4vfyw',
        primaryTokenAddress: 'bchtest:zqqsg7fpq3c4xz3pgc6algdm8tjst4x5jy0rptz0ma',
        addressPairs: [
          {
            path: "m/44'/1'/0'/0/0",
            address: 'bchtest:qqqsg7fpq3c4xz3pgc6algdm8tjst4x5jygfj4vfyw',
            tokenAddress: 'bchtest:zqqsg7fpq3c4xz3pgc6algdm8tjst4x5jy0rptz0ma',
          },
        ],
        utxos: [
          {
            tx_hash: 'token-utxo',
            tx_pos: 0,
            address: 'bchtest:zqqsg7fpq3c4xz3pgc6algdm8tjst4x5jy0rptz0ma',
            satoshis: 1000,
            token: { category: 'stable-token', amount: 910 },
          },
          {
            tx_hash: 'fee-utxo',
            tx_pos: 1,
            address: 'bchtest:qqqsg7fpq3c4xz3pgc6algdm8tjst4x5jygfj4vfyw',
            satoshis: 5_000,
          },
        ],
      },
      totals: {
        totalBchSats: 6_000_000n,
        totalStablecoinTokens: 1_000n,
      },
    },
    marketSnapshot: {
      ok: true,
      tokenId: 'stable-token',
      pools: [
        {
          pool_id: 'pool-1',
          txid: 'pool-tx',
          tx_pos: 3,
          token_id: 'stable-token',
          owner_pkh: ownerPkh,
          sats: 371_600_088n,
          tokens: 37_160n,
        },
      ],
    },
    oraclePriceRaw: 10_000n,
    tradeTokenCap: 100n,
    maxSlippageBps: 200,
  });

  assert.equal(draft.ok, true);
  assert.equal(draft.direction, 'sell-stablecoin');
  assert.equal(draft.cappedTradeTokens, '100');
  assert.equal(draft.selectedPoolId, 'pool-1');
  assert.equal(draft.route?.poolCount, 1);
  assert.ok(draft.poolAddress);
  assert.ok(draft.poolOutput);
  assert.equal(draft.transactionPreview?.inputs?.[0]?.type, 'pool');
  assert.equal(draft.walletInputs.length, 2);
});

test('toCashscriptPoolUtxo normalizes live pool reserve fields', () => {
  const utxo = toCashscriptPoolUtxo(
    {
      txid: 'pool-tx',
      tx_pos: 3,
      sats: 371_600_088n,
      tokens: 37_160n,
    },
    'stable-token'
  );

  assert.equal(utxo.txid, 'pool-tx');
  assert.equal(utxo.vout, 3);
  assert.equal(utxo.satoshis, 371_600_088n);
  assert.equal(utxo.token?.category, 'stable-token');
  assert.equal(utxo.token?.amount, 37_160n);
});
