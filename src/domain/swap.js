import { ExchangeLab } from '@cashlab/cauldron';
import { NATIVE_BCH_TOKEN_ID } from '@cashlab/common';
import {
  buildCauldronPoolV0LockingBytecode,
  poolIdentity,
} from './cauldronPool.js';

const FEE_BPS_DEFAULT = 30n;

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

export function quoteConstantProductSwap({
  reserveIn,
  reserveOut,
  amountIn,
  feeBps = FEE_BPS_DEFAULT,
}) {
  const amountInBig = toBigInt(amountIn);
  const reserveInBig = toBigInt(reserveIn);
  const reserveOutBig = toBigInt(reserveOut);
  const fee = (amountInBig * toBigInt(feeBps, FEE_BPS_DEFAULT)) / 10_000n;
  const amountInAfterFee = amountInBig - fee;

  if (amountInAfterFee <= 0n) {
    return {
      fee,
      amountOut: 0n,
      nextReserveIn: reserveInBig,
      nextReserveOut: reserveOutBig,
    };
  }

  const k = reserveInBig * reserveOutBig;
  const nextReserveIn = reserveInBig + amountInAfterFee;
  const nextReserveOut = k / nextReserveIn;
  const amountOut = reserveOutBig - nextReserveOut;

  return {
    fee,
    amountOut,
    nextReserveIn,
    nextReserveOut,
  };
}

export function pickPrimaryPool(pools, tokenId) {
  if (!Array.isArray(pools) || pools.length === 0) {
    return null;
  }

  const normalizedTokenId = String(tokenId ?? '').trim();
  const matchingPools = normalizedTokenId
    ? pools.filter((pool) => {
        const poolToken = String(
          pool?.token_id ?? pool?.tokenId ?? pool?.token ?? pool?.category ?? ''
        ).trim();
        return poolToken === normalizedTokenId;
      })
    : pools;

  const candidates = matchingPools.length > 0 ? matchingPools : pools;
  return candidates
    .slice()
    .sort((a, b) => {
      const aSats = toBigInt(a?.sats ?? a?.tvl_sats ?? 0);
      const bSats = toBigInt(b?.sats ?? b?.tvl_sats ?? 0);
      const aTokens = toBigInt(a?.tokens ?? a?.tvl_tokens ?? 0);
      const bTokens = toBigInt(b?.tokens ?? b?.tvl_tokens ?? 0);
      const aValue = aSats + aTokens;
      const bValue = bSats + bTokens;
      if (aValue === bValue) return 0;
      return aValue > bValue ? -1 : 1;
    })[0] ?? null;
}

function quotePoolForDirection(pool, { direction, amountIn }) {
  const sats = toBigInt(pool?.sats ?? pool?.tvl_sats ?? 0);
  const tokens = toBigInt(pool?.tokens ?? pool?.tvl_tokens ?? 0);
  const quote =
    direction === 'buy-stablecoin'
      ? quoteConstantProductSwap({
          reserveIn: sats,
          reserveOut: tokens,
          amountIn,
        })
      : quoteConstantProductSwap({
          reserveIn: tokens,
          reserveOut: sats,
          amountIn,
        });

  return {
    pool,
    quote,
    sats,
    tokens,
  };
}

function buildExchangeLabPool(pool, tokenId) {
  const ownerPkh = String(pool?.owner_pkh ?? pool?.ownerPkh ?? '').trim();
  const txid = String(pool?.txid ?? pool?.tx_id ?? '').trim();
  const txPos = Number(pool?.tx_pos ?? pool?.vout ?? 0);
  const sats = toBigInt(pool?.sats ?? pool?.tvl_sats ?? 0);
  const tokens = toBigInt(pool?.tokens ?? pool?.tvl_tokens ?? 0);

  if (!ownerPkh || !txid || sats <= 0n || tokens <= 0n) {
    return null;
  }

  const lockingBytecode =
    typeof pool?.locking_bytecode === 'string'
      ? Buffer.from(pool.locking_bytecode.replace(/^0x/i, ''), 'hex')
      : pool?.locking_bytecode
        ? Buffer.from(pool.locking_bytecode)
        : Buffer.from(
            buildCauldronPoolV0LockingBytecode({
              withdrawPublicKeyHash: ownerPkh,
            })
          );

  return {
    pool_id: String(pool?.pool_id ?? pool?.poolId ?? txid),
    poolId: String(pool?.pool_id ?? pool?.poolId ?? txid),
    owner_pkh: ownerPkh,
    ownerPkh: ownerPkh,
    txid,
    tx_pos: txPos,
    poolAddress: pool?.poolAddress ?? null,
    locking_bytecode: pool?.locking_bytecode ?? null,
    version: '0',
    parameters: {
      withdraw_pubkey_hash: Buffer.from(ownerPkh, 'hex'),
    },
    outpoint: {
      index: txPos,
      txhash: Buffer.from(txid, 'hex'),
    },
    output: {
      locking_bytecode: lockingBytecode,
      amount: sats,
      token: {
        amount: tokens,
        token_id: String(tokenId),
      },
    },
  };
}

