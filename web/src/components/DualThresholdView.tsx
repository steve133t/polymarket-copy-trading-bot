'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface Position {
  conditionId: string;
  slug: string;
  title: string;
  asset: string;
  window: string;
  outcome: string;
  triggerPrice: number;
  fillPrice: number;
  tokens: number;
  costUSD: number;
  entryTimestamp: number;
  resolved: boolean;
  payoutUSD: number;
  pnl: number;
}

interface AssetBreakdown {
  asset: string;
  positions: number;
  resolvedPnl: number;
  wins: number;
  losses: number;
  winRate: number;
  openCost: number;
}

interface Stats {
  summary: {
    totalPositions: number;
    openPositions: number;
    resolvedPositions: number;
    bothSidesOpenMarkets: number;
    wins: number;
    losses: number;
    winRate: number;
    totalCost: number;
    openCost: number;
    totalPayout: number;
    realizedPnl: number;
    roi: number;
    evPerPosition: number;
  };
  byAsset: AssetBreakdown[];
  recent: Position[];
  topWinners: { title: string; outcome: string; cost: number; payout: number; pnl: number; slug: string }[];
}

const REFRESH_INTERVAL = 10;

export function DualThresholdView() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchStats = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/dual-threshold-stats');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setStats(data);
      setLastUpdated(new Date());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
      setCountdown(REFRESH_INTERVAL);
    }
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(() => fetchStats(true), REFRESH_INTERVAL * 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const tick = setInterval(() => {
      setCountdown((c) => (c <= 1 ? REFRESH_INTERVAL : c - 1));
    }, 1000);
    return () => clearInterval(tick);
  }, []);

  const fmtTime = (ts: number) => {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  const pnlColor = (v: number) => v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-muted-foreground';
  const pnlSign = (v: number) => v > 0 ? '+' : '';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">🎯 Dual-Threshold Strategy</h2>
          <p className="text-sm text-muted-foreground">
            Buy crypto up/down sides when each dips below $0.10 — paper trading
            {lastUpdated && <> · Last updated: {lastUpdated.toLocaleTimeString()}</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground tabular-nums">{loading ? '⟳' : `${countdown}s`}</span>
          <Button variant="outline" size="sm" onClick={() => fetchStats()} disabled={loading}>
            {loading ? 'Refreshing...' : '⟳ Refresh'}
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border-red-500/30 bg-red-500/5">
          <CardContent className="pt-4 text-sm text-red-400">{error}</CardContent>
        </Card>
      )}

      {stats && (
        <>
          {/* Top stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card className={stats.summary.realizedPnl >= 0 ? 'border-green-500/30' : 'border-red-500/30'}>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">Realized P&amp;L</p>
                <p className={`text-2xl font-bold ${pnlColor(stats.summary.realizedPnl)}`}>
                  {pnlSign(stats.summary.realizedPnl)}${Math.abs(stats.summary.realizedPnl).toFixed(2)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  ROI: {stats.summary.roi >= 0 ? '+' : ''}{stats.summary.roi}%
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">Win Rate</p>
                <p className={`text-2xl font-bold ${stats.summary.winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                  {stats.summary.winRate}%
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {stats.summary.wins}W / {stats.summary.losses}L
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">Open Positions</p>
                <p className="text-2xl font-bold">{stats.summary.openPositions}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  ${stats.summary.openCost.toFixed(2)} at risk · {stats.summary.bothSidesOpenMarkets} jackpot setups
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">EV per Position</p>
                <p className={`text-2xl font-bold ${pnlColor(stats.summary.evPerPosition)}`}>
                  {pnlSign(stats.summary.evPerPosition)}${Math.abs(stats.summary.evPerPosition).toFixed(3)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Backtest target: +$0.115
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Per-asset breakdown */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Per-Asset Performance</CardTitle>
              <CardDescription>BTC and SOL only — ETH was excluded based on backtest results</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                {(stats.byAsset ?? []).length === 0 && (
                  <p className="text-sm text-muted-foreground">No positions yet — strategy is monitoring active markets...</p>
                )}
                {(stats.byAsset ?? []).map((a) => (
                  <div key={a.asset} className="flex items-center justify-between border-b border-muted/30 py-1.5 text-xs">
                    <div className="flex items-center gap-3">
                      <Badge variant="outline" className="text-xs px-1.5 py-0">{a.asset}</Badge>
                      <span className="text-muted-foreground">{a.positions} positions</span>
                      <span className="text-muted-foreground">{a.wins}W / {a.losses}L ({a.winRate}%)</span>
                    </div>
                    <div className="flex items-center gap-3">
                      {a.openCost > 0 && (
                        <span className="font-mono text-muted-foreground">${a.openCost.toFixed(2)} open</span>
                      )}
                      <span className={`font-mono font-bold w-24 text-right ${pnlColor(a.resolvedPnl)}`}>
                        {pnlSign(a.resolvedPnl)}${Math.abs(a.resolvedPnl).toFixed(2)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Top winners */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Top Winning Positions</CardTitle>
              <CardDescription>Biggest payouts from cheap-side buys that hit</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-1 max-h-60 overflow-y-auto">
                {(stats.topWinners ?? []).length === 0 && (
                  <p className="text-sm text-muted-foreground">No winning positions yet.</p>
                )}
                {(stats.topWinners ?? []).map((w, i) => (
                  <div key={i} className="flex items-center justify-between border-b border-muted/30 py-1.5 text-xs">
                    <div className="min-w-0">
                      <p className="truncate text-muted-foreground">{w.title}</p>
                      <p className="text-[11px] text-muted-foreground/60">→ {w.outcome} · paid ${w.payout.toFixed(2)} on ${w.cost.toFixed(2)}</p>
                    </div>
                    <span className={`shrink-0 font-mono font-bold ml-3 ${pnlColor(w.pnl)}`}>
                      {pnlSign(w.pnl)}${w.pnl.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Recent positions feed */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Recent Positions</CardTitle>
              <CardDescription>Last 50 trigger-fires from the strategy</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-1 max-h-80 overflow-y-auto">
                {(stats.recent ?? []).length === 0 && (
                  <p className="text-sm text-muted-foreground">No positions yet — waiting for prices to dip below $0.10...</p>
                )}
                {(stats.recent ?? []).map((p, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 border-b border-muted/30 py-1.5 text-xs">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge
                        variant={p.resolved ? (p.pnl > 0 ? 'default' : 'destructive') : 'outline'}
                        className={`shrink-0 px-1 py-0 text-xs ${p.resolved && p.pnl > 0 ? 'bg-green-600' : ''}`}
                      >
                        {p.resolved ? (p.pnl > 0 ? 'WIN' : 'LOSS') : 'OPEN'}
                      </Badge>
                      <Badge variant="outline" className="shrink-0 px-1 py-0 text-xs">{p.asset}</Badge>
                      <span className="truncate text-muted-foreground">{p.title}</span>
                      <span className="shrink-0 text-muted-foreground/60">→ {p.outcome}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="font-mono text-muted-foreground/80">
                        ${p.fillPrice.toFixed(3)} ({p.tokens.toFixed(0)} tok)
                      </span>
                      {p.resolved ? (
                        <span className={`font-mono font-bold w-20 text-right ${pnlColor(p.pnl)}`}>
                          {pnlSign(p.pnl)}${p.pnl.toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/60 w-20 text-right">pending</span>
                      )}
                      <span className="text-muted-foreground/60">{fmtTime(p.entryTimestamp)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
