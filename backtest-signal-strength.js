/**
 * Test if momentum signal STRENGTH correlates with prediction accuracy.
 *
 * Hypothesis: bigger 5-min spot moves should be more reliable predictors
 * than tiny moves. If true, we should bet MORE on strong signals.
 *
 * Buckets: 0.05-0.10%, 0.10-0.20%, 0.20-0.30%, 0.30-0.50%, 0.50-1.0%, 1.0%+
 */
const axios = require('axios');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SLIPPAGE = 0.05;
const MOMENTUM_WINDOW = 300;
const ENTRY_DELAY = 60;

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
  { name: '0.50-1.00%', min: 0.50, max: 1.00 },
  { name: '1.00%+',     min: 1.00, max: 100 },
];

async function fetchSpot(symbol, startSec, endSec) {
  // Kraken OHLC: 5-min candles, max 720 = 60 hours of history
  const url = `https://api.kraken.com/0/public/OHLC?pair=${symbol}&interval=5&since=${startSec - 600}`;
  try {
    const res = await axios.get(url, { timeout: 15000 });
    const result = res.data?.result || {};
    const ohlcKey = Object.keys(result).find(k => k !== 'last');
    if (!ohlcKey) return null;
    const candles = result[ohlcKey] || [];
    return candles
      .filter(c => Number(c[0]) >= startSec - 600 && Number(c[0]) <= endSec)
      .map(c => [Number(c[0]), Number(c[3]), Number(c[2]), Number(c[1]), Number(c[4]), Number(c[6])])
      .sort((a, b) => a[0] - b[0]);
  } catch (e) {
    console.log(`  fetch error: ${e.message}`);
    return null;
  }
}

function getSignal(market, klines) {
  // klines time in seconds (Kraken). With 5-min candles, momentum = close diff between adjacent candles
  const entryTimeSec = market.startTs + ENTRY_DELAY;
  const recent = klines.filter(k => k[0] < entryTimeSec);
  if (recent.length < 2) return null;
  // Get candle just before entry, and one 5-min before that
  const c1 = recent[recent.length - 1]; // most recent before entry
  const c2 = recent[recent.length - 2]; // 5 min before that
  // Verify they are ~5 min apart (should be since interval=5)
  const close1 = Number(c1[4]);
  const close2 = Number(c2[4]);
  return ((close1 - close2) / close2) * 100;
}

async function main() {
  console.log('\n📊 Signal Strength vs Accuracy Backtest\n');

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
  console.log(`Total markets: ${allMarkets.length}`);

  // Fetch spot prices per asset
  const spotByAsset = {};
  for (const s of SERIES) {
    const markets = allMarkets.filter(m => m.asset === s.asset);
    if (markets.length === 0) continue;
    const minTs = Math.min(...markets.map(m => m.startTs));
    const maxTs = Math.max(...markets.map(m => m.startTs));
    console.log(`Fetching ${s.asset}...`);
    // Kraken 5-min candles: 720 per call = 60 hours. Single call covers everything.
    const data = await fetchSpot(s.kraken, minTs - 600, maxTs + 60);
    spotByAsset[s.asset] = data || [];
    await sleep(300);
    console.log(`  ${s.asset}: ${spotByAsset[s.asset].length} candles`);
  }

  // Bucket each market by signal strength
  console.log('\nBucket           | Markets | Acc%  | Up Wins | Down Wins | EV/$1bet');
  console.log('-----------------|---------|-------|---------|-----------|---------');

  const upPrice = Math.min(0.999, 0.50 * (1 + SLIPPAGE));

  for (const bucket of BUCKETS) {
    let total = 0, correct = 0, upWins = 0, downWins = 0;
    let totalCost = 0, totalPayout = 0;
    for (const market of allMarkets) {
      const klines = spotByAsset[market.asset] || [];
      const signal = getSignal(market, klines);
      if (signal === null) continue;
      const absSignal = Math.abs(signal);
      if (absSignal < bucket.min || absSignal >= bucket.max) continue;

      total++;
      const predicted = signal > 0 ? 0 : 1;
      if (predicted === market.winnerIdx) correct++;
      if (market.winnerIdx === 0) upWins++; else downWins++;

      // Simulate: $1 bet on predicted side at $0.525 fill
      const cost = 1;
      const tokens = cost / upPrice;
      const payout = predicted === market.winnerIdx ? tokens : 0;
      totalCost += cost;
      totalPayout += payout;
    }
    if (total === 0) {
      console.log(`${bucket.name.padEnd(16)} | ${String(0).padStart(7)} | --    | --       | --        | --`);
      continue;
    }
    const acc = (correct / total) * 100;
    const upPct = (upWins / total) * 100;
    const downPct = (downWins / total) * 100;
    const evPerBet = (totalPayout - totalCost) / total;
    const sign = evPerBet >= 0 ? '+' : '';
    console.log(
      `${bucket.name.padEnd(16)} | ${String(total).padStart(7)} | ${acc.toFixed(1).padStart(5)} | ${upPct.toFixed(0).padStart(5)}%   | ${downPct.toFixed(0).padStart(5)}%     | ${sign}$${evPerBet.toFixed(3)}`
    );
  }

  console.log('\n💡 Interpretation:');
  console.log('  - If accuracy increases with signal strength → bet MORE on strong signals');
  console.log('  - If accuracy is flat → strength does not matter, keep flat sizing');
  console.log('  - EV/$1 bet shows expected return per single $1 bet on predicted side');
}

main().catch(e => console.error(e));
