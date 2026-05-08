/**
 * Test MULTIPLE signals on 15m crypto markets with STRICT no-look-ahead.
 *
 * Each signal computed using ONLY data available before market.startTs + 60s.
 * For 1-min candles: only candles with close time <= entryTime - 60s are valid.
 *
 * Signals tested:
 *   1. 1-min momentum (price change in last 60s)
 *   2. 5-min momentum (existing baseline, properly computed)
 *   3. Acceleration (1-min vs 5-min momentum delta)
 *   4. Z-score (current vs 30-min mean/std — overextension)
 *   5. Cross-asset BTC-leads (BTC momentum predicts ETH/SOL)
 *   6. Polymarket order book bias (Buy volume vs Sell volume on entry)
 *   7. Polymarket bid-ask imbalance at entry time
 */

const axios = require('axios');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SLIPPAGE = 0.05;
const ENTRY_DELAY = 60;
const PER_BUY = 1;

const SERIES = [
  { id: 10192, asset: 'BTC', kraken: 'XBTUSDT' },
  { id: 10191, asset: 'ETH', kraken: 'ETHUSDT' },
  { id: 10423, asset: 'SOL', kraken: 'SOLUSDT' },
];

async function fetchKraken(symbol, sinceSec) {
  const url = `https://api.kraken.com/0/public/OHLC?pair=${symbol}&interval=1&since=${sinceSec}`;
  try {
    const res = await axios.get(url, { timeout: 15000 });
    const result = res.data?.result || {};
    const ohlcKey = Object.keys(result).find(k => k !== 'last');
    return ohlcKey ? result[ohlcKey] : null;
  } catch { return null; }
}

async function fetchPolymarketTrades(conditionId, beforeTs) {
  // Get trades on a Polymarket market that happened BEFORE beforeTs
  try {
    const res = await axios.get(
      `https://data-api.polymarket.com/trades?market=${conditionId}&limit=500`,
      { timeout: 8000 }
    );
    if (!Array.isArray(res.data)) return [];
    return res.data.filter(t => Number(t.timestamp) < beforeTs);
  } catch { return []; }
}

// Get the safe candles (close time <= entryTime - 60s for 1-min candles)
function getSafeCandles(klines, entryTimeSec) {
  const candleCloseLimitSec = entryTimeSec - 60;
  return klines.filter(k => Number(k[0]) <= candleCloseLimitSec);
}

// === SIGNAL FUNCTIONS ===

// 1. 1-min momentum
function signal1MinMomentum(klines, entryTimeSec) {
  const safe = getSafeCandles(klines, entryTimeSec);
  if (safe.length < 2) return null;
  const c1 = safe[safe.length - 1];
  const c2 = safe[safe.length - 2];
  return ((Number(c1[4]) - Number(c2[4])) / Number(c2[4])) * 100;
}

// 2. 5-min momentum (proper)
function signal5MinMomentum(klines, entryTimeSec) {
  const safe = getSafeCandles(klines, entryTimeSec);
  if (safe.length < 6) return null;
  const c1 = safe[safe.length - 1];
  const c2 = safe[safe.length - 6]; // 5 candles back = 5 min
  return ((Number(c1[4]) - Number(c2[4])) / Number(c2[4])) * 100;
}

// 3. Acceleration (recent vs older momentum)
function signalAcceleration(klines, entryTimeSec) {
  const m1 = signal1MinMomentum(klines, entryTimeSec);
  const m5 = signal5MinMomentum(klines, entryTimeSec);
  if (m1 === null || m5 === null) return null;
  // If 1-min momentum > average per-min over 5 min, we're accelerating
  return m1 - (m5 / 5);
}

// 4. Z-score (overextension): how many std devs above/below 30-min mean
function signalZScore(klines, entryTimeSec) {
  const safe = getSafeCandles(klines, entryTimeSec);
  if (safe.length < 30) return null;
  const recent30 = safe.slice(-30).map(k => Number(k[4]));
  const mean = recent30.reduce((s, v) => s + v, 0) / recent30.length;
  const variance = recent30.reduce((s, v) => s + (v - mean) ** 2, 0) / recent30.length;
  const std = Math.sqrt(variance);
  if (std === 0) return null;
  const current = recent30[recent30.length - 1];
  return (current - mean) / std;
}

// 5. Cross-asset BTC-leads (predicts based on BTC's momentum)
function signalBTCLeads(btcKlines, entryTimeSec) {
  return signal1MinMomentum(btcKlines, entryTimeSec);
}

// 6. Polymarket order book bias (buy vs sell volume on Up side)
function signalOrderBookBias(trades) {
  if (trades.length === 0) return null;
  let upBuyVol = 0, upSellVol = 0;
  for (const t of trades) {
    if (Number(t.outcomeIndex) !== 0) continue;
    const usd = Number(t.usdcSize) || 0;
    if (t.side === 'BUY') upBuyVol += usd;
    else upSellVol += usd;
  }
  const total = upBuyVol + upSellVol;
  if (total === 0) return null;
  // Returns -1 to +1: positive = more buying = bullish for Up
  return (upBuyVol - upSellVol) / total;
}

// === BACKTEST RUNNER ===

