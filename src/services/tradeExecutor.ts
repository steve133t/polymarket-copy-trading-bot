import { ClobClient } from '@polymarket/clob-client-v2';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV, getCurrentUserAddresses } from '../config/env';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import getMyBalance from '../utils/getMyBalance';
import postOrder from '../utils/postOrder';
import Logger from '../utils/logger';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const PROXY_WALLET = ENV.PROXY_WALLET;
const TRADE_AGGREGATION_ENABLED = ENV.TRADE_AGGREGATION_ENABLED;
const TRADE_AGGREGATION_WINDOW_SECONDS = ENV.TRADE_AGGREGATION_WINDOW_SECONDS;
const TRADE_AGGREGATION_MIN_TOTAL_USD = 1.0; // Polymarket minimum

// ---------------------------------------------------------------------------
// In-memory cache for my own positions + balance.
// Fetched in parallel and refreshed at most every 5 s.
// Avoids 2 sequential Polymarket API calls (~2–3 s each) before every trade.
// ---------------------------------------------------------------------------
let myPositionsCache: UserPositionInterface[] = [];
let myBalanceCache = 0;
let myCacheTimestamp = 0;
const MY_CACHE_TTL_MS = 5_000;

async function getMyData(): Promise<{ positions: UserPositionInterface[]; balance: number }> {
    const now = Date.now();
    if (myCacheTimestamp > 0 && now - myCacheTimestamp < MY_CACHE_TTL_MS) {
        return { positions: myPositionsCache, balance: myBalanceCache };
    }
    const [positions, balance] = await Promise.all([
        fetchData(`https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`) as Promise<UserPositionInterface[]>,
        getMyBalance(PROXY_WALLET),
    ]);
    myPositionsCache = Array.isArray(positions) ? positions : [];
    myBalanceCache = balance;
    myCacheTimestamp = now;
    return { positions: myPositionsCache, balance: myBalanceCache };
}

/** Invalidate cache after a trade changes my portfolio. */
function invalidateMyCache(): void {
    myCacheTimestamp = 0;
}

// ---------------------------------------------------------------------------
// Fetch trader positions from MongoDB (kept current by tradeMonitor).
// Much faster than a Polymarket API call (~1–3 s) because the data is local.
// ---------------------------------------------------------------------------
async function getTraderData(userAddress: string): Promise<{ positions: UserPositionInterface[]; balance: number }> {
    const UserPosition = getUserPositionModel(userAddress);
    const docs = await UserPosition.find().exec();
    const positions = docs.map((d) => d.toObject() as UserPositionInterface);
    const balance = positions.reduce((sum, p) => sum + (p.currentValue || 0), 0);
    return { positions, balance };
}

// Create activity models for each user. This refreshes from .env so trader
// changes made in the UI are picked up without restarting the process.
let userActivityModels = ENV.USER_ADDRESSES.map((address) => ({
    address,
    model: getUserActivityModel(address),
}));

const refreshUserActivityModels = () => {
    const configuredAddresses = getCurrentUserAddresses();
    const existingModels = new Map(userActivityModels.map((entry) => [entry.address, entry]));
    const currentAddresses = new Set(userActivityModels.map(({ address }) => address));
    const nextAddresses = new Set(configuredAddresses);
    const added = configuredAddresses.filter((address) => !currentAddresses.has(address));
    const removed = userActivityModels
        .map(({ address }) => address)
        .filter((address) => !nextAddresses.has(address));

    if (added.length > 0) {
        Logger.success(`Trade executor added ${added.length} trader(s): ${added.map((address) => `${address.slice(0, 6)}...${address.slice(-4)}`).join(', ')}`);
    }
    if (removed.length > 0) {
        Logger.warning(`Trade executor removed ${removed.length} trader(s): ${removed.map((address) => `${address.slice(0, 6)}...${address.slice(-4)}`).join(', ')}`);
    }

    userActivityModels = configuredAddresses.map((address) => existingModels.get(address) || {
        address,
        model: getUserActivityModel(address),
    });
};

interface TradeWithUser extends UserActivityInterface {
    userAddress: string;
}

