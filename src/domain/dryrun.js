import { CAULDRON_TOKEN_ID, DUST_THRESHOLD } from '../../config.js';
import { buildLiveRebalancePreflight } from './preflight.js';
import { getTokenAmount, getTokenCategory, getUtxoSats } from './portfolio.js';
import { buildBestPoolTradeRoute, buildRoutePoolState } from './swap.js';
import { buildCauldronPoolV0ExchangeUnlockingBytecode, poolIdentity, validateLiveCauldronPoolShape } from './cauldronPool.js';

const CAULDRON_NATIVE_BCH = 'bch';
const DRY_RUN_FEE_RESERVE_SATS = 2500n;

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

function utxoLabel(utxo) {
  return `${String(utxo?.tx_hash ?? utxo?.txid ?? 'n/a')}:${String(
    utxo?.tx_pos ?? utxo?.vout ?? 0
  )}`;
}

function buildAddressLookup(wallet) {
  const lookup = new Map();
  for (const pair of wallet?.addressPairs ?? []) {
    lookup.set(pair.address, pair);
    lookup.set(pair.tokenAddress, pair);
  }
  return lookup;
}

function selectLargestUtxos(utxos, amountNeeded, predicate = () => true) {
  const eligible = utxos
    .filter(predicate)
    .slice()
    .sort((left, right) => {
      const diff = getUtxoSats(right) - getUtxoSats(left);
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

function selectLargestTokenUtxos(utxos, amountNeeded, predicate = () => true) {
  const eligible = utxos
    .filter(predicate)
    .slice()
    .sort((left, right) => {
      const diff = getTokenAmount(right) - getTokenAmount(left);
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

function summarizeUtxos(utxos) {
  return utxos.map((utxo) => ({
    id: utxoLabel(utxo),
    address: utxo.address ?? null,
    sats: fmtBigInt(getUtxoSats(utxo)),
    tokenCategory: getTokenCategory(utxo) || null,
    tokenAmount: fmtBigInt(getTokenAmount(utxo)),
  }));
}

export function buildLiveCauldronDryRun({
  portfolioSnapshot,
  marketSnapshot,
  oraclePriceRaw,
  maxSlippageBps,
}) {
  const preflight = buildLiveRebalancePreflight({
    portfolioSnapshot,
    marketSnapshot,
    oraclePriceRaw,
    maxSlippageBps,
  });

  const wallet = portfolioSnapshot?.wallet ?? null;
  const utxos = Array.isArray(wallet?.utxos) ? wallet.utxos : [];
  const addressLookup = buildAddressLookup(wallet);
  const pools = Array.isArray(marketSnapshot?.pools) ? marketSnapshot.pools : [];
  const direction = preflight.plan?.direction ?? 'hold';
  const stablecoinCategory = String(marketSnapshot?.tokenId ?? CAULDRON_TOKEN_ID);
  const route =
    preflight.plan && toBigInt(oraclePriceRaw ?? 0n) > 0n
      ? buildBestPoolTradeRoute({
          pools,
          direction,
          amountIn:
            direction === 'buy-stablecoin'
              ? preflight.plan?.expectedInputSats ?? 0n
              : preflight.plan?.tradeTokens ?? 0n,
          targetStablecoinAmount: preflight.plan?.tradeTokens ?? 0n,
          oraclePriceRaw: toBigInt(oraclePriceRaw ?? 0n),
          stablecoinCategory,
          feeRate: 30n,
        })
      : null;
  const selectedPools = route?.ok ? route.entries.map((entry) => entry.pool) : [];
  const selectedPool =
    selectedPools[0] ??
    pools.find((pool) => poolIdentity(pool) === preflight.market?.poolId) ??
    pools[0] ??
    null;
  const poolShape = selectedPool ? validateLiveCauldronPoolShape(selectedPool) : null;
  const selectedPoolId = selectedPool ? poolIdentity(selectedPool) : null;

  const setupBlockers = [];
  if (!preflight.wallet?.primaryAddress) {
    setupBlockers.push('Wallet address derivation unavailable');
  }
  if (!selectedPool) {
    setupBlockers.push('No active Cauldron pool available');
  }
  if (selectedPool && poolShape && !poolShape.ok) {
    setupBlockers.push(poolShape.error ?? 'Live pool locking bytecode mismatch');
  }
  if (route?.ok) {
    for (const pool of selectedPools.slice(1)) {
      const shape = validateLiveCauldronPoolShape(pool);
      if (!shape.ok) {
        setupBlockers.push(
          shape.error ?? `Live pool locking bytecode mismatch: ${poolIdentity(pool)}`
        );
      }
    }
  } else if (route?.error) {
    setupBlockers.push(`Route selection failed: ${route.error}`);
  }

  const plan = preflight.plan;
  const tradeAmount =
    direction === 'buy-stablecoin'
      ? toBigInt(preflight.plan?.expectedInputSats ?? 0)
      : toBigInt(preflight.plan?.tradeTokens ?? 0);

  let tradeInputs = [];
  let feeInput = null;
  let expectedFeeReserve = DRY_RUN_FEE_RESERVE_SATS;
  let settlementOutputs = [];
  let tradeOutputAddress = null;
  let changeAddress = wallet?.primaryAddress ?? null;
  let tokenChangeAddress = wallet?.primaryTokenAddress ?? null;

  if (direction === 'sell-stablecoin') {
    const tokenInputs = utxos.filter((utxo) => getTokenCategory(utxo) === stablecoinCategory);
    const selectedToken = selectLargestTokenUtxos(
      tokenInputs,
      tradeAmount,
      (utxo) => getTokenAmount(utxo) > 0n
    );
    tradeInputs.push(...selectedToken.chosen);
    feeInput =
      selectLargestUtxos(
        utxos,
        DRY_RUN_FEE_RESERVE_SATS,
        (utxo) => !utxo.token || getTokenAmount(utxo) === 0n
      ).chosen[0] ?? null;
    if (!feeInput) {
      setupBlockers.push('No BCH-only fee input available for token-to-BCH dry run');
    }
    if (selectedToken.total < tradeAmount) {
      setupBlockers.push('Token inputs do not cover the planned stablecoin trade amount');
    }
    tradeOutputAddress = wallet?.primaryAddress ?? null;
    const tokenChangeAmount = selectedToken.total > tradeAmount ? selectedToken.total - tradeAmount : 0n;
    settlementOutputs = [
      {
        address: tradeOutputAddress,
        value: fmtBigInt(preflight.quote?.amountOut ?? 0n),
        token: null,
      },
      ...(tokenChangeAmount > 0n && tokenChangeAddress
        ? [
            {
              address: tokenChangeAddress,
              value: DUST_THRESHOLD.toString(),
              token: {
                category: stablecoinCategory,
                amount: fmtBigInt(tokenChangeAmount),
              },
            },
          ]
        : []),
    ];
  } else if (direction === 'buy-stablecoin') {
    const bchInputs = utxos.filter((utxo) => !utxo.token || getTokenAmount(utxo) === 0n);
    const selectedBch = selectLargestUtxos(
      bchInputs,
      toBigInt(preflight.plan?.expectedInputSats ?? 0n) + DRY_RUN_FEE_RESERVE_SATS,
      () => true
    );
    tradeInputs = [...selectedBch.chosen];
    if (selectedBch.total < toBigInt(preflight.plan?.expectedInputSats ?? 0n) + DRY_RUN_FEE_RESERVE_SATS) {
      setupBlockers.push('BCH inputs do not cover the planned buy trade and fee reserve');
    }
    tradeOutputAddress = wallet?.primaryTokenAddress ?? null;
    const changeSats = selectedBch.total - toBigInt(preflight.plan?.expectedInputSats ?? 0n) - DRY_RUN_FEE_RESERVE_SATS;
    settlementOutputs = [
      {
        address: tradeOutputAddress,
        value: DUST_THRESHOLD.toString(),
        token: {
          category: stablecoinCategory,
          amount: fmtBigInt(preflight.quote?.amountOut ?? 0n),
        },
      },
      ...(changeSats >= DUST_THRESHOLD && changeAddress
        ? [
            {
              address: changeAddress,
              value: fmtBigInt(changeSats),
              token: null,
            },
          ]
        : []),
    ];
  }

  if (direction === 'sell-stablecoin' && feeInput) {
    const feeValue = getUtxoSats(feeInput);
    expectedFeeReserve = feeValue >= DRY_RUN_FEE_RESERVE_SATS ? DRY_RUN_FEE_RESERVE_SATS : feeValue;
  }

  const combinedWalletInputs = [...tradeInputs, ...(feeInput ? [feeInput] : [])];
  const walletInputSummary = summarizeUtxos(combinedWalletInputs);
  const totalInputSats = combinedWalletInputs.reduce((sum, utxo) => sum + getUtxoSats(utxo), 0n);

  const plannedOutputs = [
    ...settlementOutputs,
      ...(direction === 'buy-stablecoin'
        ? [
            {
              address: changeAddress,
              value: fmtBigInt(
                totalInputSats -
                  toBigInt(preflight.plan?.expectedInputSats ?? 0n) -
                  expectedFeeReserve
              ),
              token: null,
            },
          ]
        : feeInput && getUtxoSats(feeInput) > expectedFeeReserve
          ? [
              {
                address: changeAddress,
                value: fmtBigInt(getUtxoSats(feeInput) - expectedFeeReserve),
                token: null,
              },
            ]
          : []),
    ...(direction === 'sell-stablecoin' && tokenChangeAddress
      ? [
          {
            address: tokenChangeAddress,
            value: DUST_THRESHOLD.toString(),
            token: {
              category: stablecoinCategory,
              amount: '0',
            },
          },
        ]
      : []),
  ].filter(Boolean);

  const routeEntries =
    route?.ok && route.entries.length > 0
      ? route.entries
      : selectedPool
        ? [
            {
              pool: selectedPool,
              supply: tradeAmount,
              demand: toBigInt(preflight.quote?.amountOut ?? 0n),
            },
          ]
        : [];

  const poolInputs = routeEntries.map((entry) => {
    const pool = entry.pool ?? selectedPool;
    return {
      type: 'pool',
      poolId: poolIdentity(pool),
      txid: pool?.txid ?? null,
      vout: pool?.tx_pos ?? null,
    };
  });
  const poolOutputs = routeEntries.map((entry) => {
    const pool = entry.pool ?? selectedPool;
    const state = buildRoutePoolState(pool, entry, direction);
    const shape = pool ? validateLiveCauldronPoolShape(pool) : null;
    return {
      poolId: poolIdentity(pool),
      txid: pool?.txid ?? null,
      outputIndex: pool?.tx_pos ?? null,
      ownerPkh: pool?.owner_pkh ?? null,
      tokenId: pool?.token_id ?? null,
      exchangeUnlockingBytecode: pool?.owner_pkh
        ? Buffer.from(
            buildCauldronPoolV0ExchangeUnlockingBytecode({
              withdrawPublicKeyHash: pool.owner_pkh,
            })
          ).toString('hex')
        : null,
      lockingBytecode: pool?.locking_bytecode ?? shape?.expectedLockingBytecode ?? null,
      amount: fmtBigInt(state.amount),
      tokenAmount: fmtBigInt(state.tokenAmount),
    };
  });

  const transactionShape = routeEntries.length
    ? {
        version: 2,
        locktime: 0,
        pools: poolOutputs,
        inputs: [
          ...poolInputs,
          ...walletInputSummary.map((input) => ({
            type: 'wallet',
            ...input,
          })),
        ],
        outputs: plannedOutputs,
      }
    : null;

  return {
    ok: setupBlockers.length === 0,
    setupReady: setupBlockers.length === 0,
    marketReady: preflight.ok,
    broadcastReady: false,
    blockers: setupBlockers,
    marketBlockers: preflight.blockers,
    warnings: preflight.warnings,
    wallet: preflight.wallet,
    plan,
    pool: selectedPool
      ? {
          poolId: poolIdentity(selectedPool),
          txid: selectedPool.txid ?? null,
          outputIndex: selectedPool.tx_pos ?? null,
          ownerPkh: selectedPool.owner_pkh ?? null,
          lockingBytecode: selectedPool.locking_bytecode ?? null,
          shapeOk: poolShape?.ok ?? false,
          shapeError: poolShape?.error ?? null,
        }
      : null,
    route: route
      ? {
          ok: route.ok,
          error: route.error ?? null,
          poolCount: route.poolCount ?? 0,
          poolIds: route.poolIds ?? [],
          amountIn: route.amountIn?.toString?.() ?? '0',
          supply: route.routeSupply?.toString?.() ?? '0',
          demand: route.routeDemand?.toString?.() ?? '0',
          slippageBps: route.slippageBps ?? 0,
        }
      : null,
    inputs: walletInputSummary,
    outputs: plannedOutputs,
    expectedFeeReserve: fmtBigInt(expectedFeeReserve),
    transactionShape,
    oraclePriceRaw: fmtBigInt(toBigInt(oraclePriceRaw ?? 0n)),
    selectedPoolId,
  };
}
