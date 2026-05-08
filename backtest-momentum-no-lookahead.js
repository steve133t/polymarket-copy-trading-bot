/**
 * Strict no-look-ahead backtest of the momentum strategy.
 *
 * Bug in previous backtest: used close of 5-min candle that EXTENDED past entry time.
 * This gave us "future knowledge" of prices we wouldn't have in live trading.
 *
 * Fix: only use candles that CLOSED strictly before entry time.
 */

const axios = require('axios');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SLIPPAGE = 0.05;
const MOMENTUM_WINDOW = 300; // 5 min
const ENTRY_DELAY = 60;
const PER_BUY = 1; // $1 per bet for clean comparison

const SERIES = [
  { id: 10192, asset: 'BTC', kraken: 'XBTUSDT' },
  { id: 10191, asset: 'ETH', kraken: 'ETHUSDT' },
  { id: 10423, asset: 'SOL', kraken: 'SOLUSDT' },
];

const BUCKETS = [
  { name: '0.05-0.10%', min: 0.05, max: 0.10 },
  { name: '0.10-0.20%', min: 0.10, max: 0.20 },
  { name: '0.20-0.30%', min: 0.20, max: 0.30 },
  { name: '0.30-0.50%', min: 0.30, max: 0.50 },
  { name: '0.50%+',     min: 0.50, max: 99 },
];

async function fetchKraken(symbol, sinceSec) {
  // Use 1-min interval for max precision
  const url = `https://api.kraken.com/0/public/OHLC?pair=${symbol}&interval=1&since=${sinceSec}`;
  try {
    const res = await axios.get(url, { timeout: 15000 });
    const result = res.data?.result || {};
    const ohlcKey = Object.keys(result).find(k => k !== 'last');
    return ohlcKey ? result[ohlcKey] : null;
  } catch { return null; }
}

function getSignalNoLookahead(market, klines) {
  const entryTimeSec = market.startTs + ENTRY_DELAY;
  // CRITICAL: only use candles whose CLOSE time is <= entry time
  // For 1-min Kraken candles, candle starting at T closes at T+60
  // So candle is safe if T+60 <= entryTime, i.e., T <= entryTime - 60
  const candleCloseLimitSec = entryTimeSec - 60;
  const safeCandles = klines.filter(k => Number(k[0]) <= candleCloseLimitSec);
  if (safeCandles.length < 2) return null;

  // For 5-min momentum: compare close from 5 min ago to most recent close
  const lookbackTs = entryTimeSec - MOMENTUM_WINDOW;
  const past = safeCandles.find(k => Number(k[0]) >= lookbackTs - 60);
  if (!past) return null;
  const c1 = safeCandles[safeCandles.length - 1]; // most recent
  const close1 = Number(c1[4]);
  const close2 = Number(past[4]);
  return ((close1 - close2) / close2) * 100;
}

async function main() {
  console.log('\n📊 NO-LOOKAHEAD Momentum Backtest\n');

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
            kraken: s.kraken,
            startTs: Number(tsMatch[1]),
            winnerIdx,
          });
        }
      }
    }
  }
  console.log(`Markets: ${allMarkets.length}`);

  // Fetch 1-min klines for each asset
  const klinesByAsset = {};
  for (const s of SERIES) {
    const markets = allMarkets.filter(m => m.asset === s.asset);
    if (markets.length === 0) continue;
    const minTs = Math.min(...markets.map(m => m.startTs));
    console.log(`Fetching ${s.asset} 1-min candles since ${new Date(minTs*1000).toISOString().slice(0,16)}...`);

    // Kraken returns max 720 candles per call, so paginate
    const all = [];
    let since = minTs - 600;
    let lastSize = 0;
    for (let i = 0; i < 10; i++) {
      const data = await fetchKraken(s.kraken, since);
      if (!data || data.length === 0) break;
      all.push(...data);
      const newest = Number(data[data.length - 1][0]);
      if (newest === since || data.length === lastSize) break;
      since = newest;
      lastSize = data.length;
      await sleep(400);
    }
    // Dedupe
    const byTs = new Map();
    for (const c of all) byTs.set(Number(c[0]), c);
    klinesByAsset[s.asset] = Array.from(byTs.values()).sort((a,b) => Number(a[0]) - Number(b[0]));
    console.log(`  ${s.asset}: ${klinesByAsset[s.asset].length} 1-min candles`);
  }

  // Bucket each market by signal strength
  console.log('\nBucket           | Markets | Acc%  | EV/$1bet  | Verdict');
  console.log('-----------------|---------|-------|-----------|----------');

  const upPrice = Math.min(0.999, 0.50 * (1 + SLIPPAGE));

  for (const bucket of BUCKETS) {
    let total = 0, correct = 0, totalCost = 0, totalPayout = 0;
    for (const market of allMarkets) {
      const klines = klinesByAsset[market.asset] || [];
      const signal = getSignalNoLookahead(market, klines);
      if (signal === null) continue;
      const absSignal = Math.abs(signal);
      if (absSignal < bucket.min || absSignal >= bucket.max) continue;

      total++;
      const predicted = signal > 0 ? 0 : 1;
      if (predicted === market.winnerIdx) correct++;

      const cost = PER_BUY;
      const tokens = cost / upPrice;
      const payout = predicted === market.winnerIdx ? tokens : 0;
      totalCost += cost;
      totalPayout += payout;
    }
    if (total === 0) {
      console.log(`${bucket.name.padEnd(16)} | ${String(0).padStart(7)} | --    | --        | --`);
      continue;
    }
    const acc = (correct / total) * 100;
    const ev = (totalPayout - totalCost) / total;
    const verdict = ev > 0.05 ? '✅ profitable' : ev > 0 ? '🟡 marginal' : '❌ loses';
    const sign = ev >= 0 ? '+' : '';
    console.log(
      `${bucket.name.padEnd(16)} | ${String(total).padStart(7)} | ${acc.toFixed(1).padStart(5)} | ${sign}$${ev.toFixed(3).padStart(7)}  | ${verdict}`
    );
  }
}

main().catch(e => console.error(e));
