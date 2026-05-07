/**
 * Rigorous backtest of the dual-side threshold strategy.
 *
 * Tests:
 *   1. Multiple slippage levels (10%, 20%, 30%, 50%)
 *   2. Time-period stability (split markets into 4 quartiles by date)
 *   3. Per-asset breakdown (BTC vs ETH vs SOL)
 *   4. Per-window breakdown (5m vs 15m)
 *   5. More markets — pull 1500 instead of 800
 *   6. Sensitivity check: does the optimal threshold remain stable across slices?
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const SLUG_PATTERN = /^(eth|btc|sol|xrp|doge)-updown-(5m|15m|30m|1h)-\d+/i;
const PER_BUY_USD = 1.0;
const TARGET_MARKET_COUNT = 1500;
const SLIPPAGE_LEVELS = [0.10, 0.20, 0.30, 0.50];
const FOCUS_THRESHOLD = 0.10; // primary threshold for deep dive
const ALL_THRESHOLDS = [0.05, 0.10, 0.15, 0.20];

const sleep = ms => new Promise(r => setTimeout(r, ms));

const CRYPTO_SERIES = [
  { id: 10684, name: 'BTC 5m', asset: 'BTC', window: '5m' },
  { id: 10683, name: 'ETH 5m', asset: 'ETH', window: '5m' },
  { id: 10686, name: 'SOL 5m', asset: 'SOL', window: '5m' },
  { id: 10192, name: 'BTC 15m', asset: 'BTC', window: '15m' },
  { id: 10191, name: 'ETH 15m', asset: 'ETH', window: '15m' },
];

async function findResolvedMarkets() {
  console.log('📡 Fetching resolved crypto up/down markets...');
  const markets = [];

  for (const series of CRYPTO_SERIES) {
    try {
      const res = await axios.get(
        `https://gamma-api.polymarket.com/events?series_id=${series.id}&limit=500&closed=true&order=endDate&ascending=false`,
        { timeout: 20000 }
      );
      if (Array.isArray(res.data)) {
        for (const event of res.data) {
          for (const market of (event.markets || [])) {
            if (market.conditionId && market.closed && market.outcomePrices) {
              const prices = JSON.parse(market.outcomePrices).map(Number);
              const outcomes = JSON.parse(market.outcomes);
              const winnerIdx = prices.findIndex(p => p >= 0.99);
              if (winnerIdx === -1) continue;

              const tsMatch = market.slug?.match(/(\d+)$/);
              const closeTs = tsMatch ? Number(tsMatch[1]) : 0;

              markets.push({
                conditionId: market.conditionId,
                slug: market.slug,
                title: market.question,
                outcomes,
                winnerIdx,
                winnerOutcome: outcomes[winnerIdx],
                endDate: market.endDate,
                closeTs,
                asset: series.asset,
                window: series.window,
              });
            }
          }
        }
      }
    } catch (e) {
      console.log(`  ⚠️  ${series.name}: ${e.message}`);
    }
    console.log(`  ${series.name}: ${markets.length} markets total`);
    await sleep(300);
    if (markets.length >= TARGET_MARKET_COUNT) break;
  }
  return markets.slice(0, TARGET_MARKET_COUNT);
}

async function fetchMarketTrades(conditionId) {
  const trades = [];
  let offset = 0;
  while (offset < 5000) {
    try {
      const res = await axios.get(
        `https://data-api.polymarket.com/trades?market=${conditionId}&limit=500&offset=${offset}`,
        { timeout: 10000 }
      );
      if (!Array.isArray(res.data) || res.data.length === 0) break;
      trades.push(...res.data);
      if (res.data.length < 500) break;
      offset += 500;
    } catch {
      break;
    }
  }
  trades.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  return trades;
}

function simulate(market, trades, threshold, slippage) {
  const lastPrice = { 0: 0.5, 1: 0.5 };
  const bought = { 0: null, 1: null };

  for (const t of trades) {
    const idx = t.outcomeIndex;
    const price = Number(t.price);
    if (idx === 0 || idx === 1) {
      lastPrice[idx] = price;
      lastPrice[1 - idx] = Math.max(0.001, 1 - price);
    }
    for (const sideIdx of [0, 1]) {
      if (bought[sideIdx]) continue;
      const sidePrice = lastPrice[sideIdx];
      if (sidePrice > 0 && sidePrice < threshold) {
        const fillPrice = Math.min(0.999, sidePrice * (1 + slippage));
        bought[sideIdx] = {
          price: fillPrice,
          tokens: PER_BUY_USD / fillPrice,
          costUSD: PER_BUY_USD,
        };
      }
    }
  }

  let cost = 0, payout = 0, sidesBought = 0;
  for (const idx of [0, 1]) {
    if (bought[idx]) {
      cost += bought[idx].costUSD;
      sidesBought++;
      if (idx === market.winnerIdx) payout += bought[idx].tokens;
    }
  }
  return { cost, payout, pnl: payout - cost, sidesBought };
}

function aggregateResults(marketsList, tradesByMarket, threshold, slippage) {
  let totalCost = 0, totalPayout = 0;
  let bothSides = 0, oneSide = 0, neither = 0;
  let oneSideWins = 0, oneSideLoses = 0;

  for (const market of marketsList) {
    const trades = tradesByMarket.get(market.conditionId) || [];
    if (trades.length === 0) continue;
    const sim = simulate(market, trades, threshold, slippage);
    totalCost += sim.cost;
    totalPayout += sim.payout;
    if (sim.sidesBought === 2) bothSides++;
    else if (sim.sidesBought === 1) {
      oneSide++;
      if (sim.pnl > 0) oneSideWins++;
      else if (sim.pnl < 0) oneSideLoses++;
    } else neither++;
  }

  const evaluated = bothSides + oneSide + neither;
  const totalPnl = totalPayout - totalCost;
  return {
    threshold, slippage,
    evaluated, bothSides, oneSide, oneSideWins, oneSideLoses, neither,
    totalCost, totalPayout, totalPnl,
    ev: evaluated > 0 ? totalPnl / evaluated : 0,
    roi: totalCost > 0 ? (totalPnl / totalCost) * 100 : 0,
    fireRate: evaluated > 0 ? ((bothSides + oneSide) / evaluated) * 100 : 0,
    bothSidesRate: evaluated > 0 ? (bothSides / evaluated) * 100 : 0,
  };
}

function printResult(label, r) {
  const sign = r.totalPnl >= 0 ? '+' : '';
  const evSign = r.ev >= 0 ? '+' : '';
  const roiSign = r.roi >= 0 ? '+' : '';
  console.log(
    `${label.padEnd(35)} ` +
    `markets=${String(r.evaluated).padStart(4)} ` +
    `both=${String(r.bothSides).padStart(3)} (${r.bothSidesRate.toFixed(1).padStart(4)}%) ` +
    `pnl=${sign}$${r.totalPnl.toFixed(2).padStart(7)} ` +
    `roi=${roiSign}${r.roi.toFixed(1).padStart(5)}% ` +
    `ev=${evSign}$${r.ev.toFixed(3).padStart(6)}`
  );
}

async function main() {
  console.log('\n🎯 RIGOROUS Dual-Side Threshold Backtest\n');

  const markets = await findResolvedMarkets();
  console.log(`\nWill backtest on ${markets.length} resolved markets`);

  // Sort by close time
  markets.sort((a, b) => a.closeTs - b.closeTs);
  const earliestDate = new Date(markets[0].closeTs * 1000).toISOString().slice(0, 16);
  const latestDate = new Date(markets[markets.length - 1].closeTs * 1000).toISOString().slice(0, 16);
  console.log(`Time range: ${earliestDate} → ${latestDate}\n`);

  // Fetch trades
  console.log('📥 Fetching trade history per market...');
  const tradesByMarket = new Map();
  let done = 0;
  const BATCH = 5;
  for (let i = 0; i < markets.length; i += BATCH) {
    const batch = markets.slice(i, i + BATCH);
    await Promise.all(batch.map(async m => {
      const trades = await fetchMarketTrades(m.conditionId);
      tradesByMarket.set(m.conditionId, trades);
    }));
    done += batch.length;
    if (done % 100 === 0 || done >= markets.length) {
      console.log(`  ${done}/${markets.length} markets fetched`);
    }
    await sleep(50);
  }

  // === TEST 1: Slippage sensitivity at $0.10 threshold ===
  console.log('\n══════════ TEST 1: Slippage Sensitivity (threshold=$0.10) ══════════');
  console.log('Higher slippage = worse fills = less profit. Real-world is probably 20-30%.\n');
  for (const slip of SLIPPAGE_LEVELS) {
    const r = aggregateResults(markets, tradesByMarket, FOCUS_THRESHOLD, slip);
    printResult(`Slippage ${(slip * 100).toFixed(0)}%`, r);
  }

  // === TEST 2: Time-period stability (split into quartiles by date) ===
  console.log('\n══════════ TEST 2: Time-Period Stability (slippage=20%) ══════════');
  console.log('Tests if EV is stable across different time windows or just lucky in one period.\n');
  const quarter = Math.floor(markets.length / 4);
  for (let q = 0; q < 4; q++) {
    const slice = markets.slice(q * quarter, (q + 1) * quarter);
    const startDate = new Date(slice[0].closeTs * 1000).toISOString().slice(0, 10);
    const endDate = new Date(slice[slice.length - 1].closeTs * 1000).toISOString().slice(0, 10);
    const r = aggregateResults(slice, tradesByMarket, FOCUS_THRESHOLD, 0.20);
    printResult(`Q${q + 1} (${startDate} → ${endDate})`, r);
  }

  // === TEST 3: Per-asset breakdown ===
  console.log('\n══════════ TEST 3: Per-Asset Breakdown (threshold=$0.10, slippage=20%) ══════════\n');
  const byAsset = {};
  for (const m of markets) {
    if (!byAsset[m.asset]) byAsset[m.asset] = [];
    byAsset[m.asset].push(m);
  }
  for (const [asset, list] of Object.entries(byAsset)) {
    const r = aggregateResults(list, tradesByMarket, FOCUS_THRESHOLD, 0.20);
    printResult(asset, r);
  }

  // === TEST 4: Per-window breakdown ===
  console.log('\n══════════ TEST 4: Per-Window Breakdown (threshold=$0.10, slippage=20%) ══════════\n');
  const byWindow = {};
  for (const m of markets) {
    if (!byWindow[m.window]) byWindow[m.window] = [];
    byWindow[m.window].push(m);
  }
  for (const [window, list] of Object.entries(byWindow)) {
    const r = aggregateResults(list, tradesByMarket, FOCUS_THRESHOLD, 0.20);
    printResult(`${window} window`, r);
  }

  // === TEST 5: Threshold optimization at realistic 20% slippage ===
  console.log('\n══════════ TEST 5: Threshold Optimization (slippage=20%) ══════════\n');
  const thresholdResults = [];
  for (const t of ALL_THRESHOLDS) {
    const r = aggregateResults(markets, tradesByMarket, t, 0.20);
    thresholdResults.push(r);
    printResult(`Threshold $${t}`, r);
  }
  const best = thresholdResults.slice().sort((a, b) => b.totalPnl - a.totalPnl)[0];

  // === FINAL VERDICT ===
  console.log('\n══════════ VERDICT ══════════\n');
  console.log(`Markets analyzed: ${markets.length}`);
  console.log(`Best threshold (at 20% slippage): $${best.threshold} → +$${best.totalPnl.toFixed(2)} (+${best.roi.toFixed(1)}%)`);

  // Stability check — count time-period quarters that were profitable
  const profitableQuartersAt20Slip = [];
  for (let q = 0; q < 4; q++) {
    const slice = markets.slice(q * quarter, (q + 1) * quarter);
    const r = aggregateResults(slice, tradesByMarket, FOCUS_THRESHOLD, 0.20);
    if (r.totalPnl > 0) profitableQuartersAt20Slip.push(q + 1);
  }
  console.log(`Profitable quarters: ${profitableQuartersAt20Slip.length}/4 (Q${profitableQuartersAt20Slip.join(', Q')})`);

  // Save detail
  const outDir = path.join(process.cwd(), 'trader_analysis_results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `backtest_rigorous_${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    marketsAnalyzed: markets.length,
    timeRange: { earliest: earliestDate, latest: latestDate },
    bestThresholdAt20Slip: best,
    profitableQuarters: profitableQuartersAt20Slip,
  }, null, 2));
  console.log(`\n💾 Saved to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
