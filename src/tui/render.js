import {
  PROJECT_NAME,
  PROJECT_TAGLINE,
  NETWORK,
  CAULDRON_API_BASE_URL,
  CAULDRON_MODE,
  CAULDRON_POOL_ID,
  CAULDRON_TOKEN_ID,
} from '../../config.js';
import {
  formatSignedUsdCents,
  formatStablecoinAtomic,
  formatUsdCents,
  centsFromBchSats,
} from '../domain/money.js';

function fmtSats(value) {
  return `${value.toString()} sats`;
}

function fmtTokens(value) {
  return formatStablecoinAtomic(value);
}

function fmtBchUsd(value, oraclePriceRaw) {
  return fmtUsd(centsFromBchSats(toBigInt(value), toBigInt(oraclePriceRaw)));
}

function fmtStableUsd(value) {
  return fmtUsd(toBigInt(value));
}

function fmtUsd(value, digits = 2) {
  if (typeof value === 'bigint') return formatUsdCents(value);
  if (typeof value !== 'number' || !Number.isFinite(value)) return '$0.00';
  return `$${value.toFixed(digits)}`;
}

function fmtSignedUsd(value, digits = 2) {
  if (typeof value === 'bigint') return formatSignedUsdCents(value);
  if (typeof value !== 'number' || !Number.isFinite(value)) return '$0.00';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}$${Math.abs(value).toFixed(digits)}`;
}

function fmtMaybeText(value) {
  if (typeof value !== 'string') return 'n/a';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'n/a';
}

function fmtPct(value) {
  if (typeof value === 'bigint') return `${(Number(value) / 100).toFixed(2)}%`;
  if (typeof value === 'number' && Number.isFinite(value)) return `${value.toFixed(2)}%`;
  if (typeof value === 'string' && value.trim()) return value;
  return 'n/a';
}

function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value.trim()) {
    try {
      return BigInt(value.trim());
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function truncateMiddle(value, left = 10, right = 8) {
  const text = fmtMaybeText(value);
  if (text === 'n/a' || text.length <= left + right + 3) return text;
  return `${text.slice(0, left)}...${text.slice(-right)}`;
}

function renderLine(label, value) {
  return `${label}: ${value}`;
}

function buildTabBar(activeView) {
  const views = ['overview', 'history', 'portfolio', 'token', 'pools'];
  return views.map((view) => (view === activeView ? `[${view}]` : view)).join('  ');
}

function renderRouteSummary(route) {
  if (!route) return 'n/a';
  if (!route.ok) return `blocked | ${route.error ?? 'route unavailable'}`;
  const poolIds = Array.isArray(route.poolIds) ? route.poolIds.slice(0, 3) : [];
  return `${route.poolCount ?? poolIds.length} pools | demand ${route.demand ?? 'n/a'} | slippage ${
    route.slippageBps ?? 'n/a'
  } bps${poolIds.length ? ` | ${poolIds.map((id) => truncateMiddle(id, 8, 6)).join(', ')}` : ''}`;
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return 'n/a';
  const total = Math.max(0, Math.floor(Number(ms)));
  if (!Number.isFinite(total)) return 'n/a';
  if (total < 1000) return `${total}ms`;
  const seconds = Math.floor(total / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${remainder.toString().padStart(2, '0')}s`;
}

function renderDaemonSummary(daemon) {
  if (!daemon) return 'n/a';
  const mode = daemon.running ? (daemon.paused ? 'paused' : 'running') : 'stopped';
  const next = daemon.paused ? 'paused' : formatDuration(daemon.nextAttemptInMs);
  const blocker = daemon.lastBlocker ? ` | blocker ${truncateMiddle(daemon.lastBlocker, 18, 10)}` : '';
  const txid = daemon.lastBroadcastTxid ? ` | tx ${truncateMiddle(daemon.lastBroadcastTxid, 10, 8)}` : '';
  return `${mode} | stage ${daemon.stage ?? 'idle'} | manual prompt | next ${next}${txid}${blocker}`;
}

