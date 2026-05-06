'use client';

import { useEffect, useState } from 'react';
import { TraderAnalysis } from '@/types/trader';
import { PnLBarChart } from '@/components/charts/PnLBarChart';
import { ROIBarChart } from '@/components/charts/ROIBarChart';
import { MonthlyLineChart } from '@/components/charts/MonthlyLineChart';
import { VolumeLineChart } from '@/components/charts/VolumeLineChart';
import { DailyLineChart } from '@/components/charts/DailyLineChart';
import { WinRateGauge } from '@/components/charts/WinRateGauge';
import { ProfitLossDonut } from '@/components/charts/ProfitLossDonut';
import { VolumeSparkline } from '@/components/charts/VolumeSparkline';
import { TrendArrow } from '@/components/charts/TrendArrow';
import { RiskScoreMeter } from '@/components/charts/RiskScoreMeter';
import { ActivePositionsPie } from '@/components/charts/ActivePositionsPie';
import { TradersTable } from '@/components/TradersTable';
import { MyTradesView } from '@/components/MyTradesView';
import { SettingsView } from '@/components/SettingsView';
import { PreviewStatsView } from '@/components/PreviewStatsView';
import { StatusBar } from '@/components/StatusBar';
import { Button } from '@/components/ui/button';
import { TimeRangeFilter, TimeRange } from '@/components/TimeRangeFilter';
import BotOfflineAlert from '@/components/BotOfflineAlert';
import { useBotStatus } from '@/hooks/useBotStatus';

type ViewMode = 'traders' | 'my-trades' | 'paper' | 'settings';

