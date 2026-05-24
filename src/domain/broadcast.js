import {
  cashAddressToLockingBytecode,
  lockingBytecodeToCashAddress,
  encodeTransaction,
} from '@bitauth/libauth';
import { binToHex } from '@cashlab/common';
import {
  ElectrumNetworkProvider,
  SignatureTemplate,
  TransactionBuilder,
} from 'cashscript';
import { calculateDust } from 'cashscript/dist/utils.js';
import { ElectrumClient } from '@electrum-cash/network';

import {
  BROADCAST_ENABLED,
  BROADCAST_FEE_RATE_SATS_PER_BYTE,
  BROADCAST_TEST_MAX_TRADE_TOKENS,
  CAULDRON_TOKEN_ID,
  DUST_THRESHOLD,
  NETWORK,
} from '../../config.js';
import {
  buildCauldronPoolV0ExchangeUnlockingBytecode,
  buildCauldronPoolV0LockingBytecode,
  validateLiveCauldronPoolShape,
  poolIdentity,
} from './cauldronPool.js';
import { buildLiveRebalancePreflight } from './preflight.js';
import { buildBestPoolTradeRoute, buildRoutePoolState, evaluatePoolQuotes, selectBestPoolQuote } from './swap.js';
import { deriveWalletKeyMaterial, DEFAULT_WALLET_ELECTRUM_SERVERS } from '../adapters/wallet.js';
import { getTokenAmount, getTokenCategory, getUtxoSats } from './portfolio.js';

const CAULDRON_NATIVE_BCH = 'bch';

function toBigInt(value, fallback = 0n) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      return BigInt(value.trim());
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function fmtBigInt(value) {
  return typeof value === 'bigint' ? value.toString() : String(value ?? '0');
}

function selectSmallestUtxos(utxos, amountNeeded, predicate = () => true) {
  const eligible = utxos
    .filter(predicate)
    .slice()
    .sort((left, right) => {
      const diff = getUtxoSats(left) - getUtxoSats(right);
      if (diff === 0n) return 0;
      return diff > 0n ? 1 : -1;
    });
  const chosen = [];
  let total = 0n;
  for (const utxo of eligible) {
    chosen.push(utxo);
    total += getUtxoSats(utxo);
    if (total >= amountNeeded) break;
  }
  return { chosen, total };
}

function selectSmallestTokenUtxos(utxos, amountNeeded, predicate = () => true) {
  const eligible = utxos
    .filter(predicate)
    .slice()
    .sort((left, right) => {
      const diff = getTokenAmount(left) - getTokenAmount(right);
      if (diff === 0n) return 0;
      return diff > 0n ? 1 : -1;
    });
  const chosen = [];
  let total = 0n;
  for (const utxo of eligible) {
    chosen.push(utxo);
    total += getTokenAmount(utxo);
    if (total >= amountNeeded) break;
  }
  return { chosen, total };
}

function toCashscriptUtxo(utxo) {
  return {
    txid: String(utxo?.tx_hash ?? utxo?.txid ?? ''),
    vout: Number(utxo?.tx_pos ?? utxo?.vout ?? 0),
    satoshis: getUtxoSats(utxo),
    token: utxo?.token
      ? {
          amount: getTokenAmount(utxo),
          category: String(getTokenCategory(utxo)),
          nft: utxo.token.nft
            ? {
                capability: utxo.token.nft.capability,
                commitment: String(utxo.token.nft.commitment ?? ''),
              }
            : undefined,
        }
      : undefined,
  };
}

function getPoolReserveSats(pool) {
  return toBigInt(pool?.sats ?? pool?.tvl_sats ?? pool?.output?.amount ?? 0);
}

function getPoolReserveTokens(pool) {
  return toBigInt(pool?.tokens ?? pool?.tvl_tokens ?? pool?.output?.token?.amount ?? 0);
}

export function toCashscriptPoolUtxo(pool, stablecoinCategory) {
  return {
    txid: String(pool?.txid ?? pool?.tx_hash ?? ''),
    vout: Number(pool?.tx_pos ?? pool?.vout ?? 0),
    satoshis: getPoolReserveSats(pool),
    token: {
      category: String(stablecoinCategory),
      amount: getPoolReserveTokens(pool),
    },
  };
}

