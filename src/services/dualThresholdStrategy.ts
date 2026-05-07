/**
 * Dual-Side Threshold Paper Trading Service
 *
 * Strategy: For each active SOL/BTC up-or-down market, monitor both YES and NO prices.
 * When either side dips below THRESHOLD, record a paper buy at that price + slippage.
 * Each side can only be bought ONCE per market. Hold to resolution.
 *
 * Backtest showed +10.4% ROI / +$0.12 EV per market at 20% slippage on 1500 markets.
 *
 * Config is stored in MongoDB and can be edited via the dashboard.
 */

import axios from 'axios';
import mongoose, { Schema } from 'mongoose';
import Logger from '../utils/logger';

// === DEFAULTS (used when no session in DB) ===
const DEFAULT_THRESHOLD = 0.10;
const DEFAULT_PER_BUY = 1.0;
const DEFAULT_SLIPPAGE_BPS = 2000; // 20%
const DEFAULT_STARTING_BALANCE = 100;
// All assets work well on 15m (BTC +295%, ETH +161%, SOL +1130% ROI). Default to all.
const DEFAULT_ASSETS = ['BTC', 'ETH', 'SOL'];
// Default to 15m only since it's ~50x more profitable than 5m per backtest
const DEFAULT_WINDOWS = ['15m'];

const POLL_INTERVAL_MS = 3000; // Tighter polling so we don't miss last-second price dips

// All available crypto series
// 15m windows are dramatically more profitable (~50x EV) than 5m per backtest
const ACTIVE_SERIES = [
    { id: 10684, asset: 'BTC', window: '5m' },
    { id: 10683, asset: 'ETH', window: '5m' },
    { id: 10686, asset: 'SOL', window: '5m' },
    { id: 10192, asset: 'BTC', window: '15m' },
    { id: 10191, asset: 'ETH', window: '15m' },
    { id: 10423, asset: 'SOL', window: '15m' }, // Best EV per backtest: +$13.42/market
];

// === MongoDB schemas ===
const dualThresholdPositionSchema = new Schema({
    conditionId: { type: String, required: true, index: true },
    slug: { type: String, required: true },
    title: { type: String, required: true },
    asset: { type: String, required: true },
    window: { type: String, required: true },
    outcome: { type: String, required: true },
    outcomeIndex: { type: Number, required: true },
    triggerPrice: { type: Number, required: true },
    fillPrice: { type: Number, required: true },
    tokens: { type: Number, required: true },
    costUSD: { type: Number, required: true },
    entryTimestamp: { type: Number, required: true },
    resolved: { type: Boolean, default: false },
    winnerOutcomeIndex: { type: Number, default: null },
    payoutUSD: { type: Number, default: 0 },
    pnl: { type: Number, default: 0 },
    resolvedTimestamp: { type: Number, default: 0 },
});
dualThresholdPositionSchema.index({ resolved: 1, conditionId: 1 });

const dualThresholdSessionSchema = new Schema({
    _id: { type: String, default: 'default' },
    active: { type: Boolean, default: true },
    startingBalance: { type: Number, default: DEFAULT_STARTING_BALANCE },
    threshold: { type: Number, default: DEFAULT_THRESHOLD },
    perBuyUSD: { type: Number, default: DEFAULT_PER_BUY },
    slippageBps: { type: Number, default: DEFAULT_SLIPPAGE_BPS },
    enabledAssets: { type: [String], default: DEFAULT_ASSETS },
    enabledWindows: { type: [String], default: DEFAULT_WINDOWS },
    startedAt: { type: Number, default: 0 },
    updatedAt: { type: Date, default: Date.now },
}, { _id: false });

const POSITIONS_COLLECTION = 'dual_threshold_positions';
const SESSIONS_COLLECTION = 'dual_threshold_sessions';
const SESSION_ID = 'default';

