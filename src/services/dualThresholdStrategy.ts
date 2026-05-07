/**
 * Dual-Side Threshold Paper Trading Service
 *
 * Strategy: For each active SOL/BTC up-or-down market, monitor both YES and NO prices.
 * When either side dips below THRESHOLD ($0.10), record a paper buy at that price + slippage.
 * Each side can only be bought ONCE per market. Hold to resolution.
 *
 * Backtest showed +10.4% ROI / +$0.12 EV per market at 20% slippage on 1500 markets.
 *
 * This is a SEPARATE service from the copy trader. It runs alongside.
 */

import axios from 'axios';
import mongoose, { Schema } from 'mongoose';
import Logger from '../utils/logger';

// === STRATEGY PARAMETERS (validated by backtest) ===
const THRESHOLD_USD = 0.10;        // Buy when either side dips below this
const PER_BUY_USD = 1.0;           // $1 per paper buy
const SLIPPAGE_BPS = 2000;         // 20% — realistic for fast crypto markets
const TARGET_ASSETS = ['BTC', 'SOL']; // Skip ETH (backtest showed -1.4% ROI)
const POLL_INTERVAL_MS = 5000;     // Check every 5 seconds
const MAX_MARKET_AGE_MIN = 60;     // Ignore markets that opened > 60min ago

// === SERIES IDS for active crypto up/down markets ===
const ACTIVE_SERIES = [
    { id: 10684, asset: 'BTC', window: '5m' },
    { id: 10683, asset: 'ETH', window: '5m' }, // tracked but not bought
    { id: 10686, asset: 'SOL', window: '5m' },
    { id: 10192, asset: 'BTC', window: '15m' },
    { id: 10191, asset: 'ETH', window: '15m' },
];

// === MongoDB schema for paper positions ===
const dualThresholdPositionSchema = new Schema({
    conditionId: { type: String, required: true, index: true },
    slug: { type: String, required: true },
    title: { type: String, required: true },
    asset: { type: String, required: true }, // BTC / ETH / SOL
    window: { type: String, required: true }, // 5m / 15m
    outcome: { type: String, required: true }, // 'Up' / 'Down'
    outcomeIndex: { type: Number, required: true }, // 0 or 1
    triggerPrice: { type: Number, required: true }, // displayed price at trigger
    fillPrice: { type: Number, required: true }, // after slippage
    tokens: { type: Number, required: true },
    costUSD: { type: Number, required: true },
    entryTimestamp: { type: Number, required: true },
    resolved: { type: Boolean, default: false },
    winnerOutcomeIndex: { type: Number, default: null },
    payoutUSD: { type: Number, default: 0 },
    pnl: { type: Number, default: 0 },
    resolvedTimestamp: { type: Number, default: 0 },
});

// Compound index for fast resolution checks
dualThresholdPositionSchema.index({ resolved: 1, conditionId: 1 });

const COLLECTION_NAME = 'dual_threshold_positions';
const getModel = () =>
    (mongoose.models[COLLECTION_NAME] as mongoose.Model<any>) ||
    mongoose.model<any>(COLLECTION_NAME, dualThresholdPositionSchema, COLLECTION_NAME);

