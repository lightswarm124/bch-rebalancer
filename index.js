import { compileMeanRevertContract } from './src/contract/compile.js';
import { broadcastLiveCauldronTrade } from './src/domain/broadcast.js';
import {
  loadSnapshot,
  printDryRunOnce,
  printPreflightOnce,
  printPortfolioPlanOnce,
  runTui,
} from './src/tui/app.js';
import { readLastBroadcastRecord, writeLastBroadcastRecord } from './src/domain/broadcastJournal.js';
import { appendPortfolioHistoryRecord } from './src/domain/portfolioJournal.js';
import {
  formatSignedUsdCents,
  formatStablecoinAtomic,
  formatUsdCents,
} from './src/domain/money.js';
import { renderQuantumrootSpikeReport } from './src/vaulting/quantumrootSpike.js';
import {
  PROJECT_NAME,
  PROJECT_TAGLINE,
  NETWORK,
  DAEMON_BACKOFF_MS,
  DAEMON_MAX_BACKOFF_MS,
  DAEMON_POLL_MS,
} from './config.js';

function truncateTxid(txid) {
  const text = String(txid ?? 'n/a');
  if (text.length <= 18) return text;
  return `${text.slice(0, 10)}...${text.slice(-8)}`;
}

function formatTradeLedgerEntry(entry) {
  const preUsd = entry?.preUsd !== null && entry?.preUsd !== undefined ? formatUsdCents(entry.preUsd) : 'n/a';
  const postUsd =
    entry?.postUsd !== null && entry?.postUsd !== undefined ? formatUsdCents(entry.postUsd) : 'pending';
  const deltaUsd =
    entry?.deltaUsd !== null && entry?.deltaUsd !== undefined
      ? formatSignedUsdCents(entry.deltaUsd)
      : 'pending';
  const tradeTokens =
    entry?.tradeTokens !== null && entry?.tradeTokens !== undefined
      ? formatStablecoinAtomic(entry.tradeTokens)
      : 'n/a';
  const fee = entry?.estimatedFeeSats !== null && entry?.estimatedFeeSats !== undefined
    ? `${entry.estimatedFeeSats} sats fee`
    : null;
  return `${truncateTxid(entry?.txid)} | ${entry?.direction ?? 'trade'} | ${tradeTokens} | ${preUsd} -> ${postUsd} | P/L ${deltaUsd}${fee ? ` | ${fee}` : ''} | ${entry?.chainStatus ?? entry?.status ?? 'pending'}`;
}

function usage() {
  console.log(`${PROJECT_NAME}`);
  console.log(PROJECT_TAGLINE);
  console.log('');
  console.log('Usage: node index.js <command>');
  console.log('');
  console.log('Commands:');
  console.log('  tui                start the terminal UI');
  console.log('  daemon             start the always-on daemon TUI');
  console.log('  plan               print the current portfolio rebalance plan');
  console.log('  preflight          validate the current live rebalance execution path');
  console.log('  dryrun             print a live Cauldron dry-run transaction manifest');
  console.log('  broadcast          build and broadcast a capped live chipnet trade');
  console.log('  status             print the current live indexer snapshot');
  console.log('  compile-contract   compile the covenant artifact');
  console.log('  research quantumroot');
  console.log('');
  console.log(`Network: ${NETWORK}`);
}

async function runStatus() {
  const snapshot = await loadSnapshot();
  const lastBroadcast = snapshot.lastBroadcast ?? (await readLastBroadcastRecord());
  console.log(`${PROJECT_NAME} status`);
  console.log('');
  console.log(`Indexer health: ${snapshot.indexerHealth?.ok ? 'ok' : 'degraded'}`);
  console.log(
    `Chain tip: ${snapshot.indexerHealth?.payload?.chain_tip ?? 'n/a'} | indexed: ${
      snapshot.indexerHealth?.payload?.indexed_height ?? 'n/a'
    } | version: ${snapshot.indexerHealth?.payload?.version ?? 'n/a'}`
  );
  console.log(`Oracle source: ${snapshot.oracle?.source ?? 'unknown'}`);
  console.log(`Oracle price: ${snapshot.oracle?.priceValue ?? 'n/a'}`);
  console.log(
    `Daemon defaults: manual prompt | poll ${DAEMON_POLL_MS} ms | backoff ${DAEMON_BACKOFF_MS} ms | max backoff ${DAEMON_MAX_BACKOFF_MS} ms`
  );
  console.log(
    `Token: ${snapshot.market?.tokenRow?.display_name ?? 'n/a'} (${snapshot.market?.tokenRow?.display_symbol ?? 'n/a'})`
  );
  console.log(`Wallet path: ${snapshot.portfolioSnapshot?.wallet?.derivationPath ?? 'n/a'}`);
  console.log(
    `Price: ${snapshot.market?.tokenRow?.price_now_usd ?? snapshot.market?.priceNowUsd ?? 'n/a'} USD | APY 30d: ${
      snapshot.market?.tokenRow?.apy_30d_bp ?? 'n/a'
    } bp`
  );
  console.log(
    `History: ${
      snapshot.historySummary?.points
        ? `start ${formatUsdCents(snapshot.historySummary.startUsd ?? 0n)} | now ${formatUsdCents(snapshot.historySummary.latestUsd ?? 0n)} | P/L ${formatSignedUsdCents(snapshot.historySummary.deltaUsd ?? 0n)} | trades ${snapshot.historySummary.trades ?? 0}`
        : 'n/a'
    }`
  );
  console.log(`Wallet tx history: ${snapshot.portfolioSnapshot?.wallet?.txHistoryCount ?? 0}`);
  console.log(
    `Ledger: ${
      Array.isArray(snapshot.tradeLedger) && snapshot.tradeLedger.length > 0
        ? `${snapshot.tradeLedger.length} trades | ${formatTradeLedgerEntry(
            snapshot.tradeLedger[snapshot.tradeLedger.length - 1]
          )}`
        : 'n/a'
    }`
  );
  if (Array.isArray(snapshot.tradeLedger) && snapshot.tradeLedger.length > 0) {
    console.log('Recent trades');
    for (const entry of snapshot.tradeLedger.slice(-3).reverse()) {
      console.log(`  ${formatTradeLedgerEntry(entry)}`);
    }
  }
  console.log(
    `Last broadcast txid: ${lastBroadcast?.txid ?? snapshot.daemon?.lastBroadcastTxid ?? 'n/a'}`
  );
  console.log(
    `Tx status: ${lastBroadcast?.txid ? `${lastBroadcast.status ?? 'broadcasted'} | confirmation pending` : 'n/a'}`
  );
  console.log(`Cauldron pools: ${Array.isArray(snapshot.market?.pools) ? snapshot.market.pools.length : 0}`);
  console.log('');
  console.log('Top pools');
  for (const pool of Array.isArray(snapshot.market?.pools)
    ? snapshot.market.pools.slice(0, 3)
    : []) {
    console.log(
      `  ${pool.pool_id ?? 'n/a'} | ${String(pool.sats ?? pool.tvl_sats ?? 0)} sats | ${String(pool.tokens ?? pool.tvl_tokens ?? 0)} tokens | owner ${String(pool.owner_p2pkh_addr ?? 'n/a')}`
    );
  }
}