const getPositionModel = () =>
    (mongoose.models[POSITIONS_COLLECTION] as mongoose.Model<any>) ||
    mongoose.model<any>(POSITIONS_COLLECTION, dualThresholdPositionSchema, POSITIONS_COLLECTION);

const getSessionModel = () =>
    (mongoose.models[SESSIONS_COLLECTION] as mongoose.Model<any>) ||
    mongoose.model<any>(SESSIONS_COLLECTION, dualThresholdSessionSchema, SESSIONS_COLLECTION);

// === Helpers ===
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SessionConfig {
    active: boolean;
    startingBalance: number;
    threshold: number;
    perBuyUSD: number;
    slippageBps: number;
    enabledAssets: string[];
    enabledWindows: string[];
}

async function getSessionConfig(): Promise<SessionConfig> {
    const Session = getSessionModel();
    const doc = await Session.findOne({ _id: SESSION_ID }).exec();
    if (!doc) {
        // Create default session
        const newDoc = await Session.create({
            _id: SESSION_ID,
            active: true,
            startingBalance: DEFAULT_STARTING_BALANCE,
            threshold: DEFAULT_THRESHOLD,
            perBuyUSD: DEFAULT_PER_BUY,
            slippageBps: DEFAULT_SLIPPAGE_BPS,
            enabledAssets: DEFAULT_ASSETS,
            enabledWindows: DEFAULT_WINDOWS,
            startedAt: Math.floor(Date.now() / 1000),
        });
        return newDoc.toObject() as SessionConfig;
    }
    const obj = doc.toObject() as SessionConfig;
    // Backfill if old session doesn't have enabledWindows
    if (!Array.isArray(obj.enabledWindows) || obj.enabledWindows.length === 0) {
        obj.enabledWindows = DEFAULT_WINDOWS;
    }
    return obj;
}

async function getCashBalance(session: SessionConfig): Promise<number> {
    const Position = getPositionModel();
    const positions = await Position.find({}).exec();
    let cash = session.startingBalance;
    for (const p of positions) {
        cash -= Number(p.costUSD) || 0;       // Spent on buy
        if (p.resolved) cash += Number(p.payoutUSD) || 0; // Received on resolution
    }
    return cash;
}

async function fetchActiveMarkets(): Promise<any[]> {
    const allMarkets: any[] = [];
    const now = Date.now() / 1000;

    for (const series of ACTIVE_SERIES) {
        try {
            // Sort by endDate ascending so we get markets CLOSING SOONEST first.
            // Those are the ones where prices crash below threshold.
            const res = await axios.get(
                `https://gamma-api.polymarket.com/events?series_id=${series.id}&active=true&closed=false&limit=50&order=endDate&ascending=true`,
                { timeout: 10000 }
            );
            if (Array.isArray(res.data)) {
                for (const event of res.data) {
                    for (const market of event.markets || []) {
                        if (market.conditionId && market.active && !market.closed) {
                            // Compute closeTs from slug (eth-updown-15m-1778193900)
                            const tsMatch = String(market.slug || '').match(/(\d+)$/);
                            const startTs = tsMatch ? Number(tsMatch[1]) : 0;
                            const windowSec = series.window === '15m' ? 15 * 60 : 5 * 60;
                            const closeTs = startTs + windowSec;
                            // Only keep markets that haven't closed yet
                            if (closeTs <= now) continue;
                            // Skip markets > 16 min away (just opened, prices won't dip yet)
                            if (closeTs - now > 16 * 60) continue;
                            allMarkets.push({
                                conditionId: market.conditionId,
                                slug: market.slug,
                                title: market.question,
                                outcomes: JSON.parse(market.outcomes || '["Up","Down"]'),
                                clobTokenIds: JSON.parse(market.clobTokenIds || '[]'),
                                asset: series.asset,
                                window: series.window,
                                closeTs,
                            });
                        }
                    }
                }
            }
        } catch {
            // skip on error
        }
    }
    // Process markets closing soonest first (where prices have crashed)
    allMarkets.sort((a, b) => a.closeTs - b.closeTs);
    return allMarkets;
}