function summarizeTradeRoute({
  direction,
  summary,
  oraclePriceRaw,
  targetStablecoinAmount,
}) {
  const routeDemand = toBigInt(summary?.demand ?? 0n);
  const routeSupply = toBigInt(summary?.supply ?? 0n);
  const priceRaw = toBigInt(oraclePriceRaw);
  const expectedStablecoinValue = toBigInt(targetStablecoinAmount ?? 0n);
  const quotedStablecoinValue =
    direction === 'buy-stablecoin'
      ? routeDemand
      : priceRaw > 0n
        ? (routeDemand * priceRaw) / 100_000_000n
        : 0n;
  const slippageBps =
    expectedStablecoinValue > 0n
      ? Number(
          ((expectedStablecoinValue > quotedStablecoinValue
            ? expectedStablecoinValue - quotedStablecoinValue
            : quotedStablecoinValue - expectedStablecoinValue) *
            10_000n) /
            expectedStablecoinValue
        )
      : 0;

  return {
    routeDemand,
    routeSupply,
    expectedStablecoinValue,
    quotedStablecoinValue,
    slippageBps,
  };
}

export function buildBestPoolTradeRoute({
  pools,
  direction,
  amountIn,
  targetStablecoinAmount,
  oraclePriceRaw,
  stablecoinCategory,
  feeRate = FEE_BPS_DEFAULT,
}) {
  if (!Array.isArray(pools) || pools.length === 0) {
    return null;
  }

  const tradeAmount = toBigInt(amountIn);
  if (tradeAmount <= 0n) {
    return null;
  }

  const tokenId = String(stablecoinCategory ?? '').trim();
  if (!tokenId) {
    return null;
  }

  const exlab = new ExchangeLab();
  const supplyTokenId = direction === 'buy-stablecoin' ? NATIVE_BCH_TOKEN_ID : tokenId;
  const demandTokenId = direction === 'buy-stablecoin' ? tokenId : NATIVE_BCH_TOKEN_ID;
  const exchangePools = pools
    .map((pool) => buildExchangeLabPool(pool, tokenId))
    .filter(Boolean);

  if (exchangePools.length === 0) {
    return null;
  }

  try {
    const result = exlab.constructTradeBestRateForTargetSupply(
      supplyTokenId,
      demandTokenId,
      tradeAmount,
      exchangePools,
      toBigInt(feeRate)
    );
    const summary = result?.summary ?? null;
    const route = summarizeTradeRoute({
      direction,
      summary,
      oraclePriceRaw,
      targetStablecoinAmount,
    });

    return {
      ok: true,
      exlab,
      result,
      direction,
      supplyTokenId,
      demandTokenId,
      amountIn: tradeAmount,
      stablecoinCategory: tokenId,
      poolCount: result?.entries?.length ?? 0,
      poolIds: (result?.entries ?? []).map((entry) => poolIdentity(entry.pool ?? {})),
      entries: result?.entries ?? [],
      summary,
      ...route,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      direction,
      amountIn: tradeAmount,
      stablecoinCategory: tokenId,
      poolCount: 0,
      poolIds: [],
      entries: [],
      summary: null,
      routeDemand: 0n,
      routeSupply: 0n,
      expectedStablecoinValue: toBigInt(targetStablecoinAmount ?? 0n),
      quotedStablecoinValue: 0n,
      slippageBps: 0,
    };
  }
}

export function evaluatePoolQuotes({
  pools,
  direction,
  amountIn,
  targetStablecoinAmount,
  oraclePriceRaw,
}) {
  if (!Array.isArray(pools) || pools.length === 0) {
    return [];
  }

  const tradeAmount = toBigInt(amountIn);
  const targetAmount = toBigInt(targetStablecoinAmount, tradeAmount);
  const priceRaw = toBigInt(oraclePriceRaw);
  return pools
    .map((pool) => {
      const { quote, sats, tokens } = quotePoolForDirection(pool, {
        direction,
        amountIn: tradeAmount,
      });

      const quotedStablecoinValue =
        direction === 'buy-stablecoin'
          ? quote.amountOut
          : priceRaw > 0n
            ? (quote.amountOut * priceRaw) / 100_000_000n
            : 0n;
      const expectedStablecoinValue = targetAmount;
      const slippageBps =
        expectedStablecoinValue > 0n
          ? Number(
              ((expectedStablecoinValue > quotedStablecoinValue
                ? expectedStablecoinValue - quotedStablecoinValue
                : quotedStablecoinValue - expectedStablecoinValue) *
                10_000n) /
                expectedStablecoinValue
            )
          : 0;

      return {
        pool,
        poolId: pool?.pool_id ?? pool?.poolId ?? null,
        sats,
        tokens,
        quote,
        quotedStablecoinValue,
        expectedStablecoinValue,
        slippageBps,
      };
    })
    .sort((a, b) => {
      const aOut = a.quote?.amountOut ?? 0n;
      const bOut = b.quote?.amountOut ?? 0n;
      if (aOut === bOut) return 0;
      return aOut > bOut ? -1 : 1;
    });
}

export function selectBestPoolQuote(options) {
  const quotes = evaluatePoolQuotes(options);
  return quotes[0] ?? null;
}

export function buildRoutePoolState(pool, entry, direction) {
  const reserveSats = toBigInt(pool?.sats ?? pool?.tvl_sats ?? pool?.output?.amount ?? 0);
  const reserveTokens = toBigInt(pool?.tokens ?? pool?.tvl_tokens ?? pool?.output?.token?.amount ?? 0);
  const supply = toBigInt(entry?.supply ?? 0n);
  const demand = toBigInt(entry?.demand ?? 0n);

  if (direction === 'buy-stablecoin') {
    return {
      amount: reserveSats + supply,
      tokenAmount: reserveTokens - demand,
    };
  }

  return {
    amount: reserveSats - demand,
    tokenAmount: reserveTokens + supply,
  };
}
