import {
  MAX_SLIPPAGE_BPS,
  MAX_TRADE_BPS,
  MIN_TRADE_SATS,
  MIN_NET_BENEFIT_CENTS,
} from '../../config.js';
import {
  centsFromBchSats,
  formatStablecoinAtomic,
  formatUsdCents,
  formatSignedUsdCents,
  toMoneyCents,
} from './money.js';

const SATS_PER_BCH = 100_000_000n;

function absBigInt(value) {
  return value < 0n ? -value : value;
}

function stablecoinCentsFromTokens(value) {
  return toMoneyCents(value);
}

export function estimateRebalanceEconomics({
  bchSats,
  stablecoinTokens,
  oraclePriceRaw,
  direction,
  tradeTokens,
  expectedInputSats,
  quotedTradeValueCents,
  estimatedFeeSats = 0n,
  minimumNetBenefitCents = MIN_NET_BENEFIT_CENTS,
}) {
  const price = toMoneyCents(oraclePriceRaw);
  if (price <= 0n || !direction || !tradeTokens) {
    return null;
  }

  const bchUsd = bchValueUsdFromSats(bchSats, price);
  const stablecoinUsd = stablecoinCentsFromTokens(stablecoinTokens);
  const beforeImbalance = absBigInt(bchUsd - stablecoinUsd);
  const quotedValueCents = toMoneyCents(quotedTradeValueCents);
  const inputValueCents = centsFromBchSats(expectedInputSats, price);

  let afterBchUsd = bchUsd;
  let afterStablecoinUsd = stablecoinUsd;
  if (direction === 'buy-stablecoin') {
    afterBchUsd = afterBchUsd - inputValueCents;
    afterStablecoinUsd = afterStablecoinUsd + quotedValueCents;
  } else if (direction === 'sell-stablecoin') {
    afterBchUsd = afterBchUsd + quotedValueCents;
    afterStablecoinUsd = afterStablecoinUsd - stablecoinCentsFromTokens(tradeTokens);
  } else {
    return null;
  }

  const afterImbalance = absBigInt(afterBchUsd - afterStablecoinUsd);
  const grossImprovementCents = beforeImbalance > afterImbalance ? beforeImbalance - afterImbalance : 0n;
  const estimatedFeeCents = centsFromBchSats(estimatedFeeSats, price);
  const netBenefitCents = grossImprovementCents - estimatedFeeCents;
  const minimumNetBenefit = toMoneyCents(minimumNetBenefitCents);

  return {
    beforeImbalanceCents: beforeImbalance,
    afterImbalanceCents: afterImbalance,
    grossImprovementCents,
    estimatedFeeCents,
    netBenefitCents,
    minimumNetBenefitCents: minimumNetBenefit,
    isWorthDoing: grossImprovementCents > 0n && netBenefitCents >= minimumNetBenefit,
  };
}

export function bchValueUsdFromSats(bchSats, oraclePriceRaw) {
  return centsFromBchSats(bchSats, oraclePriceRaw);
}

export function portfolioUsdValue({ bchSats, stablecoinTokens, oraclePriceRaw }) {
  return bchValueUsdFromSats(bchSats, oraclePriceRaw) + stablecoinCentsFromTokens(stablecoinTokens);
}

export function portfolioImbalance({ bchSats, stablecoinTokens, oraclePriceRaw }) {
  return absBigInt(
    bchValueUsdFromSats(bchSats, oraclePriceRaw) - stablecoinCentsFromTokens(stablecoinTokens)
  );
}

function tradeSatsFromCents(tradeCents, oraclePriceRaw) {
  const price = toMoneyCents(oraclePriceRaw);
  if (price <= 0n) return 0n;
  return (toMoneyCents(tradeCents) * SATS_PER_BCH) / price;
}

