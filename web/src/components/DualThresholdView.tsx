'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

interface Session {
  active: boolean;
  startingBalance: number;
  threshold: number;
  perBuyUSD: number;
  slippageBps: number;
  enabledAssets: string[];
  enabledWindows: string[];
  startedAt: number;
}

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
  session: Session;
  summary: {
    totalPositions: number;
    openPositions: number;
    resolvedPositions: number;
    bothSidesOpenMarkets: number;
    wins: number;
    losses: number;
    winRate: number;
    startingBalance: number;
    cashBalance: number;
    openMarketValue: number;
    totalEquity: number;
    totalCost: number;
    openCost: number;
    totalPayout: number;
    realizedPnl: number;
    totalPnl: number;
    returnPct: number;
    roi: number;
    evPerPosition: number;
  };
  byAsset: AssetBreakdown[];
  recent: Position[];
  topWinners: { title: string; outcome: string; cost: number; payout: number; pnl: number; slug: string }[];
}

const REFRESH_INTERVAL = 10;
const ALL_ASSETS = ['BTC', 'SOL', 'ETH'];
const ALL_WINDOWS = ['5m', '15m'];

export function DualThresholdView() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingSession, setSavingSession] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [startingBalance, setStartingBalance] = useState('100');
  const [threshold, setThreshold] = useState('0.10');
  const [perBuyUSD, setPerBuyUSD] = useState('1');
  const [slippagePercent, setSlippagePercent] = useState('20');
  const [enabledAssets, setEnabledAssets] = useState<string[]>(['BTC', 'ETH', 'SOL']);
  const [enabledWindows, setEnabledWindows] = useState<string[]>(['15m']);
  const formInitialized = useRef(false);

  const syncForm = useCallback((s: Session) => {
    setStartingBalance(String(s.startingBalance));
    setThreshold(String(s.threshold));
    setPerBuyUSD(String(s.perBuyUSD));
    setSlippagePercent(String((s.slippageBps || 0) / 100));
    setEnabledAssets(s.enabledAssets);
    setEnabledWindows(s.enabledWindows && s.enabledWindows.length > 0 ? s.enabledWindows : ['15m']);
  }, []);

  const fetchStats = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/dual-threshold-stats');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setStats(data);
      if (data.session && !formInitialized.current) {
        syncForm(data.session);
        formInitialized.current = true;
      }
      setLastUpdated(new Date());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
      setCountdown(REFRESH_INTERVAL);
    }
  }, [syncForm]);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(() => fetchStats(true), REFRESH_INTERVAL * 1000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  useEffect(() => {
    const tick = setInterval(() => {
      setCountdown((c) => (c <= 1 ? REFRESH_INTERVAL : c - 1));
    }, 1000);
    return () => clearInterval(tick);
  }, []);

  const saveSession = async (action: 'start' | 'stop' | 'update' | 'reset') => {
    setSavingSession(true);
    setError(null);
    try {
      const body = {
        action,
        startingBalance: Number(startingBalance),
        threshold: Number(threshold),
        perBuyUSD: Number(perBuyUSD),
        slippageBps: Math.round(Number(slippagePercent) * 100),
        enabledAssets,
        enabledWindows,
      };
      const res = await fetch('/api/dual-threshold-stats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save session');
      if (data.session) syncForm(data.session as Session);
      await fetchStats(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSavingSession(false);
    }
  };

  const toggleAsset = (asset: string) => {
    setEnabledAssets((prev) =>
      prev.includes(asset) ? prev.filter((a) => a !== asset) : [...prev, asset]
    );
  };

  const toggleWindow = (window: string) => {
    setEnabledWindows((prev) =>
      prev.includes(window) ? prev.filter((w) => w !== window) : [...prev, window]
    );
  };

  const fmtTime = (ts: number) => {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  const pnlColor = (v: number) => (v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-muted-foreground');
  const pnlSign = (v: number) => (v > 0 ? '+' : '');

  const sessionActive = stats?.session.active ?? false;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">🎯 Dual-Threshold Strategy</h2>
          <p className="text-sm text-muted-foreground">
            Buy crypto up/down sides when each dips below threshold — paper trading
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

      {/* Session config */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Strategy Session
            {stats && (
              <Badge
                variant={sessionActive ? 'default' : 'outline'}
                className={`ml-3 px-1.5 py-0 text-xs ${sessionActive ? 'bg-green-600' : ''}`}
              >
                {sessionActive ? 'ACTIVE' : 'STOPPED'}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>Backtest target: $0.10 threshold, $1/buy, 20% slippage, BTC+SOL</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div>
              <label className="text-xs text-muted-foreground">Starting Balance ($)</label>
              <Input
                type="number"
                value={startingBalance}
                onChange={(e) => setStartingBalance(e.target.value)}
                className="mt-1"
                step="10"
                min="10"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Threshold ($)</label>
              <Input
                type="number"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                className="mt-1"
                step="0.01"
                min="0.01"
                max="0.50"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Per Buy ($)</label>
              <Input
                type="number"
                value={perBuyUSD}
                onChange={(e) => setPerBuyUSD(e.target.value)}
                className="mt-1"
                step="0.5"
                min="0.5"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Slippage (%)</label>
              <Input
                type="number"
                value={slippagePercent}
                onChange={(e) => setSlippagePercent(e.target.value)}
                className="mt-1"
                step="1"
                min="0"
                max="80"
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-6">
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Enabled Assets</p>
              <div className="flex gap-2">
                {ALL_ASSETS.map((asset) => (
                  <div key={asset} className="flex items-center gap-2 rounded-md border border-muted/40 px-3 py-1.5">
                    <span className="text-xs font-mono">{asset}</span>
                    <Switch checked={enabledAssets.includes(asset)} onCheckedChange={() => toggleAsset(asset)} />
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Time Windows
                <span className="ml-2 text-[10px] text-muted-foreground/60">
                  (15m is ~50× more profitable than 5m per backtest)
                </span>
              </p>
              <div className="flex gap-2">
                {ALL_WINDOWS.map((window) => (
                  <div key={window} className="flex items-center gap-2 rounded-md border border-muted/40 px-3 py-1.5">
                    <span className="text-xs font-mono">{window}</span>
                    <Switch checked={enabledWindows.includes(window)} onCheckedChange={() => toggleWindow(window)} />
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => saveSession('update')} disabled={savingSession}>
              Save Settings
            </Button>
            {sessionActive ? (
              <Button size="sm" variant="outline" onClick={() => saveSession('stop')} disabled={savingSession}>
                ⏸ Stop Strategy
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => saveSession('start')} disabled={savingSession}>
                ▶ Start Strategy
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-300"
              onClick={() => {
                if (confirm('Reset deletes ALL positions and starts fresh. Continue?')) saveSession('reset');
              }}
              disabled={savingSession}
            >
              ↺ Reset Session
            </Button>
          </div>
        </CardContent>
      </Card>

      {stats && (
        <>
          {/* Equity stats */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card className={stats.summary.totalPnl >= 0 ? 'border-green-500/30' : 'border-red-500/30'}>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">Total Equity</p>
                <p className={`text-2xl font-bold ${pnlColor(stats.summary.totalPnl)}`}>
                  ${stats.summary.totalEquity.toFixed(2)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {pnlSign(stats.summary.totalPnl)}${Math.abs(stats.summary.totalPnl).toFixed(2)} ({pnlSign(stats.summary.returnPct)}{stats.summary.returnPct}%)
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">Cash Balance</p>
                <p className="text-2xl font-bold">${stats.summary.cashBalance.toFixed(2)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  of ${stats.summary.startingBalance} starting
                </p>
              </CardContent>
            </Card>

            <Card>
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
          </div>

          {/* Secondary stats */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">Open Positions</p>
                <p className="text-2xl font-bold">{stats.summary.openPositions}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  ${stats.summary.openCost.toFixed(2)} at risk
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">Both-Side Setups</p>
                <p className="text-2xl font-bold text-green-400">{stats.summary.bothSidesOpenMarkets}</p>
                <p className="mt-1 text-xs text-muted-foreground">guaranteed wins</p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">EV per Position</p>
                <p className={`text-2xl font-bold ${pnlColor(stats.summary.evPerPosition)}`}>
                  {pnlSign(stats.summary.evPerPosition)}${Math.abs(stats.summary.evPerPosition).toFixed(3)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">Backtest target: +$0.115</p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">Total Positions</p>
                <p className="text-2xl font-bold">{stats.summary.totalPositions}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {stats.summary.resolvedPositions} resolved
                </p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Per-Asset Performance</CardTitle>
              <CardDescription>Resolved P&amp;L per asset · open positions shown separately</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                {/* Header row */}
                {(stats.byAsset ?? []).length > 0 && (
                  <div className="grid grid-cols-[60px_1fr_1fr_120px_120px] items-center gap-3 border-b border-muted/30 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">
                    <span>Asset</span>
                    <span>Positions</span>
                    <span>W / L</span>
                    <span className="text-right">Open</span>
                    <span className="text-right">Resolved P&amp;L</span>
                  </div>
                )}
                {(stats.byAsset ?? []).length === 0 && (
                  <p className="text-sm text-muted-foreground">No positions yet — strategy is monitoring active markets...</p>
                )}
                {(stats.byAsset ?? []).map((a) => (
                  <div key={a.asset} className="grid grid-cols-[60px_1fr_1fr_120px_120px] items-center gap-3 border-b border-muted/30 py-1.5 text-xs">
                    <Badge variant="outline" className="text-xs px-1.5 py-0 w-fit">{a.asset}</Badge>
                    <span className="text-muted-foreground">{a.positions} total</span>
                    <span className="text-muted-foreground">
                      {a.wins}W / {a.losses}L
                      {(a.wins + a.losses) > 0 ? ` (${a.winRate}%)` : ''}
                    </span>
                    <span className="text-right font-mono text-muted-foreground">
                      {a.openCost > 0 ? `$${a.openCost.toFixed(2)}` : '—'}
                    </span>
                    <span className={`text-right font-mono font-bold ${a.wins + a.losses === 0 ? 'text-muted-foreground/40' : pnlColor(a.resolvedPnl)}`}>
                      {a.wins + a.losses === 0
                        ? 'pending'
                        : `${pnlSign(a.resolvedPnl)}$${Math.abs(a.resolvedPnl).toFixed(2)}`}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Top Winning Positions</CardTitle>
              <CardDescription>Biggest payouts from cheap-side buys that hit</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="max-h-60 space-y-1 overflow-y-auto">
                {(stats.topWinners ?? []).length === 0 && (
                  <p className="text-sm text-muted-foreground">No winning positions yet.</p>
                )}
                {(stats.topWinners ?? []).map((w, i) => (
                  <div key={i} className="flex items-center justify-between border-b border-muted/30 py-1.5 text-xs">
                    <div className="min-w-0">
                      <p className="truncate text-muted-foreground">{w.title}</p>
                      <p className="text-[11px] text-muted-foreground/60">→ {w.outcome} · paid ${w.payout.toFixed(2)} on ${w.cost.toFixed(2)}</p>
                    </div>
                    <span className={`shrink-0 ml-3 font-mono font-bold ${pnlColor(w.pnl)}`}>
                      {pnlSign(w.pnl)}${w.pnl.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Recent Positions</CardTitle>
              <CardDescription>Last 50 trigger fires from the strategy</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="max-h-80 space-y-1 overflow-y-auto">
                {(stats.recent ?? []).length === 0 && (
                  <p className="text-sm text-muted-foreground">No positions yet — waiting for prices to dip below threshold...</p>
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
                        <span className="w-20 text-right text-muted-foreground/60">pending</span>
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