function renderTxSummary(snapshot, daemon) {
  const txid = snapshot?.lastBroadcast?.txid ?? snapshot?.broadcast?.txid ?? daemon?.lastBroadcastTxid ?? null;
  if (!txid) return 'none';
  const status = snapshot?.lastBroadcast?.status ?? (snapshot?.broadcast?.txid ? 'broadcasted' : 'pending');
  return `${truncateMiddle(txid, 10, 8)} | ${status} | confirmation pending`;
}

function renderHistorySummary(historySummary) {
  if (!historySummary || historySummary.points <= 0) {
    return 'n/a';
  }
  const latest = historySummary.latestUsd ?? 0n;
  const delta = historySummary.deltaUsd ?? 0n;
  const trades = Number(historySummary.trades ?? 0);
  return `points ${Number(historySummary.points ?? 0)} | start ${fmtUsd(historySummary.startUsd ?? 0n)} | now ${fmtUsd(latest)} | P/L ${fmtSignedUsd(delta)} | trades ${trades}`;
}

function renderLedgerSummary(tradeLedger, historySummary) {
  const ledger = Array.isArray(tradeLedger) ? tradeLedger : [];
  const lastTrade = ledger[ledger.length - 1] ?? historySummary?.lastTrade ?? null;
  if (!lastTrade) return 'no trades yet';

  const preUsd = lastTrade.preUsd !== null && lastTrade.preUsd !== undefined ? fmtUsd(lastTrade.preUsd) : 'n/a';
  const postUsd = lastTrade.postUsd !== null && lastTrade.postUsd !== undefined ? fmtUsd(lastTrade.postUsd) : 'pending';
  const deltaUsd =
    lastTrade.deltaUsd !== null && lastTrade.deltaUsd !== undefined ? fmtSignedUsd(lastTrade.deltaUsd) : 'pending';
  const status = lastTrade.chainStatus ?? lastTrade.status ?? 'pending';
  const fee = lastTrade.estimatedFeeSats !== null && lastTrade.estimatedFeeSats !== undefined
    ? ` | fee ${lastTrade.estimatedFeeSats} sats`
    : '';
  return `${truncateMiddle(lastTrade.txid, 10, 8)} | ${lastTrade.direction ?? 'trade'} | ${fmtTokens(
    lastTrade.tradeTokens ?? 0n
  )} | ${preUsd} -> ${postUsd} | P/L ${deltaUsd}${fee} | ${status}`;
}

function renderLedgerRows(tradeLedger, limit = 3) {
  const ledger = Array.isArray(tradeLedger) ? tradeLedger : [];
  if (!ledger.length) return ['  no trades yet'];

  return ledger.slice(-limit).reverse().map((entry, index) => {
    const preUsd = entry.preUsd !== null && entry.preUsd !== undefined ? fmtUsd(entry.preUsd) : 'n/a';
    const postUsd = entry.postUsd !== null && entry.postUsd !== undefined ? fmtUsd(entry.postUsd) : 'pending';
    const deltaUsd =
      entry.deltaUsd !== null && entry.deltaUsd !== undefined ? fmtSignedUsd(entry.deltaUsd) : 'pending';
    const status = entry.chainStatus ?? entry.status ?? 'pending';
    const fee = entry.estimatedFeeSats !== null && entry.estimatedFeeSats !== undefined
      ? ` | fee ${entry.estimatedFeeSats} sats`
      : '';
    return `  ${index + 1}. ${truncateMiddle(entry.txid, 10, 8)} | ${entry.direction ?? 'trade'} | ${fmtTokens(
      entry.tradeTokens ?? 0n
    )} | ${preUsd} -> ${postUsd} | ${deltaUsd}${fee} | ${status}`;
  });
}