function clampTradeStep(
  stepCents,
  { maxTradeTokens, minTradeSats, oraclePriceRaw, availableBchSats, availableStablecoinTokens, direction }
) {
  let nextStep = stepCents < 0n ? 0n : stepCents;

  if (maxTradeTokens > 0n && nextStep > maxTradeTokens) {
    nextStep = maxTradeTokens;
  }

  if (direction === 'buy-stablecoin') {
    const maxByBch = centsFromBchSats(availableBchSats, oraclePriceRaw);
    if (nextStep > maxByBch) nextStep = maxByBch;
  }

  if (direction === 'sell-stablecoin' && nextStep > availableStablecoinTokens) {
    nextStep = availableStablecoinTokens;
  }

  if (nextStep <= 0n) return 0n;

  const estimatedTradeSats = tradeSatsFromCents(nextStep, oraclePriceRaw);
  if (estimatedTradeSats < minTradeSats) return 0n;
  return nextStep;
}

export function chooseRebalanceStep({
  bchSats,
  stablecoinTokens,
  oraclePriceRaw,
  maxSlippageBps = MAX_SLIPPAGE_BPS,
  maxTradeBps = MAX_TRADE_BPS,
  minTradeSats = MIN_TRADE_SATS,
}) {
  const price = toMoneyCents(oraclePriceRaw);
  if (price <= 0n) {
    return {
      direction: 'hold',
      reason: 'Oracle price unavailable',
      tradeTokens: 0n,
      expectedInputSats: 0n,
      expectedOutputSats: 0n,
      expectedTradeSats: 0n,
      beforeImbalance: 0n,
      afterImbalance: 0n,
      slippageBps: 0,
      maxSlippageBps,
    };
  }

  const stablecoinUsd = stablecoinCentsFromTokens(stablecoinTokens);
  const bchUsd = bchValueUsdFromSats(bchSats, price);
  const beforeImbalance = absBigInt(bchUsd - stablecoinUsd);
  if (beforeImbalance === 0n) {
    return {
      direction: 'hold',
      reason: 'Already at the target balance',
      tradeTokens: 0n,
      expectedInputSats: 0n,
      expectedOutputSats: 0n,
      expectedTradeSats: 0n,
      beforeImbalance,
      afterImbalance: beforeImbalance,
      slippageBps: 0,
      maxSlippageBps,
    };
  }

  const direction = stablecoinUsd > bchUsd ? 'sell-stablecoin' : 'buy-stablecoin';
  const gap = absBigInt(stablecoinUsd - bchUsd);
  const targetStep = gap / 2n > 0n ? gap / 2n : 1n;
  const portfolioValueUsd = portfolioUsdValue({
    bchSats,
    stablecoinTokens,
    oraclePriceRaw: price,
  });
  const maxTradeTokens = (portfolioValueUsd * BigInt(maxTradeBps)) / 10_000n;

  const tradeTokens = clampTradeStep(targetStep, {
    maxTradeTokens,
    minTradeSats,
    oraclePriceRaw: price,
    availableBchSats: bchSats,
    availableStablecoinTokens: stablecoinTokens,
    direction,
  });

  if (tradeTokens <= 0n) {
    return {
      direction: 'hold',
      reason: 'Trade step fell below the minimum or exceeded guardrails',
      tradeTokens: 0n,
      expectedInputSats: 0n,
      expectedOutputSats: 0n,
      expectedTradeSats: 0n,
      beforeImbalance,
      afterImbalance: beforeImbalance,
      slippageBps: 0,
      maxSlippageBps,
    };
  }

  const expectedTradeSats = tradeSatsFromCents(tradeTokens, price);
  const expectedInputSats = direction === 'buy-stablecoin' ? expectedTradeSats : 0n;
  const expectedOutputSats = direction === 'sell-stablecoin' ? expectedTradeSats : 0n;
  const afterBchUsd =
    direction === 'buy-stablecoin' ? bchUsd - tradeTokens : bchUsd + tradeTokens;
  const afterStablecoinUsd =
    direction === 'buy-stablecoin' ? stablecoinUsd + tradeTokens : stablecoinUsd - tradeTokens;
  const afterImbalance = absBigInt(afterBchUsd - afterStablecoinUsd);

  return {
    direction,
    reason:
      direction === 'buy-stablecoin'
        ? 'BCH is overweight versus the stablecoin'
        : 'Stablecoin is overweight versus BCH',
    tradeTokens,
    expectedInputSats,
    expectedOutputSats,
    expectedTradeSats,
    expectedTradeValueUsd: tradeTokens,
    beforeImbalance,
    afterImbalance,
    grossImprovement: beforeImbalance > afterImbalance ? beforeImbalance - afterImbalance : 0n,
    slippageBps: 25,
    maxSlippageBps,
    maxTradeBps,
  };
}