function walletAddressLookup(wallet) {
  const lookup = new Map();
  for (const pair of wallet?.addressPairs ?? []) {
    lookup.set(pair.address, pair);
    lookup.set(pair.tokenAddress, pair);
  }
  return lookup;
}

function resolvePoolAddress(pool) {
  if (typeof pool?.poolAddress === 'string' && pool.poolAddress.trim()) {
    return pool.poolAddress;
  }
  const ownerPkh = String(pool?.owner_pkh ?? '').trim();
  if (!ownerPkh) return null;
  const lockingBytecode = Buffer.from(
    buildCauldronPoolV0LockingBytecode({ withdrawPublicKeyHash: ownerPkh })
  );
  const result = lockingBytecodeToCashAddress({
    prefix: 'bchtest',
    bytecode: lockingBytecode,
    tokenSupport: true,
  });
  if (typeof result === 'string') {
    return null;
  }
  return result.address ?? null;
}

function buildTradePoolOutput(pool, direction, amountIn, amountOut) {
  const reserveSats = getPoolReserveSats(pool);
  const reserveTokens = getPoolReserveTokens(pool);
  if (direction === 'buy-stablecoin') {
    return {
      to: resolvePoolAddress(pool),
      amount: reserveSats + amountIn,
      token: {
        category: String(pool?.token_id ?? pool?.tokenId ?? CAULDRON_TOKEN_ID),
        amount: reserveTokens - amountOut,
      },
    };
  }
  return {
    to: resolvePoolAddress(pool),
    amount: reserveSats - amountOut,
    token: {
      category: String(pool?.token_id ?? pool?.tokenId ?? CAULDRON_TOKEN_ID),
      amount: reserveTokens + amountIn,
    },
  };
}

function buildSettlementOutputs({
  direction,
  totalWalletBch,
  totalWalletTokenSupply,
  totalSupply,
  totalDemand,
  recipientAddress,
  changeAddress,
  tokenChangeAddress,
  tokenChangeCategoryHex,
  feeSatoshis,
  tokenOutputSatoshis,
}) {
  const outputs = [];

  if (direction === 'sell-stablecoin') {
    outputs.push({
      to: recipientAddress,
      amount: totalDemand,
    });

    const tokenChange = totalWalletTokenSupply - totalSupply;
    if (tokenChange < 0n) {
      throw new Error('Insufficient token funding for Cauldron trade');
    }

    let bchChange = totalWalletBch - totalSupply - feeSatoshis;
    if (tokenChange > 0n) {
      const tokenChangeTarget = tokenChangeAddress ?? changeAddress;
      if (!tokenChangeCategoryHex) {
        throw new Error('Missing token category for token change output');
      }
      outputs.push({
        to: tokenChangeTarget,
        amount: tokenOutputSatoshis,
        token: {
          category: tokenChangeCategoryHex,
          amount: tokenChange,
        },
      });
      bchChange -= tokenOutputSatoshis;
    }

    // The wallet contributes the satoshis that back the consumed token UTXO
    // plus the dedicated fee input. The token principal itself is not deducted
    // from BCH backing because it is represented separately in the token output.
    bchChange = totalWalletBch - feeSatoshis - tokenOutputSatoshis;
    if (bchChange >= DUST_THRESHOLD) {
      outputs.push({
        to: changeAddress,
        amount: bchChange,
      });
    } else if (bchChange < 0n) {
      throw new Error('Insufficient BCH funding for Cauldron fee/change backing');
    }
    return outputs;
  }

  outputs.push({
    to: recipientAddress,
    amount: tokenOutputSatoshis,
    token: {
      category: String(tokenChangeCategoryHex ?? CAULDRON_TOKEN_ID),
      amount: totalDemand,
    },
  });

  let bchChange = totalWalletBch - totalSupply - feeSatoshis - tokenOutputSatoshis;
  if (bchChange >= DUST_THRESHOLD) {
    outputs.push({
      to: changeAddress,
      amount: bchChange,
    });
  } else if (bchChange < 0n) {
    throw new Error('Insufficient BCH funding for Cauldron trade');
  }
  return outputs;
}

