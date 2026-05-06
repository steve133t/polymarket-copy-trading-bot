'use client';

import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { TraderAnalysis } from '@/types/trader';
import { TimeRange } from '@/components/TimeRangeFilter';

interface ActivePositionsPieProps {
  traders: TraderAnalysis[];
  timeRange?: TimeRange;
}

export function ActivePositionsPie({ traders }: ActivePositionsPieProps) {
  const tracked = traders.filter(t => !t.label.includes('My Wallet') && !t.label.includes('МОЙ'));
  const totalWins = tracked.reduce((sum, t) => sum + t.positions.winners, 0);
  const totalLosses = tracked.reduce((sum, t) => sum + t.positions.losers, 0);

  // For the pie, show wins vs losses ratio
  const data = [
    { name: 'Wins', value: totalWins, color: '#22c55e' },
    { name: 'Losses', value: totalLosses, color: '#ef4444' },
  ].filter((d) => d.value > 0);

  const total = totalWins + totalLosses;
  const winRate = total > 0 ? Math.round((totalWins / total) * 100) : null;

  return (
    <div className="bg-card rounded-xl border p-4 flex flex-col items-center justify-center h-full">
      <span className="text-sm font-medium mb-0.5">Trader Win Rate</span>
      <span className="text-xs text-muted-foreground mb-2">Resolved positions — tracked traders</span>
      {total === 0 ? (
        <span className="text-xs text-muted-foreground">No resolved positions</span>
      ) : (
        <div className="flex items-center gap-4">
          {/* Mini pie */}
          <div className="relative" style={{ width: 70, height: 70 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  cx="50%"
                  cy="50%"
                  innerRadius={20}
                  outerRadius={32}
                  paddingAngle={data.length > 1 ? 2 : 0}
                  dataKey="value"
                  isAnimationActive={false}
                >
                  {data.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} stroke="none" />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            {/* Center: win rate % */}
            <div className="absolute inset-0 flex items-center justify-center">
              <span className={`text-xs font-bold font-mono ${winRate === 0 ? 'text-red-400' : 'text-green-400'}`}>
                {winRate}%
              </span>
            </div>
          </div>

          {/* Stats */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500"></span>
              <span className="text-xs text-muted-foreground">Wins</span>
              <span className="text-sm font-bold font-mono text-green-500">{totalWins}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500"></span>
              <span className="text-xs text-muted-foreground">Losses</span>
              <span className="text-sm font-bold font-mono text-red-500">{totalLosses}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