export default function Home() {
  const [viewMode, setViewMode] = useState<ViewMode>('traders');
  const [traders, setTraders] = useState<TraderAnalysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>('30d');
  const [countdown, setCountdown] = useState(30);
  const botStatus = useBotStatus();

  const REFRESH_INTERVAL = 30;

  const fetchTraders = async (refresh = false) => {
    try {
      if (refresh) {
        setRefreshing(true);
      }
      const url = refresh ? '/api/traders?refresh=true' : '/api/traders';
      const res = await fetch(url);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to fetch traders');
      }

      setTraders(data.traders);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchTraders();
  }, []);

  // Auto-refresh every 30 seconds with countdown
  useEffect(() => {
    let count = REFRESH_INTERVAL;
    const tick = setInterval(() => {
      count -= 1;
      setCountdown(count);
      if (count <= 0) {
        fetchTraders();
        count = REFRESH_INTERVAL;
        setCountdown(REFRESH_INTERVAL);
      }
    }, 1000);
    return () => clearInterval(tick);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show loading only for traders view initial load
  if (loading && viewMode === 'traders') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
          <p className="mt-4 text-muted-foreground">Loading trader data...</p>
        </div>
      </div>
    );
  }

  // Show error only for traders view
  if (error && viewMode === 'traders') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center max-w-md">
          <h2 className="text-xl font-semibold text-red-500 mb-2">Error</h2>
          <p className="text-muted-foreground mb-4">{error}</p>
          <p className="text-sm text-muted-foreground mb-4">
            Make sure to run <code className="bg-muted px-2 py-1 rounded">npm run analyze</code> first
            to generate trader reports.
          </p>
          <div className="flex gap-2 justify-center">
            <Button onClick={() => fetchTraders()}>Retry</Button>
            <Button variant="outline" onClick={() => setViewMode('settings')}>
              Go to Settings
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const getSubtitle = () => {
    switch (viewMode) {
      case 'traders':
        return (
          <>
            Tracking {traders.length} wallets · Last analyzed:{' '}
            {traders[0]?.analysisDate?.split('T')[0] || 'N/A'}
          </>
        );
      case 'my-trades':
        return <>My Copy Trading Performance</>;
      case 'paper':
        return <>Paper trading — trades detected but not executed</>;
      case 'settings':
        return <>Configure bot settings and execute actions</>;
    }
  };

  const navItems: { id: ViewMode; label: string }[] = [
    { id: 'traders', label: 'Traders' },
    { id: 'my-trades', label: 'My Trades' },
    { id: 'paper', label: 'Paper' },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <div className="min-h-screen bg-background dark">
      <BotOfflineAlert />
      {/* Sticky top nav — Polymarket-style */}
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur border-b border-border">
        <div className="container mx-auto px-4 md:px-8 flex items-center justify-between h-14">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm tracking-tight text-foreground">
              Polymarket Bot
            </span>
            {botStatus !== null && (
              <span
                className={`flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full border ${
                  botStatus
                    ? 'text-green-400 border-green-500/30 bg-green-500/10'
                    : 'text-red-400 border-red-500/30 bg-red-500/10'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${botStatus ? 'bg-green-400' : 'bg-red-400'}`} />
                {botStatus ? 'Bot live' : 'Bot offline'}
              </span>
            )}
          </div>
          <nav className="flex items-center">
            {navItems.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setViewMode(id)}
                className={`relative h-14 px-4 text-sm font-medium transition-colors ${
                  viewMode === id
                    ? 'text-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-primary after:rounded-t'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <div className="container mx-auto px-4 md:px-8 py-8">

        {viewMode === 'traders' && (
          <>
            {/* Status Bar with Time Range Filter */}
            <div className="mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <StatusBar
              lastUpdated={traders[0]?.analysisDate}
              totalItems={traders.length}
              itemLabel="tracked wallets"
              refreshing={refreshing}
              onRefresh={() => { fetchTraders(true); setCountdown(REFRESH_INTERVAL); }}
              countdown={countdown}
            />
              {error ? (
                <p className="text-sm text-red-400">{error}</p>
              ) : null}
              <TimeRangeFilter value={timeRange} onChange={setTimeRange} />
            </div>

            {/* Hero Section - Bento Grid */}
            <div className="grid grid-cols-12 gap-3 mb-6" style={{ minHeight: '320px' }}>
              {/* P&L Chart - Left */}
              <div className="col-span-12 lg:col-span-4">
                <PnLBarChart traders={traders} compact timeRange={timeRange} />
              </div>

              {/* Center Column - 2x2 Grid of small widgets */}
              <div className="col-span-12 lg:col-span-4 grid grid-cols-2 gap-3">
                <WinRateGauge traders={traders} timeRange={timeRange} />
                <ProfitLossDonut traders={traders} timeRange={timeRange} />
                <VolumeSparkline traders={traders} timeRange={timeRange} />
                <TrendArrow traders={traders} timeRange={timeRange} />
              </div>

              {/* ROI Chart - Right */}
              <div className="col-span-12 lg:col-span-4">
                <ROIBarChart traders={traders} compact timeRange={timeRange} />
              </div>
            </div>

            {/* Second Row - Time Series Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
              <DailyLineChart traders={traders} compact timeRange={timeRange} />
              <MonthlyLineChart traders={traders} compact timeRange={timeRange} />
            </div>

            {/* Third Row - Additional Metrics + Table Preview */}
            <div className="grid grid-cols-12 gap-4 mb-6">
              <div className="col-span-6 lg:col-span-2">
                <RiskScoreMeter traders={traders} timeRange={timeRange} />
              </div>
              <div className="col-span-6 lg:col-span-2">
                <ActivePositionsPie traders={traders} timeRange={timeRange} />
              </div>
              <div className="col-span-12 lg:col-span-8">
                <VolumeLineChart traders={traders} compact timeRange={timeRange} />
              </div>
            </div>

            {/* Table */}
            <TradersTable traders={traders} />
          </>
        )}

        {viewMode === 'my-trades' && <MyTradesView />}

        {viewMode === 'paper' && <PreviewStatsView />}

        {viewMode === 'settings' && <SettingsView />}
      </div>
    </div>
  );
}
