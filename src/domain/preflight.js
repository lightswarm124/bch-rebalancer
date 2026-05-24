import { ESTIMATED_TRADE_FEE_SATS, MIN_NET_BENEFIT_CENTS } from '../../config.js';
import { buildPortfolioRebalanceSnapshot, estimateRebalanceEconomics } from './rebalance.js';
import {
  buildBestPoolTradeRoute,
  evaluatePoolQuotes,
  pickPrimaryPool,
  selectBestPoolQuote,
} from './swap.js';
import { formatSignedUsdCents, formatUsdCents } from './money.js';

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

export function buildLiveRebalancePreflight({
  portfolioSnapshot,
  marketSnapshot,
  oraclePriceRaw,
  maxSlippageBps = 150,
  maxTradeBps = 5_000,
  minTradeSats = 10_000n,
}) {
  const blockers = [];
  const warnings = [];

  if (!portfolioSnapshot?.ok) {
    blockers.push('Wallet snapshot unavailable');
  }
  if (!marketSnapshot?.ok) {
    blockers.push('Cauldron market snapshot unavailable');
  }

  const wallet = portfolioSnapshot?.wallet ?? null;
  const totals = portfolioSnapshot?.totals ?? null;
  const rebalance = portfolioSnapshot?.ok
    ? buildPortfolioRebalanceSnapshot({
        bchSats: totals?.totalBchSats ?? 0n,
        stablecoinTokens: totals?.totalStablecoinTokens ?? 0n,
        oraclePriceRaw: toBigInt(oraclePriceRaw ?? 0n),
        maxSlippageBps,
        maxTradeBps,
        minTradeSats,
      })
    : null;

  if (!wallet?.primaryAddress) {
    blockers.push('No derived primary BCH address');
  }
  if (!wallet?.addressPairs?.length) {
    blockers.push('No derived address pairs');
  }

  const pools = Array.isArray(marketSnapshot?.pools) ? marketSnapshot.pools : [];
  const primaryPool = pickPrimaryPool(pools, marketSnapshot?.tokenId);
  if (!primaryPool) {
    blockers.push('No active Cauldron pool selected');
  }

  const plan = rebalance?.direction === 'hold' ? null : rebalance;
  if (!plan) {
    warnings.push('No rebalance required');
  } else if (
    plan.tradeTokens <= 0n ||
    (plan.direction === 'buy-stablecoin' && plan.expectedInputSats <= 0n) ||
    (plan.direction === 'sell-stablecoin' && plan.expectedOutputSats <= 0n)
  ) {
    blockers.push('Trade step did not clear guardrails');
  }

  const direction = plan?.direction ?? 'hold';
  let quote = null;
  let slippageBps = null;
  const stablecoinCategory = String(marketSnapshot?.tokenId ?? '');
  const route =
    plan && toBigInt(oraclePriceRaw) > 0n
      ? buildBestPoolTradeRoute({
          pools,
          direction,
          amountIn:
            direction === 'buy-stablecoin'
              ? plan.expectedInputSats
              : plan.tradeTokens,
          targetStablecoinAmount: plan.tradeTokens,
          oraclePriceRaw: toBigInt(oraclePriceRaw),
          stablecoinCategory,
          feeRate: 30n,
        })
      : null;
  const quoteCandidates =
    plan && toBigInt(oraclePriceRaw) > 0n
      ? evaluatePoolQuotes({
          pools,
          direction,
          amountIn:
            direction === 'buy-stablecoin'
              ? plan.expectedInputSats
              : plan.tradeTokens,
          targetStablecoinAmount: plan.tradeTokens,
          oraclePriceRaw: toBigInt(oraclePriceRaw),
        })
      : [];
  const bestQuote = !route?.ok
    ? selectBestPoolQuote({
        pools,
        direction,
        amountIn:
          direction === 'buy-stablecoin'
            ? plan?.expectedInputSats ?? 0n
            : plan?.tradeTokens ?? 0n,
        targetStablecoinAmount: plan?.tradeTokens ?? 0n,
        oraclePriceRaw: toBigInt(oraclePriceRaw),
      })
    : null;
  const selectedPool = route?.entries?.[0]?.pool ?? bestQuote?.pool ?? primaryPool;

  const quotedTradeValueCents =
    route?.ok && route?.quotedStablecoinValue !== undefined
      ? route.quotedStablecoinValue
      : bestQuote?.quotedStablecoinValue ?? 0n;
  const economics = plan
    ? estimateRebalanceEconomics({
        bchSats: totals?.totalBchSats ?? 0n,
        stablecoinTokens: totals?.totalStablecoinTokens ?? 0n,
        oraclePriceRaw: toBigInt(oraclePriceRaw ?? 0n),
        direction: plan.direction,
        tradeTokens: plan.tradeTokens,
        expectedInputSats: plan.expectedInputSats,
        quotedTradeValueCents,
        estimatedFeeSats: ESTIMATED_TRADE_FEE_SATS,
        minimumNetBenefitCents: MIN_NET_BENEFIT_CENTS,
      })
    : null;

  if (plan && route?.ok) {
    quote = {
      fee: fmtBigInt(route.summary?.trade_fee ?? 0n),
      amountOut: fmtBigInt(route.routeDemand),
      nextReserveIn: fmtBigInt(route.summary?.supply ?? 0n),
      nextReserveOut: fmtBigInt(route.summary?.demand ?? 0n),
      slippageBps: route.slippageBps,
    };
    slippageBps = route.slippageBps;
    if (slippageBps > maxSlippageBps) {
      blockers.push(
        `Pool slippage ${slippageBps} bps exceeds cap ${maxSlippageBps} bps`
      );
    }
  } else if (plan && bestQuote) {
    quote = bestQuote.quote;
    slippageBps = bestQuote.slippageBps;
    if (slippageBps > maxSlippageBps) {
      blockers.push(
        `Pool slippage ${slippageBps} bps exceeds cap ${maxSlippageBps} bps`
      );
    }
    if (route?.error) {
      warnings.push(`Route selection fell back to single-pool quoting: ${route.error}`);
    }
  } else if (plan) {
    blockers.push('No pool quote available for the planned trade');
  }

  if (plan && economics) {
    if (economics.grossImprovementCents <= 0n) {
      blockers.push('Trade does not improve the portfolio after fees');
    } else if (economics.netBenefitCents < economics.minimumNetBenefitCents) {
      blockers.push(
        `Estimated net benefit ${formatSignedUsdCents(economics.netBenefitCents)} is below the minimum ${formatUsdCents(
          economics.minimumNetBenefitCents
        )} after fees`
      );
    }
  }

  const executionSupported = false;

  return {
    ok: blockers.length === 0,
    executionSupported,
    readyToExecute: blockers.length === 0,
    canBroadcast: executionSupported && blockers.length === 0,
    broadcastBlocker: executionSupported ? null : 'Broadcast execution is not implemented yet',
    blockers,
    warnings,
    oraclePriceRaw: toBigInt(oraclePriceRaw ?? 0n),
    wallet: wallet
      ? {
          derivationPath: wallet.derivationPath ?? null,
          primaryAddress: wallet.primaryAddress ?? null,
          primaryTokenAddress: wallet.primaryTokenAddress ?? null,
          bchSats: wallet.bchSats ?? 0n,
          stablecoinTokens: wallet.stablecoinTokens ?? 0n,
        }
      : null,
    market: selectedPool
      ? {
          poolId: selectedPool.pool_id ?? selectedPool.poolId ?? null,
          poolAddress: selectedPool.poolAddress ?? null,
          tokenId: marketSnapshot?.tokenId ?? null,
          sats: toBigInt(selectedPool.sats ?? selectedPool.tvl_sats ?? 0),
          tokens: toBigInt(selectedPool.tokens ?? selectedPool.tvl_tokens ?? 0),
        }
      : null,
    route: route
      ? {
          ok: route.ok,
          error: route.error ?? null,
          poolCount: route.poolCount ?? 0,
          poolIds: route.poolIds ?? [],
          amountIn: fmtBigInt(route.amountIn ?? 0n),
          supply: fmtBigInt(route.routeSupply ?? 0n),
          demand: fmtBigInt(route.routeDemand ?? 0n),
          expectedStablecoinValue: fmtBigInt(route.expectedStablecoinValue ?? 0n),
          quotedStablecoinValue: fmtBigInt(route.quotedStablecoinValue ?? 0n),
          slippageBps: route.slippageBps ?? 0,
        }
      : null,
    quoteCandidates: quoteCandidates.slice(0, 3).map((candidate) => ({
      poolId: candidate.poolId,
      sats: fmtBigInt(candidate.sats),
      tokens: fmtBigInt(candidate.tokens),
      amountOut: fmtBigInt(candidate.quote.amountOut),
      slippageBps: candidate.slippageBps,
    })),
    plan: rebalance
      ? {
          direction: rebalance.direction,
          tradeTokens: fmtBigInt(rebalance.tradeTokens),
          expectedInputSats: fmtBigInt(rebalance.expectedInputSats),
          headline: rebalance.formatted?.headline ?? rebalance.reason,
          details: rebalance.formatted?.details ?? '',
        }
      : null,
    economics: economics
      ? {
          beforeImbalanceCents: fmtBigInt(economics.beforeImbalanceCents),
          afterImbalanceCents: fmtBigInt(economics.afterImbalanceCents),
          grossImprovementCents: fmtBigInt(economics.grossImprovementCents),
          estimatedFeeCents: fmtBigInt(economics.estimatedFeeCents),
          netBenefitCents: fmtBigInt(economics.netBenefitCents),
          minimumNetBenefitCents: fmtBigInt(economics.minimumNetBenefitCents),
          isWorthDoing: economics.isWorthDoing,
        }
      : null,
    quote: quote
      ? {
          fee: fmtBigInt(quote.fee),
          amountOut: fmtBigInt(quote.amountOut),
          nextReserveIn: fmtBigInt(quote.nextReserveIn),
          nextReserveOut: fmtBigInt(quote.nextReserveOut),
          slippageBps,
        }
      : null,
  };
}
