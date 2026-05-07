/**
 * Backtest the dual-side threshold strategy on historical crypto up/down markets.
 *
 * Strategy:
 *   - For each market, watch both YES and NO prices over time
 *   - When YES drops below THRESHOLD, place a buy at that price
 *   - When NO drops below THRESHOLD, place a buy at that price
 *   - Each side can only be bought ONCE per market
 *   - Hold to resolution
 *
 * For each threshold tested, we report:
 *   - Total markets sampled
 *   - Markets where we caught both sides (jackpot)
 *   - Markets where we caught only one side
 *   - Markets where we caught neither side
 *   - Total P&L
 *   - Average EV per market
 *   - ROI on capital deployed
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const SLUG_PATTERN = /^(eth|btc|sol|xrp|doge)-updown-(5m|15m|30m|1h)-\d+/i;
const SLIPPAGE = 0.10; // 10% worse fills than displayed price (realistic for live)
const PER_BUY_USD = 1.0; // $1 per buy when threshold hits

// Test these thresholds
const THRESHOLDS = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30];
const TARGET_MARKET_COUNT = 800;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const CRYPTO_SERIES = [
  { id: 10684, name: 'BTC 5m' },
  { id: 10683, name: 'ETH 5m' },
  { id: 10686, name: 'SOL 5m' },
  { id: 10192, name: 'BTC 15m' },
  { id: 10191, name: 'ETH 15m' },
];

// Step 1 — collect resolved markets with their conditionId and resolution
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
              // Skip markets that resolved 50/50 (rare draw cases)
              const winnerIdx = prices.findIndex(p => p >= 0.99);
              if (winnerIdx === -1) continue;
              markets.push({
                conditionId: market.conditionId,
                slug: market.slug,
                title: market.question,
                clobTokenIds: JSON.parse(market.clobTokenIds || '[]'),
                outcomes,
                winnerIdx,
                winnerOutcome: outcomes[winnerIdx],
                endDate: market.endDate,
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

// Step 2 — for each market, fetch all trades and build price-over-time series
async function fetchMarketTrades(conditionId) {
  // Polymarket /trades endpoint returns recent trades — paginate to get full history
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
  // Sort chronologically (oldest first)
  trades.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  return trades;
}

// Step 3 — simulate the strategy on one market
function simulate(market, trades, threshold) {
  // Track most recent traded price per outcome
  const lastPrice = { 0: 0.5, 1: 0.5 }; // start at 50/50
  const bought = { 0: null, 1: null };  // null or { price, tokens }

  for (const t of trades) {
    const idx = t.outcomeIndex;
    const price = Number(t.price);
    if (idx === 0 || idx === 1) {
      lastPrice[idx] = price;
      // Derive the OTHER side's price from the spread (sum to ~1)
      const otherIdx = 1 - idx;
      lastPrice[otherIdx] = Math.max(0.001, 1 - price);
    }

    // Check both sides — if either is below threshold and not yet bought, buy it
    for (const sideIdx of [0, 1]) {
      if (bought[sideIdx]) continue;
      const sidePrice = lastPrice[sideIdx];
      if (sidePrice > 0 && sidePrice < threshold) {
        const fillPrice = Math.min(0.999, sidePrice * (1 + SLIPPAGE));
        const tokens = PER_BUY_USD / fillPrice;
        bought[sideIdx] = { price: fillPrice, tokens, costUSD: PER_BUY_USD };
      }
    }
  }

  // At resolution: payout = tokens of winning side × $1
  let cost = 0;
  let payout = 0;
  let sidesBought = 0;
  for (const idx of [0, 1]) {
    if (bought[idx]) {
      cost += bought[idx].costUSD;
      sidesBought++;
      if (idx === market.winnerIdx) {
        payout += bought[idx].tokens * 1.0;
      }
    }
  }
  return { cost, payout, pnl: payout - cost, sidesBought };
}

async function main() {
  console.log('\n🎯 Dual-Side Threshold Strategy Backtest\n');
  console.log(`Slippage: ${(SLIPPAGE * 100).toFixed(0)}% | Per-buy: $${PER_BUY_USD}\n`);

  // Step 1
  const markets = await findResolvedMarkets();
  console.log(`\nWill backtest on ${markets.length} resolved markets\n`);

  // Step 2 — fetch trades for each market (this is the expensive part)
  // Limit concurrency to be polite
  const tradesByMarket = new Map();
  console.log('📥 Fetching trade history per market...');
  let done = 0;
  const BATCH = 5;
  for (let i = 0; i < markets.length; i += BATCH) {
    const batch = markets.slice(i, i + BATCH);
    await Promise.all(batch.map(async m => {
      const trades = await fetchMarketTrades(m.conditionId);
      tradesByMarket.set(m.conditionId, trades);
    }));
    done += batch.length;
    if (done % 50 === 0 || done >= markets.length) {
      console.log(`  ${done}/${markets.length} markets fetched`);
    }
    await sleep(50);
  }

  // Step 3 — simulate at each threshold
  console.log('\n══════════ RESULTS BY THRESHOLD ══════════\n');
  const results = [];

  for (const threshold of THRESHOLDS) {
    let totalCost = 0;
    let totalPayout = 0;
    let bothSides = 0;     // markets where we bought both sides
    let oneSide = 0;       // only one side bought
    let neither = 0;       // never triggered
    let bothWins = 0;      // markets where we got both AND won (always do)
    let oneSideWins = 0;   // only bought one side, but it won
    let oneSideLoses = 0;  // bought one side, lost
    const winSizes = [];
    const lossSizes = [];

    for (const market of markets) {
      const trades = tradesByMarket.get(market.conditionId) || [];
      if (trades.length === 0) continue;
      const sim = simulate(market, trades, threshold);

      totalCost += sim.cost;
      totalPayout += sim.payout;

      if (sim.sidesBought === 2) {
        bothSides++;
        bothWins++;
        winSizes.push(sim.pnl);
      } else if (sim.sidesBought === 1) {
        oneSide++;
        if (sim.pnl > 0) {
          oneSideWins++;
          winSizes.push(sim.pnl);
        } else if (sim.pnl < 0) {
          oneSideLoses++;
          lossSizes.push(-sim.pnl);
        }
      } else {
        neither++;
      }
    }

    const totalMarkets = markets.length;
    const evaluated = bothSides + oneSide + neither;
    const totalPnl = totalPayout - totalCost;
    const ev = evaluated > 0 ? totalPnl / evaluated : 0;
    const roi = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
    const fireRate = ((bothSides + oneSide) / evaluated) * 100;
    const avgWin = winSizes.length > 0 ? winSizes.reduce((s,v) => s+v, 0) / winSizes.length : 0;
    const avgLoss = lossSizes.length > 0 ? lossSizes.reduce((s,v) => s+v, 0) / lossSizes.length : 0;

    results.push({ threshold, totalPnl, ev, roi, bothSides, oneSide, neither, evaluated, avgWin, avgLoss });

    console.log(`Threshold = $${threshold.toFixed(2)}`);
    console.log(`  Markets evaluated:      ${evaluated}`);
    console.log(`  Both sides caught:      ${bothSides} (${(100*bothSides/evaluated).toFixed(1)}%) — ALL win`);
    console.log(`  Only one side caught:   ${oneSide} (${oneSideWins} wins / ${oneSideLoses} losses)`);
    console.log(`  Never triggered:        ${neither} (${(100*neither/evaluated).toFixed(1)}%)`);
    console.log(`  Total cost:             $${totalCost.toFixed(2)}`);
    console.log(`  Total payout:           $${totalPayout.toFixed(2)}`);
    console.log(`  Total P&L:              ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
    console.log(`  ROI on deployed cap:    ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`);
    console.log(`  EV per market:          ${ev >= 0 ? '+' : ''}$${ev.toFixed(3)}`);
    console.log(`  Avg win: +$${avgWin.toFixed(2)} | Avg loss: -$${avgLoss.toFixed(2)}`);
    console.log();
  }

  // Save results
  const outDir = path.join(process.cwd(), 'trader_analysis_results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `backtest_dual_threshold_${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ marketsAnalyzed: markets.length, slippage: SLIPPAGE, perBuy: PER_BUY_USD, results }, null, 2));
  console.log(`\n💾 Saved to ${outPath}`);

  // Best threshold
  const best = results.slice().sort((a, b) => b.totalPnl - a.totalPnl)[0];
  console.log(`\n🏆 Best threshold: $${best.threshold} (P&L: ${best.totalPnl >= 0 ? '+' : ''}$${best.totalPnl.toFixed(2)}, ROI: ${best.roi.toFixed(1)}%, EV: $${best.ev.toFixed(3)}/market)`);
}

main().catch(e => { console.error(e); process.exit(1); });