function renderOpportunitySummary(preflight, dryRun) {
  const ready = Boolean(
    preflight?.readyToExecute &&
      dryRun?.setupReady &&
      dryRun?.marketReady &&
      !dryRun?.blockers?.length
  );
  const plan = preflight?.plan ?? null;
  const route = preflight?.route ?? dryRun?.route ?? null;
  const economics = preflight?.economics ?? null;
  const pieces = [ready ? 'ready' : 'blocked'];

  if (plan?.headline) pieces.push(plan.headline);
  if (plan?.details) pieces.push(plan.details);
  if (route?.poolCount !== null && route?.poolCount !== undefined) pieces.push(`${route.poolCount} pools`);
  if (preflight?.quote?.slippageBps !== null && preflight?.quote?.slippageBps !== undefined) {
    pieces.push(`slippage ${preflight.quote.slippageBps} bps`);
  }
  if (economics?.netBenefitCents !== null && economics?.netBenefitCents !== undefined) {
    pieces.push(`net ${fmtSignedUsd(economics.netBenefitCents)}`);
  }
  if (economics?.estimatedFeeCents !== null && economics?.estimatedFeeCents !== undefined) {
    pieces.push(`fees ${fmtUsd(economics.estimatedFeeCents)}`);
  }
  if (dryRun?.expectedFeeReserve !== null && dryRun?.expectedFeeReserve !== undefined) {
    pieces.push(`fee reserve ${dryRun.expectedFeeReserve} sats`);
  }
  pieces.push(
    ready ? 'press Trade now or b to review and confirm trade' : 'wait for a rebalance opportunity'
  );
  return pieces.join(' | ');
}

function renderTradeActionSummary(preflight, dryRun) {
  const ready = Boolean(
    preflight?.readyToExecute &&
      dryRun?.setupReady &&
      dryRun?.marketReady &&
      !dryRun?.blockers?.length
  );
  return ready
    ? '[ Trade now ] | b opens prompt | y confirm | n cancel'
    : 'no trade ready';
}

function renderOpportunitySignal(preflight, dryRun) {
  const ready = Boolean(
    preflight?.readyToExecute &&
      dryRun?.setupReady &&
      dryRun?.marketReady &&
      !dryRun?.blockers?.length
  );
  if (ready) return 'worth doing';
  if (preflight?.blockers?.length) return `blocked: ${preflight.blockers[0]}`;
  if (dryRun?.blockers?.length) return `blocked: ${dryRun.blockers[0]}`;
  return 'no trade';
}

function renderPoolLine(pool, index) {
  return `${index + 1} ${truncateMiddle(pool?.pool_id, 10, 6)} | ${fmtSats(
    toBigInt(pool?.sats ?? pool?.tvl_sats ?? 0)
  )} | ${fmtTokens(toBigInt(pool?.tokens ?? pool?.tvl_tokens ?? 0))} | owner ${truncateMiddle(
    pool?.owner_p2pkh_addr ?? pool?.owner ?? null,
    10,
    8
  )}`;
}

function renderTopPools(pools) {
  if (!pools.length) return ['  no active pools'];
  const topPools = pools.slice(0, 3);
  const lines = topPools.map((pool, index) => `  ${renderPoolLine(pool, index)}`);
  if (pools.length > topPools.length) {
    lines.push(`  +${pools.length - topPools.length} more`);
  }
  return lines;
}

function renderOverviewLines({ indexerHealth, oracle, market, portfolio, rebalance, preflight, daemon, dryRun, historySummary, tradeLedger }) {
  const portfolioSnapshot = portfolio ?? {};
  const tokenRow = market?.tokenRow ?? null;
  const wallet = portfolioSnapshot?.wallet ?? null;
  const route = preflight?.route ?? portfolioSnapshot?.preflight?.route ?? null;
  const daemonSnapshot = preflight?.daemon ?? portfolioSnapshot?.daemon ?? daemon ?? null;
  const broadcast = portfolioSnapshot?.lastBroadcast ?? null;
  const statusPrefix = broadcast?.status
    ? `${broadcast.status}${broadcast.txid ? ` | tx ${truncateMiddle(broadcast.txid, 10, 8)}` : ''}`
    : `${daemonSnapshot?.lastDecision ?? 'idle'} | ${daemonSnapshot?.stage ?? 'idle'}`;
  const history = renderHistorySummary(historySummary ?? portfolioSnapshot.historySummary ?? null);
  const ledger = renderLedgerSummary(
    tradeLedger ?? portfolioSnapshot.tradeLedger ?? [],
    historySummary ?? portfolioSnapshot.historySummary ?? null
  );
  return [
    renderLine('Price', `${fmtUsd(tokenRow?.price_now_usd ?? market?.priceNowUsd ?? 0)} | oracle ${fmtUsd(oracle?.priceValue)} | raw ${oracle?.priceRaw ?? 'n/a'}`),
    renderLine(
      'Balance',
      `${fmtSats(wallet?.bchSats ?? 0n)} BCH (~${fmtBchUsd(wallet?.bchSats ?? 0n, oracle?.priceRaw ?? 0n)}) | ${fmtTokens(
        wallet?.stablecoinTokens ?? 0n
      )} stable (~${fmtStableUsd(wallet?.stablecoinTokens ?? 0n)})`
    ),
    renderLine('Opportunity', renderOpportunitySummary(preflight, dryRun)),
    renderLine('Trade', renderTradeActionSummary(preflight, dryRun)),
    renderLine('Route', renderRouteSummary(route)),
    renderLine('Tx', renderTxSummary(portfolioSnapshot, daemonSnapshot)),
    renderLine('History', history),
    renderLine('Ledger', ledger),
    renderLine('Status', `${statusPrefix} | ${indexerHealth?.ok ? 'indexer ok' : 'indexer degraded'}${rebalance?.reason ? ` | ${rebalance.reason}` : ''}`),
  ];
}

