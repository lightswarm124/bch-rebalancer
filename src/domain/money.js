const MONEY_SCALE = 100n;

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

function formatMinorUnits(value, { signed = false, prefix = '', suffix = '' } = {}) {
  const amount = toBigInt(value);
  const negative = amount < 0n;
  const absValue = negative ? -amount : amount;
  const whole = absValue / MONEY_SCALE;
  const fraction = (absValue % MONEY_SCALE).toString().padStart(2, '0');
  const sign = negative ? '-' : signed && absValue > 0n ? '+' : '';
  return `${sign}${prefix}${whole.toString()}.${fraction}${suffix}`;
}

export function formatUsdCents(value, { signed = false } = {}) {
  return `$${formatMinorUnits(value, { signed })}`;
}

export function formatSignedUsdCents(value) {
  return formatUsdCents(value, { signed: true });
}

export function formatStablecoinAtomic(value, { symbol = 'stable', signed = false } = {}) {
  return `${formatMinorUnits(value, { signed })} ${symbol}`;
}

export function formatSignedStablecoinAtomic(value, { symbol = 'stable' } = {}) {
  return formatStablecoinAtomic(value, { symbol, signed: true });
}

export function centsFromBchSats(bchSats, oraclePriceRawCents) {
  return (toBigInt(bchSats) * toBigInt(oraclePriceRawCents)) / 100_000_000n;
}

export function toMoneyCents(value, fallback = 0n) {
  return toBigInt(value, fallback);
}