function getWalletPrivateKey(wallet, mnemonic = process.env.BIP39_MNEMONIC ?? '', passphrase = process.env.BIP39_PASSPHRASE ?? '') {
  const path = wallet?.derivationPath;
  if (!path) {
    throw new Error('Wallet derivation path unavailable for signing');
  }
  const keyMaterial = deriveWalletKeyMaterial({
    mnemonic,
    passphrase,
    path,
  });
  return keyMaterial.privateKey;
}

function cashlabLockingBytecodeForAddress(address) {
  const result = cashAddressToLockingBytecode(String(address ?? ''));
  if (typeof result === 'string') {
    throw new Error(`Invalid cash address: ${address}`);
  }
  return result.bytecode;
}

function buildCashlabInputCoins(walletInputs, walletPrivateKey, primaryAddress, primaryTokenAddress) {
  return walletInputs.map((utxo) => {
    const address = utxo.token ? primaryTokenAddress : primaryAddress;
    const lockingResult = cashAddressToLockingBytecode(String(address ?? ''));
    if (typeof lockingResult === 'string') {
      throw new Error(`Invalid cash address for funding input: ${address}`);
    }
    return {
      type: SpendableCoinType.P2PKH,
      key: walletPrivateKey,
      outpoint: {
        index: Number(utxo.tx_pos ?? utxo.vout ?? 0),
        txhash: Buffer.from(String(utxo.tx_hash ?? utxo.txid ?? ''), 'hex'),
      },
      output: {
        locking_bytecode: lockingResult.bytecode,
        amount: getUtxoSats(utxo),
        token: utxo.token
          ? {
              amount: getTokenAmount(utxo),
              token_id: String(getTokenCategory(utxo)),
            }
          : undefined,
      },
    };
  });
}

function buildPoolUnlocker(pool) {
  const lockingBytecode = buildCauldronPoolV0LockingBytecode({
    withdrawPublicKeyHash: pool.owner_pkh,
  });
  const unlockingBytecode = buildCauldronPoolV0ExchangeUnlockingBytecode({
    withdrawPublicKeyHash: pool.owner_pkh,
  });
  return {
    generateLockingBytecode: () => lockingBytecode,
    generateUnlockingBytecode: () => unlockingBytecode,
  };
}

function cashscriptUtxoFromWalletInput(utxo) {
  return {
    txid: String(utxo?.tx_hash ?? utxo?.txid ?? ''),
    vout: Number(utxo?.tx_pos ?? utxo?.vout ?? 0),
    satoshis: getUtxoSats(utxo),
    token: utxo?.token
      ? {
          amount: getTokenAmount(utxo),
          category: String(getTokenCategory(utxo)),
          nft: utxo.token.nft
            ? {
                capability: utxo.token.nft.capability,
                commitment: String(utxo.token.nft.commitment ?? ''),
              }
            : undefined,
        }
      : undefined,
  };
}

