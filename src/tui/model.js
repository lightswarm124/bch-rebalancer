import {
  CAULDRON_MODE,
  NETWORK,
  PROJECT_NAME,
  PROJECT_TAGLINE,
} from '../../config.js';
import { daemonDescribe } from '../domain/daemon.js';
import {
  formatSignedStablecoinAtomic,
  formatSignedUsdCents,
  formatStablecoinAtomic,
  formatUsdCents,
} from '../domain/money.js';

function fmtSats(value) {
  return `${toBigInt(value).toString()} sats`;
}

function fmtTokens(value) {
  return formatStablecoinAtomic(value);
}

function fmtUsd(value, digits = 2) {
  if (typeof value === 'bigint') {
    return formatUsdCents(value);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return '$0.00';
  return `$${value.toFixed(digits)}`;
}

function fmtSignedUsd(value, digits = 2) {
  if (typeof value === 'bigint') {
    return formatSignedUsdCents(value);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return '$0.00';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}$${Math.abs(value).toFixed(digits)}`;
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
  const text = String(value ?? 'n/a').trim() || 'n/a';
  if (text === 'n/a' || text.length <= left + right + 3) return text;
  return `${text.slice(0, left)}...${text.slice(-right)}`;
}

function line(label, value) {
  return `${label}: ${value}`;
}

const TAB_ORDER = ['overview', 'history', 'portfolio', 'token', 'pools'];

function buildRouteSummary(route) {
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

function buildDaemonSummary(daemon) {
  if (!daemon) return 'n/a';
  const current = daemonDescribe(daemon);
  const mode = current.running ? (current.paused ? 'paused' : 'running') : 'stopped';
  const next = current.paused ? 'paused' : formatDuration(current.nextAttemptInMs);
  const blocker = current.lastBlocker ? ` | blocker ${truncateMiddle(current.lastBlocker, 18, 10)}` : '';
  const txid = current.lastBroadcastTxid ? ` | tx ${truncateMiddle(current.lastBroadcastTxid, 10, 8)}` : '';
  return `${mode} | stage ${current.stage} | manual prompt | next ${next}${txid}${blocker}`;
}

function buildTxSummary(snapshot, daemon) {
  const txid = snapshot?.lastBroadcast?.txid ?? snapshot?.broadcast?.txid ?? daemon?.lastBroadcastTxid ?? null;
  if (!txid) return 'none';
  const status = snapshot?.lastBroadcast?.status ?? (snapshot?.broadcast?.txid ? 'broadcasted' : 'pending');
  return `${truncateMiddle(txid, 10, 8)} | ${status} | confirmation pending`;
}

function buildHistorySummary(historySummary) {
  if (!historySummary || historySummary.points <= 0) {
    return 'n/a';
  }
  const latest = historySummary.latestUsd ?? 0n;
  const delta = historySummary.deltaUsd ?? 0n;
  const tradeCount = Number(historySummary.trades ?? 0);
  return `points ${Number(historySummary.points ?? 0)} | start ${fmtUsd(historySummary.startUsd ?? 0n)} | now ${fmtUsd(latest)} | P/L ${fmtSignedUsd(delta)} | trades ${tradeCount}`;
}

function buildLedgerSummary(tradeLedger, historySummary) {
  const ledger = Array.isArray(tradeLedger) ? tradeLedger : [];
  const lastTrade = ledger[ledger.length - 1] ?? historySummary?.lastTrade ?? null;
  if (!lastTrade) {
    return 'no trades yet';
  }

  const tradeTokens = lastTrade.tradeTokens ?? null;
  const preUsd = lastTrade.preUsd !== null && lastTrade.preUsd !== undefined ? fmtUsd(lastTrade.preUsd) : 'n/a';
  const postUsd = lastTrade.postUsd !== null && lastTrade.postUsd !== undefined ? fmtUsd(lastTrade.postUsd) : 'pending';
  const deltaUsd = lastTrade.deltaUsd !== null && lastTrade.deltaUsd !== undefined
    ? fmtSignedUsd(lastTrade.deltaUsd)
    : 'pending';
  const status = lastTrade.chainStatus ?? lastTrade.status ?? 'pending';
  const fee = lastTrade.estimatedFeeSats !== null && lastTrade.estimatedFeeSats !== undefined
    ? ` | fee ${lastTrade.estimatedFeeSats} sats`
    : '';
  return `${truncateMiddle(lastTrade.txid, 10, 8)} | ${lastTrade.direction ?? 'trade'} | ${fmtTokens(
    tradeTokens ?? 0n
  )} | ${preUsd} -> ${postUsd} | P/L ${deltaUsd}${fee} | ${status}`;
}

function buildLedgerRows(tradeLedger, limit = 3) {
  const ledger = Array.isArray(tradeLedger) ? tradeLedger : [];
  if (ledger.length === 0) {
    return ['no trades yet'];
  }

  return ledger.slice(-limit).reverse().map((entry, index) => {
    const preUsd = entry.preUsd !== null && entry.preUsd !== undefined ? fmtUsd(entry.preUsd) : 'n/a';
    const postUsd = entry.postUsd !== null && entry.postUsd !== undefined ? fmtUsd(entry.postUsd) : 'pending';
    const deltaUsd =
      entry.deltaUsd !== null && entry.deltaUsd !== undefined ? fmtSignedUsd(entry.deltaUsd) : 'pending';
    const status = entry.chainStatus ?? entry.status ?? 'pending';
    const fee = entry.estimatedFeeSats !== null && entry.estimatedFeeSats !== undefined
      ? ` | fee ${entry.estimatedFeeSats} sats`
      : '';
    return `${index + 1}. ${truncateMiddle(entry.txid, 10, 8)} | ${entry.direction ?? 'trade'} | ${fmtTokens(
      entry.tradeTokens ?? 0n
    )} | ${preUsd} -> ${postUsd} | ${deltaUsd}${fee} | ${status}`;
  });
}

function buildOpportunitySummary({ preflight, dryRun }) {
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

function buildTradeActionSummary({ preflight, dryRun }) {
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

function buildOpportunitySignal({ preflight, dryRun }) {
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

function buildTabs(activeView) {
  return TAB_ORDER
    .map((view) => {
      const label = view === activeView ? `[${view}]` : view;
      return label;
    })
    .join('  ');
}

function buildHistoryLines(portfolio, historySummary, tradeLedger, daemon, preflight, dryRun) {
  const portfolioSnapshot = portfolio ?? {};
  const wallet = portfolioSnapshot?.wallet ?? null;
  const daemonSnapshot = preflight?.daemon ?? portfolioSnapshot?.daemon ?? daemon ?? null;
  const history = buildHistorySummary(historySummary ?? portfolioSnapshot.historySummary ?? null);
  const ledger = Array.isArray(tradeLedger) ? tradeLedger : portfolioSnapshot.tradeLedger ?? [];
  return [
    line('History', history),
    line('Tx history', `${wallet?.txHistoryCount ?? 0} on-chain events`),
    line('Ledger', buildLedgerSummary(ledger, historySummary ?? portfolioSnapshot.historySummary ?? null)),
    line('Opportunity', buildOpportunitySummary({ preflight, dryRun })),
    line('Trade', buildTradeActionSummary({ preflight, dryRun })),
    line('Tx', buildTxSummary(portfolioSnapshot, daemonSnapshot)),
    '',
    ...buildLedgerRows(ledger, 5).map((entry) => `Recent: ${entry}`),
  ];
}

function buildPoolItems(pools) {
  if (!pools.length) return ['(no active pools)'];
  return pools.slice(0, 10).map((pool, index) => {
    return `${index + 1}. ${truncateMiddle(pool?.pool_id, 10, 6)} | ${fmtSats(
      pool?.sats ?? pool?.tvl_sats ?? 0
    )} | ${fmtTokens(pool?.tokens ?? pool?.tvl_tokens ?? 0)} | ${truncateMiddle(
      pool?.owner_p2pkh_addr ?? pool?.owner ?? null,
      10,
      8
    )}`;
  });
}

function buildOverviewLines({ indexerHealth, oracle, market, portfolio, rebalance, preflight, daemon, dryRun, historySummary, tradeLedger }) {
  const portfolioSnapshot = portfolio ?? {};
  const tokenRow = market?.tokenRow ?? null;
  const wallet = portfolioSnapshot?.wallet ?? null;
  const totals = portfolioSnapshot?.totals ?? {};
  const route = preflight?.route ?? portfolioSnapshot?.preflight?.route ?? null;
  const daemonSnapshot = preflight?.daemon ?? portfolioSnapshot?.daemon ?? daemon ?? null;
  const broadcast = portfolioSnapshot?.lastBroadcast ?? null;
  const statusPrefix = broadcast?.status
    ? `${broadcast.status}${broadcast.txid ? ` | tx ${truncateMiddle(broadcast.txid, 10, 8)}` : ''}`
    : `${daemonSnapshot?.lastDecision ?? 'idle'} | ${daemonSnapshot?.stage ?? 'idle'}`;
  return [
    line('Price', `${fmtUsd(tokenRow?.price_now_usd ?? market?.priceNowUsd ?? 0)} | oracle ${fmtUsd(oracle?.priceValue)} | raw ${oracle?.priceRaw ?? 'n/a'}`),
    line('Balance', `${fmtSats(wallet?.bchSats ?? 0n)} BCH | ${fmtTokens(wallet?.stablecoinTokens ?? 0n)} stable`),
    line('Opportunity', buildOpportunitySummary({ preflight, dryRun })),
    line('Trade', buildTradeActionSummary({ preflight, dryRun })),
    line('Route', buildRouteSummary(route)),
    line('Tx', buildTxSummary(portfolioSnapshot, daemonSnapshot)),
    line('History', buildHistorySummary(historySummary ?? portfolioSnapshot.historySummary ?? null)),
    line('Tx history', `${wallet?.txHistoryCount ?? 0} on-chain events`),
    line('Ledger', buildLedgerSummary(tradeLedger ?? portfolioSnapshot.tradeLedger ?? [], historySummary ?? portfolioSnapshot.historySummary ?? null)),
    line('Status', `${statusPrefix} | ${indexerHealth?.ok ? 'indexer ok' : 'indexer degraded'}`),
  ];
}

function buildPortfolioLines(portfolio, rebalance, preflight, daemon, dryRun, historySummary, tradeLedger) {
  const portfolioSnapshot = portfolio ?? {};
  const wallet = portfolioSnapshot?.wallet ?? null;
  const totals = portfolioSnapshot?.totals ?? {};
  const route = preflight?.route ?? portfolioSnapshot?.preflight?.route ?? null;
  const daemonSnapshot = preflight?.daemon ?? portfolioSnapshot?.daemon ?? daemon ?? null;
  if (!wallet) return ['portfolio snapshot unavailable'];
  return [
    line('Wallet path', wallet.derivationPath ?? 'n/a'),
    line(
      'Primary',
      `${truncateMiddle(wallet.primaryAddress ?? 'n/a', 12, 8)} | token ${truncateMiddle(
        wallet.primaryTokenAddress ?? 'n/a',
        12,
        8
      )}`
    ),
    line('Scan', `${portfolioSnapshot.scannedPairs ?? 0} address pairs | hits ${wallet.discoveredPairs?.length ?? 0}`),
    line(
      'Holdings',
      `${wallet.utxoCount ?? 0} UTXOs | BCH ${fmtSats(wallet.bchSats ?? 0n)} | stable ${fmtTokens(
        wallet.stablecoinTokens ?? 0n
      )} | NFT ${wallet.nftCount ?? 0}`
    ),
    line(
      'Totals',
      `${fmtSats(totals.totalBchSats ?? 0n)} BCH | ${fmtTokens(totals.totalStablecoinTokens ?? 0n)} stable`
    ),
    line(
      'Recommendation',
      `${rebalance?.formatted?.headline ?? 'No rebalance'}${rebalance?.reason ? ` - ${rebalance.reason}` : ''}`
    ),
    line('Opportunity', buildOpportunitySummary({ preflight, dryRun })),
    line('Trade', buildTradeActionSummary({ preflight, dryRun })),
    line('History', buildHistorySummary(historySummary ?? portfolioSnapshot.historySummary ?? null)),
    line('Tx history', `${wallet?.txHistoryCount ?? 0} on-chain events`),
    line('Ledger', buildLedgerSummary(tradeLedger ?? portfolioSnapshot.tradeLedger ?? [], historySummary ?? portfolioSnapshot.historySummary ?? null)),
    line('Tx', buildTxSummary(portfolioSnapshot, daemonSnapshot)),
    ...buildLedgerRows(tradeLedger ?? portfolioSnapshot.tradeLedger ?? [], 3).map((entry) => `Recent: ${entry}`),
  ];
}

function buildTokenLines(market) {
  const tokenRow = market?.tokenRow ?? null;
  const tokenPriceUsd = tokenRow?.price_now_usd ?? market?.priceNowUsd ?? 0;
  return [
    line('Token', `${tokenRow?.display_name ?? 'n/a'} (${tokenRow?.display_symbol ?? 'n/a'}) | id ${market?.tokenId ?? 'n/a'}`),
    line('Price', `${fmtUsd(tokenPriceUsd)} | 24h ${fmtUsd(tokenRow?.price_24h_usd ?? tokenPriceUsd)} | 7d ${fmtUsd(tokenRow?.price_7d_usd ?? tokenPriceUsd)}`),
    line('Yield', `apy ${fmtPct((tokenRow?.apy_30d_bp ?? 0) / 100)} | tvl ${fmtSats(tokenRow?.tvl_sats ?? market?.tvlSats ?? 0)} | pools ${Array.isArray(market?.pools) ? market.pools.length : 0}`),
  ];
}

function buildPoolsLines(snapshot) {
  const market = snapshot?.market ?? {};
  const pools = Array.isArray(market.pools) ? market.pools : [];
  const preflight = snapshot?.preflight ?? null;
  const dryRun = snapshot?.dryRun ?? null;
  const daemon = snapshot?.daemon ?? null;
  const tradeLedger = snapshot?.tradeLedger ?? [];
  return [
    line(
      'Selected',
      `${pools.length} active | routing is automatic`
    ),
    line(
      'Route',
      buildRouteSummary(preflight?.route ?? null)
    ),
    line(
      'Dry run',
      `${dryRun?.setupReady ? 'setup ok' : 'setup blocked'} | inputs ${dryRun?.inputs?.length ?? 0} | outputs ${dryRun?.outputs?.length ?? 0}`
    ),
    line(
      'Broadcast',
      `${preflight?.canBroadcast ? 'yes' : 'no'} | ${preflight?.broadcastBlocker ?? 'broadcast disabled'}`
    ),
    line('Opportunity', buildOpportunitySummary({ preflight, dryRun })),
    line('Daemon', buildDaemonSummary(daemon)),
    ...buildLedgerRows(tradeLedger ?? portfolioSnapshot.tradeLedger ?? [], 3).map((entry) => `Recent: ${entry}`),
    '',
    ...buildPoolItems(pools),
  ];
}

function buildSelectedPoolLines(snapshot) {
  const market = snapshot?.market ?? {};
  const pools = Array.isArray(market.pools) ? market.pools : [];
  const preflight = snapshot?.preflight ?? null;
  const dryRun = snapshot?.dryRun ?? null;
  const daemon = snapshot?.daemon ?? null;
  return [
    line('Pools', `${pools.length} active | routing across all pools`),
    line('Route', buildRouteSummary(preflight?.route ?? null)),
    line('Best', preflight?.quote ? `${preflight.quote.amountOut ?? 'n/a'} | slippage ${preflight.quote.slippageBps ?? 'n/a'} bps` : 'n/a'),
    line(
      'Preflight',
      `${preflight?.readyToExecute ? 'ready' : 'blocked'} | ${preflight?.blockers?.[0] ?? 'ok'}`
    ),
    line(
      'Dry run',
      `${dryRun?.setupReady ? 'setup ok' : 'setup blocked'} | ${dryRun?.pool?.shapeOk ? 'pool shape ok' : 'pool shape check pending'}`
    ),
    line('Daemon', buildDaemonSummary(daemon)),
  ];
}

function buildHeaderLines({ status, tick, refreshMode, uiState }) {
  return [
    PROJECT_NAME,
    PROJECT_TAGLINE,
    line('Network', `${NETWORK} | mode ${CAULDRON_MODE} | refresh ${refreshMode}`),
    line('Tabs', buildTabs(uiState.view ?? 'overview')),
    line('Status', `${status ?? 'idle'} | tick ${tick} | view ${uiState.view ?? 'overview'} | ${uiState.tradeSignal ?? 'no trade'}`),
  ];
}

function buildHelpLines(activeView, promptOpen = false) {
  if (promptOpen) {
    return [
      'Shortcuts',
      'y / Enter: confirm the manual trade',
      'n / Esc: cancel the manual trade prompt',
      'tab: toggle confirm/cancel focus',
    ];
  }

  const common = ['q / Ctrl-C: quit', 'tab: next tab', 'shift+tab: previous tab', 'r: refresh now'];
  const tabSpecific = {
    overview: ['b: open the manual trade prompt when ready'],
    history: ['no tab-specific controls'],
    portfolio: ['no tab-specific controls'],
    token: ['no tab-specific controls'],
    pools: ['routing is automatic; no pool selection controls'],
  };

  return ['Shortcuts', ...common, ...(tabSpecific[activeView] ?? ['no tab-specific controls'])];
}

export function buildTuiModel({
  snapshot,
  status,
  tick,
  refreshMode,
  uiState,
}) {
  const portfolio = snapshot?.portfolio ?? snapshot?.portfolioSnapshot ?? null;
  const daemon = snapshot?.daemon ?? null;
  const preflight = snapshot?.preflight ?? portfolio?.preflight ?? null;
  const dryRun = snapshot?.dryRun ?? portfolio?.dryRun ?? null;
  const historySummary = snapshot?.historySummary ?? portfolio?.historySummary ?? null;
  const tradeLedger = snapshot?.tradeLedger ?? portfolio?.tradeLedger ?? [];
  const tradeSignal = buildOpportunitySignal({ preflight, dryRun });
  const activeView = uiState?.view ?? 'overview';
  return {
    headerLines: buildHeaderLines({ status, tick, refreshMode, uiState: { ...uiState, tradeSignal } }),
    tabs: buildTabs(activeView),
    activeView,
    overviewLines: buildOverviewLines({ ...snapshot, portfolio, preflight, daemon, dryRun, historySummary, tradeLedger }),
    historyLines: buildHistoryLines(portfolio, historySummary, tradeLedger, daemon, preflight, dryRun),
    portfolioLines: buildPortfolioLines(portfolio, snapshot?.rebalance, preflight, daemon, dryRun, historySummary, tradeLedger),
    tokenLines: buildTokenLines(snapshot?.market),
    poolsLines: buildPoolsLines(snapshot),
    selectedPoolLines: buildSelectedPoolLines(snapshot),
    helpLines: buildHelpLines(activeView, Boolean(uiState?.promptOpen)),
    pools: Array.isArray(snapshot?.market?.pools) ? snapshot.market.pools : [],
    daemon,
  };
}
