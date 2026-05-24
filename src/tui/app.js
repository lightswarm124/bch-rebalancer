import readline from 'node:readline';

import blessed from 'blessed';

import {
  BROADCAST_TEST_MAX_TRADE_TOKENS,
  CAULDRON_MODE,
  CAULDRON_PUBLIC_KEY_HASH,
  CAULDRON_TOKEN_ID,
  DAEMON_BACKOFF_MS,
  DAEMON_MAX_BACKOFF_MS,
  DAEMON_POLL_MS,
  INDEXER_BASE_URL,
  MAX_SLIPPAGE_BPS,
  MOCK_ORACLE_PRICE_RAW,
  PROJECT_NAME,
  PROJECT_TAGLINE,
  TUI_REFRESH_MS,
} from '../../config.js';
import { createCauldronAdapter } from '../adapters/cauldron.js';
import { fetchIndexerHealth } from '../adapters/indexer.js';
import { fetchOracleSnapshot } from '../adapters/oracle.js';
import { fetchWalletPortfolioSnapshot } from '../adapters/wallet.js';
import { buildLiveCauldronDryRun } from '../domain/dryrun.js';
import { broadcastLiveCauldronTrade } from '../domain/broadcast.js';
import { writeLastBroadcastRecord, readLastBroadcastRecord } from '../domain/broadcastJournal.js';
import {
  appendPortfolioHistoryRecord,
  buildPortfolioTradeLedger,
  readPortfolioHistory,
  summarizePortfolioHistory,
} from '../domain/portfolioJournal.js';
import { buildPortfolioRebalanceSnapshot, portfolioUsdValue } from '../domain/rebalance.js';
import { buildLiveRebalancePreflight } from '../domain/preflight.js';
import { formatStablecoinAtomic } from '../domain/money.js';
import { createMockCauldronFixture } from '../mocknet/cauldronFixture.js';
import { renderTuiFrame } from './render.js';
import { toBigInt } from '../domain/portfolio.js';

readline.emitKeypressEvents(process.stdin);

