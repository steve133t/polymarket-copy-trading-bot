'use client';

import { useEffect, useState, useMemo } from 'react';
import { MyTradesResponse, CopyTrade, TraderCopyStats } from '@/types/myTrades';
import { CopyPnLBarChart } from '@/components/charts/CopyPnLBarChart';
import { TradesCountChart } from '@/components/charts/TradesCountChart';
import { CopyTimelineChart } from '@/components/charts/CopyTimelineChart';
import { TradesPieChart } from '@/components/charts/TradesPieChart';
import { MyTradesTable } from '@/components/MyTradesTable';

type DatePreset = '7d' | '30d' | '90d' | 'all';

export function MyTradesView() {
  const [data, setData] = useState<MyTradesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [datePreset, setDatePreset] = useState<DatePreset>('30d');
  const [customDateFrom, setCustomDateFrom] = useState<string>('');
  const [customDateTo, setCustomDateTo] = useState<string>('');
  const [countdown, setCountdown] = useState(30);

  const REFRESH_INTERVAL = 30;

  const fetchData = async (refresh = false) => {
    try {
      if (refresh) setRefreshing(true);
      else setLoading(true);

      const url = refresh ? '/api/my-trades?refresh=true' : '/api/my-trades';
      const res = await fetch(url);
      const json = await res.json();

      if (!res.ok) {
        throw new Error(json.error || 'Failed to fetch my trades');
      }

      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Auto-refresh every 30 seconds with countdown
  useEffect(() => {
    let count = REFRESH_INTERVAL;
    const tick = setInterval(() => {
      count -= 1;
      setCountdown(count);
      if (count <= 0) {
        fetchData(true);
        count = REFRESH_INTERVAL;
        setCountdown(REFRESH_INTERVAL);
      }
    }, 1000);
    return () => clearInterval(tick);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Filter trades by date
  const filteredData = useMemo(() => {
    if (!data) return null;

    let startTimestamp: number;
    let endTimestamp = Date.now() / 1000;

    if (customDateFrom && customDateTo) {
      startTimestamp = new Date(customDateFrom).getTime() / 1000;
      endTimestamp = new Date(customDateTo).getTime() / 1000 + 86400; // end of day
    } else {
      const now = Date.now() / 1000;
      switch (datePreset) {
        case '7d':
          startTimestamp = now - 7 * 24 * 60 * 60;
          break;
        case '30d':
          startTimestamp = now - 30 * 24 * 60 * 60;
          break;
        case '90d':
          startTimestamp = now - 90 * 24 * 60 * 60;
          break;
        case 'all':
        default:
          startTimestamp = 0;
          break;
      }
    }

    const filteredTrades = data.allMyTrades.filter(
      (t) => t.timestamp >= startTimestamp && t.timestamp <= endTimestamp
    );

    // Recalculate byTrader stats for filtered trades
    const byTraderMap = new Map<string, CopyTrade[]>();
    byTraderMap.set('unmatched', []);
    for (const trader of data.traders) {
      byTraderMap.set(trader.address.toLowerCase(), []);
    }

    for (const trade of filteredTrades) {
      if (trade.matchedTrader) {
        const key = trade.matchedTrader.toLowerCase();
        const existing = byTraderMap.get(key) || [];
        existing.push(trade);
        byTraderMap.set(key, existing);
      } else {
        const unmatched = byTraderMap.get('unmatched') || [];
        unmatched.push(trade);
        byTraderMap.set('unmatched', unmatched);
      }
    }

    const byTrader: TraderCopyStats[] = data.traders.map((trader) => {
      const trades = byTraderMap.get(trader.address.toLowerCase()) || [];
      let totalBought = 0;
      let totalSold = 0;
      let buyCount = 0;
      let lagSum = 0;
      let lagCount = 0;

      for (const trade of trades) {
        if (trade.side === 'BUY') { totalBought += trade.usdcSize; buyCount++; }
        else totalSold += trade.usdcSize;
        if (trade.timeDiff !== null) { lagSum += trade.timeDiff; lagCount++; }
      }

      return {
        traderAddress: trader.address,
        traderLabel: trader.label,
        trades,
        totalBought,
        totalSold,
        buyCount,
        tradeCount: trades.length,
        netFlow: totalSold - totalBought,
        avgBuySize: buyCount > 0 ? totalBought / buyCount : 0,
        avgCopyLagSeconds: lagCount > 0 ? Math.round(lagSum / lagCount) : null,
      };
    });

    // Add unmatched
    const unmatchedTrades = byTraderMap.get('unmatched') || [];
    if (unmatchedTrades.length > 0) {
      let totalBought = 0;
      let totalSold = 0;
      let buyCount = 0;
      for (const trade of unmatchedTrades) {
        if (trade.side === 'BUY') { totalBought += trade.usdcSize; buyCount++; }
        else totalSold += trade.usdcSize;
      }
      byTrader.push({
        traderAddress: 'unmatched',
        traderLabel: 'Unmatched Trades',
        trades: unmatchedTrades,
        totalBought,
        totalSold,
        buyCount,
        tradeCount: unmatchedTrades.length,
        netFlow: totalSold - totalBought,
        avgBuySize: buyCount > 0 ? totalBought / buyCount : 0,
        avgCopyLagSeconds: null,
      });
    }

    byTrader.sort((a, b) => b.tradeCount - a.tradeCount);

    const matchedCount = filteredTrades.filter((t) => t.matchedTrader).length;

    return {
      ...data,
      allMyTrades: filteredTrades,
      byTrader,
      summary: {
        totalTrades: filteredTrades.length,
        totalBought: filteredTrades.filter((t) => t.side === 'BUY').reduce((s, t) => s + t.usdcSize, 0),
        totalSold: filteredTrades.filter((t) => t.side === 'SELL').reduce((s, t) => s + t.usdcSize, 0),
        matchedTrades: matchedCount,
        unmatchedTrades: filteredTrades.length - matchedCount,
      },
    };
  }, [data, datePreset, customDateFrom, customDateTo]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
          <p className="mt-4 text-muted-foreground">Loading your trades...</p>
          <p className="text-sm text-muted-foreground mt-2">
            This may take a moment as we fetch data from Polymarket
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center max-w-md">
          <h2 className="text-xl font-semibold text-red-500 mb-2">Error</h2>
          <p className="text-muted-foreground mb-4">{error}</p>
          <button onClick={() => fetchData()} className="px-4 py-2 rounded-md bg-card border text-sm hover:bg-muted/50 transition-colors">Retry</button>
        </div>
      </div>
    );
  }

  if (!filteredData) {
    return null;
  }

  const totalPnL = data?.positions?.totalPnL ?? 0;
  const unrealizedPnL = data?.positions?.unrealizedPnL ?? 0;
  const realizedPnL = data?.positions?.realizedPnL ?? 0;

  const matchRate =
    filteredData.summary.totalTrades > 0
      ? (filteredData.summary.matchedTrades / filteredData.summary.totalTrades) * 100
      : 0;

  // Average copy lag across all matched trades in the filtered window
  const matchedLags = filteredData.allMyTrades
    .filter((t) => t.timeDiff !== null)
    .map((t) => t.timeDiff as number);
  const avgLagSeconds = matchedLags.length > 0
    ? Math.round(matchedLags.reduce((a, b) => a + b, 0) / matchedLags.length)
    : null;

  const lagColor = avgLagSeconds === null ? 'text-muted-foreground'
    : avgLagSeconds <= 10 ? 'text-green-400'
    : avgLagSeconds <= 60 ? 'text-yellow-400'
    : 'text-red-400';

  const lagLabel = avgLagSeconds === null ? '—'
    : avgLagSeconds < 60 ? `${avgLagSeconds}s`
    : `${Math.round(avgLagSeconds / 60)}m`;

  const dateLabel = customDateFrom && customDateTo
    ? `${customDateFrom} – ${customDateTo}`
    : datePreset === '7d' ? 'Last 7 days'
    : datePreset === '30d' ? 'Last 30 days'
    : datePreset === '90d' ? 'Last 90 days'
    : 'All time';

  return (
    <div className="space-y-6">
      {/* Slim status strip */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${data?.cached ? 'bg-yellow-400' : 'bg-green-400'}`} />
            <span className={`relative inline-flex rounded-full h-2 w-2 ${data?.cached ? 'bg-yellow-500' : 'bg-green-500'}`} />
          </span>
          <span className="text-xs text-muted-foreground">
            {data?.cached ? 'Cached' : 'Live'} · {(data?.cacheDate || data?.analysisDate || '').split('T')[0]} · {data?.allMyTrades.length ?? 0} trades total
          </span>
        </div>
        <div className="flex items-center gap-3">
          {countdown != null && !refreshing && (
            <span className="text-xs text-muted-foreground tabular-nums">refreshes in {countdown}s</span>
          )}
          <button
            onClick={() => { fetchData(true); setCountdown(REFRESH_INTERVAL); }}
            disabled={refreshing}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 disabled:opacity-40"
          >
            <svg className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Segmented date control */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex p-1 bg-muted/30 rounded-lg gap-0.5">
          {(['7d', '30d', '90d', 'all'] as DatePreset[]).map((preset) => (
            <button
              key={preset}
              onClick={() => { setDatePreset(preset); setCustomDateFrom(''); setCustomDateTo(''); }}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                datePreset === preset && !customDateFrom
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {preset === '7d' ? '7D' : preset === '30d' ? '30D' : preset === '90d' ? '90D' : 'All'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-sm">
          <input
            type="date"
            value={customDateFrom}
            onChange={(e) => setCustomDateFrom(e.target.value)}
            className="bg-muted/30 border-0 rounded-md px-2 py-1.5 text-sm text-muted-foreground outline-none focus:ring-1 focus:ring-border w-36"
          />
          <span className="text-muted-foreground text-xs">→</span>
          <input
            type="date"
            value={customDateTo}
            onChange={(e) => setCustomDateTo(e.target.value)}
            className="bg-muted/30 border-0 rounded-md px-2 py-1.5 text-sm text-muted-foreground outline-none focus:ring-1 focus:ring-border w-36"
          />
        </div>
      </div>

      {/* Total P&L hero */}
      <div className={`rounded-xl p-6 border ${totalPnL >= 0 ? 'border-green-500/25 bg-green-500/5' : 'border-red-500/20 bg-red-500/5'}`}>
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-3">Total P&L — all positions, all-time</p>
        <p className={`text-5xl font-bold tabular-nums leading-none ${totalPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {totalPnL >= 0 ? '+' : '-'}${Math.abs(totalPnL).toFixed(2)}
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-4 text-sm text-muted-foreground">
          <span>
            Unrealized&nbsp;
            <span className={unrealizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}>
              {unrealizedPnL >= 0 ? '+' : '-'}${Math.abs(unrealizedPnL).toFixed(2)}
            </span>
          </span>
          <span className="text-border">·</span>
          <span>
            Realized&nbsp;
            <span className={realizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}>
              {realizedPnL >= 0 ? '+' : '-'}${Math.abs(realizedPnL).toFixed(2)}
            </span>
          </span>
          <span className="text-border">·</span>
          <span>{data?.positions?.total ?? 0} open positions · <span className="text-foreground">${(data?.positions?.totalValue ?? 0).toFixed(2)}</span> value</span>
          <span className="text-border">·</span>
          <span className="font-mono text-xs" title={filteredData.myWallet}>{filteredData.myWallet.slice(0, 10)}…{filteredData.myWallet.slice(-6)}</span>
        </div>
        <p className="text-[11px] text-amber-500/70 mt-3">⚠ Position data is always all-time — not affected by the date filter above</p>
      </div>

      {/* Copy activity — date filtered */}
      <div>
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-3">Copy Activity · {dateLabel}</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-lg p-4 bg-muted/20 border border-border/50">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Trades Copied</p>
            <p className="text-3xl font-bold tabular-nums">{filteredData.summary.totalTrades}</p>
            <p className="text-xs text-muted-foreground mt-1">{filteredData.summary.matchedTrades} matched · {filteredData.summary.unmatchedTrades} unmatched</p>
          </div>
          <div className="rounded-lg p-4 bg-muted/20 border border-border/50">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Total Spent</p>
            <p className="text-3xl font-bold tabular-nums">${filteredData.summary.totalBought.toFixed(0)}</p>
            <p className="text-xs text-muted-foreground mt-1">USDC on buys</p>
          </div>
          <div className="rounded-lg p-4 bg-muted/20 border border-border/50">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Match Rate</p>
            <p className="text-3xl font-bold tabular-nums">{matchRate.toFixed(0)}%</p>
            <p className="text-xs text-muted-foreground mt-1">{filteredData.summary.matchedTrades} of {filteredData.summary.totalTrades} traced</p>
          </div>
          <div className="rounded-lg p-4 bg-muted/20 border border-border/50">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Avg Copy Lag</p>
            <p className={`text-3xl font-bold tabular-nums ${lagColor}`}>{lagLabel}</p>
            <p className="text-xs text-muted-foreground mt-1">avg seconds after trader</p>
          </div>
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <CopyPnLBarChart byTrader={filteredData.byTrader} />
        <TradesPieChart byTrader={filteredData.byTrader} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TradesCountChart byTrader={filteredData.byTrader} />
        <CopyTimelineChart trades={filteredData.allMyTrades} />
      </div>

      {/* Table */}
      <MyTradesTable byTrader={filteredData.byTrader} />
    </div>
  );
}