async function fetchRecentTrades(conditionId: string): Promise<any[]> {
    try {
        const res = await axios.get(
            `https://data-api.polymarket.com/trades?market=${conditionId}&limit=50`,
            { timeout: 8000 }
        );
        return Array.isArray(res.data) ? res.data : [];
    } catch {
        return [];
    }
}

async function fetchMarketResolution(slug: string): Promise<{ resolved: boolean; winnerIdx: number } | null> {
    try {
        // Use /events?slug=... — confirmed working endpoint (condition_ids filter returns empty)
        const res = await axios.get(
            `https://gamma-api.polymarket.com/events?slug=${slug}`,
            { timeout: 8000 }
        );
        if (Array.isArray(res.data) && res.data.length > 0) {
            const market = res.data[0].markets?.[0];
            if (market && market.closed && market.outcomePrices) {
                const prices = JSON.parse(market.outcomePrices).map(Number);
                const winnerIdx = prices.findIndex((p: number) => p >= 0.99);
                if (winnerIdx >= 0) return { resolved: true, winnerIdx };
            }
        }
        return { resolved: false, winnerIdx: -1 };
    } catch {
        return null;
    }
}

async function processMarket(market: any, session: SessionConfig, cashLeft: { value: number }): Promise<void> {
    const Position = getPositionModel();

    if (!session.enabledAssets.includes(market.asset)) return;
    if (!session.enabledWindows.includes(market.window)) return;
    if (cashLeft.value < session.perBuyUSD) return; // Out of cash

    const existing = await Position.find({ conditionId: market.conditionId, resolved: false }).exec();
    const existingByOutcome = new Set(existing.map((p) => p.outcomeIndex));
    if (existingByOutcome.size === 2) return;

    const trades = await fetchRecentTrades(market.conditionId);
    if (trades.length === 0) return;

    const lastPrice: Record<number, number> = { 0: -1, 1: -1 };
    for (const t of trades) {
        const idx = Number(t.outcomeIndex);
        if ((idx === 0 || idx === 1) && lastPrice[idx] === -1) {
            lastPrice[idx] = Number(t.price);
        }
        if (lastPrice[0] !== -1 && lastPrice[1] !== -1) break;
    }
    if (lastPrice[0] === -1 && lastPrice[1] !== -1) lastPrice[0] = Math.max(0.001, 1 - lastPrice[1]);
    if (lastPrice[1] === -1 && lastPrice[0] !== -1) lastPrice[1] = Math.max(0.001, 1 - lastPrice[0]);

    const slippage = session.slippageBps / 10000;
    const now = Math.floor(Date.now() / 1000);

    for (const sideIdx of [0, 1]) {
        if (existingByOutcome.has(sideIdx)) continue;
        if (cashLeft.value < session.perBuyUSD) break;
        const price = lastPrice[sideIdx];
        if (price <= 0 || price >= session.threshold) continue;

        const fillPrice = Math.min(0.999, price * (1 + slippage));
        const tokens = session.perBuyUSD / fillPrice;
        const outcome = market.outcomes[sideIdx] || (sideIdx === 0 ? 'Up' : 'Down');

        await Position.create({
            conditionId: market.conditionId,
            slug: market.slug,
            title: market.title,
            asset: market.asset,
            window: market.window,
            outcome,
            outcomeIndex: sideIdx,
            triggerPrice: price,
            fillPrice,
            tokens,
            costUSD: session.perBuyUSD,
            entryTimestamp: now,
            resolved: false,
        });
        cashLeft.value -= session.perBuyUSD;

        Logger.info(
            `[DUAL-THRESHOLD] 🎯 BUY ${outcome} @ $${fillPrice.toFixed(3)} ` +
            `(trigger $${price.toFixed(3)}) → ${tokens.toFixed(0)} tokens — ${market.title}`
        );
    }
}