function clampIndex(index, length) {
  if (!Number.isFinite(length) || length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

const TAB_ORDER = ['overview', 'history', 'portfolio', 'token', 'pools'];

function normalizeView(view) {
  return TAB_ORDER.includes(view) ? view : 'overview';
}

function nextView(view, delta) {
  const currentIndex = TAB_ORDER.indexOf(normalizeView(view));
  const nextIndex = (currentIndex + delta + TAB_ORDER.length) % TAB_ORDER.length;
  return TAB_ORDER[nextIndex];
}

function formatSats(value) {
  return `${toBigInt(value).toString()} sats`;
}

function canPromptManualTrade(snapshot) {
  const preflight = snapshot?.preflight ?? null;
  const dryRun = snapshot?.dryRun ?? null;
  return Boolean(
    preflight?.readyToExecute &&
      dryRun?.setupReady &&
      dryRun?.marketReady &&
      !dryRun?.blockers?.length
  );
}

function buildManualTradePromptLines(snapshot, focus = 'confirm') {
  const preflight = snapshot?.preflight ?? null;
  const dryRun = snapshot?.dryRun ?? null;
  const economics = preflight?.economics ?? null;
  const route = preflight?.route ?? dryRun?.route ?? null;
  const plan = preflight?.plan ?? null;
  const blockers = [...(preflight?.blockers ?? []), ...(dryRun?.blockers ?? [])];
  const feeReserve = dryRun?.expectedFeeReserve ?? null;

  if (!canPromptManualTrade(snapshot)) {
    return [
      'No rebalance opportunity is ready yet.',
      `Plan: ${plan?.headline ?? 'No rebalance'}${plan?.details ? ` | ${plan.details}` : ''}`,
      `Route: ${route?.ok ? `${route.poolCount ?? 0} pools | slippage ${route.slippageBps ?? 'n/a'} bps` : 'n/a'}`,
      blockers.length ? `Blocker: ${blockers[0]}` : 'Blocker: waiting for the next opportunity',
      'Press n to close.',
    ];
  }

  return [
    'Manual trade opportunity ready.',
    `Plan: ${plan?.headline ?? 'No rebalance'}${plan?.details ? ` | ${plan.details}` : ''}`,
    `Route: ${route?.ok ? `${route.poolCount ?? 0} pools | slippage ${route.slippageBps ?? 'n/a'} bps` : 'n/a'}`,
    `Dry run: ${dryRun?.setupReady ? 'setup ok' : 'setup blocked'} | ${dryRun?.marketReady ? 'market ok' : 'market blocked'}`,
    `Fee reserve: ${feeReserve ?? 'n/a'} sats`,
    economics
      ? `Economics: gross ${economics.grossImprovementCents ?? 'n/a'} | fee ${economics.estimatedFeeCents ?? 'n/a'} | net ${economics.netBenefitCents ?? 'n/a'}`
      : 'Economics: n/a',
    `Focus: ${focus}`,
    'Keys: y / Enter confirms prompt | n / Esc cancels | tab toggles focus',
  ];
}

export async function loadSnapshot() {
  const cauldronMode = String(CAULDRON_MODE ?? 'live').toLowerCase();
  const mockFixture =
    cauldronMode === 'mock'
      ? createMockCauldronFixture({
          poolId: process.env.CAULDRON_POOL_ID ?? 'mock-cauldron-pool-1',
          tokenId: CAULDRON_TOKEN_ID,
          oraclePriceRaw: MOCK_ORACLE_PRICE_RAW,
          poolCount: Number(process.env.CAULDRON_MOCK_POOL_COUNT ?? 3),
        })
      : null;

  const [indexerHealth, oracle, market, portfolioSnapshot] = await Promise.all([
    fetchIndexerHealth({
      baseUrl: INDEXER_BASE_URL,
    }),
    cauldronMode === 'mock'
      ? Promise.resolve({
          source: 'mock',
          ...mockFixture.getCurrentPrice(),
          priceRaw: mockFixture.state.oraclePriceRaw,
          priceScale: 100,
          priceValue: Number(mockFixture.state.oraclePriceRaw) / 100,
        })
      : fetchOracleSnapshot(),
    createCauldronAdapter(
      cauldronMode === 'mock'
        ? { mode: 'mock', fixture: mockFixture }
        : {
            tokenId: CAULDRON_TOKEN_ID,
            poolId: process.env.CAULDRON_POOL_ID ?? '',
            publicKeyHash: CAULDRON_PUBLIC_KEY_HASH,
          }
    ).getMarketSnapshot(),
    cauldronMode === 'mock'
      ? Promise.resolve(null)
      : fetchWalletPortfolioSnapshot({
          baseUrl: INDEXER_BASE_URL,
          stablecoinCategory: CAULDRON_TOKEN_ID,
        }).catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })),
  ]);

  const lastBroadcast = await readLastBroadcastRecord();
  const history = await readPortfolioHistory({ limit: 90 });
  const tradeLedger = buildPortfolioTradeLedger(history, {
    txHistory: portfolioSnapshot?.wallet?.txHistory ?? [],
  });
  const liveHistoryBaseline = portfolioSnapshot?.ok
    ? summarizePortfolioHistory([
        {
          type: 'snapshot',
          timestamp: Date.now(),
          bchSats: portfolioSnapshot.totals?.totalBchSats ?? 0n,
          stablecoinTokens: portfolioSnapshot.totals?.totalStablecoinTokens ?? 0n,
          oraclePriceRaw: oracle?.priceRaw ?? 0n,
          totalUsd: portfolioUsdValue({
            bchSats: portfolioSnapshot.totals?.totalBchSats ?? 0n,
            stablecoinTokens: portfolioSnapshot.totals?.totalStablecoinTokens ?? 0n,
            oraclePriceRaw: toBigInt(oracle?.priceRaw ?? 0),
          }),
        },
      ])
    : summarizePortfolioHistory([]);

  let historySummary = history.length > 0 ? summarizePortfolioHistory(history) : liveHistoryBaseline;
  if (
    portfolioSnapshot?.ok &&
    historySummary.points > 0 &&
    historySummary.latestUsd === 0n &&
    historySummary.trades === 0
  ) {
    historySummary = liveHistoryBaseline;
  }

  const rebalance = portfolioSnapshot?.ok
    ? buildPortfolioRebalanceSnapshot({
        bchSats: portfolioSnapshot.totals?.totalBchSats ?? 0n,
        stablecoinTokens: portfolioSnapshot.totals?.totalStablecoinTokens ?? 0n,
        oraclePriceRaw: toBigInt(oracle?.priceRaw ?? 0),
      })
    : null;

  return {
    indexerHealth,
    oracle,
    market,
    portfolio: portfolioSnapshot,
    portfolioSnapshot,
    tradeLedger,
    rebalance,
    lastBroadcast,
    history,
    historySummary,
    mockFixture,
  };
}

