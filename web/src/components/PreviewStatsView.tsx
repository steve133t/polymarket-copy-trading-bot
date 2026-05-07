'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, RefreshCw, Square } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

interface PaperSession {
  active: boolean;
  startingBalance: number;
  startedAt: number;
  copyStrategy: 'FIXED' | 'PERCENTAGE' | 'CAPITAL';
  copySize: number;
  minBuySize: number;
  maxTurnoverMultiple: number;
  slippageEnabled: boolean;
  slippageBps: number;
  lockProfits: boolean;
  excludedWallets: string[];
  trackedWallets: string[];
}

interface MarketEntry {
  slug: string;
  title: string;
  outcome: string;
  buys: number;
  sells: number;
  skippedBuys: number;
  skippedSells: number;
  buyVolume: number;
  sellVolume: number;
  pnl: number;
  openTokens: number;
  marketValue: number;
  settledValue: number;
  unrealizedPnl: number;
  totalPnl: number;
  resolved: boolean;
  pendingResolution: boolean;
  resolutionValue: number | null;
  wallets: {
    trackedAddress: string;
    buys: number;
    sells: number;
    skippedBuys: number;
    skippedSells: number;
    buyVolume: number;
    sellVolume: number;
    pnl: number;
    openTokens: number;
    costBasis: number;
    marketValue: number;
    unrealizedPnl: number;
    totalPnl: number;
  }[];
}

interface PreviewStats {
  session: PaperSession;
  summary: {
    totalTrades: number;
    executedTrades: number;
    skippedTrades: number;
    totalBuys: number;
    totalSells: number;
    totalBuyVolume: number;
    turnoverLimit?: number;
    totalSellVolume: number;
    redeemedValue: number;
    lockedProfit: number;
    realizedPnl: number;
    unrealizedPnl: number;
    openPositionValue: number;
    resolvedPositionValue: number;
    totalPositionValue: number;
    openCostBasis: number;
    resolvedCostBasis: number;
    startingBalance: number;
    cashBalance: number;
    totalEquity: number;
    totalPnl: number;
    returnPct: number;
    profitableMarkets: number;
    losingMarkets: number;
    openMarkets: number;
    dustMarkets?: number;
    dustValue?: number;
    pendingMarkets?: number;
    resolvedMarkets?: number;
    winRate: number;
    estimatedTrades?: number;
  };
  totalMarketsCount?: number;
  walletSummaries: {
    trackedAddress: string;
    buys: number;
    sells: number;
    skippedTrades: number;
    buyVolume: number;
    sellVolume: number;
    realizedPnl: number;
    unrealizedPnl: number;
    totalPnl: number;
    marketValue: number;
    openMarkets: number;
    pendingMarkets: number;
    wins: number;
    losses: number;
    winRate: number;
  }[];
  recentTrades: {
    timestamp: number;
    side: string;
    title: string;
    outcome: string | null;
    price: number;
    rawPrice: number;
    usdcSize: number;
    requestedSize: number;
    slug: string;
    trackedAddress: string;
    executed: boolean;
    skippedReason: string | null;
  }[];
  markets: MarketEntry[];
}

const REFRESH_INTERVAL = 10;