export function buildLiveCauldronBroadcastDraft({
  portfolioSnapshot,
  marketSnapshot,
  oraclePriceRaw,
  maxSlippageBps = 150,
  tradeTokenCap = BROADCAST_TEST_MAX_TRADE_TOKENS,
}) {
  const preflight = buildLiveRebalancePreflight({
    portfolioSnapshot,
    marketSnapshot,
    oraclePriceRaw,
    maxSlippageBps,
  });

  const wallet = portfolioSnapshot?.wallet ?? null;
  const utxos = Array.isArray(wallet?.utxos) ? wallet.utxos : [];
  const walletLookup = walletAddressLookup(wallet);
  const pools = Array.isArray(marketSnapshot?.pools) ? marketSnapshot.pools : [];
  const primaryPool = pools.find((pool) => poolIdentity(pool) === preflight.market?.poolId) ?? pools[0] ?? null;
  const poolShape = primaryPool ? validateLiveCauldronPoolShape(primaryPool) : null;
  const blockers = [...(preflight.blockers ?? [])];
  const warnings = [...(preflight.warnings ?? [])];

  if (!wallet?.primaryAddress) {
    blockers.push('No derived primary BCH address');
  }
  if (!primaryPool) {
    blockers.push('No active Cauldron pool selected');
  }
  if (primaryPool && poolShape && !poolShape.ok) {
    blockers.push(poolShape.error ?? 'Live pool locking bytecode mismatch');
  }

  const cappedTradeTokens = preflight.plan?.tradeTokens
    ? (tradeTokenCap > 0n && preflight.plan.tradeTokens > tradeTokenCap ? tradeTokenCap : preflight.plan.tradeTokens)
    : 0n;
  if (preflight.plan?.tradeTokens && cappedTradeTokens < preflight.plan.tradeTokens) {
    warnings.push(
      `Broadcast capped to ${cappedTradeTokens.toString()} tokens for test isolation`
    );
  }

  const direction = preflight.plan?.direction ?? 'hold';
  if (direction === 'hold' || cappedTradeTokens <= 0n) {
    blockers.push('No trade selected for broadcast');
  }

  const stablecoinCategory = String(marketSnapshot?.tokenId ?? CAULDRON_TOKEN_ID);
  const route =
    direction !== 'hold' && toBigInt(oraclePriceRaw) > 0n
      ? buildBestPoolTradeRoute({
          pools,
          direction,
          amountIn:
            direction === 'buy-stablecoin'
              ? preflight.plan?.expectedInputSats ?? 0n
              : cappedTradeTokens,
          targetStablecoinAmount: cappedTradeTokens,
          oraclePriceRaw: toBigInt(oraclePriceRaw),
          stablecoinCategory,
          feeRate: 30n,
        })
      : null;
  const quoteCandidates =
    direction !== 'hold' && toBigInt(oraclePriceRaw) > 0n
      ? evaluatePoolQuotes({
          pools,
          direction,
          amountIn: direction === 'buy-stablecoin' ? preflight.plan?.expectedInputSats ?? 0n : cappedTradeTokens,
          targetStablecoinAmount: cappedTradeTokens,
          oraclePriceRaw: toBigInt(oraclePriceRaw),
        })
      : [];
  const bestQuote = !route?.ok
    ? selectBestPoolQuote({
        pools,
        direction,
        amountIn:
          direction === 'buy-stablecoin'
            ? preflight.plan?.expectedInputSats ?? 0n
            : cappedTradeTokens,
        targetStablecoinAmount: cappedTradeTokens,
        oraclePriceRaw: toBigInt(oraclePriceRaw),
      })
    : null;
  const quote = route?.ok
    ? {
        fee: fmtBigInt(route.summary?.trade_fee ?? 0n),
        amountOut: fmtBigInt(route.routeDemand ?? 0n),
        nextReserveIn: fmtBigInt(route.summary?.supply ?? 0n),
        nextReserveOut: fmtBigInt(route.summary?.demand ?? 0n),
        slippageBps: route.slippageBps ?? 0,
      }
    : bestQuote?.quote ?? null;
  const slippageBps = route?.ok ? route.slippageBps ?? null : bestQuote?.slippageBps ?? null;
  if (slippageBps !== null && slippageBps > maxSlippageBps) {
    blockers.push(`Pool slippage ${slippageBps} bps exceeds cap ${maxSlippageBps} bps`);
  }

  const selectedPool = route?.entries?.[0]?.pool ?? bestQuote?.pool ?? primaryPool ?? null;
  const tradeAmount =
    direction === 'buy-stablecoin'
      ? toBigInt(preflight.plan?.expectedInputSats ?? 0n)
      : cappedTradeTokens;

  const tokenInputs =
    direction === 'sell-stablecoin'
      ? utxos.filter((utxo) => getTokenCategory(utxo) === stablecoinCategory && getTokenAmount(utxo) > 0n)
      : [];
  const bchInputs = utxos.filter((utxo) => !utxo.token || getTokenAmount(utxo) === 0n);

  let selectedTokenInputs = [];
  let selectedBchInputs = [];
  let totalWalletTokenSupply = 0n;
  let totalWalletBch = 0n;
  const setupBlockers = [];

  if (direction === 'sell-stablecoin') {
    const tokenSelection = selectSmallestTokenUtxos(tokenInputs, tradeAmount);
    selectedTokenInputs = tokenSelection.chosen;
    totalWalletTokenSupply = tokenSelection.total;
    if (totalWalletTokenSupply < tradeAmount) {
      setupBlockers.push('Token inputs do not cover the planned capped stablecoin trade amount');
    }

    const feeSelection = selectSmallestUtxos(
      bchInputs,
      DUST_THRESHOLD * 3n,
      (utxo) => getUtxoSats(utxo) >= DUST_THRESHOLD
    );
    selectedBchInputs = feeSelection.chosen;
    if (selectedBchInputs.length === 0) {
      setupBlockers.push('No BCH-only fee input available for token-to-BCH broadcast');
    }
    totalWalletBch =
      selectedTokenInputs.reduce((sum, utxo) => sum + getUtxoSats(utxo), 0n) +
      selectedBchInputs.reduce((sum, utxo) => sum + getUtxoSats(utxo), 0n);
  } else if (direction === 'buy-stablecoin') {
    const bchSelection = selectSmallestUtxos(
      bchInputs,
      toBigInt(preflight.plan?.expectedInputSats ?? 0n) + DUST_THRESHOLD * 3n,
      () => true
    );
    selectedBchInputs = bchSelection.chosen;
    totalWalletBch = bchSelection.total;
    if (totalWalletBch < toBigInt(preflight.plan?.expectedInputSats ?? 0n) + DUST_THRESHOLD * 3n) {
      setupBlockers.push('BCH inputs do not cover the planned buy trade and fee reserve');
    }
  }

  const walletInputs = [...selectedTokenInputs, ...selectedBchInputs];
  const poolAddress = selectedPool ? resolvePoolAddress(selectedPool) : null;
  if (selectedPool && !poolAddress) {
    setupBlockers.push('Unable to derive the live pool address');
  }

  const routeEntries =
    route?.ok && route.entries.length > 0
      ? route.entries
      : selectedPool && quote
        ? [{ pool: selectedPool, supply: tradeAmount, demand: toBigInt(quote.amountOut ?? 0n) }]
        : [];

  const poolOutputs = routeEntries.map((entry) => {
    const pool = entry.pool ?? selectedPool;
    const state = buildRoutePoolState(pool, entry, direction);
    return {
      to: resolvePoolAddress(pool),
      amount: state.amount,
      token: {
        category: String(stablecoinCategory),
        amount: state.tokenAmount,
      },
    };
  });

  const transactionPreview = routeEntries.length > 0 && quote
    ? {
        version: 2,
        locktime: 0,
        inputs: [
          ...routeEntries.map((entry) => {
            const pool = entry.pool ?? selectedPool;
            return {
              type: 'pool',
              poolId: poolIdentity(pool),
              txid: pool?.txid ?? null,
              vout: pool?.tx_pos ?? null,
            };
          }),
          ...walletInputs.map((input) => ({
            type: 'wallet',
            txid: String(input.tx_hash ?? input.txid ?? 'n/a'),
            vout: Number(input.tx_pos ?? input.vout ?? 0),
            satoshis: fmtBigInt(getUtxoSats(input)),
            tokenCategory: getTokenCategory(input) || null,
            tokenAmount: fmtBigInt(getTokenAmount(input)),
          })),
        ],
        outputs: [...poolOutputs],
      }
    : null;

  return {
    ok: blockers.length === 0 && setupBlockers.length === 0,
    blockers: [...blockers, ...setupBlockers],
    warnings,
    preflight,
    selectedPool,
    selectedPoolId: selectedPool ? poolIdentity(selectedPool) : null,
    poolAddress,
    poolShape,
    quote,
    route: route?.ok
      ? {
          ok: true,
          poolCount: route.poolCount ?? 0,
          poolIds: route.poolIds ?? [],
          demand: fmtBigInt(route.routeDemand ?? 0n),
          supply: fmtBigInt(route.routeSupply ?? 0n),
          slippageBps: route.slippageBps ?? 0,
        }
      : route
        ? {
            ok: false,
            error: route.error ?? null,
          }
        : null,
    quoteCandidates: quoteCandidates.slice(0, 3).map((candidate) => ({
      poolId: candidate.poolId,
      sats: fmtBigInt(candidate.sats),
      tokens: fmtBigInt(candidate.tokens),
      amountOut: fmtBigInt(candidate.quote.amountOut),
      slippageBps: candidate.slippageBps,
    })),
    direction,
    tradeAmount: fmtBigInt(tradeAmount),
    cappedTradeTokens: fmtBigInt(cappedTradeTokens),
    wallet,
    walletInputs,
    totalWalletBch,
    totalWalletTokenSupply,
    poolOutput: poolOutputs[0] ?? null,
    transactionPreview,
    stablecoinCategory,
  };
}