function renderOverviewScreen(snapshot, uiState, status, tick, promptOpen, lastMessage) {
  return renderTuiFrame({
    indexerHealth: snapshot?.indexerHealth,
    oracle: snapshot?.oracle,
    market: snapshot?.market,
    portfolio: snapshot?.portfolioSnapshot,
    rebalance: snapshot?.rebalance,
    preflight: snapshot?.preflight,
    dryRun: snapshot?.dryRun,
    historySummary: snapshot?.historySummary,
    tradeLedger: snapshot?.tradeLedger,
    daemon: snapshot?.daemon,
    status,
    tick,
    uiState: {
      ...uiState,
      tradeSignal: canPromptManualTrade(snapshot) ? 'worth doing' : 'blocked',
      promptOpen,
      lastMessage,
    },
  });
}

function buildFooterText({ status, promptOpen, lastMessage, view }) {
  const parts = [`status ${status}`];
  if (promptOpen) {
    parts.push('manual prompt');
    parts.push('y confirm', 'n cancel');
  } else {
    parts.push('q quit', 'tab switch tabs', 'r refresh');
    if (view === 'overview') {
      parts.push('b trade');
    }
  }
  if (lastMessage) {
    parts.push(lastMessage);
  }
  return parts.join(' | ');
}

export async function runTui({ refreshMs = TUI_REFRESH_MS } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    await printStatusOnce();
    return;
  }

  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    dockBorders: true,
    mouse: false,
    warnings: false,
    title: PROJECT_NAME,
  });

  let rawModeEnabled = false;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    rawModeEnabled = true;
  }

  if (typeof screen.program?.disableMouse === 'function') {
    screen.program.disableMouse();
  }

  screen.program.hideCursor();

  let stopped = false;
  let tick = 0;
  let status = 'loading';
  let latestSnapshot = null;
  let renderInFlight = false;
  let renderQueued = false;
  let promptOpen = false;
  let promptFocus = 'confirm';
  let lastMessage = '';
  const uiState = {
    view: 'overview',
  };

  const mainBox = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    right: 0,
    bottom: 1,
    border: { type: 'line' },
    style: {
      border: { fg: 'cyan' },
    },
    tags: false,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    mouse: false,
    content: 'Loading…',
  });

  const footer = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    right: 0,
    height: 1,
    style: { fg: 'gray' },
    tags: false,
    content: '',
  });

  const tradeButton = blessed.button({
    parent: screen,
    bottom: 0,
    right: 1,
    height: 1,
    shrink: true,
    keys: false,
    style: {
      fg: 'black',
      bg: 'gray',
      focus: { bg: 'lightgreen' },
    },
    content: ' No trade ',
  });

  const promptBox = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '82%',
    height: 12,
    border: { type: 'line' },
    hidden: true,
    draggable: false,
    style: {
      border: { fg: 'yellow' },
    },
    padding: {
      left: 1,
      right: 1,
      top: 1,
      bottom: 1,
    },
    tags: false,
  });

  const confirmButton = blessed.button({
    parent: promptBox,
    bottom: 1,
    left: 2,
    width: 14,
    height: 1,
    keys: false,
    content: ' Confirm ',
    style: {
      fg: 'black',
      bg: 'green',
      focus: { bg: 'lightgreen' },
    },
  });

  const cancelButton = blessed.button({
    parent: promptBox,
    bottom: 1,
    right: 2,
    width: 14,
    height: 1,
    keys: false,
    content: ' Cancel ',
    style: {
      fg: 'white',
      bg: 'gray',
      focus: { bg: 'white', fg: 'black' },
    },
  });

  function syncPromptButtons() {
    const confirmFocused = promptFocus === 'confirm';
    confirmButton.style.bg = confirmFocused ? 'green' : 'gray';
    confirmButton.style.fg = confirmFocused ? 'black' : 'white';
    cancelButton.style.bg = confirmFocused ? 'gray' : 'white';
    cancelButton.style.fg = confirmFocused ? 'white' : 'black';
  }

  function paint() {
    if (stopped) return;

    const manualReady = canPromptManualTrade(latestSnapshot);
    const frame = latestSnapshot
      ? renderOverviewScreen(latestSnapshot, uiState, status, tick, promptOpen, lastMessage)
      : 'Loading…';

    mainBox.setContent(frame);
    footer.setContent(
      buildFooterText({
        status,
        promptOpen,
        view: uiState.view,
        lastMessage,
      })
    );

    const showTradeButton = uiState.view === 'overview' && manualReady && !promptOpen;
    tradeButton.setContent(manualReady ? ' Trade now ' : ' No trade ');
    tradeButton.style.bg = manualReady ? 'green' : 'gray';
    tradeButton.style.fg = manualReady ? 'black' : 'white';
    if (showTradeButton) {
      tradeButton.show();
    } else {
      tradeButton.hide();
    }

    if (promptOpen) {
      promptBox.show();
      promptBox.setContent(buildManualTradePromptLines(latestSnapshot, promptFocus).join('\n'));
      syncPromptButtons();
    } else {
      promptBox.hide();
    }

    screen.render();
  }

  async function refresh({ force = false } = {}) {
    if (renderInFlight && !force) {
      renderQueued = true;
      return;
    }

    renderInFlight = true;
    status = 'refreshing';
      lastMessage = '';

    try {
      const raw = await loadSnapshot();
      const preflight = raw.portfolioSnapshot?.ok
        ? buildLiveRebalancePreflight({
            portfolioSnapshot: raw.portfolioSnapshot,
            marketSnapshot: raw.market,
            oraclePriceRaw: raw.oracle?.priceRaw ?? 0n,
          })
        : null;
      const dryRun = raw.portfolioSnapshot?.ok
        ? buildLiveCauldronDryRun({
            portfolioSnapshot: raw.portfolioSnapshot,
            marketSnapshot: raw.market,
            oraclePriceRaw: raw.oracle?.priceRaw ?? 0n,
            maxSlippageBps: preflight?.quote?.slippageBps ?? MAX_SLIPPAGE_BPS,
          })
        : null;

      const runtime = {
        ...raw,
        preflight,
        dryRun,
        daemon: {
          running: true,
          paused: false,
          stage: promptOpen ? 'manual-prompt' : 'idle',
          nextAttemptInMs: refreshMs > 0 ? refreshMs : null,
          lastBlocker: preflight?.blockers?.[0] ?? dryRun?.blockers?.[0] ?? null,
          lastBroadcastTxid: raw.lastBroadcast?.txid ?? null,
        },
      };

      latestSnapshot = runtime;
      tick += 1;
      status = canPromptManualTrade(runtime)
        ? 'manual-ready'
        : runtime.indexerHealth?.ok
          ? 'ok'
          : 'indexer-degraded';
    } catch (error) {
      status = 'error';
      lastMessage = error instanceof Error ? error.message : String(error);
    } finally {
      renderInFlight = false;
      paint();
      if (renderQueued && !stopped) {
        renderQueued = false;
        void refresh({ force: true });
      }
    }
  }

  function openPrompt() {
    if (uiState.view !== 'overview') {
      lastMessage = 'trade prompt only available on overview';
      paint();
      return;
    }
    if (!canPromptManualTrade(latestSnapshot)) {
      lastMessage = 'manual trade unavailable';
      paint();
      return;
    }
    promptOpen = true;
    promptFocus = 'confirm';
    paint();
  }

  function setView(view) {
    uiState.view = normalizeView(view);
    paint();
  }

  function cycleView(delta) {
    setView(nextView(uiState.view, delta));
  }

  function closePrompt() {
    promptOpen = false;
    promptFocus = 'confirm';
    paint();
  }

  function togglePromptFocus() {
    promptFocus = promptFocus === 'confirm' ? 'cancel' : 'confirm';
    paint();
  }

  async function executeManualTrade() {
    const currentSnapshot = latestSnapshot;
    if (!currentSnapshot || !canPromptManualTrade(currentSnapshot)) {
      status = 'manual-blocked';
      promptOpen = false;
      paint();
      return;
    }

    promptOpen = false;
    status = 'broadcasting';
    paint();

    try {
      const broadcast = await broadcastLiveCauldronTrade({
        portfolioSnapshot: currentSnapshot.portfolioSnapshot ?? currentSnapshot.portfolio ?? null,
        marketSnapshot: currentSnapshot.market,
        oraclePriceRaw: currentSnapshot.oracle?.priceRaw ?? 0n,
        maxSlippageBps: MAX_SLIPPAGE_BPS,
        tradeTokenCap: BROADCAST_TEST_MAX_TRADE_TOKENS,
        broadcastEnabled: true,
      });
      const route = currentSnapshot.preflight?.route ?? currentSnapshot.dryRun?.route ?? null;
      const broadcastRecord = await writeLastBroadcastRecord({
        txid: broadcast.txid,
        broadcastAt: Date.now(),
        direction: broadcast.direction,
        poolCount: route?.poolCount ?? 0,
        slippageBps: route?.slippageBps ?? null,
        estimatedFeeSats: broadcast.estimatedFee ?? null,
        status: 'broadcasted',
      });
      await appendPortfolioHistoryRecord({
        type: 'broadcast',
        timestamp: Date.now(),
        txid: broadcast.txid,
        direction: broadcast.direction,
        bchSats: currentSnapshot.portfolioSnapshot?.totals?.totalBchSats ?? 0n,
        stablecoinTokens: currentSnapshot.portfolioSnapshot?.totals?.totalStablecoinTokens ?? 0n,
        oraclePriceRaw: currentSnapshot.oracle?.priceRaw ?? 0n,
        totalUsd: currentSnapshot.rebalance?.totalUsd ?? undefined,
        tradeTokens: broadcast.cappedTradeTokens ?? null,
        poolCount: route?.poolCount ?? 0,
        slippageBps: route?.slippageBps ?? null,
        estimatedFeeSats: broadcast.estimatedFee ?? null,
        status: 'broadcasted',
      });
      lastMessage = `broadcasted ${broadcast.txid}`;
      status = 'broadcasted';
      latestSnapshot = {
        ...(currentSnapshot ?? {}),
        lastBroadcast: broadcastRecord ?? currentSnapshot.lastBroadcast ?? null,
      };
      await refresh({ force: true });
    } catch (error) {
      status = 'manual-ready';
      lastMessage = `broadcast failed: ${error instanceof Error ? error.message : String(error)}`;
      paint();
    }
  }

  const interval =
    Number.isFinite(refreshMs) && refreshMs > 0
      ? setInterval(() => {
          void refresh();
        }, refreshMs)
      : null;

  function shutdown() {
    if (stopped) return;
    stopped = true;
    if (interval) clearInterval(interval);
    screen.destroy();
    if (rawModeEnabled) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }
    process.stdout.write('\n');
    process.exit(0);
  }

  screen.key(['C-c', 'q'], shutdown);
  screen.key(['r'], () => {
    void refresh({ force: true });
  });
  screen.key(['tab'], () => {
    if (promptOpen) {
      togglePromptFocus();
      return;
    }
    cycleView(1);
  });
  screen.key(['S-tab', 'backtab'], () => {
    if (promptOpen) {
      togglePromptFocus();
      return;
    }
    cycleView(-1);
  });
  screen.key(['b'], () => {
    if (uiState.view === 'overview') {
      openPrompt();
    }
  });
  screen.key(['enter', 'return', 'y'], () => {
    if (!promptOpen) return;
    if (promptFocus === 'confirm') {
      void executeManualTrade();
      return;
    }
    closePrompt();
  });
  screen.key(['escape', 'n'], () => {
    if (promptOpen) {
      closePrompt();
    }
  });

  if (tradeButton && typeof tradeButton.on === 'function') {
    tradeButton.on('press', () => {
      if (uiState.view === 'overview') {
        openPrompt();
      }
    });
  }
  if (confirmButton && typeof confirmButton.on === 'function') {
    confirmButton.on('press', () => {
      promptFocus = 'confirm';
      void executeManualTrade();
    });
  }
  if (cancelButton && typeof cancelButton.on === 'function') {
    cancelButton.on('press', () => {
      closePrompt();
    });
  }

  process.on('SIGINT', shutdown);
  await refresh({ force: true });
}