function renderPortfolioSummary(portfolio, rebalance, preflight, daemon = null, oraclePriceRaw = 0n) {
  if (!portfolio) {
    return [
      '  portfolio snapshot unavailable',
    ];
  }

  const wallet = portfolio.wallet ?? null;
  const contract = portfolio.contract ?? {};
  const treasury = portfolio.treasury ?? {};
  const totals = portfolio.totals ?? {};
  const daemonSnapshot = preflight?.daemon ?? portfolio.preflight?.daemon ?? daemon ?? null;
  const tradeLedger = portfolio.tradeLedger ?? [];

  if (wallet) {
    return [
      renderLine(
        'Wallet',
        `${wallet.utxoCount ?? 0} UTXOs | BCH ${fmtSats(wallet.bchSats ?? 0n)} (~${fmtBchUsd(
          wallet.bchSats ?? 0n,
          oraclePriceRaw
        )}) | stable ${fmtTokens(wallet.stablecoinTokens ?? 0n)} (~${fmtStableUsd(
          wallet.stablecoinTokens ?? 0n
        )}) | NFT ${wallet.nftCount ?? 0}`
      ),
      renderLine(
        'Totals',
        `${fmtSats(totals.totalBchSats ?? 0n)} BCH (~${fmtBchUsd(
          totals.totalBchSats ?? 0n,
          oraclePriceRaw
        )}) | ${fmtTokens(totals.totalStablecoinTokens ?? 0n)} stable (~${fmtStableUsd(
          totals.totalStablecoinTokens ?? 0n
        )})`
      ),
      renderLine('History', renderHistorySummary(portfolio.historySummary ?? null)),
      renderLine('Tx history', `${wallet.txHistoryCount ?? 0} on-chain events`),
      renderLine('Ledger', renderLedgerSummary(tradeLedger, portfolio.historySummary ?? null)),
      renderLine(
        'Path',
        `${wallet.derivationPath ?? 'n/a'} | BCH ${truncateMiddle(wallet.primaryAddress ?? 'n/a', 12, 8)} | token ${truncateMiddle(
          wallet.primaryTokenAddress ?? 'n/a',
          12,
          8
        )}`
      ),
      renderLine('Tx', renderTxSummary(portfolio, daemonSnapshot)),
    ];
  }

  return [
    renderLine(
      'Portfolio',
      `C ${fmtSats(contract.bchSats ?? 0n)} (~${fmtBchUsd(contract.bchSats ?? 0n, oraclePriceRaw)}) / ${fmtTokens(
        contract.stablecoinTokens ?? 0n
      )} (~${fmtStableUsd(contract.stablecoinTokens ?? 0n)}) | T ${fmtSats(
        treasury.bchSats ?? 0n
      )} (~${fmtBchUsd(treasury.bchSats ?? 0n, oraclePriceRaw)}) / ${fmtTokens(
        treasury.stablecoinTokens ?? 0n
      )} (~${fmtStableUsd(treasury.stablecoinTokens ?? 0n)}) | NFT ${treasury.nftCount ?? 0}`
    ),
    renderLine(
      'Totals',
        `${fmtSats(totals.totalBchSats ?? 0n)} BCH (~${fmtBchUsd(
          totals.totalBchSats ?? 0n,
          oraclePriceRaw
        )}) | ${fmtTokens(totals.totalStablecoinTokens ?? 0n)} stable (~${fmtStableUsd(
          totals.totalStablecoinTokens ?? 0n
        )})`
    ),
    renderLine('History', renderHistorySummary(portfolio.historySummary ?? null)),
    renderLine('Tx history', `${portfolio.wallet?.txHistoryCount ?? 0} on-chain events`),
    renderLine('Ledger', renderLedgerSummary(tradeLedger, portfolio.historySummary ?? null)),
    renderLine('Tx', renderTxSummary(portfolio, daemonSnapshot)),
  ];
}