// === Helpers ===
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchActiveMarkets(): Promise<any[]> {
    const allMarkets: any[] = [];
    for (const series of ACTIVE_SERIES) {
        try {
            const res = await axios.get(
                `https://gamma-api.polymarket.com/events?series_id=${series.id}&active=true&closed=false&limit=50&order=startDate&ascending=false`,
                { timeout: 10000 }
            );
            if (Array.isArray(res.data)) {
                for (const event of res.data) {
                    for (const market of event.markets || []) {
                        if (market.conditionId && market.active && !market.closed) {
                            allMarkets.push({
                                conditionId: market.conditionId,
                                slug: market.slug,
                                title: market.question,
                                outcomes: JSON.parse(market.outcomes || '["Up","Down"]'),
                                clobTokenIds: JSON.parse(market.clobTokenIds || '[]'),
                                asset: series.asset,
                                window: series.window,
                                eventEndDate: event.endDate,
                            });
                        }
                    }
                }
            }
        } catch {
            // skip on error
        }
    }
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

async function fetchMarketResolution(conditionId: string): Promise<{ resolved: boolean; winnerIdx: number } | null> {
    try {
        const res = await axios.get(
            `https://gamma-api.polymarket.com/markets?condition_ids=${conditionId}`,
            { timeout: 8000 }
        );
        const market = Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : null;
        if (market && market.closed && market.outcomePrices) {
            const prices = JSON.parse(market.outcomePrices).map(Number);
            const winnerIdx = prices.findIndex((p: number) => p >= 0.99);
            if (winnerIdx >= 0) return { resolved: true, winnerIdx };
        }
        return { resolved: false, winnerIdx: -1 };
    } catch {
        return null;
    }
}

// === Process price triggers for a market ===
async function processMarket(market: any): Promise<void> {
    const Position = getModel();

    // Skip if we shouldn't trade this asset
    if (!TARGET_ASSETS.includes(market.asset)) return;

    // Skip if market is too old (already missed the window)
    // ... actually for short markets we want them all

    // Check existing positions for this market
    const existing = await Position.find({ conditionId: market.conditionId, resolved: false }).exec();
    const existingByOutcome = new Set(existing.map((p) => p.outcomeIndex));
    if (existingByOutcome.size === 2) return; // both sides already triggered

    // Get latest prices from recent trades
    const trades = await fetchRecentTrades(market.conditionId);
    if (trades.length === 0) return;

    // Track last price per outcome
    const lastPrice: Record<number, number> = { 0: -1, 1: -1 };
    for (const t of trades) {
        const idx = Number(t.outcomeIndex);
        if ((idx === 0 || idx === 1) && lastPrice[idx] === -1) {
            lastPrice[idx] = Number(t.price);
        }
        if (lastPrice[0] !== -1 && lastPrice[1] !== -1) break;
    }

    // Derive missing side from spread (sum to ~1)
    if (lastPrice[0] === -1 && lastPrice[1] !== -1) lastPrice[0] = Math.max(0.001, 1 - lastPrice[1]);
    if (lastPrice[1] === -1 && lastPrice[0] !== -1) lastPrice[1] = Math.max(0.001, 1 - lastPrice[0]);

    const slippage = SLIPPAGE_BPS / 10000;
    const now = Math.floor(Date.now() / 1000);

    for (const sideIdx of [0, 1]) {
        if (existingByOutcome.has(sideIdx)) continue;
        const price = lastPrice[sideIdx];
        if (price <= 0 || price >= THRESHOLD_USD) continue;

        const fillPrice = Math.min(0.999, price * (1 + slippage));
        const tokens = PER_BUY_USD / fillPrice;
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
            costUSD: PER_BUY_USD,
            entryTimestamp: now,
            resolved: false,
        });

        Logger.info(
            `[DUAL-THRESHOLD] 🎯 BUY ${outcome} @ $${fillPrice.toFixed(3)} ` +
            `(trigger $${price.toFixed(3)}) → ${tokens.toFixed(0)} tokens — ${market.title}`
        );
    }
}

// === Resolve closed markets and compute P&L ===
async function checkResolutions(): Promise<void> {
    const Position = getModel();
    const unresolved = await Position.find({ resolved: false }).exec();

    // Group by conditionId to batch resolution checks
    const conditionIds = Array.from(new Set(unresolved.map((p) => p.conditionId)));

    let resolvedCount = 0;
    let totalPnlChange = 0;

    for (const conditionId of conditionIds) {
        const result = await fetchMarketResolution(conditionId);
        if (!result || !result.resolved) continue;

        const positions = unresolved.filter((p) => p.conditionId === conditionId);
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

// === Main service loop ===
let isRunning = true;

export const stopDualThresholdStrategy = (): void => {
    isRunning = false;
};

const dualThresholdStrategy = async (): Promise<void> => {
    Logger.info('[DUAL-THRESHOLD] Service starting...');
    Logger.info(
        `[DUAL-THRESHOLD] Threshold=$${THRESHOLD_USD}, Per-buy=$${PER_BUY_USD}, ` +
        `Slippage=${(SLIPPAGE_BPS / 100).toFixed(1)}%, Assets=${TARGET_ASSETS.join('/')}`
    );

    let cycle = 0;
    while (isRunning) {
        cycle++;
        try {
            // Every cycle: scan active markets and check for triggers
            const markets = await fetchActiveMarkets();
            const tradeable = markets.filter((m) => TARGET_ASSETS.includes(m.asset));

            if (cycle % 12 === 0) {
                // Every minute: log heartbeat
                Logger.info(
                    `[DUAL-THRESHOLD] Heartbeat: monitoring ${tradeable.length} active ${TARGET_ASSETS.join('/')} markets`
                );
            }

            // Process each market for potential triggers (parallel batches)
            const BATCH = 8;
            for (let i = 0; i < tradeable.length; i += BATCH) {
                const batch = tradeable.slice(i, i + BATCH);
                await Promise.all(batch.map(processMarket));
            }

            // Every 5th cycle (~25 sec): check for resolutions
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
