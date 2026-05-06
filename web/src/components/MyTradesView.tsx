'use client';

import { useEffect, useState, useMemo } from 'react';
import { MyTradesResponse, CopyTrade, TraderCopyStats } from '@/types/myTrades';
import { CopyPnLBarChart } from '@/components/charts/CopyPnLBarChart';
import { TradesCountChart } from '@/components/charts/TradesCountChart';
import { CopyTimelineChart } from '@/components/charts/CopyTimelineChart';
import { TradesPieChart } from '@/components/charts/TradesPieChart';
import { MyTradesTable } from '@/components/MyTradesTable';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatusBar } from '@/components/StatusBar';

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
          <Button onClick={() => fetchData()}>Retry</Button>
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

  return (
    <>
      {/* Status Bar */}
      <StatusBar
        cached={data?.cached}
        cacheDate={data?.cacheDate}
        lastUpdated={data?.analysisDate}
        totalItems={data?.allMyTrades.length}
        itemLabel="trades"
        refreshing={refreshing}
        onRefresh={() => { fetchData(true); setCountdown(REFRESH_INTERVAL); }}
        countdown={countdown}
      />

      {/* Date Filter */}
      <Card className="mb-6 p-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <span className="text-sm font-medium">Filter by date:</span>
          <div className="flex gap-2 flex-wrap">
            {(['7d', '30d', '90d', 'all'] as DatePreset[]).map((preset) => (
              <Button
                key={preset}
                variant={datePreset === preset && !customDateFrom ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  setDatePreset(preset);
                  setCustomDateFrom('');
                  setCustomDateTo('');
                }}
              >
                {preset === '7d' && '7 Days'}
                {preset === '30d' && '30 Days'}
                {preset === '90d' && '90 Days'}
                {preset === 'all' && 'All Time'}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={customDateFrom}
              onChange={(e) => setCustomDateFrom(e.target.value)}
              className="bg-background border rounded px-2 py-1 text-sm"
            />
            <span className="text-muted-foreground">to</span>
            <input
              type="date"
              value={customDateTo}
              onChange={(e) => setCustomDateTo(e.target.value)}
              className="bg-background border rounded px-2 py-1 text-sm"
            />
          </div>
        </div>
      </Card>

      {/* P&L Hero — all-time from live positions, not date-filtered */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
        <div className="bg-card rounded-lg p-5 border md:col-span-2">
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
            Total P&L <span className="normal-case">(all positions, all-time)</span>
          </p>
          <p className={`text-4xl font-bold ${totalPnL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
            {totalPnL >= 0 ? '+' : '-'}${Math.abs(totalPnL).toFixed(2)}
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            Unrealized {unrealizedPnL >= 0 ? '+' : '-'}${Math.abs(unrealizedPnL).toFixed(2)}
            &nbsp;·&nbsp;
            Realized {realizedPnL >= 0 ? '+' : '-'}${Math.abs(realizedPnL).toFixed(2)}
          </p>
          <p className="text-xs text-amber-500 mt-1">
            ⚠ Positions data is always all-time — not filtered by the date selector above
          </p>
        </div>
        <div className="bg-card rounded-lg p-5 border">
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Open Positions</p>
          <p className="text-3xl font-bold">{data?.positions?.total ?? 0}</p>
          <p className="text-xs text-muted-foreground mt-2">
            Value ${(data?.positions?.totalValue ?? 0).toFixed(2)}
          </p>
        </div>
        <div className="bg-card rounded-lg p-5 border">
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">My Wallet</p>
          <p className="text-sm font-mono mt-1" title={filteredData.myWallet}>
            {filteredData.myWallet.slice(0, 8)}…{filteredData.myWallet.slice(-6)}
          </p>
        </div>
      </div>

      {/* Copy activity metrics — these ARE filtered by the date selector */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-card rounded-lg p-4 border">
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Trades Copied</p>
          <p className="text-2xl font-bold">{filteredData.summary.totalTrades}</p>
          <p className="text-xs text-muted-foreground mt-1">in selected period</p>
        </div>
        <div className="bg-card rounded-lg p-4 border">
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Total Spent</p>
          <p className="text-2xl font-bold">${filteredData.summary.totalBought.toFixed(2)}</p>
          <p className="text-xs text-muted-foreground mt-1">USDC on buys</p>
        </div>
        <div className="bg-card rounded-lg p-4 border">
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Match Rate</p>
          <p className="text-2xl font-bold">{matchRate.toFixed(1)}%</p>
          <p className="text-xs text-muted-foreground mt-1">
            {filteredData.summary.matchedTrades} / {filteredData.summary.totalTrades} traced to a trader
          </p>
        </div>
        <div className="bg-card rounded-lg p-4 border">
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Avg Copy Lag</p>
          <p className={`text-2xl font-bold ${
            avgLagSeconds === null ? '' :
            avgLagSeconds <= 10 ? 'text-green-500' :
            avgLagSeconds <= 60 ? 'text-yellow-500' : 'text-red-400'
          }`}>
            {avgLagSeconds === null ? '—' : avgLagSeconds < 60 ? `${avgLagSeconds}s` : `${Math.round(avgLagSeconds / 60)}m`}
          </p>
          <p className="text-xs text-muted-foreground mt-1">median after trader</p>
        </div>
      </div>

      {/* Charts Row 1 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <CopyPnLBarChart byTrader={filteredData.byTrader} />
        <TradesPieChart byTrader={filteredData.byTrader} />
      </div>

      {/* Charts Row 2 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <TradesCountChart byTrader={filteredData.byTrader} />
        <CopyTimelineChart trades={filteredData.allMyTrades} />
      </div>

      {/* Table */}
      <MyTradesTable byTrader={filteredData.byTrader} />
    </>
  );
}