interface AggregatedTrade {
    userAddress: string;
    conditionId: string;
    asset: string;
    side: string;
    slug?: string;
    eventSlug?: string;
    trades: TradeWithUser[];
    totalUsdcSize: number;
    averagePrice: number;
    firstTradeTime: number;
    lastTradeTime: number;
}

// Buffer for aggregating trades
const tradeAggregationBuffer: Map<string, AggregatedTrade> = new Map();

// Maximum trades to load per executor tick — prevents OOM on big backlogs
const MAX_TRADES_PER_TICK = 50;
// Only consider trades from the last N seconds — anything older gets auto-skipped
// (avoids processing stale backlog when bot was down or fell behind)
const TRADE_FRESHNESS_WINDOW_SEC = 600; // 10 minutes
const STALE_TRADE_CUTOFF_SEC = 60 * 60; // anything older than 1 hour: auto-skip silently

const readTempTrades = async (): Promise<TradeWithUser[]> => {
    refreshUserActivityModels();

    const nowSec = Math.floor(Date.now() / 1000);
    const freshSince = nowSec - TRADE_FRESHNESS_WINDOW_SEC;
    const staleBefore = nowSec - STALE_TRADE_CUTOFF_SEC;
    const allTrades: TradeWithUser[] = [];

    for (const { address, model } of userActivityModels) {
        // Auto-skip trades older than 1h so they don't pile up forever.
        // Fire-and-forget — don't block the tick on this.
        model
            .updateMany(
                {
                    type: 'TRADE',
                    bot: false,
                    botExcutedTime: 0,
                    timestamp: { $lt: staleBefore },
                },
                { $set: { bot: true, botExcutedTime: 999, skipped: true, skipReason: 'stale' } }
            )
            .exec()
            .catch(() => undefined);

        // Only fetch fresh, unprocessed trades — limited batch, sorted oldest-first
        // so we process in chronological order even when batched.
        const trades = await model
            .find({
                type: 'TRADE',
                bot: false,
                botExcutedTime: 0,
                timestamp: { $gte: freshSince },
            })
            .sort({ timestamp: 1 })
            .limit(MAX_TRADES_PER_TICK)
            .exec();

        const tradesWithUser = trades.map((trade) => ({
            ...(trade.toObject() as UserActivityInterface),
            userAddress: address,
        }));

        allTrades.push(...tradesWithUser);
    }

    return allTrades;
};

/**
 * Generate a unique key for trade aggregation based on user, market, side
 */
const getAggregationKey = (trade: TradeWithUser): string => {
    return `${trade.userAddress}:${trade.conditionId}:${trade.asset}:${trade.side}`;
};

/**
 * Add trade to aggregation buffer or update existing aggregation
 */
const addToAggregationBuffer = (trade: TradeWithUser): void => {
    const key = getAggregationKey(trade);
    const existing = tradeAggregationBuffer.get(key);
    const now = Date.now();

    if (existing) {
        // Update existing aggregation
        existing.trades.push(trade);
        existing.totalUsdcSize += trade.usdcSize;
        // Recalculate weighted average price
        const totalValue = existing.trades.reduce((sum, t) => sum + t.usdcSize * t.price, 0);
        existing.averagePrice = totalValue / existing.totalUsdcSize;
        existing.lastTradeTime = now;
    } else {
        // Create new aggregation
        tradeAggregationBuffer.set(key, {
            userAddress: trade.userAddress,
            conditionId: trade.conditionId,
            asset: trade.asset,
            side: trade.side || 'BUY',
            slug: trade.slug,
            eventSlug: trade.eventSlug,
            trades: [trade],
            totalUsdcSize: trade.usdcSize,
            averagePrice: trade.price,
            firstTradeTime: now,
            lastTradeTime: now,
        });
    }
};

/**
 * Check buffer and return ready aggregated trades
 * Trades are ready if:
 * 1. Total size >= minimum AND
 * 2. Time window has passed since first trade
 */