function renderHistorySummaryView(portfolio, preflight, daemon = null) {
  const portfolioSnapshot = portfolio ?? {};
  const wallet = portfolioSnapshot.wallet ?? null;
  const historySummary = portfolioSnapshot.historySummary ?? null;
  const tradeLedger = portfolioSnapshot.tradeLedger ?? [];
  const daemonSnapshot = preflight?.daemon ?? portfolioSnapshot?.daemon ?? daemon ?? null;
  const dryRun = preflight?.dryRun ?? portfolioSnapshot.dryRun ?? null;
  return [
    renderLine('History', renderHistorySummary(historySummary)),
    renderLine('Tx history', `${wallet?.txHistoryCount ?? 0} on-chain events`),
    renderLine('Ledger', renderLedgerSummary(tradeLedger, historySummary)),
    renderLine('Opportunity', renderOpportunitySummary(preflight, dryRun)),
    renderLine('Signal', renderOpportunitySignal(preflight, dryRun)),
    renderLine('Tx', renderTxSummary(portfolioSnapshot, daemonSnapshot)),
    '',
    ...renderLedgerRows(tradeLedger, 5).map((entry) => `Recent: ${entry}`),
  ];
}

function renderTokenSummary(market) {
  const tokenRow = market?.tokenRow ?? null;
  const tokenPriceUsd = tokenRow?.price_now_usd ?? market?.priceNowUsd ?? 0;
  return [
    renderLine(
      'Token',
      `${tokenRow?.display_name ?? 'n/a'} (${tokenRow?.display_symbol ?? 'n/a'}) | id ${market?.tokenId ?? 'n/a'}`
    ),
    renderLine(
      'Market',
      `price ${fmtUsd(tokenPriceUsd)} | 24h ${fmtUsd(tokenRow?.price_24h_usd ?? tokenPriceUsd)} | 7d ${fmtUsd(
        tokenRow?.price_7d_usd ?? tokenPriceUsd
      )}`
    ),
    renderLine(
      'Yield',
      `apy ${fmtPct((tokenRow?.apy_30d_bp ?? 0) / 100)} | tvl ${fmtSats(
        toBigInt(tokenRow?.tvl_sats ?? market?.tvlSats ?? 0)
      )} | pools ${Array.isArray(market?.pools) ? market.pools.length : 0}`
    ),
    renderLine('Opportunity', renderOpportunitySummary(market?.preflight ?? null, market?.dryRun ?? null)),
  ];
}

function renderHeader({ status, tick, refreshMode, uiState, preflight = null, dryRun = null }) {
  return [
    PROJECT_NAME,
    PROJECT_TAGLINE,
    '',
    renderLine('Network', `${NETWORK} | mode ${CAULDRON_MODE} | refresh ${refreshMode}`),
    renderLine('Tabs', buildTabBar(uiState.view ?? 'overview')),
    renderLine('View', `${uiState.view ?? 'overview'} | ${status ?? 'idle'} | tick ${tick} | ${renderOpportunitySignal(preflight, dryRun)}`),
  ];
}

