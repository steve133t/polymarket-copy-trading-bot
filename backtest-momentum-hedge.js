/**
 * Backtest momentum-based hedge strategy on historical crypto up/down markets.
 *
 * Strategy:
 *   1. At market open (or just after), check spot price momentum on Binance
 *   2. Compute % change in last 60 seconds
 *   3. If momentum > +threshold: bet $1.5 on Up + $0.5 on Down
 *   4. If momentum < -threshold: bet $1.5 on Down + $0.5 on Up
 *   5. Skip if momentum unclear (between -threshold and +threshold)
 *   6. Hold both positions to resolution
 */

const axios = require('axios');

const SLIPPAGE = 0.05; // 5% slippage for entries near $0.50
const MOMENTUM_THRESHOLD = 0.05; // % change required to take a bet (0.05% per 60s)
const BIG_BET = 1.5; // Major bet on predicted winner
const SMALL_BET = 0.5; // Hedge bet on opposite side
const ENTRY_DELAY_SEC = 60; // Wait this many seconds after market open before betting
                             // (so we're not betting before the spot price has moved)

const sleep = ms => new Promise(r => setTimeout(r, ms));

const SERIES = [
  { id: 10192, asset: 'BTC', coinbase: 'BTC-USD' },
  { id: 10191, asset: 'ETH', coinbase: 'ETH-USD' },
  { id: 10423, asset: 'SOL', coinbase: 'SOL-USD' },
];

async function fetchSpotPriceWindow(symbol, startSec, endSec) {
  const startIso = new Date(startSec * 1000).toISOString();
  const endIso = new Date(endSec * 1000).toISOString();
  const url = `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=60&start=${startIso}&end=${endIso}`;
  try {
    const res = await axios.get(url, { timeout: 10000 });
    if (!Array.isArray(res.data)) {
      console.log(`    not array: ${typeof res.data} ${JSON.stringify(res.data).slice(0,100)}`);
      return null;
    }
    return res.data
      .map(c => [c[0] * 1000, c[3], c[2], c[1], c[4], c[5], c[0] * 1000 + 60000])
      .sort((a, b) => a[0] - b[0]);
  } catch (e) {
    console.log(`    fetch error ${symbol}: ${e.message} status=${e.response?.status}`);
    return null;
  }
}

async function fetchTrades(conditionId) {
  const trades = [];
  let offset = 0;
  while (offset < 5000) {
    try {
      const res = await axios.get(`https://data-api.polymarket.com/trades?market=${conditionId}&limit=500&offset=${offset}`, { timeout: 8000 });
      if (!Array.isArray(res.data) || res.data.length === 0) break;
      trades.push(...res.data);
      if (res.data.length < 500) break;
      offset += 500;
    } catch { break; }
  }
  trades.sort((a,b) => Number(a.timestamp) - Number(b.timestamp));
  return trades;
}