export async function printStatusOnce() {
  const snapshot = await loadSnapshot();
  console.log(JSON.stringify(snapshot.indexerHealth, null, 2));
}

export async function printPortfolioPlanOnce() {
  const snapshot = await loadSnapshot();
  console.log(`${snapshot.market?.tokenRow?.display_name ?? 'Portfolio'} rebalance plan`);
  console.log('');
  console.log(`Indexer: ${snapshot.portfolioSnapshot?.ok ? 'ok' : 'degraded'}`);
  console.log(
    `Wallet scan: ${snapshot.portfolioSnapshot?.scannedPairs ?? 0} address pairs | hits ${
      snapshot.portfolioSnapshot?.wallet?.discoveredPairs?.length ?? 0
    }`
  );
  console.log(
    `Totals: BCH ${snapshot.portfolioSnapshot?.totals?.totalBchSats?.toString?.() ?? '0'} sats | stablecoin ${
      formatStablecoinAtomic(snapshot.portfolioSnapshot?.totals?.totalStablecoinTokens ?? 0n)
    }`
  );
  if (snapshot.rebalance) {
    console.log(`Recommendation: ${snapshot.rebalance.formatted?.headline ?? snapshot.rebalance.reason}`);
    console.log(snapshot.rebalance.formatted?.details ?? snapshot.rebalance.reason ?? 'No action required');
  } else {
    console.log('Recommendation: unavailable');
  }
}