function renderCompactDashboard({
  indexerHealth,
  oracle,
  market,
  portfolio,
  rebalance,
  preflight,
  dryRun = null,
  uiState,
  daemon = null,
}) {
  const tokenRow = market?.tokenRow ?? null;
  const pools = Array.isArray(market?.pools) ? market.pools : [];
  const wallet = portfolio?.wallet ?? null;
  const totals = portfolio?.totals ?? {};

  return [
    renderLine(
      'Oracle',
      `${oracle?.source ?? 'unknown'} | ${fmtUsd(oracle?.priceValue)} | raw ${oracle?.priceRaw ?? 'n/a'}`
    ),
    renderLine(
      'Indexer',
      `${indexerHealth?.ok ? 'ok' : 'degraded'} | tip ${indexerHealth?.payload?.chain_tip ?? 'n/a'}/${
        indexerHealth?.payload?.indexed_height ?? 'n/a'
      } | v ${indexerHealth?.payload?.version ?? 'n/a'}`
    ),
    renderLine(
      'Cauldron',
      `${tokenRow?.display_name ?? 'n/a'} | ${tokenRow?.display_symbol ?? 'n/a'} | price ${fmtUsd(
        tokenRow?.price_now_usd ?? market?.priceNowUsd ?? 0
      )} | apy ${fmtPct((tokenRow?.apy_30d_bp ?? 0) / 100)} | pools ${pools.length}`
    ),
    renderLine(
      'DEX',
      `${CAULDRON_API_BASE_URL} | pool ${CAULDRON_POOL_ID || 'n/a'} | token ${CAULDRON_TOKEN_ID || 'n/a'}`
    ),
    renderLine(
      'Balance',
      `BCH ${fmtSats(wallet?.bchSats ?? totals.totalBchSats ?? 0n)} (~${fmtBchUsd(
        wallet?.bchSats ?? totals.totalBchSats ?? 0n,
        oracle?.priceRaw ?? 0n
      )}) | stable ${fmtTokens(wallet?.stablecoinTokens ?? totals.totalStablecoinTokens ?? 0n)} (~${fmtStableUsd(
        wallet?.stablecoinTokens ?? totals.totalStablecoinTokens ?? 0n
      )})`
    ),
    renderLine('Route', renderRouteSummary(preflight?.route ?? portfolio?.preflight?.route ?? null)),
    renderLine('Daemon', renderDaemonSummary(preflight?.daemon ?? portfolio?.daemon ?? daemon ?? null)),
    renderLine('Trade', renderTradeActionSummary(preflight, preflight?.dryRun ?? dryRun ?? portfolio?.dryRun ?? null)),
    renderLine('Signal', renderOpportunitySignal(preflight, dryRun ?? portfolio?.dryRun ?? null)),
    renderLine('Tx', renderTxSummary(portfolio, preflight?.daemon ?? portfolio?.daemon ?? daemon ?? null)),
    renderLine('History', renderHistorySummary(portfolio?.historySummary ?? null)),
    renderLine('Ledger', renderLedgerSummary(portfolio?.tradeLedger ?? [], portfolio?.historySummary ?? null)),
    renderLine('Pools', `${pools.length} active | routing automatic`),
  ];
}

function renderFocusedToken(market) {
  const tokenRow = market?.tokenRow ?? null;
  return [
    renderLine('Token id', `${market?.tokenId ?? 'n/a'}`),
    renderLine('Name', `${tokenRow?.display_name ?? 'n/a'}`),
    renderLine('Symbol', `${tokenRow?.display_symbol ?? 'n/a'}`),
    renderLine('Decimals', `${tokenRow?.decimals ?? 'n/a'} | trades ${tokenRow?.trade_count ?? 'n/a'} | rank ${
      tokenRow?.score_rank ?? 'n/a'
    }`),
    renderLine('BCMR', `${fmtMaybeText(tokenRow?.bcmr?.name)} | ${fmtMaybeText(tokenRow?.bcmr?.uris?.web)}`),
  ];
}

