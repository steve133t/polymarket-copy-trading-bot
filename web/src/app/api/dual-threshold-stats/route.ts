import { NextResponse } from 'next/server';
import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI!;
const SESSION_ID = 'default';

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

const DEFAULT_SESSION = {
  _id: SESSION_ID,
  strategyMode: 'dual_threshold',
  active: true,
  startingBalance: 100,
  // dual_threshold params
  threshold: 0.10,
  perBuyUSD: 1.0,
  slippageBps: 2000,
  enabledAssets: ['BTC', 'ETH', 'SOL'],
  enabledWindows: ['15m'],
  // momentum_hedge params (backtest: 64% accuracy, +8.5% ROI)
  momentumWindowSec: 300,
  momentumThresholdPct: 0.10,
  bigBetUSD: 1.5,
  smallBetUSD: 0.5,
  startedAt: 0,
};

export async function GET() {
  try {
    const db = await getDb();
    const positionsCol = db.collection('dual_threshold_positions');
    const sessionsCol = db.collection('dual_threshold_sessions');

    // Use type assertion since we use string _id (custom convention)
    const sessionsAny = sessionsCol as unknown as {
      findOne: (filter: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      insertOne: (doc: Record<string, unknown>) => Promise<unknown>;
      updateOne: (filter: Record<string, unknown>, update: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>;
      replaceOne: (filter: Record<string, unknown>, doc: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>;
      deleteMany: (filter: Record<string, unknown>) => Promise<unknown>;
    };

    let session = await sessionsAny.findOne({ _id: SESSION_ID });
    if (!session) {
      session = { ...DEFAULT_SESSION, startedAt: Math.floor(Date.now() / 1000) };
      await sessionsAny.insertOne(session);
    }

    const all = await positionsCol.find({}).sort({ entryTimestamp: -1 }).toArray();
    const open = all.filter((p) => !p.resolved);
    const resolved = all.filter((p) => p.resolved);
    const wins = resolved.filter((p) => (p.pnl || 0) > 0);
    const losses = resolved.filter((p) => (p.pnl || 0) < 0);

    const totalCost = all.reduce((s, p) => s + (Number(p.costUSD) || 0), 0);
    const realizedPnl = resolved.reduce((s, p) => s + (Number(p.pnl) || 0), 0);
    const totalPayout = resolved.reduce((s, p) => s + (Number(p.payoutUSD) || 0), 0);
    const openCost = open.reduce((s, p) => s + (Number(p.costUSD) || 0), 0);

    // Mark open positions to market — value held tokens at last fill price
    // (no real-time price feed yet, so use entry price as proxy for marketValue)
    const openMarketValue = open.reduce(
      (s, p) => s + (Number(p.tokens) || 0) * (Number(p.fillPrice) || 0),
      0
    );

    // Cash = startingBalance - sum(open costs) - sum(losing closed costs) + sum(winning closed payouts)
    const cashBalance =
      Number(session.startingBalance) -
      open.reduce((s, p) => s + (Number(p.costUSD) || 0), 0) -
      resolved.reduce((s, p) => s + (Number(p.costUSD) || 0), 0) +
      resolved.reduce((s, p) => s + (Number(p.payoutUSD) || 0), 0);

    const totalEquity = cashBalance + openMarketValue;
    const totalPnl = totalEquity - Number(session.startingBalance);
    const returnPct =
      Number(session.startingBalance) > 0
        ? (totalPnl / Number(session.startingBalance)) * 100
        : 0;

    // Group open positions by market — show both-sides-caught jackpot setups
    const openByMarket: Record<string, any[]> = {};
    for (const p of open) {
      const key = String(p.conditionId);
      if (!openByMarket[key]) openByMarket[key] = [];
      openByMarket[key].push(p);
    }
    const bothSidesOpen = Object.values(openByMarket).filter((g) => g.length >= 2).length;

    const byAsset: Record<
      string,
      { positions: number; resolvedPnl: number; wins: number; losses: number; openCost: number }
    > = {};
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
      session: {
        strategyMode: String(session.strategyMode || 'dual_threshold'),
        active: Boolean(session.active),
        startingBalance: Number(session.startingBalance) || 100,
        threshold: Number(session.threshold) || 0.1,
        perBuyUSD: Number(session.perBuyUSD) || 1,
        slippageBps: Number(session.slippageBps) || 2000,
        enabledAssets: Array.isArray(session.enabledAssets) ? session.enabledAssets : ['BTC', 'ETH', 'SOL'],
        enabledWindows: Array.isArray(session.enabledWindows) && session.enabledWindows.length > 0
          ? session.enabledWindows
          : ['15m'],
        momentumWindowSec: Number(session.momentumWindowSec) || 300,
        momentumThresholdPct: Number(session.momentumThresholdPct ?? 0.10),
        bigBetUSD: Number(session.bigBetUSD ?? 1.5),
        smallBetUSD: Number(session.smallBetUSD ?? 0.5),
        startedAt: Number(session.startedAt) || 0,
      },
      summary: {
        totalPositions: all.length,
        openPositions: open.length,
        resolvedPositions: resolved.length,
        bothSidesOpenMarkets: bothSidesOpen,
        wins: wins.length,
        losses: losses.length,
        winRate:
          wins.length + losses.length > 0
            ? Number(((wins.length / (wins.length + losses.length)) * 100).toFixed(1))
            : 0,
        startingBalance: Number(session.startingBalance) || 100,
        cashBalance: Number(cashBalance.toFixed(2)),
        openMarketValue: Number(openMarketValue.toFixed(2)),
        totalEquity: Number(totalEquity.toFixed(2)),
        totalCost: Number(totalCost.toFixed(2)),
        openCost: Number(openCost.toFixed(2)),
        totalPayout: Number(totalPayout.toFixed(2)),
        realizedPnl: Number(realizedPnl.toFixed(2)),
        totalPnl: Number(totalPnl.toFixed(2)),
        returnPct: Number(returnPct.toFixed(2)),
        roi: totalCost > 0 ? Number(((realizedPnl / totalCost) * 100).toFixed(1)) : 0,
        evPerPosition: resolved.length > 0 ? Number((realizedPnl / resolved.length).toFixed(3)) : 0,
      },
      byAsset: Object.entries(byAsset).map(([asset, data]) => ({
        asset,
        positions: data.positions,
        resolvedPnl: Number(data.resolvedPnl.toFixed(2)),
        wins: data.wins,
        losses: data.losses,
        winRate:
          data.wins + data.losses > 0
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

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const action = String(body.action || 'update');
    const db = await getDb();
    const sessionsCol = db.collection('dual_threshold_sessions');
    const positionsCol = db.collection('dual_threshold_positions');

    const sessionsAny = sessionsCol as unknown as {
      findOne: (filter: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      updateOne: (filter: Record<string, unknown>, update: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>;
      replaceOne: (filter: Record<string, unknown>, doc: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>;
    };

    if (action === 'reset') {
      await positionsCol.deleteMany({});
      const fresh = {
        _id: SESSION_ID,
        strategyMode: String(body.strategyMode || 'dual_threshold'),
        active: true,
        startingBalance: Number(body.startingBalance) || 100,
        threshold: Number(body.threshold) || 0.1,
        perBuyUSD: Number(body.perBuyUSD) || 1,
        slippageBps: Number(body.slippageBps) || 2000,
        enabledAssets: Array.isArray(body.enabledAssets) ? body.enabledAssets : ['BTC', 'ETH', 'SOL'],
        enabledWindows: Array.isArray(body.enabledWindows) && body.enabledWindows.length > 0
          ? body.enabledWindows
          : ['15m'],
        momentumWindowSec: Number(body.momentumWindowSec) || 300,
        momentumThresholdPct: Number(body.momentumThresholdPct ?? 0.10),
        bigBetUSD: Number(body.bigBetUSD ?? 1.5),
        smallBetUSD: Number(body.smallBetUSD ?? 0.5),
        startedAt: Math.floor(Date.now() / 1000),
        updatedAt: new Date(),
      };
      await sessionsAny.replaceOne({ _id: SESSION_ID }, fresh, { upsert: true });
      return NextResponse.json({ success: true, session: fresh, action: 'reset' });
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };

    if (action === 'start') update.active = true;
    if (action === 'stop') update.active = false;

    if (typeof body.active === 'boolean') update.active = body.active;
    if (body.startingBalance !== undefined) update.startingBalance = Number(body.startingBalance);
    if (body.threshold !== undefined) update.threshold = Number(body.threshold);
    if (body.perBuyUSD !== undefined) update.perBuyUSD = Number(body.perBuyUSD);
    if (body.slippageBps !== undefined) update.slippageBps = Number(body.slippageBps);
    if (Array.isArray(body.enabledAssets)) update.enabledAssets = body.enabledAssets;
    if (Array.isArray(body.enabledWindows)) update.enabledWindows = body.enabledWindows;
    if (typeof body.strategyMode === 'string') update.strategyMode = body.strategyMode;
    if (body.momentumWindowSec !== undefined) update.momentumWindowSec = Number(body.momentumWindowSec);
    if (body.momentumThresholdPct !== undefined) update.momentumThresholdPct = Number(body.momentumThresholdPct);
    if (body.bigBetUSD !== undefined) update.bigBetUSD = Number(body.bigBetUSD);
    if (body.smallBetUSD !== undefined) update.smallBetUSD = Number(body.smallBetUSD);

    if (action === 'start') update.startedAt = Math.floor(Date.now() / 1000);

    await sessionsAny.updateOne(
      { _id: SESSION_ID },
      { $set: update, $setOnInsert: { _id: SESSION_ID } },
      { upsert: true }
    );

    const updated = await sessionsAny.findOne({ _id: SESSION_ID });
    return NextResponse.json({ success: true, session: updated, action });
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to update session: ${error instanceof Error ? error.message : error}` },
      { status: 500 }
    );
  }
}