export function PreviewStatsView() {
  const [stats, setStats] = useState<PreviewStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingSession, setSavingSession] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [startingBalance, setStartingBalance] = useState('100');
  const [copyStrategy, setCopyStrategy] = useState<'FIXED' | 'PERCENTAGE' | 'CAPITAL'>('FIXED');
  const [copySize, setCopySize] = useState('1');
  const [minBuySize, setMinBuySize] = useState('1');
  const [maxTurnoverMultiple, setMaxTurnoverMultiple] = useState('0');
  const [slippageEnabled, setSlippageEnabled] = useState(false);
  const [slippagePercent, setSlippagePercent] = useState('0.5');
  const [lockProfits, setLockProfits] = useState(false);
  const [excludedWallets, setExcludedWallets] = useState<string[]>([]);
  const formInitialized = useRef(false);

  const syncSessionForm = useCallback((session: PaperSession) => {
    setStartingBalance(String(session.startingBalance || 100));
    setCopyStrategy(session.copyStrategy || 'FIXED');
    setCopySize(String(session.copySize || 1));
    setMinBuySize(String(session.minBuySize || 1));
    setMaxTurnoverMultiple(String(session.maxTurnoverMultiple || 0));
    setSlippageEnabled(session.slippageEnabled);
    setSlippagePercent(String((session.slippageBps || 0) / 100));
    setLockProfits(Boolean(session.lockProfits));
    setExcludedWallets((session.excludedWallets || []).map(wallet => wallet.toLowerCase()));
  }, []);

  const fetchStats = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/preview-stats');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setStats(data);
      if (data.session && !formInitialized.current) {
        syncSessionForm(data.session);
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
  }, [syncSessionForm]);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(() => fetchStats(true), REFRESH_INTERVAL * 1000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  useEffect(() => {
    const tick = setInterval(() => {
      setCountdown(c => (c <= 1 ? REFRESH_INTERVAL : c - 1));
    }, 1000);
    return () => clearInterval(tick);
  }, []);

  const saveSession = async (action: 'start' | 'update') => {
    setSavingSession(true);
    setError(null);
    try {
      const balance = Number(startingBalance);
      const size = Number(copySize);
      const minimumBuy = Number(minBuySize);
      const maxTurnover = Number(maxTurnoverMultiple);
      const slippage = Number(slippagePercent);
      const res = await fetch('/api/preview-stats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          startingBalance: balance,
          copyStrategy,
          copySize: size,
          minBuySize: minimumBuy,
          maxTurnoverMultiple: maxTurnover,
          slippageEnabled,
          slippageBps: Math.round(slippage * 100),
          lockProfits,
          excludedWallets,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start paper session');
      if (data.session) {
        syncSessionForm(data.session);
      }
      await fetchStats(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSavingSession(false);
    }
  };

  const stopSession = async () => {
    setSavingSession(true);
    setError(null);
    try {
      const res = await fetch('/api/preview-stats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to stop paper session');
      await fetchStats(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSavingSession(false);
    }
  };

  const formatTime = (ts: number) => {
    if (!ts) return 'not started';
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const formatCurrency = (value: number) =>
    `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;

  const formatAddress = (address: string) =>
    address ? `${address.slice(0, 6)}...${address.slice(-4)}` : 'unknown';

  const paperWalletEnabled = (address: string) =>
    !excludedWallets.includes(address.toLowerCase());

  const setPaperWalletEnabled = (address: string, enabled: boolean) => {
    const normalizedAddress = address.toLowerCase();
    setExcludedWallets(current => {
      const next = new Set(current.map(wallet => wallet.toLowerCase()));
      if (enabled) {
        next.delete(normalizedAddress);
      } else {
        next.add(normalizedAddress);
      }
      return Array.from(next);
    });
  };

  const pnlColor = (v: number) => v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-muted-foreground';
  const pnlSign = (v: number) => v > 0 ? '+' : '';
  const sessionActive = stats?.session.active ?? false;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold">Paper Trading Stats</h2>
          <p className="text-sm text-muted-foreground">
            Auto-refreshing every {REFRESH_INTERVAL}s
            {lastUpdated ? <> · Last updated: {lastUpdated.toLocaleTimeString()}</> : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground tabular-nums">
            {loading ? '...' : `${countdown}s`}
          </span>
          <Button variant="outline" size="sm" onClick={() => fetchStats()} disabled={loading}>
            <RefreshCw data-icon="inline-start" />
            {loading ? 'Refreshing' : 'Refresh'}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Paper Account</CardTitle>
          <CardDescription>
            {sessionActive
              ? `Running since ${formatTime(stats?.session.startedAt ?? 0)}. Changes can be applied without restarting.`
              : 'Set a starting balance and copy sizing, then start a clean paper session.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)_auto] md:items-end">
            <Input
              label="Starting Balance"
              type="number"
              min="1"
              step="1"
              value={startingBalance}
              onChange={e => setStartingBalance(e.target.value)}
            />
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Select
                label="Copy Mode"
                value={copyStrategy}
                onValueChange={value => {
                  const nextStrategy = value === 'PERCENTAGE'
                    ? 'PERCENTAGE'
                    : value === 'CAPITAL'
                      ? 'CAPITAL'
                      : 'FIXED';
                  setCopyStrategy(nextStrategy);
                  if (nextStrategy === 'CAPITAL' && Number(copySize) < 100) {
                    setCopySize('1000');
                  }
                }}
                options={[
                  { value: 'FIXED', label: 'Fixed $' },
                  { value: 'PERCENTAGE', label: 'Percent' },
                  { value: 'CAPITAL', label: 'Wallet Scale' },
                ]}
              />
              <Input
                label={
                  copyStrategy === 'PERCENTAGE'
                    ? 'Copy %'
                    : copyStrategy === 'CAPITAL'
                      ? 'Fallback Capital $'
                      : 'Fixed $'
                }
                type="number"
                min="0.01"
                step={copyStrategy === 'PERCENTAGE' ? '1' : copyStrategy === 'CAPITAL' ? '100' : '0.01'}
                value={copySize}
                onChange={e => setCopySize(e.target.value)}
              />
              <Input
                label="Min Buy $"
                type="number"
                min="1"
                step="0.01"
                value={minBuySize}
                disabled={copyStrategy === 'FIXED'}
                onChange={e => setMinBuySize(e.target.value)}
              />
              <Input
                label="Max Turnover x"
                type="number"
                min="0"
                step="0.25"
                value={maxTurnoverMultiple}
                onChange={e => setMaxTurnoverMultiple(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-3">
              <Switch
                checked={lockProfits}
                onCheckedChange={setLockProfits}
                label="Lock Profits"
                description="Sweeps cash above the starting balance into the lockbox."
              />
              <Switch
                checked={slippageEnabled}
                onCheckedChange={setSlippageEnabled}
                label="Apply Slippage"
                description="Worsens buys and sells by the percent below."
              />
              <Input
                label="Slippage %"
                type="number"
                min="0"
                max="50"
                step="0.1"
                value={slippagePercent}
                disabled={!slippageEnabled}
                onChange={e => setSlippagePercent(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              {sessionActive ? (
                <Button variant="secondary" onClick={() => saveSession('update')} disabled={savingSession}>
                  Apply
                </Button>
              ) : null}
              <Button onClick={() => saveSession('start')} disabled={savingSession}>
                <Play data-icon="inline-start" />
                {sessionActive ? 'Reset' : 'Start'}
              </Button>
              {sessionActive ? (
                <Button variant="outline" onClick={stopSession} disabled={savingSession}>
                  <Square data-icon="inline-start" />
                  Stop
                </Button>
              ) : null}
            </div>
          </div>
          {(stats?.session.trackedWallets?.length ?? 0) > 0 ? (
            <div className="mt-4 border-t border-muted/30 pt-4">
              <p className="mb-2 text-xs font-medium text-muted-foreground">Paper Wallets</p>
              <div className="grid gap-2 md:grid-cols-2">
                {(stats?.session.trackedWallets ?? []).map(address => (
                  <div key={address} className="flex items-center justify-between rounded-md border border-muted/40 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs">{formatAddress(address)}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {paperWalletEnabled(address) ? 'Included in paper trading' : 'Excluded from paper trading'}
                      </p>
                    </div>
                    <Switch
                      checked={paperWalletEnabled(address)}
                      onCheckedChange={checked => setPaperWalletEnabled(address, checked)}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {error ? (
        <Card className="border-red-500/30 bg-red-500/5">
          <CardContent className="pt-4 text-sm text-red-400">{error}</CardContent>
        </Card>
      ) : null}

      {stats ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card className={stats.summary.totalPnl >= 0 ? 'border-green-500/30' : 'border-red-500/30'}>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">Total Equity</p>
                <p className={`text-2xl font-bold ${pnlColor(stats.summary.totalPnl)}`}>
                  {formatCurrency(stats.summary.totalEquity)}
                </p>
                <p className={`mt-1 text-xs ${pnlColor(stats.summary.totalPnl)}`}>
                  {pnlSign(stats.summary.totalPnl)}${Math.abs(stats.summary.totalPnl).toFixed(2)} total P&amp;L
                  <span className="text-muted-foreground"> ({pnlSign(stats.summary.totalPnl)}{stats.summary.returnPct.toFixed(2)}%)</span>
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">Total Cash</p>
                <p className="text-2xl font-bold">
                  {formatCurrency(stats.summary.cashBalance + stats.summary.lockedProfit)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatCurrency(stats.summary.cashBalance)} active
                  {stats.summary.lockedProfit > 0 ? ` / ${formatCurrency(stats.summary.lockedProfit)} locked` : ''}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">Position Value</p>
                <p className="text-2xl font-bold">{formatCurrency(stats.summary.totalPositionValue)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatCurrency(stats.summary.openPositionValue)} open
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">Realized Paper P&amp;L</p>
                <p className={`text-2xl font-bold ${pnlColor(stats.summary.realizedPnl)}`}>
                  {pnlSign(stats.summary.realizedPnl)}${Math.abs(stats.summary.realizedPnl).toFixed(2)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  net closed P&amp;L
                  {stats.summary.redeemedValue > 0 ? ` / ${formatCurrency(stats.summary.redeemedValue)} gross redeemed` : ''}
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">Cumulative Buys</p>
                <p className="text-xl font-bold text-red-400">${stats.summary.totalBuyVolume.toFixed(2)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {stats.summary.totalBuys} filled
                  {stats.summary.turnoverLimit ? ` / ${formatCurrency(stats.summary.turnoverLimit)} cap` : ''}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">Cumulative Sells</p>
                <p className="text-xl font-bold text-green-400">${stats.summary.totalSellVolume.toFixed(2)}</p>
                <p className="mt-1 text-xs text-muted-foreground">{stats.summary.totalSells} filled</p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">Market Win Rate</p>
                <p className={`text-xl font-bold ${stats.summary.winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                  {stats.summary.winRate}%
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {stats.summary.profitableMarkets}W / {stats.summary.losingMarkets}L
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">Skipped</p>
                <p className="text-xl font-bold">{stats.summary.skippedTrades}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {stats.summary.executedTrades} executed / {stats.summary.totalTrades} seen
                </p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Per-Wallet Paper P&amp;L</CardTitle>
              <CardDescription>Attribution by tracked wallet in this active session</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex max-h-52 flex-col gap-1 overflow-y-auto">
                {(stats.walletSummaries?.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">No wallet attribution yet.</p>
                ) : null}
                {(stats.walletSummaries ?? []).map(wallet => (
                  <div key={wallet.trackedAddress} className="grid grid-cols-[minmax(120px,1fr)_repeat(6,max-content)] items-center gap-4 border-b border-muted/30 py-1.5 text-xs">
                    <span className="font-mono text-muted-foreground">{formatAddress(wallet.trackedAddress)}</span>
                    <span className={`w-20 text-right font-mono font-bold ${pnlColor(wallet.totalPnl)}`}>
                      {pnlSign(wallet.totalPnl)}${Math.abs(wallet.totalPnl).toFixed(2)}
                    </span>
                    <span className="w-20 text-right font-mono text-muted-foreground">{wallet.winRate}%</span>
                    <span className="w-20 text-right font-mono text-muted-foreground">{wallet.wins}W / {wallet.losses}L</span>
                    <span className="w-24 text-right font-mono text-muted-foreground">${wallet.buyVolume.toFixed(2)} buys</span>
                    <span className="w-24 text-right font-mono text-muted-foreground">{wallet.skippedTrades} skip</span>
                    <a
                      href={`https://polymarket.com/profile/${wallet.trackedAddress}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded border border-muted/50 px-2 py-0.5 text-xs text-muted-foreground transition hover:border-primary hover:text-primary"
                      title="View wallet on Polymarket"
                    >
                      View ↗
                    </a>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Per-Market P&amp;L</CardTitle>
              <CardDescription>
                Sorted by total market impact
                {stats.summary.estimatedTrades ? ` · ${stats.summary.estimatedTrades} older trades estimated` : ''}
                {(() => {
                  const totalCount = (stats as unknown as { totalMarketsCount?: number }).totalMarketsCount;
                  const shown = stats.markets?.length ?? 0;
                  if (totalCount && totalCount > shown) {
                    return ` · showing top ${shown} of ${totalCount}`;
                  }
                  return '';
                })()}
                {(stats.summary.dustMarkets ?? 0) > 0 ? (
                  <> · {stats.summary.dustMarkets} dust positions hidden (&lt;$1, totaling ${(stats.summary.dustValue ?? 0).toFixed(2)})</>
                ) : null}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
                {(stats.markets?.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {sessionActive ? 'No paper trades have been seen since this session started.' : 'Start a paper session to begin tracking.'}
                  </p>
                ) : null}
                {(stats.markets ?? []).map((m, i) => {
                  const isOpen = m.openTokens > 0;
                  const skipped = m.skippedBuys + m.skippedSells;
                  const walletCount = m.wallets?.length ?? 0;
                  const valueLabel = m.resolved ? 'redeemed' : m.pendingResolution ? 'pending' : 'open';
                  const displayValue = m.resolved ? m.settledValue : m.marketValue;
                  return (
                    <div key={`${m.slug}-${m.outcome}-${i}`} className="flex items-center justify-between gap-3 border-b border-muted/30 py-1.5 text-xs">
                      <div className="flex min-w-0 flex-col gap-1">
                        <div className="flex min-w-0 items-center gap-2">
                          {isOpen ? (
                            <Badge
                              variant={m.resolved ? 'secondary' : 'outline'}
                              className={`shrink-0 px-1 py-0 text-xs ${
                                m.pendingResolution
                                  ? 'border-emerald-400 bg-emerald-200 text-emerald-950'
                                  : ''
                              }`}
                            >
                              {m.resolved ? 'RESOLVED' : m.pendingResolution ? 'PENDING' : 'OPEN'}
                            </Badge>
                          ) : m.pnl >= 0 ? (
                            <Badge className="shrink-0 bg-green-600 px-1 py-0 text-xs">WIN</Badge>
                          ) : (
                            <Badge variant="destructive" className="shrink-0 px-1 py-0 text-xs">LOSS</Badge>
                          )}
                          <span className="truncate text-muted-foreground">{m.title}</span>
                          {m.outcome ? <span className="shrink-0 text-muted-foreground/60">-&gt; {m.outcome}</span> : null}
                          {walletCount > 1 ? (
                            <Badge variant="outline" className="px-1 py-0 text-xs">{walletCount} wallets</Badge>
                          ) : null}
                        </div>
                        {walletCount > 1 ? (
                          <div className="flex flex-wrap gap-x-3 gap-y-1 pl-10 text-[11px] text-muted-foreground/70">
                            {m.wallets.map(wallet => (
                              <span key={wallet.trackedAddress}>
                                {formatAddress(wallet.trackedAddress)} {formatCurrency(wallet.buyVolume)} in
                                {' / '}
                                <span className={pnlColor(wallet.totalPnl)}>
                                  {pnlSign(wallet.totalPnl)}${Math.abs(wallet.totalPnl).toFixed(2)}
                                </span>
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <div className="ml-2 flex shrink-0 items-center gap-4">
                        <span className="font-mono text-[11px] text-muted-foreground">${m.buyVolume.toFixed(2)} in</span>
                        <span className="font-mono text-[11px] text-muted-foreground">${m.sellVolume.toFixed(2)} out</span>
                        <span className="w-24 text-right font-mono text-[11px] text-muted-foreground">
                          ${displayValue.toFixed(2)} {valueLabel}
                        </span>
                        <span className={`w-24 text-right font-mono font-bold ${pnlColor(m.totalPnl)}`}>
                          {pnlSign(m.totalPnl)}${Math.abs(m.totalPnl).toFixed(2)}
                        </span>
                        {skipped > 0 ? (
                          <Badge variant="outline" className="px-1 py-0 text-xs">{skipped} skip</Badge>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Recent Paper Trades</CardTitle>
              <CardDescription>Last 50 trades detected in the active session</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                {stats.recentTrades.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {sessionActive ? 'No trades detected yet.' : 'Paper trading is stopped.'}
                  </p>
                ) : null}
                {stats.recentTrades.map((t, i) => (
                  <div key={`${t.timestamp}-${i}`} className="flex items-center justify-between gap-3 border-b border-muted/30 py-1.5 text-xs">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge variant={t.executed ? (t.side === 'BUY' ? 'default' : 'outline') : 'secondary'} className="px-1 py-0 text-xs">
                        {t.executed ? t.side : 'SKIP'}
                      </Badge>
                      <span className="max-w-[220px] truncate text-muted-foreground">
                        {t.title || t.slug || 'Unknown market'}
                      </span>
                      {t.outcome ? <span className="text-muted-foreground">-&gt; {t.outcome}</span> : null}
                      <span className="text-muted-foreground/60">{formatAddress(t.trackedAddress)}</span>
                      {t.skippedReason ? <span className="text-muted-foreground/70">({t.skippedReason})</span> : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="font-mono">
                        ${t.usdcSize.toFixed(2)} @ {t.price.toFixed(2)}
                      </span>
                      <span className="text-muted-foreground">{formatTime(t.timestamp)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