export async function printPreflightOnce() {
  const snapshot = await loadSnapshot();
  const preflight = buildLiveRebalancePreflight({
    portfolioSnapshot: snapshot.portfolioSnapshot,
    marketSnapshot: snapshot.market,
    oraclePriceRaw: snapshot.oracle?.priceRaw ?? 0n,
  });

  console.log(`${snapshot.market?.tokenRow?.display_name ?? 'Portfolio'} live rebalance preflight`);
  console.log('');
  console.log(`Wallet: ${preflight.wallet?.primaryAddress ?? 'n/a'}`);
  console.log(
    `Pool: ${preflight.market?.poolId ?? 'n/a'}${preflight.quote?.slippageBps !== null ? ` | slippage ${preflight.quote.slippageBps} bps` : ''}`
  );
  if (preflight.route) {
    console.log(
      `Route: ${preflight.route.ok ? 'ok' : 'blocked'} | ${preflight.route.poolCount ?? 0} pools | demand ${preflight.route.demand ?? 'n/a'} | slippage ${preflight.route.slippageBps ?? 'n/a'} bps`
    );
  }
  console.log(
    `Plan: ${preflight.plan?.headline ?? 'No rebalance'}${preflight.plan?.details ? ` | ${preflight.plan.details}` : ''}`
  );
  console.log(`Quote: ${preflight.quote?.amountOut ?? 'n/a'}`);
  console.log(
    `Ready: ${preflight.readyToExecute ? 'yes' : 'no'} | broadcast: ${
      preflight.canBroadcast ? 'yes' : 'no'
    }`
  );
  if (preflight.blockers.length > 0) {
    console.log('Blockers:');
    for (const blocker of preflight.blockers) {
      console.log(`  - ${blocker}`);
    }
  }
  if (preflight.broadcastBlocker) {
    console.log(`Broadcast blocker: ${preflight.broadcastBlocker}`);
  }
  if (Array.isArray(preflight.quoteCandidates) && preflight.quoteCandidates.length > 0) {
    console.log('Top pool quotes:');
    for (const candidate of preflight.quoteCandidates) {
      console.log(
        `  ${candidate.poolId ?? 'n/a'} | out ${candidate.amountOut} | slippage ${candidate.slippageBps} bps | ${candidate.sats} sats / ${formatStablecoinAtomic(candidate.tokens)}`
      );
    }
  }
}