function runBacktest(name, allMarkets, klinesByAsset, signalFn, threshold, opts = {}) {
  let total = 0, correct = 0, totalCost = 0, totalPayout = 0;
  const upPrice = Math.min(0.999, 0.50 * (1 + SLIPPAGE));

  for (const market of allMarkets) {
    const entryTimeSec = market.startTs + ENTRY_DELAY;
    const klines = klinesByAsset[market.asset] || [];

    let signal;
    if (opts.usePolymarket) {
      signal = signalFn(market.precomputedTrades || []);
    } else if (opts.useBTCLeads) {
      signal = signalFn(klinesByAsset['BTC'] || [], entryTimeSec);
    } else {
      signal = signalFn(klines, entryTimeSec);
    }

    if (signal === null) continue;
    if (Math.abs(signal) < threshold) continue;

    total++;
    const predicted = signal > 0 ? 0 : 1;
    if (predicted === market.winnerIdx) correct++;

    const cost = PER_BUY;
    const tokens = cost / upPrice;
    const payout = predicted === market.winnerIdx ? tokens : 0;
    totalCost += cost;
    totalPayout += payout;
  }

  const acc = total > 0 ? (correct / total) * 100 : 0;
  const ev = total > 0 ? (totalPayout - totalCost) / total : 0;
  return { name, total, correct, acc, ev };
}

async function main() {
  console.log('\n📊 Multi-Signal No-Lookahead Backtest\n');

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

  // Fetch 1-min Kraken candles
  const klinesByAsset = {};
  for (const s of SERIES) {
    const markets = allMarkets.filter(m => m.asset === s.asset);
    if (markets.length === 0) continue;
    const minTs = Math.min(...markets.map(m => m.startTs));
    const all = [];
    let since = minTs - 1800;
    let lastNewest = 0;
    for (let i = 0; i < 10; i++) {
      const data = await fetchKraken(s.kraken, since);
      if (!data || data.length === 0) break;
      all.push(...data);
      const newest = Number(data[data.length - 1][0]);
      if (newest === lastNewest) break;
      since = newest;
      lastNewest = newest;
      await sleep(400);
    }
    const byTs = new Map();
    for (const c of all) byTs.set(Number(c[0]), c);
    klinesByAsset[s.asset] = Array.from(byTs.values()).sort((a,b) => Number(a[0]) - Number(b[0]));
    console.log(`  ${s.asset}: ${klinesByAsset[s.asset].length} candles`);
  }

  // Pre-fetch Polymarket trades for order book bias signal (this is slow, sample only)
  console.log('\nPre-fetching Polymarket trade data (sampling 50 markets)...');
  const sampledMarkets = allMarkets.slice(0, 50);
  let fetched = 0;
  for (const m of sampledMarkets) {
    const entryTimeSec = m.startTs + ENTRY_DELAY;
    m.precomputedTrades = await fetchPolymarketTrades(m.conditionId, entryTimeSec);
    fetched++;
    if (fetched % 10 === 0) console.log(`  ${fetched}/50`);
    await sleep(50);
  }

  // Run all signals at multiple thresholds
  console.log('\n══════════ RESULTS ══════════');
  console.log('Signal                       | Threshold | Total | Acc%  | EV/$1bet | Verdict');
  console.log('-----------------------------|-----------|-------|-------|----------|----------');

  const tests = [
    // Baseline
    { name: '5-min momentum', fn: signal5MinMomentum, thresholds: [0.05, 0.10, 0.20] },
    // New signals
    { name: '1-min momentum', fn: signal1MinMomentum, thresholds: [0.02, 0.05, 0.10] },
    { name: 'Acceleration', fn: signalAcceleration, thresholds: [0.02, 0.05, 0.10] },
    { name: 'Z-score (REVERSE)', fn: signalZScore, thresholds: [0.5, 1.0, 1.5], opts: { invert: true } },
    { name: 'Z-score (FOLLOW)', fn: signalZScore, thresholds: [0.5, 1.0, 1.5] },
    { name: 'BTC-leads', fn: signalBTCLeads, thresholds: [0.02, 0.05, 0.10], opts: { useBTCLeads: true } },
    { name: 'Polymarket bias', fn: signalOrderBookBias, thresholds: [0.10, 0.20, 0.30], opts: { usePolymarket: true, sample: 50 } },
  ];

  for (const test of tests) {
    for (const threshold of test.thresholds) {
      const markets = test.opts?.sample ? sampledMarkets : allMarkets;
      let result = runBacktest(test.name, markets, klinesByAsset, test.fn, threshold, test.opts);

      // For inverted signals, flip the prediction post-hoc
      if (test.opts?.invert && result.total > 0) {
        // Re-run inverted
        let total = 0, correct = 0, totalCost = 0, totalPayout = 0;
        const upPrice = Math.min(0.999, 0.50 * (1 + SLIPPAGE));
        for (const m of markets) {
          const entryTimeSec = m.startTs + ENTRY_DELAY;
          const klines = klinesByAsset[m.asset] || [];
          const signal = test.fn(klines, entryTimeSec);
          if (signal === null) continue;
          if (Math.abs(signal) < threshold) continue;
          total++;
          // INVERTED: bet AGAINST the signal direction
          const predicted = signal > 0 ? 1 : 0;
          if (predicted === m.winnerIdx) correct++;
          const cost = PER_BUY;
          const tokens = cost / upPrice;
          const payout = predicted === m.winnerIdx ? tokens : 0;
          totalCost += cost;
          totalPayout += payout;
        }
        result = {
          name: test.name,
          total,
          correct,
          acc: total > 0 ? (correct/total)*100 : 0,
          ev: total > 0 ? (totalPayout-totalCost)/total : 0,
        };
      }

      const verdict = result.acc > 55 && result.ev > 0.05 ? '✅ EDGE' : result.acc > 52 ? '🟡 weak' : '❌';
      const evSign = result.ev >= 0 ? '+' : '';
      console.log(
        `${test.name.padEnd(28)} | ${String(threshold).padStart(9)} | ${String(result.total).padStart(5)} | ${result.acc.toFixed(1).padStart(5)} | ${evSign}$${result.ev.toFixed(3).padStart(6)}  | ${verdict}`
      );
    }
  }

  console.log('\n💡 EDGE means accuracy > 55% AND EV > $0.05/bet across enough samples');
}

main().catch(e => console.error(e));
