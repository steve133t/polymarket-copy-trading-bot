import { NextResponse } from 'next/server';
import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI!;
let client: MongoClient | null = null;

async function getDb() {
  if (!client) {
    client = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    await client.connect();
  }
  return client.db();
}

export async function GET() {
  try {
    const db = await getDb();
    const col = db.collection('dual_threshold_positions');

    const all = await col.find({}).sort({ entryTimestamp: -1 }).toArray();

    const open = all.filter((p) => !p.resolved);
    const resolved = all.filter((p) => p.resolved);
    const wins = resolved.filter((p) => (p.pnl || 0) > 0);
    const losses = resolved.filter((p) => (p.pnl || 0) < 0);

    const totalCost = all.reduce((s, p) => s + (Number(p.costUSD) || 0), 0);
    const realizedPnl = resolved.reduce((s, p) => s + (Number(p.pnl) || 0), 0);
    const totalPayout = resolved.reduce((s, p) => s + (Number(p.payoutUSD) || 0), 0);
    const openCost = open.reduce((s, p) => s + (Number(p.costUSD) || 0), 0);

    // Group open positions by market (conditionId) — show "both sides caught" jackpot setups
    const openByMarket: Record<string, any[]> = {};
    for (const p of open) {
      const key = String(p.conditionId);
      if (!openByMarket[key]) openByMarket[key] = [];
      openByMarket[key].push(p);
    }
    const bothSidesOpen = Object.values(openByMarket).filter((g) => g.length >= 2).length;

    // Per-asset breakdown
    const byAsset: Record<string, { positions: number; resolvedPnl: number; wins: number; losses: number; openCost: number }> = {};
    for (const p of all) {
      const asset = String(p.asset || 'unknown');
      if (!byAsset[asset]) byAsset[asset] = { positions: 0, resolvedPnl: 0, wins: 0, losses: 0, openCost: 0 };
      byAsset[asset].positions++;
      if (p.resolved) {
        byAsset[asset].resolvedPnl += Number(p.pnl) || 0;
        if ((p.pnl || 0) > 0) byAsset[asset].wins++;
        else if ((p.pnl || 0) < 0) byAsset[asset].losses++;
      } else {
        byAsset[asset].openCost += Number(p.costUSD) || 0;
      }
    }

    // Recent positions (50)
    const recent = all.slice(0, 50).map((p) => ({
      conditionId: p.conditionId,
      slug: p.slug,
      title: p.title,
      asset: p.asset,
      window: p.window,
      outcome: p.outcome,
      triggerPrice: Number(p.triggerPrice) || 0,
      fillPrice: Number(p.fillPrice) || 0,
      tokens: Number(p.tokens) || 0,
      costUSD: Number(p.costUSD) || 0,
      entryTimestamp: Number(p.entryTimestamp) || 0,
      resolved: Boolean(p.resolved),
      payoutUSD: Number(p.payoutUSD) || 0,
      pnl: Number(p.pnl) || 0,
    }));

    // Top winners and losers (by P&L)
    const topWinners = resolved
      .slice()
      .sort((a, b) => (Number(b.pnl) || 0) - (Number(a.pnl) || 0))
      .slice(0, 10)
      .map((p) => ({
        title: p.title,
        outcome: p.outcome,
        cost: Number(p.costUSD) || 0,
        payout: Number(p.payoutUSD) || 0,
        pnl: Number(p.pnl) || 0,
        slug: p.slug,
      }));

    return NextResponse.json({
      summary: {
        totalPositions: all.length,
        openPositions: open.length,
        resolvedPositions: resolved.length,
        bothSidesOpenMarkets: bothSidesOpen,
        wins: wins.length,
        losses: losses.length,
        winRate: wins.length + losses.length > 0
          ? Number(((wins.length / (wins.length + losses.length)) * 100).toFixed(1))
          : 0,
        totalCost: Number(totalCost.toFixed(2)),
        openCost: Number(openCost.toFixed(2)),
        totalPayout: Number(totalPayout.toFixed(2)),
        realizedPnl: Number(realizedPnl.toFixed(2)),
        roi: totalCost > 0 ? Number(((realizedPnl / totalCost) * 100).toFixed(1)) : 0,
        evPerPosition: resolved.length > 0
          ? Number((realizedPnl / resolved.length).toFixed(3))
          : 0,
      },
      byAsset: Object.entries(byAsset).map(([asset, data]) => ({
        asset,
        positions: data.positions,
        resolvedPnl: Number(data.resolvedPnl.toFixed(2)),
        wins: data.wins,
        losses: data.losses,
        winRate: data.wins + data.losses > 0
          ? Number(((data.wins / (data.wins + data.losses)) * 100).toFixed(1))
          : 0,
        openCost: Number(data.openCost.toFixed(2)),
      })),
      recent,
      topWinners,
    });
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to fetch dual-threshold stats: ${error instanceof Error ? error.message : error}` },
      { status: 500 }
    );
  }
}
