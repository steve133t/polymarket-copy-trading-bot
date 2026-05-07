/**
 * 15m-only backtest of dual-threshold strategy.
 * Hypothesis: 15m windows give 3x more time for price oscillation,
 * which should INCREASE the both-sides-caught rate (the win case).
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const PER_BUY_USD = 1.0;
const SLIPPAGE = 0.20; // realistic
const THRESHOLDS = [0.05, 0.10, 0.15, 0.20];

const SERIES_15M = [
  { id: 10192, asset: 'BTC' },
  { id: 10191, asset: 'ETH' },
  { id: 10423, asset: 'SOL' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function findResolvedMarkets() {
  const markets = [];
  for (const series of SERIES_15M) {
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
              markets.push({
                conditionId: market.conditionId,
                slug: market.slug,
                outcomes,
                winnerIdx,
                asset: series.asset,
                window: '15m',
              });
            }
          }
        }
      }
    } catch (e) {
      console.log(`  ⚠️  series ${series.id}: ${e.message}`);
    }
    console.log(`  ${series.asset} 15m: ${markets.length} markets total`);
    await sleep(300);
  }
  return markets;
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
    } catch { break; }
  }
  trades.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  return trades;
}

function simulate(market, trades, threshold) {
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
        const fillPrice = Math.min(0.999, sidePrice * (1 + SLIPPAGE));
        bought[sideIdx] = { price: fillPrice, tokens: PER_BUY_USD / fillPrice, costUSD: PER_BUY_USD };
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

function aggregate(markets, tradesByMarket, threshold) {
  let cost = 0, payout = 0, both = 0, one = 0, neither = 0;
  for (const m of markets) {
    const tr = tradesByMarket.get(m.conditionId) || [];
    if (tr.length === 0) continue;
    const sim = simulate(m, tr, threshold);
    cost += sim.cost; payout += sim.payout;
    if (sim.sidesBought === 2) both++;
    else if (sim.sidesBought === 1) one++;
    else neither++;
  }
  const evaluated = both + one + neither;
  const pnl = payout - cost;
  return {
    threshold, evaluated, both, one, neither,
    cost, payout, pnl,
    bothRate: evaluated > 0 ? (both/evaluated)*100 : 0,
    roi: cost > 0 ? (pnl/cost)*100 : 0,
    ev: evaluated > 0 ? pnl/evaluated : 0,
  };
}

async function main() {
  console.log('\n🎯 15m-Window Backtest (slippage=20%)\n');
  console.log('📡 Fetching 15m crypto markets...');
  const markets = await findResolvedMarkets();
  console.log(`\nTotal: ${markets.length} resolved 15m markets\n`);

  if (markets.length === 0) return;

  console.log('📥 Fetching trade history...');
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
    if (done % 50 === 0 || done >= markets.length) {
      console.log(`  ${done}/${markets.length}`);
    }
    await sleep(50);
  }

  console.log('\n══════════ 15m RESULTS at 20% slippage ══════════\n');
  const results = [];
  for (const t of THRESHOLDS) {
    const r = aggregate(markets, tradesByMarket, t);
    results.push(r);
    const sign = r.pnl >= 0 ? '+' : '';
    console.log(
      `Threshold=$${t.toFixed(2)}  ` +
      `markets=${String(r.evaluated).padStart(4)}  ` +
      `both=${String(r.both).padStart(3)} (${r.bothRate.toFixed(1).padStart(4)}%)  ` +
      `pnl=${sign}$${r.pnl.toFixed(2).padStart(8)}  ` +
      `roi=${sign}${r.roi.toFixed(1).padStart(5)}%  ` +
      `ev=${sign}$${r.ev.toFixed(3).padStart(7)}`
    );
  }

  console.log('\n══════════ Per-Asset (threshold=$0.10) ══════════\n');
  const byAsset = {};
  for (const m of markets) {
    if (!byAsset[m.asset]) byAsset[m.asset] = [];
    byAsset[m.asset].push(m);
  }
  for (const [asset, list] of Object.entries(byAsset)) {
    const r = aggregate(list, tradesByMarket, 0.10);
    const sign = r.pnl >= 0 ? '+' : '';
    console.log(
      `${asset.padEnd(5)} markets=${String(r.evaluated).padStart(4)}  both=${String(r.both).padStart(3)} (${r.bothRate.toFixed(1).padStart(4)}%)  pnl=${sign}$${r.pnl.toFixed(2).padStart(8)}  roi=${sign}${r.roi.toFixed(1)}%  ev=${sign}$${r.ev.toFixed(3)}`
    );
  }

  const best = results.slice().sort((a, b) => b.pnl - a.pnl)[0];
  console.log(`\n🏆 Best 15m threshold: $${best.threshold} → +$${best.pnl.toFixed(2)} (${best.roi.toFixed(1)}% ROI, EV +$${best.ev.toFixed(3)}/market)`);

  // Save
  const outDir = path.join(process.cwd(), 'trader_analysis_results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `backtest_15m_${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ markets: markets.length, results }, null, 2));
  console.log(`\n💾 ${out}`);
}

main().catch(e => { console.error(e); process.exit(1); });
