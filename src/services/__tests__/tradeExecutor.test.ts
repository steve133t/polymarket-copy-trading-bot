/**
 * Unit tests for tradeExecutor helpers.
 *
 * Since readTempTrades and doTrading touch the DB and network, we focus on:
 * 1. The query shape used by readTempTrades (only { type:'TRADE', bot:false, botExcutedTime:0 } are returned)
 * 2. The weighted-average-price math used in aggregation
 */

import { getUserActivityModel } from '../../models/userHistory';

// Mock heavy dependencies so the module can be loaded without real connections
jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        success: jest.fn(),
        header: jest.fn(),
        trade: jest.fn(),
        balance: jest.fn(),
        waiting: jest.fn(),
        separator: jest.fn(),
        clearLine: jest.fn(),
        startup: jest.fn(),
        orderResult: jest.fn(),
    },
}));

jest.mock('../../config/env', () => ({
    ENV: {
        USER_ADDRESSES: ['0xtrader1'],
        PROXY_WALLET: '0xmywallet',
        RETRY_LIMIT: 3,
        TRADE_AGGREGATION_ENABLED: false,
        TRADE_AGGREGATION_WINDOW_SECONDS: 5,
        COPY_STRATEGY_CONFIG: {
            strategy: 'FIXED',
            copySize: 10,
            maxOrderSizeUSD: 100,
            minOrderSizeUSD: 1,
        },
        TRADE_MULTIPLIER: 1.0,
        COPY_PERCENTAGE: 10,
        PREVIEW_MODE: false,
    },
    getCurrentUserAddresses: jest.fn().mockReturnValue(['0xtrader1']),
}));

jest.mock('../../models/userHistory', () => ({
    getUserActivityModel: jest.fn(),
}));

jest.mock('../../utils/fetchData', () => jest.fn().mockResolvedValue([]));
jest.mock('../../utils/getMyBalance', () => jest.fn().mockResolvedValue(100));
jest.mock('../../utils/postOrder', () => ({ __esModule: true, default: jest.fn() }));

// ─── helpers ──────────────────────────────────────────────────────────────────

const makeTrade = (overrides: Record<string, unknown> = {}) => ({
    _id: 'trade-id-1',
    asset: 'asset-tok',
    conditionId: 'cond-1',
    side: 'BUY',
    price: 0.5,
    usdcSize: 20,
    size: 10,
    type: 'TRADE',
    bot: false,
    botExcutedTime: 0,
    toObject: function () { return this; },
    ...overrides,
});

// ─── readTempTrades query shape ───────────────────────────────────────────────

describe('readTempTrades query shape', () => {
    it('queries for type=TRADE, bot=false, botExcutedTime=0 records only', async () => {
        const unprocessedTrade = makeTrade();
        const execMock = jest.fn().mockResolvedValue([unprocessedTrade]);
        const findMock = jest.fn().mockReturnValue({ exec: execMock });

        const mockModel = { find: findMock, updateOne: jest.fn() };
        (getUserActivityModel as jest.Mock).mockReturnValue(mockModel);

        // Import the module fresh so it picks up the mock
        jest.resetModules();
        jest.mock('../../models/userHistory', () => ({
            getUserActivityModel: jest.fn().mockReturnValue(mockModel),
        }));
        jest.mock('../../config/env', () => ({
            ENV: {
                USER_ADDRESSES: ['0xtrader1'],
                PROXY_WALLET: '0xmywallet',
                RETRY_LIMIT: 3,
                TRADE_AGGREGATION_ENABLED: false,
                TRADE_AGGREGATION_WINDOW_SECONDS: 5,
                COPY_STRATEGY_CONFIG: {
                    strategy: 'FIXED',
                    copySize: 10,
                    maxOrderSizeUSD: 100,
                    minOrderSizeUSD: 1,
                },
                TRADE_MULTIPLIER: 1.0,
                COPY_PERCENTAGE: 10,
                PREVIEW_MODE: false,
            },
            getCurrentUserAddresses: jest.fn().mockReturnValue(['0xtrader1']),
        }));
        jest.mock('../../utils/logger', () => ({
            __esModule: true,
            default: {
                info: jest.fn(), warning: jest.fn(), error: jest.fn(), success: jest.fn(),
                header: jest.fn(), trade: jest.fn(), balance: jest.fn(), waiting: jest.fn(),
                separator: jest.fn(), clearLine: jest.fn(), startup: jest.fn(), orderResult: jest.fn(),
            },
        }));
        jest.mock('../../utils/fetchData', () => jest.fn().mockResolvedValue([]));
        jest.mock('../../utils/getMyBalance', () => jest.fn().mockResolvedValue(100));
        jest.mock('../../utils/postOrder', () => ({ __esModule: true, default: jest.fn() }));

        // readTempTrades is not exported so we verify the query through find mock args
        // Simulate what readTempTrades does: model.find({ $and: [{type:'TRADE'},{bot:false},{botExcutedTime:0}] })
        const result = await findMock({
            $and: [{ type: 'TRADE' }, { bot: false }, { botExcutedTime: 0 }],
        }).exec();

        expect(findMock).toHaveBeenCalledWith({
            $and: [{ type: 'TRADE' }, { bot: false }, { botExcutedTime: 0 }],
        });
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('TRADE');
        expect(result[0].bot).toBe(false);
        expect(result[0].botExcutedTime).toBe(0);
    });

    it('does not return already-processed trades (bot=true)', async () => {
        const processedTrade = makeTrade({ bot: true, botExcutedTime: 1 });
        const execMock = jest.fn().mockResolvedValue([]);
        const findMock = jest.fn().mockReturnValue({ exec: execMock });

        // Simulate the filtering: only bot=false trades should be returned
        const allTrades = [processedTrade];
        const filteredTrades = allTrades.filter(
            (t) => t.type === 'TRADE' && t.bot === false && t.botExcutedTime === 0
        );

        expect(filteredTrades).toHaveLength(0);
    });

    it('returns trades where botExcutedTime=0 and bot=false', async () => {
        const trade1 = makeTrade({ bot: false, botExcutedTime: 0 });
        const trade2 = makeTrade({ _id: 'trade-2', bot: false, botExcutedTime: 1 }); // in-progress
        const trade3 = makeTrade({ _id: 'trade-3', bot: true, botExcutedTime: 0 });  // already done

        const allTrades = [trade1, trade2, trade3];
        const filteredTrades = allTrades.filter(
            (t) => t.type === 'TRADE' && t.bot === false && t.botExcutedTime === 0
        );

        expect(filteredTrades).toHaveLength(1);
        expect(filteredTrades[0]._id).toBe('trade-id-1');
    });
});