async function checkResolutions(): Promise<void> {
    const Position = getPositionModel();
    const unresolved = await Position.find({ resolved: false }).exec();

    // Group by slug since fetchMarketResolution uses slug now
    const slugToPositions = new Map<string, any[]>();
    for (const p of unresolved) {
        const key = p.slug;
        if (!slugToPositions.has(key)) slugToPositions.set(key, []);
        slugToPositions.get(key)!.push(p);
    }

    let resolvedCount = 0;
    let totalPnlChange = 0;

    for (const [slug, positions] of slugToPositions.entries()) {
        const result = await fetchMarketResolution(slug);
        if (!result || !result.resolved) continue;
        for (const pos of positions) {
            const won = pos.outcomeIndex === result.winnerIdx;
            const payout = won ? pos.tokens : 0;
            const pnl = payout - pos.costUSD;

            await Position.updateOne(
                { _id: pos._id },
                {
                    $set: {
                        resolved: true,
                        winnerOutcomeIndex: result.winnerIdx,
                        payoutUSD: payout,
                        pnl,
                        resolvedTimestamp: Math.floor(Date.now() / 1000),
                    },
                }
            );

            totalPnlChange += pnl;
            resolvedCount++;
            Logger.info(
                `[DUAL-THRESHOLD] ${won ? '✅ WIN ' : '❌ LOSS'} ${pos.outcome} ` +
                `cost $${pos.costUSD.toFixed(2)} → payout $${payout.toFixed(2)} (P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})`
            );
        }
        await sleep(50);
    }

    if (resolvedCount > 0) {
        Logger.info(
            `[DUAL-THRESHOLD] Resolved ${resolvedCount} positions, net P&L change: ` +
            `${totalPnlChange >= 0 ? '+' : ''}$${totalPnlChange.toFixed(2)}`
        );
    }
}

let isRunning = true;

export const stopDualThresholdStrategy = (): void => {
    isRunning = false;
};

const dualThresholdStrategy = async (): Promise<void> => {
    Logger.info('[DUAL-THRESHOLD] Service starting...');

    let cycle = 0;
    while (isRunning) {
        cycle++;
        try {
            const session = await getSessionConfig();

            if (!session.active) {
                if (cycle % 12 === 0) {
                    Logger.info('[DUAL-THRESHOLD] Session inactive — skipping');
                }
                await sleep(POLL_INTERVAL_MS);
                continue;
            }

            const cashAvailable = await getCashBalance(session);

            if (cycle % 12 === 0) {
                Logger.info(
                    `[DUAL-THRESHOLD] Threshold=$${session.threshold} | Per-buy=$${session.perBuyUSD} | ` +
                    `Cash=$${cashAvailable.toFixed(2)}/$${session.startingBalance} | ` +
                    `Assets=${session.enabledAssets.join('/')} | Windows=${session.enabledWindows.join('/')}`
                );
            }

            const markets = await fetchActiveMarkets();
            const tradeable = markets.filter(
                (m) => session.enabledAssets.includes(m.asset) && session.enabledWindows.includes(m.window)
            );

            const cashLeft = { value: cashAvailable };
            const BATCH = 8;
            for (let i = 0; i < tradeable.length; i += BATCH) {
                if (cashLeft.value < session.perBuyUSD) break;
                const batch = tradeable.slice(i, i + BATCH);
                await Promise.all(batch.map((m) => processMarket(m, session, cashLeft)));
            }

            if (cycle % 5 === 0) {
                await checkResolutions();
            }
        } catch (e) {
            Logger.warning(`[DUAL-THRESHOLD] Cycle error: ${e instanceof Error ? e.message : e}`);
        }

        if (!isRunning) break;
        await sleep(POLL_INTERVAL_MS);
    }

    Logger.info('[DUAL-THRESHOLD] Service stopped');
};

export default dualThresholdStrategy;
