/**
 * Verify BTC-leads signal works on ETH/SOL (cross-asset).
 * Test multiple lookback windows and thresholds with strict no-look-ahead.
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

function getSafeCandles(klines, entryTimeSec) {
  const candleCloseLimitSec = entryTimeSec - 60;
  return klines.filter(k => Number(k[0]) <= candleCloseLimitSec);
}

function btcMomentum(btcKlines, entryTimeSec, lookbackMin) {
  const safe = getSafeCandles(btcKlines, entryTimeSec);
  if (safe.length < lookbackMin + 1) return null;
  const c1 = safe[safe.length - 1];
  const c2 = safe[safe.length - 1 - lookbackMin];
  return ((Number(c1[4]) - Number(c2[4])) / Number(c2[4])) * 100;
}

async function main() {
  console.log('\n🎯 BTC-leads signal verification\n');

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
            startTs: Number(tsMatch[1]),
            winnerIdx,
          });
        }
      }
    }
  }

  // Fetch BTC klines (the predictor)
  let btcKlines = [];
  const minTs = Math.min(...allMarkets.map(m => m.startTs));
  let since = minTs - 1800;
  let lastNewest = 0;
  for (let i = 0; i < 10; i++) {
    const data = await fetchKraken('XBTUSDT', since);
    if (!data || data.length === 0) break;
    btcKlines.push(...data);
    const newest = Number(data[data.length - 1][0]);
    if (newest === lastNewest) break;
    since = newest;
    lastNewest = newest;
    await sleep(400);
  }
  const byTs = new Map();
  for (const c of btcKlines) byTs.set(Number(c[0]), c);
  btcKlines = Array.from(byTs.values()).sort((a,b) => Number(a[0]) - Number(b[0]));
  console.log(`BTC: ${btcKlines.length} 1-min candles`);
  console.log(`Markets: ${allMarkets.length}\n`);

  // Test combinations: lookback (1, 2, 3, 5 min) × threshold × asset
  const upPrice = Math.min(0.999, 0.50 * (1 + SLIPPAGE));

  console.log('Lookback | Threshold | Asset | Bets | Acc%  | EV/$1bet | Verdict');
  console.log('---------|-----------|-------|------|-------|----------|----------');

  for (const lookback of [1, 2, 3, 5]) {
    for (const threshold of [0.01, 0.02, 0.05, 0.10]) {
      for (const targetAsset of ['ETH', 'SOL', 'BOTH']) {
        let bets = 0, correct = 0, cost = 0, payout = 0;
        const targetMarkets = targetAsset === 'BOTH'
          ? allMarkets.filter(m => m.asset === 'ETH' || m.asset === 'SOL')
          : allMarkets.filter(m => m.asset === targetAsset);

        for (const market of targetMarkets) {
          const entryTimeSec = market.startTs + ENTRY_DELAY;
          const signal = btcMomentum(btcKlines, entryTimeSec, lookback);
          if (signal === null) continue;
          if (Math.abs(signal) < threshold) continue;

          bets++;
          const predicted = signal > 0 ? 0 : 1;
          if (predicted === market.winnerIdx) correct++;
          cost += PER_BUY;
          const tokens = PER_BUY / upPrice;
          if (predicted === market.winnerIdx) payout += tokens;
        }

        const acc = bets > 0 ? (correct / bets) * 100 : 0;
        const ev = bets > 0 ? (payout - cost) / bets : 0;
        const verdict = bets >= 20 && acc > 58 && ev > 0.10 ? '🏆 STRONG' : bets >= 20 && acc > 55 ? '✅ edge' : bets >= 10 && acc > 55 ? '🟡 small sample' : '❌';
        const evSign = ev >= 0 ? '+' : '';
        console.log(
          `${String(lookback).padStart(7)}m | ${String(threshold).padStart(9)} | ${targetAsset.padEnd(5)} | ${String(bets).padStart(4)} | ${acc.toFixed(1).padStart(5)} | ${evSign}$${ev.toFixed(3).padStart(6)}  | ${verdict}`
        );
      }
    }
  }
}

main().catch(e => console.error(e));