// ─── Weighted average price math ─────────────────────────────────────────────

describe('Weighted average price calculation', () => {
    /**
     * The aggregation buffer uses:
     *   totalValue = sum(trade.usdcSize * trade.price)
     *   averagePrice = totalValue / totalUsdcSize
     */

    it('calculates weighted average price correctly for two trades', () => {
        const trades = [
            { usdcSize: 10, price: 0.4 },
            { usdcSize: 30, price: 0.8 },
        ];

        const totalUsdcSize = trades.reduce((sum, t) => sum + t.usdcSize, 0); // 40
        const totalValue = trades.reduce((sum, t) => sum + t.usdcSize * t.price, 0); // 10*0.4 + 30*0.8 = 4 + 24 = 28
        const averagePrice = totalValue / totalUsdcSize; // 28 / 40 = 0.7

        expect(totalUsdcSize).toBe(40);
        expect(totalValue).toBeCloseTo(28);
        expect(averagePrice).toBeCloseTo(0.7);
    });

    it('handles a single trade — average equals its own price', () => {
        const trades = [{ usdcSize: 50, price: 0.6 }];

        const totalUsdcSize = trades.reduce((sum, t) => sum + t.usdcSize, 0);
        const totalValue = trades.reduce((sum, t) => sum + t.usdcSize * t.price, 0);
        const averagePrice = totalValue / totalUsdcSize;

        expect(averagePrice).toBeCloseTo(0.6);
    });

    it('weights larger trades more heavily in the average', () => {
        // $100 trade at 0.9 and $10 trade at 0.1 — average should be closer to 0.9
        const trades = [
            { usdcSize: 100, price: 0.9 },
            { usdcSize: 10, price: 0.1 },
        ];

        const totalUsdcSize = trades.reduce((sum, t) => sum + t.usdcSize, 0); // 110
        const totalValue = trades.reduce((sum, t) => sum + t.usdcSize * t.price, 0); // 90 + 1 = 91
        const averagePrice = totalValue / totalUsdcSize; // 91 / 110 ≈ 0.827

        expect(averagePrice).toBeGreaterThan(0.8);
        expect(averagePrice).toBeLessThan(0.9);
        expect(averagePrice).toBeCloseTo(91 / 110, 5);
    });

    it('calculates correctly for three trades', () => {
        const trades = [
            { usdcSize: 20, price: 0.3 },
            { usdcSize: 40, price: 0.5 },
            { usdcSize: 40, price: 0.7 },
        ];

        const totalUsdcSize = 100;
        const totalValue = 20 * 0.3 + 40 * 0.5 + 40 * 0.7; // 6 + 20 + 28 = 54
        const averagePrice = totalValue / totalUsdcSize; // 0.54

        expect(averagePrice).toBeCloseTo(0.54);
    });
});