function renderFocusedPools(market, portfolio, uiState, preflight, dryRun = null, daemon = null) {
  const pools = Array.isArray(market?.pools) ? market.pools : [];
  const tradeLedger = portfolio?.tradeLedger ?? [];
  const effectiveDryRun = dryRun ?? market?.dryRun ?? null;

  return [
    renderLine('Pools', `${pools.length} active | aggregated apy ${fmtMaybeText(market?.aggregatedApy?.apy)}`),
    renderLine('Opportunity', renderOpportunitySummary(preflight, effectiveDryRun)),
    renderLine('Signal', renderOpportunitySignal(preflight, effectiveDryRun)),
    renderLine('Trade', renderTradeActionSummary(preflight, preflight?.dryRun ?? effectiveDryRun)),
    renderLine('History', renderHistorySummary(portfolio?.historySummary ?? market?.historySummary ?? null)),
    renderLine('Ledger', renderLedgerSummary(portfolio?.tradeLedger ?? [], portfolio?.historySummary ?? null)),
    renderLine('Tx', renderTxSummary(market ?? {}, preflight?.daemon ?? market?.daemon ?? daemon ?? null)),
    ...renderLedgerRows(tradeLedger, 3).map((entry) => `Recent: ${entry}`),
    ...renderTopPools(pools),
    '',
    renderLine('Routing', 'automatic across all pools'),
    renderLine('Route', renderRouteSummary(preflight?.route ?? market?.preflight?.route ?? null)),
    renderLine('Daemon', renderDaemonSummary(preflight?.daemon ?? market?.daemon ?? daemon ?? null)),
  ];
}

function renderFooter(activeView, promptOpen) {
  if (promptOpen) {
    return [renderLine('Keys', 'y / Enter confirm | n / Esc cancel | tab toggle focus')];
  }

  const base = ['q quit', 'tab switch tab', 'r refresh'];
  const tabSpecific = {
    overview: 'b trade',
    history: null,
    portfolio: null,
    token: null,
    pools: 'routing automatic',
  };
  const extra = tabSpecific[activeView] ? ` | ${tabSpecific[activeView]}` : '';
  return [renderLine('Keys', `${base.join(' | ')}${extra}`)];
}

export function renderTuiFrame({
  indexerHealth,
  oracle,
  market,
  portfolio,
  tradeLedger = [],
  rebalance,
  preflight = null,
  dryRun = null,
  daemon = null,
  status,
  tick,
  uiState = {},
  refreshMode = 'manual',
}) {
  const effectivePreflight = preflight ?? portfolio?.preflight ?? market?.preflight ?? null;
  const tradeSignal = renderOpportunitySignal(effectivePreflight, dryRun ?? portfolio?.dryRun ?? null);
  const portfolioWithLedger = {
    ...(portfolio ?? {}),
    tradeLedger:
      Array.isArray(tradeLedger) && tradeLedger.length > 0 ? tradeLedger : portfolio?.tradeLedger ?? [],
  };
  const pools = Array.isArray(market?.pools) ? market.pools : [];
  const activeView = uiState.view ?? 'overview';
  let bodyLines = [];
  if (activeView === 'history') {
    bodyLines = renderHistorySummaryView(portfolioWithLedger, effectivePreflight, daemon);
  } else if (activeView === 'portfolio') {
    bodyLines = renderPortfolioSummary(portfolioWithLedger, rebalance, effectivePreflight, daemon, oracle?.priceRaw ?? 0n);
  } else if (activeView === 'token') {
    bodyLines = renderTokenSummary(market);
  } else if (activeView === 'pools') {
    bodyLines = renderFocusedPools(
      market,
      portfolioWithLedger,
      uiState,
      effectivePreflight,
      dryRun,
      daemon
    );
  } else {
    bodyLines = renderOverviewLines({
      indexerHealth,
      oracle,
      market,
      portfolio: portfolioWithLedger,
      rebalance,
      preflight: effectivePreflight,
      daemon,
      dryRun,
      historySummary: portfolioWithLedger.historySummary,
      tradeLedger: portfolioWithLedger.tradeLedger,
    });
  }
  const lines = [
    ...renderHeader({
      status,
      tick,
      refreshMode,
      uiState: { ...uiState, view: activeView, tradeSignal },
      preflight: effectivePreflight,
      dryRun,
    }),
    '',
    activeView.charAt(0).toUpperCase() + activeView.slice(1),
    ...bodyLines,
  ];
  lines.push('', ...renderFooter(activeView, Boolean(uiState.promptOpen)));
  return lines.join('\n');
}
