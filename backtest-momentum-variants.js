/**
 * Test multiple momentum strategy variants:
 *   1. Follow momentum (original)
 *   2. Reverse momentum (bet against)
 *   3. 5-min momentum window
 *   4. Higher threshold (only strong moves)
 *   5. Equal bets (just pure mean reversion)
 *   6. Hold and exit at peak (not all-in to resolution)
 */

const axios = require('axios');

const SLIPPAGE = 0.05;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SERIES = [
  { id: 10192, asset: 'BTC', coinbase: 'BTC-USD' },
  { id: 10191, asset: 'ETH', coinbase: 'ETH-USD' },
  { id: 10423, asset: 'SOL', coinbase: 'SOL-USD' },
];

async function fetchSpot(symbol, startSec, endSec) {
  const url = `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=60&start=${new Date(startSec*1000).toISOString()}&end=${new Date(endSec*1000).toISOString()}`;
  try {
    const res = await axios.get(url, { timeout: 10000 });
    return Array.isArray(res.data) ? res.data.sort((a,b) => a[0] - b[0]) : null;
  } catch { return null; }
}

function simulate(market, klines, config) {
  const { momentumWindowSec, threshold, entryDelay, big, small, invert } = config;
  const entryTime = (market.startTs + entryDelay) * 1000;
  const recent = klines.filter(k => k[0] * 1000 < entryTime);
  if (recent.length < 2) return null;

  // Find candle that's `momentumWindowSec` ago
  const lookbackTime = entryTime - momentumWindowSec * 1000;
  const earlier = recent.filter(k => k[0] * 1000 <= lookbackTime);
  if (earlier.length === 0) return null;

  const c1 = recent[recent.length - 1];
  const c2 = earlier[earlier.length - 1];
  const close1 = Number(c1[4]);
  const close2 = Number(c2[4]);
  const momentumPct = ((close1 - close2) / close2) * 100;

  if (Math.abs(momentumPct) < threshold) return null; // no signal

  // momentumPct > 0 means price went up
  let predictedWinner = momentumPct > 0 ? 0 : 1; // 0=Up, 1=Down
  if (invert) predictedWinner = 1 - predictedWinner;

  const upPrice = Math.min(0.999, 0.50 * (1 + SLIPPAGE));
  const upTokens = (predictedWinner === 0 ? big : small) / upPrice;
  const downTokens = (predictedWinner === 1 ? big : small) / upPrice;
  const cost = big + small;
  const payout = market.winnerIdx === 0 ? upTokens : downTokens;
  return { cost, payout, pnl: payout - cost, predictedWinner, actualWinner: market.winnerIdx };
}

async function main() {
  console.log('\n🎯 Momentum Strategy Variants\n');

  // Fetch markets
  const allMarkets = [];
  for (const s of SERIES) {
    const res = await axios.get(
      `https://gamma-api.polymarket.com/events?series_id=${s.id}&limit=200&closed=true&order=endDate&ascending=false`,
      { timeout: 15000 }
    );
    for (const ev of res.data || []) {
      for (const m of (ev.markets || [])) {
        if (m.conditionId && m.closed && m.outcomePrices) {
          const prices = JSON.parse(m.outcomePrices).map(Number);
          const winnerIdx = prices.findIndex(p => p >= 0.99);
          if (winnerIdx === -1) continue;
          const tsMatch = m.slug.match(/(\d+)$/);
          if (!tsMatch) continue;
          allMarkets.push({
            conditionId: m.conditionId,
            slug: m.slug,
            asset: s.asset,
            coinbase: s.coinbase,
            startTs: Number(tsMatch[1]),
            winnerIdx,
          });
        }
      }
    }
  }
  console.log(`Markets: ${allMarkets.length}\n`);

  // Fetch spot prices once per asset
  const spotByAsset = {};
  for (const s of SERIES) {
    const markets = allMarkets.filter(m => m.asset === s.asset);
    if (markets.length === 0) continue;
    const minTs = Math.min(...markets.map(m => m.startTs));
    const maxTs = Math.max(...markets.map(m => m.startTs));
    console.log(`Fetching ${s.asset} klines...`);
    const all = [];
    let cur = minTs - 600;
    while (cur < maxTs + 60) {
      const end = Math.min(cur + 250 * 60, maxTs + 60);
      const data = await fetchSpot(s.coinbase, cur, end);
      if (data) all.push(...data);
      cur = end + 60;
      await sleep(150);
    }
    spotByAsset[s.asset] = all;
    console.log(`  ${all.length} candles`);
  }

  // Test variants
  const variants = [
    { name: 'Follow 1m / 0.05% / delay 60s', momentumWindowSec: 60, threshold: 0.05, entryDelay: 60, big: 1.5, small: 0.5, invert: false },
    { name: 'INVERT 1m / 0.05% / delay 60s', momentumWindowSec: 60, threshold: 0.05, entryDelay: 60, big: 1.5, small: 0.5, invert: true },
    { name: 'Follow 5m / 0.10% / delay 60s', momentumWindowSec: 300, threshold: 0.10, entryDelay: 60, big: 1.5, small: 0.5, invert: false },
    { name: 'INVERT 5m / 0.10% / delay 60s', momentumWindowSec: 300, threshold: 0.10, entryDelay: 60, big: 1.5, small: 0.5, invert: true },
    { name: 'Follow 5m / 0.20% / delay 0s',  momentumWindowSec: 300, threshold: 0.20, entryDelay: 0,  big: 1.5, small: 0.5, invert: false },
    { name: 'INVERT 5m / 0.20% / delay 0s',  momentumWindowSec: 300, threshold: 0.20, entryDelay: 0,  big: 1.5, small: 0.5, invert: true },
    { name: 'INVERT 1m / 0.10% / delay 60s, big bet only', momentumWindowSec: 60, threshold: 0.10, entryDelay: 60, big: 2.0, small: 0, invert: true },
    { name: 'Follow 1m / 0.10% / delay 60s, big bet only', momentumWindowSec: 60, threshold: 0.10, entryDelay: 60, big: 2.0, small: 0, invert: false },
  ];

  console.log('\nVariant'.padEnd(55) + ' | Bets | Acc%  | P&L     | ROI    | EV');
  console.log('-'.repeat(105));

  for (const v of variants) {
    let correct = 0, wrong = 0, totalCost = 0, totalPayout = 0;
    for (const market of allMarkets) {
      const sim = simulate(market, spotByAsset[market.asset] || [], v);
      if (!sim) continue;
      totalCost += sim.cost;
      totalPayout += sim.payout;
      if (sim.predictedWinner === sim.actualWinner) correct++;
      else wrong++;
    }
    const total = correct + wrong;
    const pnl = totalPayout - totalCost;
    const roi = totalCost > 0 ? (pnl/totalCost)*100 : 0;
    const acc = total > 0 ? (correct/total)*100 : 0;
    const ev = total > 0 ? pnl/total : 0;
    const sign = pnl >= 0 ? '+' : '';
    console.log(
      `${v.name.padEnd(55)} | ${String(total).padStart(4)} | ${acc.toFixed(1).padStart(5)} | ${sign}$${pnl.toFixed(2).padStart(6)} | ${sign}${roi.toFixed(1).padStart(5)}% | ${sign}$${ev.toFixed(3)}`
    );
  }
}

main().catch(e => console.error(e));