const getReadyAggregatedTrades = (): AggregatedTrade[] => {
    const ready: AggregatedTrade[] = [];
    const now = Date.now();
    const windowMs = TRADE_AGGREGATION_WINDOW_SECONDS * 1000;

    for (const [key, agg] of tradeAggregationBuffer.entries()) {
        const timeElapsed = now - agg.firstTradeTime;

        // Check if aggregation is ready
        if (timeElapsed >= windowMs) {
            if (agg.totalUsdcSize >= TRADE_AGGREGATION_MIN_TOTAL_USD) {
                // Aggregation meets minimum and window passed - ready to execute
                ready.push(agg);
            } else {
                // Window passed but total too small - mark individual trades as skipped
                Logger.info(
                    `Trade aggregation for ${agg.userAddress} on ${agg.slug || agg.asset}: $${agg.totalUsdcSize.toFixed(2)} total from ${agg.trades.length} trades below minimum ($${TRADE_AGGREGATION_MIN_TOTAL_USD}) - skipping`
                );

                // Mark all trades in this aggregation as processed (bot: true)
                for (const trade of agg.trades) {
                    const UserActivity = getUserActivityModel(trade.userAddress);
                    UserActivity.updateOne({ _id: trade._id }, { bot: true }).exec();
                }
            }
            // Remove from buffer either way
            tradeAggregationBuffer.delete(key);
        }
    }

    return ready;
};

const doTrading = async (clobClient: ClobClient, trades: TradeWithUser[]) => {
    for (const trade of trades) {
        // Mark trade as being processed immediately to prevent duplicate processing
        const UserActivity = getUserActivityModel(trade.userAddress);
        await UserActivity.updateOne({ _id: trade._id }, { $set: { botExcutedTime: 1 } });

        Logger.trade(trade.userAddress, trade.side || 'UNKNOWN', {
            asset: trade.asset,
            side: trade.side,
            amount: trade.usdcSize,
            price: trade.price,
            slug: trade.slug,
            eventSlug: trade.eventSlug,
            transactionHash: trade.transactionHash,
        });

        try {
            // Parallel fetch: my data from cache/API, trader data from MongoDB (no extra API call)
            const [myData, traderData] = await Promise.all([
                getMyData(),
                getTraderData(trade.userAddress),
            ]);

            const my_position = myData.positions.find(
                (p) => p.conditionId === trade.conditionId
            );
            const user_position = traderData.positions.find(
                (p) => p.conditionId === trade.conditionId
            );

            Logger.balance(myData.balance, traderData.balance, trade.userAddress);

            // Execute the trade
            await postOrder(
                clobClient,
                trade.side === 'BUY' ? 'buy' : 'sell',
                my_position,
                user_position,
                trade,
                myData.balance,
                traderData.balance,
                trade.userAddress
            );

            // Invalidate cache so the next trade sees updated positions
            invalidateMyCache();
        } catch (err) {
            // Reset in-progress marker so the trade is retried on the next poll cycle
            await UserActivity.updateOne({ _id: trade._id }, { $set: { botExcutedTime: 0 } });
            Logger.error(`Trade execution failed, will retry: ${err}`);
        }

        Logger.separator();
    }
};

/**
 * Execute aggregated trades
 */
const doAggregatedTrading = async (clobClient: ClobClient, aggregatedTrades: AggregatedTrade[]) => {
    for (const agg of aggregatedTrades) {
        Logger.header(`📊 AGGREGATED TRADE (${agg.trades.length} trades combined)`);
        Logger.info(`Market: ${agg.slug || agg.asset}`);
        Logger.info(`Side: ${agg.side}`);
        Logger.info(`Total volume: $${agg.totalUsdcSize.toFixed(2)}`);
        Logger.info(`Average price: $${agg.averagePrice.toFixed(4)}`);

        // Mark all individual trades as being processed
        for (const trade of agg.trades) {
            const UserActivity = getUserActivityModel(trade.userAddress);
            await UserActivity.updateOne({ _id: trade._id }, { $set: { botExcutedTime: 1 } });
        }

        try {
            // Parallel fetch: my data from cache/API, trader data from MongoDB
            const [myData, traderData] = await Promise.all([
                getMyData(),
                getTraderData(agg.userAddress),
            ]);

            const my_position = myData.positions.find(
                (p) => p.conditionId === agg.conditionId
            );
            const user_position = traderData.positions.find(
                (p) => p.conditionId === agg.conditionId
            );

            Logger.balance(myData.balance, traderData.balance, agg.userAddress);

            // Create a synthetic trade object for postOrder using aggregated values
            const syntheticTrade: UserActivityInterface = {
                ...agg.trades[0], // Use first trade as template
                usdcSize: agg.totalUsdcSize,
                price: agg.averagePrice,
                side: agg.side as 'BUY' | 'SELL',
            };

            // Execute the aggregated trade
            await postOrder(
                clobClient,
                agg.side === 'BUY' ? 'buy' : 'sell',
                my_position,
                user_position,
                syntheticTrade,
                myData.balance,
                traderData.balance,
                agg.userAddress
            );

            invalidateMyCache();
        } catch (err) {
            // Reset in-progress marker on all constituent trades so they can be retried
            for (const trade of agg.trades) {
                const UserActivity = getUserActivityModel(trade.userAddress);
                await UserActivity.updateOne({ _id: trade._id }, { $set: { botExcutedTime: 0 } });
            }
            Logger.error(`Aggregated trade execution failed, will retry: ${err}`);
        }

        Logger.separator();
    }
};