export async function broadcastLiveCauldronTrade({
  portfolioSnapshot,
  marketSnapshot,
  oraclePriceRaw,
  maxSlippageBps = 150,
  tradeTokenCap = BROADCAST_TEST_MAX_TRADE_TOKENS,
  broadcastEnabled = BROADCAST_ENABLED,
} = {}) {
  const draft = buildLiveCauldronBroadcastDraft({
    portfolioSnapshot,
    marketSnapshot,
    oraclePriceRaw,
    maxSlippageBps,
    tradeTokenCap,
  });

  if (!draft.ok) {
    const error = new Error(draft.blockers.join('; '));
    error.draft = draft;
    throw error;
  }

  if (!broadcastEnabled) {
    const error = new Error(
      'Live broadcast is disabled. Set BROADCAST_ENABLED=1 (or ENABLE_LIVE_BROADCAST=1) to send the transaction.'
    );
    error.draft = draft;
    throw error;
  }

  const feeRate = BigInt(BROADCAST_FEE_RATE_SATS_PER_BYTE);
  const walletKeyMaterial = deriveWalletKeyMaterial({
    mnemonic: process.env.BIP39_MNEMONIC ?? '',
    passphrase: process.env.BIP39_PASSPHRASE ?? '',
    path: draft.wallet?.derivationPath ?? '',
  });
  const walletPrivateKey = walletKeyMaterial.privateKey;
  if (!walletPrivateKey) {
    throw new Error('Unable to derive wallet signing key for broadcast');
  }

  const selectedPool = draft.selectedPool;
  if (!selectedPool) {
    throw new Error('Unable to select a live Cauldron pool for broadcast');
  }
  const pools = Array.isArray(marketSnapshot?.pools) ? marketSnapshot.pools : [];

  const tradeAmount = toBigInt(draft.tradeAmount);
  const route =
    draft.direction !== 'hold' && toBigInt(oraclePriceRaw) > 0n
      ? buildBestPoolTradeRoute({
          pools,
          direction: draft.direction,
          amountIn: tradeAmount,
          targetStablecoinAmount: toBigInt(draft.cappedTradeTokens ?? 0n),
          oraclePriceRaw: toBigInt(oraclePriceRaw),
          stablecoinCategory: draft.stablecoinCategory,
          feeRate,
        })
      : null;
  const routePoolEntries = route?.ok && route.entries.length > 0 ? route.entries : [
    {
      pool: selectedPool,
      supply: tradeAmount,
      demand: toBigInt(draft.quote?.amountOut ?? 0n),
    },
  ];
  if (routePoolEntries.length === 0) {
    throw new Error('No pool trade was generated for broadcast');
  }

  const primaryAddress = draft.wallet?.primaryAddress;
  const primaryTokenAddress = draft.wallet?.primaryTokenAddress;
  if (!primaryAddress || !primaryTokenAddress) {
    throw new Error('Wallet payout addresses unavailable');
  }
  const primaryWalletInputs = draft.walletInputs.filter((utxo) =>
    String(utxo.address ?? '') === String(primaryAddress) ||
    String(utxo.address ?? '') === String(primaryTokenAddress)
  );
  if (primaryWalletInputs.length === 0) {
    throw new Error('No primary-address wallet inputs available for broadcast');
  }
  if (String(process.env.BROADCAST_DEBUG ?? '0').trim() === '1') {
    console.log('Broadcast wallet inputs:', primaryWalletInputs.map((utxo) => ({
      address: utxo.address ?? null,
      txid: utxo.tx_hash ?? utxo.txid ?? null,
      vout: utxo.tx_pos ?? utxo.vout ?? null,
      sats: String(utxo.satoshis ?? utxo.amount ?? 0),
      token: utxo.token ? { category: utxo.token.category, amount: String(utxo.token.amount) } : null,
    })));
  }
  const providerServer = Array.isArray(DEFAULT_WALLET_ELECTRUM_SERVERS)
    ? DEFAULT_WALLET_ELECTRUM_SERVERS[0] ?? ''
    : '';
  if (!providerServer) {
    throw new Error('No electrum server configured for broadcast');
  }
  const builderProvider = new ElectrumNetworkProvider(NETWORK, {
    hostname: providerServer,
  });
  const transactionBuilder = new TransactionBuilder({ provider: builderProvider });
  const walletUnlocker = new SignatureTemplate(walletPrivateKey).unlockP2PKH();
  for (const entry of routePoolEntries) {
    const pool = entry.pool ?? selectedPool;
    const poolUnlocker = buildPoolUnlocker(pool);
    transactionBuilder.addInput(toCashscriptPoolUtxo(pool, draft.stablecoinCategory), poolUnlocker);
  }
  for (const walletInput of primaryWalletInputs) {
    transactionBuilder.addInput(cashscriptUtxoFromWalletInput(walletInput), walletUnlocker);
  }

  for (const entry of routePoolEntries) {
    const pool = entry.pool ?? selectedPool;
    const state = buildRoutePoolState(pool, entry, draft.direction);
    transactionBuilder.addOutput({
      to: pool.poolAddress ?? pool.owner_p2pkh_addr ?? resolvePoolAddress(pool),
      amount: state.amount,
      token: {
        category: draft.stablecoinCategory,
        amount: state.tokenAmount,
      },
    });
  }

  const routeDemand = toBigInt(route?.routeDemand ?? draft.route?.demand ?? draft.quote?.amountOut ?? 0n);
  if (draft.direction === 'sell-stablecoin') {
    transactionBuilder.addOutput({
      to: primaryAddress,
      amount: routeDemand,
    });
  } else {
    const tokenPayoutOutput = {
      to: primaryTokenAddress,
      amount: BigInt(
        calculateDust({
          to: primaryTokenAddress,
          amount: 0n,
          token: {
            amount: routeDemand,
            category: draft.stablecoinCategory,
          },
        })
      ),
      token: {
        amount: routeDemand,
        category: draft.stablecoinCategory,
      },
    };
    transactionBuilder.addOutput(tokenPayoutOutput);
  }

  transactionBuilder.addTokenChangeOutputIfNeeded({
    category: draft.stablecoinCategory,
    to: primaryTokenAddress,
  });
  transactionBuilder.addBchChangeOutputIfNeeded({
    to: primaryAddress,
    feeRate: Number(feeRate),
  });

  const tradeTransaction = transactionBuilder.buildLibauthTransaction();
  const tradeTxHex = binToHex(encodeTransaction(tradeTransaction));

  const broadcastClient = new ElectrumClient(
    'CashScript Application',
    '1.4.1',
    providerServer,
    { disableBrowserVisibilityHandling: true }
  );
  await broadcastClient.connect();
  let txid;
  try {
    const response = await broadcastClient.request(
      'blockchain.transaction.broadcast',
      tradeTxHex
    );
    if (response instanceof Error) {
      throw response;
    }
    txid = typeof response === 'string' ? response : tradeTxHex;
  } finally {
    await broadcastClient.disconnect(true).catch(() => {});
  }

  return {
    ...draft,
    estimatedBytes: fmtBigInt(tradeTxHex.length / 2),
    estimatedFee: fmtBigInt(
      routePoolEntries.reduce((sum, entry) => sum + getPoolReserveSats(entry.pool ?? selectedPool), 0n) +
      primaryWalletInputs.reduce((sum, input) => sum + getUtxoSats(input), 0n) -
      tradeTransaction.outputs.reduce((sum, output) => sum + toBigInt(output.valueSatoshis), 0n)
    ),
    txid,
    hex: tradeTxHex,
    transaction: tradeTransaction,
    finalOutputs: tradeTransaction.outputs,
  };
}