async function main() {
  console.log('\n🎯 Momentum Hedge Backtest\n');
  console.log(`Bet sizes: BIG=$${BIG_BET}, SMALL=$${SMALL_BET} | Slippage: ${(SLIPPAGE*100).toFixed(0)}% | Momentum threshold: ${MOMENTUM_THRESHOLD}%/60s\n`);

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
          const slug = m.slug;
          const tsMatch = slug.match(/(\d+)$/);
          if (!tsMatch) continue;
          const startTs = Number(tsMatch[1]); // Market starts at this unix timestamp
          allMarkets.push({
            conditionId: m.conditionId,
            slug,
            asset: s.asset,
            coinbase: s.coinbase,
            startTs,
            winnerIdx, // 0=Up, 1=Down
          });
        }
      }
    }
  }

  console.log(`Total markets to backtest: ${allMarkets.length}\n`);

  // Group markets by asset for spot price fetching
  const byAsset = {};
  for (const m of allMarkets) {
    if (!byAsset[m.asset]) byAsset[m.asset] = [];
    byAsset[m.asset].push(m);
  }

  // For each asset, fetch a single big batch of spot prices
  const spotByAsset = {};
  for (const [asset, markets] of Object.entries(byAsset)) {
    if (markets.length === 0) continue;
    const minTs = Math.min(...markets.map(m => m.startTs));
    const maxTs = Math.max(...markets.map(m => m.startTs));
    console.log(`Fetching ${asset} spot prices from ${new Date(minTs*1000).toISOString().slice(0,16)} to ${new Date(maxTs*1000).toISOString().slice(0,16)}...`);
    // Coinbase max 300 candles per call (300 minutes = 5 hours)
    const allKlines = [];
    let curSec = minTs - 300;
    const endSec = maxTs + 60;
    while (curSec < endSec) {
      const chunkEndSec = Math.min(curSec + 250 * 60, endSec); // 250 min per chunk
      const data = await fetchSpotPriceWindow(markets[0].coinbase, curSec, chunkEndSec);
      if (data) allKlines.push(...data);
      curSec = chunkEndSec + 60;
      await sleep(150); // Coinbase rate limit
    }
    spotByAsset[asset] = allKlines;
    console.log(`  Got ${allKlines.length} 1-min candles`);
  }

  // For each market, find the candle just before market open and compute momentum
  let bigBetCorrect = 0;
  let bigBetWrong = 0;
  let skipped = 0;
  let totalCost = 0, totalPayout = 0;
  let upBets = 0, downBets = 0;

  for (const market of allMarkets) {
    const klines = spotByAsset[market.asset] || [];
    if (klines.length < 2) continue;

    // Find the candle that ENDED just before market.startTs + ENTRY_DELAY_SEC
    const entryTime = (market.startTs + ENTRY_DELAY_SEC) * 1000;
    const recentCandles = klines.filter(k => k[6] < entryTime); // closeTime < entryTime
    if (recentCandles.length < 2) {
      skipped++;
      continue;
    }
    const c1 = recentCandles[recentCandles.length - 1]; // most recent before entry
    const c2 = recentCandles[recentCandles.length - 2]; // 1 minute before that
    const close1 = Number(c1[4]);
    const close2 = Number(c2[4]);
    const momentumPct = ((close1 - close2) / close2) * 100;

    if (Math.abs(momentumPct) < MOMENTUM_THRESHOLD) {
      skipped++;
      continue;
    }

    // Predicted winner: Up (0) if momentum > 0, Down (1) if < 0
    const predictedWinner = momentumPct > 0 ? 0 : 1;

    // Assume entry prices around $0.50 (after slippage)
    const upPrice = Math.min(0.999, 0.50 * (1 + SLIPPAGE));
    const downPrice = upPrice;

    let upTokens, downTokens, costUp, costDown;
    if (predictedWinner === 0) {
      upTokens = BIG_BET / upPrice;
      downTokens = SMALL_BET / downPrice;
      costUp = BIG_BET;
      costDown = SMALL_BET;
      upBets++;
    } else {
      upTokens = SMALL_BET / upPrice;
      downTokens = BIG_BET / downPrice;
      costUp = SMALL_BET;
      costDown = BIG_BET;
      downBets++;
    }

    const cost = costUp + costDown;
    const payout = market.winnerIdx === 0 ? upTokens : downTokens;
    totalCost += cost;
    totalPayout += payout;

    if (predictedWinner === market.winnerIdx) bigBetCorrect++;
    else bigBetWrong++;
  }

  const evaluated = bigBetCorrect + bigBetWrong;
  const total = evaluated + skipped;
  const accuracy = evaluated > 0 ? (bigBetCorrect / evaluated) * 100 : 0;
  const pnl = totalPayout - totalCost;
  const roi = totalCost > 0 ? (pnl / totalCost) * 100 : 0;
  const ev = evaluated > 0 ? pnl / evaluated : 0;

  console.log('\n══════════ MOMENTUM HEDGE RESULTS ══════════\n');
  console.log(`Markets total:      ${total}`);
  console.log(`Skipped (no signal): ${skipped} (${((100*skipped/total)).toFixed(1)}%)`);
  console.log(`Bets placed:        ${evaluated}`);
  console.log(`  Up bets:          ${upBets}`);
  console.log(`  Down bets:        ${downBets}`);
  console.log(`Big bet correct:    ${bigBetCorrect} (${accuracy.toFixed(1)}% accuracy)`);
  console.log(`Big bet wrong:      ${bigBetWrong}`);
  console.log();
  console.log(`Total cost:         $${totalCost.toFixed(2)}`);
  console.log(`Total payout:       $${totalPayout.toFixed(2)}`);
  console.log(`Net P&L:            ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
  console.log(`ROI:                ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`);
  console.log(`EV per market:      ${ev >= 0 ? '+' : ''}$${ev.toFixed(3)}`);
  console.log();
  console.log('💡 Interpretation:');
  if (accuracy > 53) console.log('  ✅ Momentum signal has edge (>53% accuracy)');
  else if (accuracy > 51) console.log('  🟡 Momentum signal has marginal edge');
  else console.log('  ❌ No edge — momentum doesn\'t predict 15m outcomes reliably');
}

main().catch(e => { console.error(e); process.exit(1); });
