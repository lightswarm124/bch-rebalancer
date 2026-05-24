import test from 'node:test';
import assert from 'node:assert/strict';

import { discoverWalletAddressPairs, fetchWalletPortfolioSnapshot } from '../src/adapters/wallet.js';

test('fetchWalletPortfolioSnapshot aggregates discovered wallet addresses', async () => {
  const mnemonic =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const pairs = discoverWalletAddressPairs({
    mnemonic,
    addressLimit: 1,
  });
  assert.equal(pairs.length, 1);

  const [pair] = pairs;
  assert.equal(pair.path, "m/44'/1'/0'/0/0");
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes(encodeURIComponent(pair.address))) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            utxos: [
              {
                tx_hash: 'aa',
                tx_pos: 0,
                satoshis: 50_000,
              },
              {
                tx_hash: 'bb',
                tx_pos: 1,
                satoshis: 2_000,
                token: { category: 'stable', amount: 80 },
              },
            ],
          }),
      };
    }
    throw new Error(`Unexpected fetch url: ${target}`);
  };

  try {
    const snapshot = await fetchWalletPortfolioSnapshot({
      baseUrl: 'http://indexer.test',
      mnemonic,
      stablecoinCategory: 'stable',
      addressLimit: 1,
      electrumServers: [],
    });

    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.wallet.utxoCount, 2);
    assert.equal(snapshot.wallet.bchSats, 52_000n);
    assert.equal(snapshot.wallet.stablecoinTokens, 80n);
    assert.equal(snapshot.totals.totalBchSats, 52_000n);
    assert.equal(snapshot.totals.totalStablecoinTokens, 80n);
    assert.equal(snapshot.scannedPairs, 1);
    assert.equal(snapshot.wallet.discoveredPairs.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});
