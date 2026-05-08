/**
 * Verify 5m momentum follow strategy works per-asset (not just lucky on one)
 */
const axios = require('axios');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SLIPPAGE = 0.05;
const MOMENTUM_WINDOW = 300; // 5 min
const THRESHOLD = 0.10; // %
const ENTRY_DELAY = 60; // s
const BIG = 1.5;
const SMALL = 0.5;

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

function simulate(market, klines) {
  const entryTime = (market.startTs + ENTRY_DELAY) * 1000;
  const recent = klines.filter(k => k[0] * 1000 < entryTime);
  if (recent.length < 2) return null;
  const lookbackTime = entryTime - MOMENTUM_WINDOW * 1000;
  const earlier = recent.filter(k => k[0] * 1000 <= lookbackTime);
  if (earlier.length === 0) return null;
  const c1 = recent[recent.length - 1];
  const c2 = earlier[earlier.length - 1];
  const close1 = Number(c1[4]);
  const close2 = Number(c2[4]);
  const momentumPct = ((close1 - close2) / close2) * 100;
  if (Math.abs(momentumPct) < THRESHOLD) return null;
  const predictedWinner = momentumPct > 0 ? 0 : 1;
  const upPrice = Math.min(0.999, 0.50 * (1 + SLIPPAGE));
  const upTokens = (predictedWinner === 0 ? BIG : SMALL) / upPrice;
  const downTokens = (predictedWinner === 1 ? BIG : SMALL) / upPrice;
  const cost = BIG + SMALL;
  const payout = market.winnerIdx === 0 ? upTokens : downTokens;
  return { cost, payout, pnl: payout - cost, predictedWinner, actualWinner: market.winnerIdx };
}

async function main() {
  console.log('\n📊 Per-Asset 5m Momentum Strategy Verification\n');

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

  // Fetch spot prices per asset
  const spotByAsset = {};
  for (const s of SERIES) {
    const markets = allMarkets.filter(m => m.asset === s.asset);
    if (markets.length === 0) continue;
    const minTs = Math.min(...markets.map(m => m.startTs));
    const maxTs = Math.max(...markets.map(m => m.startTs));
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
  }

  // Per-asset results
  console.log('Asset | Bets | Acc%  | P&L     | ROI    | EV/market');
  console.log('------|------|-------|---------|--------|----------');
  for (const s of SERIES) {
    let correct = 0, wrong = 0, totalCost = 0, totalPayout = 0;
    const markets = allMarkets.filter(m => m.asset === s.asset);
    for (const market of markets) {
      const sim = simulate(market, spotByAsset[s.asset] || []);
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
      `${s.asset.padEnd(5)} | ${String(total).padStart(4)} | ${acc.toFixed(1).padStart(5)} | ${sign}$${pnl.toFixed(2).padStart(6)} | ${sign}${roi.toFixed(1).padStart(5)}% | ${sign}$${ev.toFixed(3)}`
    );
  }
}

main().catch(e => console.error(e));
