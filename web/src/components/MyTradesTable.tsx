'use client';

import { Fragment, useState } from 'react';
import { TraderCopyStats, CopyTrade } from '@/types/myTrades';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface MyTradesTableProps {
  byTrader: TraderCopyStats[];
}

type SortKey = 'traderLabel' | 'pnl' | 'roi' | 'tradeCount' | 'totalBought';
type SortDir = 'asc' | 'desc';

export function MyTradesTable({ byTrader }: MyTradesTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('tradeCount');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [expandedTrader, setExpandedTrader] = useState<string | null>(null);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sortedTraders = [...byTrader].sort((a, b) => {
    let aVal: number | string;
    let bVal: number | string;

    switch (sortKey) {
      case 'traderLabel':
        aVal = a.traderLabel.toLowerCase();
        bVal = b.traderLabel.toLowerCase();
        break;
      case 'pnl':
        aVal = a.pnl;
        bVal = b.pnl;
        break;
      case 'roi':
        aVal = a.roi;
        bVal = b.roi;
        break;
      case 'tradeCount':
        aVal = a.tradeCount;
        bVal = b.tradeCount;
        break;
      case 'totalBought':
        aVal = a.totalBought;
        bVal = b.totalBought;
        break;
      default:
        return 0;
    }

    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }

    return sortDir === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
  });

  const SortButton = ({ label, sortKeyName, title }: { label: string; sortKeyName: SortKey; title?: string }) => (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => handleSort(sortKeyName)}
      className="h-auto p-0 hover:bg-transparent font-semibold"
      title={title}
    >
      {label}
      {sortKey === sortKeyName && (
        <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>
      )}
    </Button>
  );

  const formatCurrency = (value: number) => {
    const formatted = Math.abs(value).toFixed(2);
    return value >= 0 ? `$${formatted}` : `-$${formatted}`;
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>My Copy Trades by Trader</CardTitle>
        <CardDescription>
          Your trades on your wallet, grouped by which tracked trader triggered them. Click a row to
          see individual trades. Traders with no match appear under "Unmatched Trades".
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Cash flow disclaimer */}
        <p className="text-xs text-muted-foreground mb-3 p-2 bg-muted/40 rounded">
          💡 <strong>Net Flow</strong> = total USDC received from sells minus total USDC spent on
          buys. This is <em>not</em> your realized P&amp;L — open positions still hold value.
          See the P&amp;L cards above for real position data.
        </p>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <SortButton label="Trader" sortKeyName="traderLabel" title="Tracked trader whose trades you copied" />
              </TableHead>
              <TableHead className="text-right">
                <SortButton label="Trades" sortKeyName="tradeCount" title="Number of trades copied from this trader" />
              </TableHead>
              <TableHead className="text-right" title="Total USDC spent buying positions">
                <SortButton label="Spent" sortKeyName="totalBought" title="Total USDC you spent buying" />
              </TableHead>
              <TableHead className="text-right" title="Total USDC received from selling positions">
                Received
              </TableHead>
              <TableHead className="text-right">
                <SortButton
                  label="Net Flow"
                  sortKeyName="pnl"
                  title="Received minus Spent. Positive = more sold than bought so far."
                />
              </TableHead>
              <TableHead className="text-right">
                <SortButton
                  label="Cash ROI"
                  sortKeyName="roi"
                  title="Net Flow ÷ Spent. Based on cash flow only — doesn't include open position value."
                />
              </TableHead>
              <TableHead className="text-right" title="Average size per trade">
                Avg Size
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedTraders.map((trader) => (
              <Fragment key={trader.traderAddress}>
                <TableRow
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() =>
                    setExpandedTrader(
                      expandedTrader === trader.traderAddress ? null : trader.traderAddress
                    )
                  }
                >
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground text-xs">
                        {expandedTrader === trader.traderAddress ? '▼' : '▶'}
                      </span>
                      <div>
                        <div>{trader.traderLabel}</div>
                        {trader.traderAddress !== 'unmatched' && (
                          <div className="text-xs text-muted-foreground font-mono">
                            {trader.traderAddress.slice(0, 8)}...
                          </div>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {trader.tradeCount}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatCurrency(trader.totalBought)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatCurrency(trader.totalSold)}
                  </TableCell>
                  <TableCell
                    className={`text-right font-mono ${
                      trader.pnl >= 0 ? 'text-green-500' : 'text-red-500'
                    }`}
                  >
                    {trader.pnl >= 0 ? '+' : ''}{formatCurrency(trader.pnl)}
                  </TableCell>
                  <TableCell
                    className={`text-right font-mono ${
                      trader.roi >= 0 ? 'text-green-500' : 'text-red-500'
                    }`}
                  >
                    {trader.roi >= 0 ? '+' : ''}{trader.roi.toFixed(1)}%
                  </TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {trader.tradeCount > 0
                      ? formatCurrency(trader.totalBought / trader.tradeCount)
                      : '-'}
                  </TableCell>
                </TableRow>

                {expandedTrader === trader.traderAddress && (
                  <TableRow>
                    <TableCell colSpan={7} className="bg-muted/30 p-4">
                      <TradesList
                        trades={trader.trades}
                        formatCurrency={formatCurrency}
                        formatTime={formatTime}
                      />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function CopyLagBadge({ seconds }: { seconds: number | null }) {
  if (seconds === null) return <span className="text-muted-foreground">—</span>;

  const label = seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;

  const color =
    seconds <= 10
      ? 'text-green-500'
      : seconds <= 60
      ? 'text-yellow-500'
      : 'text-red-400';

  return (
    <span className={`font-mono ${color}`} title={`${seconds} seconds after the tracked trader's trade`}>
      {label}
    </span>
  );
}

function TradesList({
  trades,
  formatCurrency,
  formatTime,
}: {
  trades: CopyTrade[];
  formatCurrency: (v: number) => string;
  formatTime: (t: number) => string;
}) {
  const sortedTrades = [...trades].sort((a, b) => b.timestamp - a.timestamp);

  if (trades.length === 0) {
    return <p className="text-muted-foreground text-sm">No trades in this period.</p>;
  }

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-2">
        <strong>Copy lag</strong> = how many seconds after the tracked trader's trade that your copy
        executed. Green ≤ 10s · Yellow ≤ 60s · Red &gt; 60s.
      </p>
      <div className="max-h-80 overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Side</TableHead>
              <TableHead>Market</TableHead>
              <TableHead className="text-right" title="How much USDC you put in (buy) or received (sell)">
                Your Size
              </TableHead>
              <TableHead className="text-right" title="Token price at time of trade — also the implied probability (e.g. $0.72 = 72% chance)">
                Entry Price
              </TableHead>
              <TableHead className="text-right" title="Seconds between the trader's trade and your copy">
                Copy Lag
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedTrades.slice(0, 50).map((trade, idx) => (
              <TableRow
                key={`${trade.timestamp}-${trade.conditionId}-${trade.asset}-${trade.side}-${idx}`}
                className="text-sm"
              >
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {formatTime(trade.timestamp)}
                </TableCell>
                <TableCell>
                  <span className={trade.side === 'BUY' ? 'text-green-500 font-medium' : 'text-red-500 font-medium'}>
                    {trade.side}
                  </span>
                </TableCell>
                <TableCell className="max-w-xs">
                  <span className="truncate block" title={trade.title}>
                    {trade.title.length > 40 ? trade.title.slice(0, 37) + '…' : trade.title}
                  </span>
                  <span className="text-xs text-muted-foreground">{trade.outcome}</span>
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatCurrency(trade.usdcSize)}
                </TableCell>
                <TableCell className="text-right font-mono text-muted-foreground" title="Token price = implied probability">
                  ${trade.price.toFixed(3)}
                </TableCell>
                <TableCell className="text-right">
                  <CopyLagBadge seconds={trade.timeDiff} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {trades.length > 50 && (
          <p className="text-xs text-muted-foreground mt-2 pl-1">
            Showing 50 of {trades.length} trades
          </p>
        )}
      </div>
    </div>
  );
}