export async function printDryRunOnce() {
  const snapshot = await loadSnapshot();
  const dryRun = buildLiveCauldronDryRun({
    portfolioSnapshot: snapshot.portfolioSnapshot,
    marketSnapshot: snapshot.market,
    oraclePriceRaw: snapshot.oracle?.priceRaw ?? 0n,
  });

  console.log(`${snapshot.market?.tokenRow?.display_name ?? 'Portfolio'} live Cauldron dry run`);
  console.log('');
  console.log(`Wallet: ${dryRun.wallet?.primaryAddress ?? 'n/a'}`);
  console.log(`Pool: ${dryRun.pool?.poolId ?? 'n/a'}${dryRun.pool?.shapeOk ? '' : ' | shape mismatch'}`);
  console.log(
    `Setup ready: ${dryRun.setupReady ? 'yes' : 'no'} | market ready: ${dryRun.marketReady ? 'yes' : 'no'} | broadcast: ${dryRun.broadcastReady ? 'yes' : 'no'}`
  );
  console.log(
    `Plan: ${dryRun.plan?.headline ?? 'No rebalance'}${dryRun.plan?.details ? ` | ${dryRun.plan.details}` : ''}`
  );
  console.log(`Fee reserve: ${dryRun.expectedFeeReserve ?? 'n/a'} sats`);
  if (dryRun.route) {
    console.log(
      `Route: ${dryRun.route.ok ? 'ok' : 'blocked'} | ${dryRun.route.poolCount ?? 0} pools | demand ${dryRun.route.demand ?? 'n/a'} | slippage ${dryRun.route.slippageBps ?? 'n/a'} bps`
    );
  }
  console.log(`Selected inputs: ${dryRun.inputs?.length ?? 0}`);
  for (const input of dryRun.inputs ?? []) {
    console.log(
      `  ${input.id} | ${input.address ?? 'n/a'} | ${input.sats} sats${input.tokenCategory ? ` | token ${input.tokenCategory}:${formatStablecoinAtomic(input.tokenAmount)}` : ''}`
    );
  }
  console.log(`Outputs: ${dryRun.outputs?.length ?? 0}`);
  for (const output of dryRun.outputs ?? []) {
    console.log(
      `  ${output.address ?? 'n/a'} | ${output.value} sats${output.token ? ` | token ${output.token.category}:${formatStablecoinAtomic(output.token.amount)}` : ''}`
    );
  }
  if (dryRun.transactionShape) {
    console.log(
      `Transaction shape: ${dryRun.transactionShape.inputs.length} inputs | ${dryRun.transactionShape.outputs.length} outputs`
    );
  }
  if (dryRun.marketBlockers?.length) {
    console.log('Market blockers:');
    for (const blocker of dryRun.marketBlockers) {
      console.log(`  - ${blocker}`);
    }
  }
  if (dryRun.blockers?.length) {
    console.log('Setup blockers:');
    for (const blocker of dryRun.blockers) {
      console.log(`  - ${blocker}`);
    }
  }
}