export function buildPortfolioRebalanceSnapshot({
  bchSats,
  stablecoinTokens,
  oraclePriceRaw,
  maxSlippageBps = MAX_SLIPPAGE_BPS,
  maxTradeBps = MAX_TRADE_BPS,
  minTradeSats = MIN_TRADE_SATS,
}) {
  const plan = chooseRebalanceStep({
    bchSats,
    stablecoinTokens,
    oraclePriceRaw,
    maxSlippageBps,
    maxTradeBps,
    minTradeSats,
  });
  const bchUsd = bchValueUsdFromSats(bchSats, oraclePriceRaw);
  const stablecoinUsd = stablecoinCentsFromTokens(stablecoinTokens);
  const totalUsd = portfolioUsdValue({
    bchSats,
    stablecoinTokens,
    oraclePriceRaw,
  });
  const targetUsd = totalUsd / 2n;
  const grossImprovement = plan.beforeImbalance > plan.afterImbalance ? plan.beforeImbalance - plan.afterImbalance : 0n;
  const bchWeightBps = totalUsd > 0n ? (bchUsd * 10_000n) / totalUsd : 0n;
  const stableWeightBps = totalUsd > 0n ? (stablecoinUsd * 10_000n) / totalUsd : 0n;

  return {
    ...plan,
    bchUsd,
    stablecoinUsd,
    totalUsd,
    targetUsd,
    grossImprovement,
    bchWeightBps,
    stableWeightBps,
    targetStablecoinTokens: targetUsd,
    formatted: formatRebalancePlan(plan),
  };
}

export function formatRebalancePlan(plan) {
  if (!plan || plan.direction === 'hold') {
    return {
      headline: 'No rebalance',
      details: plan?.reason ?? 'No action required',
    };
  }

  const tradeValue = formatStablecoinAtomic(plan.tradeTokens ?? 0n, { symbol: 'stable' });
  return {
    headline:
      plan.direction === 'buy-stablecoin'
        ? 'Buy stablecoin with BCH'
        : 'Sell stablecoin for BCH',
    details:
      plan.direction === 'buy-stablecoin'
        ? [
            `Trade: ${tradeValue}`,
            `Expected BCH in: ${plan.expectedInputSats.toString()} sats`,
            `Imbalance: ${formatUsdCents(plan.beforeImbalance)} -> ${formatUsdCents(plan.afterImbalance)}`,
            `Gross improvement: ${formatSignedUsdCents(plan.grossImprovement ?? 0n)}`,
            `Slippage cap: ${plan.maxSlippageBps} bps`,
          ].join(' | ')
        : [
            `Trade: ${tradeValue}`,
            `Expected BCH out: ${plan.expectedOutputSats.toString()} sats`,
            `Imbalance: ${formatUsdCents(plan.beforeImbalance)} -> ${formatUsdCents(plan.afterImbalance)}`,
            `Gross improvement: ${formatSignedUsdCents(plan.grossImprovement ?? 0n)}`,
            `Slippage cap: ${plan.maxSlippageBps} bps`,
          ].join(' | '),
  };
}