// Track if executor should continue running
let isRunning = true;

/**
 * Stop the trade executor gracefully
 */
export const stopTradeExecutor = () => {
    isRunning = false;
    Logger.info('Trade executor shutdown requested...');
};

const tradeExecutor = async (clobClient: ClobClient) => {
    refreshUserActivityModels();
    Logger.success(`Trade executor ready for ${userActivityModels.length} trader(s)`);
    if (TRADE_AGGREGATION_ENABLED) {
        Logger.info(
            `Trade aggregation enabled: ${TRADE_AGGREGATION_WINDOW_SECONDS}s window, $${TRADE_AGGREGATION_MIN_TOTAL_USD} minimum`
        );
    }

    let lastCheck = Date.now();
    while (isRunning) {
        const trades = await readTempTrades();

        if (TRADE_AGGREGATION_ENABLED) {
            // Process with aggregation logic
            if (trades.length > 0) {
                Logger.clearLine();
                Logger.info(
                    `📥 ${trades.length} new trade${trades.length > 1 ? 's' : ''} detected`
                );

                // Add trades to aggregation buffer
                for (const trade of trades) {
                    // Only aggregate BUY trades below minimum threshold
                    if (trade.side === 'BUY' && trade.usdcSize < TRADE_AGGREGATION_MIN_TOTAL_USD) {
                        Logger.info(
                            `Adding $${trade.usdcSize.toFixed(2)} ${trade.side} trade to aggregation buffer for ${trade.slug || trade.asset}`
                        );
                        addToAggregationBuffer(trade);
                    } else {
                        // Execute large trades immediately (not aggregated)
                        Logger.clearLine();
                        Logger.header(`⚡ IMMEDIATE TRADE (above threshold)`);
                        await doTrading(clobClient, [trade]);
                    }
                }
                lastCheck = Date.now();
            }

            // Check for ready aggregated trades
            const readyAggregations = getReadyAggregatedTrades();
            if (readyAggregations.length > 0) {
                Logger.clearLine();
                Logger.header(
                    `⚡ ${readyAggregations.length} AGGREGATED TRADE${readyAggregations.length > 1 ? 'S' : ''} READY`
                );
                await doAggregatedTrading(clobClient, readyAggregations);
                lastCheck = Date.now();
            }

            // Update waiting message
            if (trades.length === 0 && readyAggregations.length === 0) {
                if (Date.now() - lastCheck > 300) {
                    const bufferedCount = tradeAggregationBuffer.size;
                    if (bufferedCount > 0) {
                        Logger.waiting(
                            userActivityModels.length,
                            `${bufferedCount} trade group(s) pending`
                        );
                    } else {
                        Logger.waiting(userActivityModels.length);
                    }
                    lastCheck = Date.now();
                }
            }
        } else {
            // Original non-aggregation logic
            if (trades.length > 0) {
                Logger.clearLine();
                Logger.header(
                    `⚡ ${trades.length} NEW TRADE${trades.length > 1 ? 'S' : ''} TO COPY`
                );
                await doTrading(clobClient, trades);
                lastCheck = Date.now();
            } else {
                // Update waiting message every 300ms for smooth animation
                if (Date.now() - lastCheck > 300) {
                    Logger.waiting(userActivityModels.length);
                    lastCheck = Date.now();
                }
            }
        }

        if (!isRunning) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
    }

    Logger.info('Trade executor stopped');
};

export default tradeExecutor;
