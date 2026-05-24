import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCauldronPoolV0LockingBytecode } from '../src/domain/cauldronPool.js';
import { buildLiveCauldronDryRun } from '../src/domain/dryrun.js';

test('buildLiveCauldronDryRun produces a validated live Cauldron transaction manifest', () => {
  const ownerPkh = '00112233445566778899aabbccddeeff00112233';
  const lockingBytecode = Buffer.from(
    buildCauldronPoolV0LockingBytecode({
      withdrawPublicKeyHash: ownerPkh,
    })
  ).toString('hex');

  const dryRun = buildLiveCauldronDryRun({
    portfolioSnapshot: {
      ok: true,
      wallet: {
        derivationPath: "m/44'/1'/0'/0/0",
        primaryAddress: 'bchtest:qqqsg7fpq3c4xz3pgc6algdm8tjst4x5jygfj4vfyw',
        primaryTokenAddress: 'bchtest:zqqsg7fpq3c4xz3pgc6algdm8tjst4x5jy0rptz0ma',
        addressPairs: [],
        utxos: [
          {
            tx_hash: 'token-utxo',
            tx_pos: 0,
            address: 'bchtest:zqqsg7fpq3c4xz3pgc6algdm8tjst4x5jy0rptz0ma',
            satoshis: 1000,
            token: { category: 'stable-token', amount: 1_000 },
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
          locking_bytecode: lockingBytecode,
          sats: 100_000_000n,
          tokens: 1_000n,
        },
      ],
    },
    oraclePriceRaw: 10_000n,
    maxSlippageBps: 20_000,
  });

  assert.equal(dryRun.setupReady, true);
  assert.equal(dryRun.marketReady, false);
  assert.equal(dryRun.pool?.shapeOk, true);
  assert.equal(dryRun.route?.poolCount, 1);
  assert.equal(dryRun.inputs.length, 2);
  assert.equal(dryRun.outputs.length >= 2, true);
  assert.equal(dryRun.transactionShape?.inputs?.[0]?.type, 'pool');
  assert.equal(dryRun.transactionShape?.pools?.[0]?.poolId, 'pool-1');
});