async function runBroadcast() {
  const snapshot = await loadSnapshot();
  try {
    const result = await broadcastLiveCauldronTrade({
      portfolioSnapshot: snapshot.portfolioSnapshot ?? snapshot.portfolio ?? null,
      marketSnapshot: snapshot.market,
      oraclePriceRaw: snapshot.oracle?.priceRaw ?? 0n,
    });
    await writeLastBroadcastRecord({
      txid: result.txid,
      broadcastAt: Date.now(),
      direction: result.direction,
      poolCount: result.route?.poolCount ?? 0,
      slippageBps: result.route?.slippageBps ?? null,
      estimatedFeeSats: result.estimatedFee ?? null,
      status: 'broadcasted',
    });
    await appendPortfolioHistoryRecord({
      type: 'broadcast',
      timestamp: Date.now(),
      txid: result.txid,
      direction: result.direction,
      bchSats: snapshot.portfolioSnapshot?.totals?.totalBchSats ?? 0n,
      stablecoinTokens: snapshot.portfolioSnapshot?.totals?.totalStablecoinTokens ?? 0n,
      oraclePriceRaw: snapshot.oracle?.priceRaw ?? 0n,
      totalUsd: snapshot.rebalance?.totalUsd ?? undefined,
      tradeTokens: result.cappedTradeTokens ?? null,
      poolCount: result.route?.poolCount ?? 0,
      slippageBps: result.route?.slippageBps ?? null,
      estimatedFeeSats: result.estimatedFee ?? null,
      status: 'broadcasted',
    });

    console.log(`${snapshot.market?.tokenRow?.display_name ?? 'Portfolio'} live Cauldron broadcast`);
    console.log('');
    console.log(`Wallet: ${result.wallet?.primaryAddress ?? 'n/a'}`);
    console.log(`Pool: ${result.selectedPoolId ?? 'n/a'}`);
    console.log(`Direction: ${result.direction} | capped trade: ${result.cappedTradeTokens ?? 'n/a'} tokens`);
    console.log(`Estimated fee: ${result.estimatedFee ?? 'n/a'} sats`);
    console.log(`Txid: ${result.txid}`);
    console.log(`Hex length: ${result.hex?.length ?? 0}`);
  } catch (error) {
    console.log(`${snapshot.market?.tokenRow?.display_name ?? 'Portfolio'} live Cauldron broadcast`);
    console.log('');
    if (error?.draft) {
      console.log(`Wallet: ${error.draft.wallet?.primaryAddress ?? 'n/a'}`);
      console.log(`Pool: ${error.draft.selectedPoolId ?? 'n/a'}`);
      console.log(`Direction: ${error.draft.direction}`);
      console.log(`Capped trade: ${error.draft.cappedTradeTokens ?? 'n/a'} tokens`);
      if (Array.isArray(error.draft.blockers) && error.draft.blockers.length > 0) {
        console.log('Blockers:');
        for (const blocker of error.draft.blockers) {
          console.log(`  - ${blocker}`);
        }
      }
    }
    if (String(error?.message ?? '').includes('Live broadcast is disabled')) {
      return;
    }
    throw error;
  }
}

async function main() {
  const [cmd, subcmd] = process.argv.slice(2);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  if (cmd === 'tui' || cmd === 'daemon') {
    await runTui();
    return;
  }

  if (cmd === 'plan') {
    await printPortfolioPlanOnce();
    return;
  }

  if (cmd === 'preflight') {
    await printPreflightOnce();
    return;
  }

  if (cmd === 'dryrun') {
    await printDryRunOnce();
    return;
  }

  if (cmd === 'broadcast') {
    await runBroadcast();
    return;
  }

  if (cmd === 'status') {
    await runStatus();
    return;
  }

  if (cmd === 'compile-contract') {
    const artifact = compileMeanRevertContract();
    console.log('Compiled artifact written to artifacts/MeanRevertSingleTokenNFTAuthV3.json');
    console.log(`Contract bytecode length: ${artifact.bytecode.length}`);
    return;
  }

  if (cmd === 'research' && subcmd === 'quantumroot') {
    console.log(renderQuantumrootSpikeReport());
    return;
  }

  usage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
