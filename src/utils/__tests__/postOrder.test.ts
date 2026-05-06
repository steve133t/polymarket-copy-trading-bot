import { getUserActivityModel } from '../../models/userHistory';
import { calculateOrderSize } from '../../config/copyStrategy';

// Mock logger
jest.mock('../logger', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        success: jest.fn(),
        orderResult: jest.fn(),
        separator: jest.fn(),
    },
}));

// Mock ENV — start with PREVIEW_MODE=true; individual tests override via jest.resetModules
jest.mock('../../config/env', () => ({
    ENV: {
        PREVIEW_MODE: true,
        RETRY_LIMIT: 3,
        COPY_STRATEGY_CONFIG: {
            strategy: 'FIXED',
            copySize: 10,
            maxOrderSizeUSD: 100,
            minOrderSizeUSD: 1,
        },
        TRADE_MULTIPLIER: 1.0,
        COPY_PERCENTAGE: 10,
    },
}));

// Mock getUserActivityModel
jest.mock('../../models/userHistory', () => ({
    getUserActivityModel: jest.fn(),
}));

// Mock copyStrategy
jest.mock('../../config/copyStrategy', () => ({
    calculateOrderSize: jest.fn(),
    getTradeMultiplier: jest.fn().mockReturnValue(1.0),
    CopyStrategy: { FIXED: 'FIXED', PERCENTAGE: 'PERCENTAGE', ADAPTIVE: 'ADAPTIVE' },
}));

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
    ...overrides,
});

const makePosition = (overrides: Record<string, unknown> = {}) => ({
    asset: 'asset-tok',
    conditionId: 'cond-1',
    size: 100,
    avgPrice: 0.5,
    currentValue: 50,
    curPrice: 0.5,
    ...overrides,
});

const makeUpdateOne = () => jest.fn().mockResolvedValue({});
const makeFind = (results: unknown[] = []) =>
    jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(results) });

const makeModel = (overrides: Record<string, unknown> = {}) => ({
    updateOne: makeUpdateOne(),
    find: makeFind(),
    updateMany: jest.fn().mockResolvedValue({}),
    ...overrides,
});

// ─── PREVIEW_MODE tests (default mock has PREVIEW_MODE=true) ─────────────────

describe('postOrder — PREVIEW_MODE=true', () => {
    let postOrder: (
        clobClient: unknown,
        condition: string,
        my_position: unknown,
        user_position: unknown,
        trade: unknown,
        my_balance: number,
        user_balance: number,
        userAddress: string
    ) => Promise<void>;

    let mockModel: ReturnType<typeof makeModel>;

    beforeEach(() => {
        jest.resetModules();

        // Re-apply mocks after resetModules
        jest.mock('../logger', () => ({
            __esModule: true,
            default: {
                info: jest.fn(),
                warning: jest.fn(),
                error: jest.fn(),
                success: jest.fn(),
                orderResult: jest.fn(),
                separator: jest.fn(),
            },
        }));
        jest.mock('../../config/env', () => ({
            ENV: {
                PREVIEW_MODE: true,
                RETRY_LIMIT: 3,
                COPY_STRATEGY_CONFIG: {
                    strategy: 'FIXED',
                    copySize: 10,
                    maxOrderSizeUSD: 100,
                    minOrderSizeUSD: 1,
                },
                TRADE_MULTIPLIER: 1.0,
                COPY_PERCENTAGE: 10,
            },
        }));
        jest.mock('../../models/userHistory', () => ({
            getUserActivityModel: jest.fn(),
        }));
        jest.mock('../../config/copyStrategy', () => ({
            calculateOrderSize: jest.fn().mockReturnValue({
                finalAmount: 10,
                reasoning: 'FIXED $10',
                belowMinimum: false,
                cappedByMax: false,
                reducedByBalance: false,
            }),
            getTradeMultiplier: jest.fn().mockReturnValue(1.0),
            CopyStrategy: { FIXED: 'FIXED', PERCENTAGE: 'PERCENTAGE', ADAPTIVE: 'ADAPTIVE' },
        }));

        mockModel = makeModel({ find: makeFind([]) });
        // After resetModules the top-level import is stale; require fresh module
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getUserActivityModel: getMock } = require('../../models/userHistory');
        (getMock as jest.Mock).mockReturnValue(mockModel);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        postOrder = require('../postOrder').default;
    });

    it('BUY in preview: updateOne called with previewMode fields', async () => {
        const trade = makeTrade({ side: 'BUY', price: 0.5, usdcSize: 20 });

        await postOrder(
            {},
            'buy',
            undefined,
            undefined,
            trade,
            100,
            50,
            '0xuser'
        );

        expect(mockModel.updateOne).toHaveBeenCalledWith(
            { _id: trade._id },
            {
                $set: expect.objectContaining({
                    bot: true,
                    previewMode: true,
                    botCopySize: expect.any(Number),
                    botCopyTokens: expect.any(Number),
                    botCopyPrice: trade.price,
                }),
            }
        );
    });

    it('SELL in preview with no previous trades: botCopyTokens=0', async () => {
        // find returns empty array (no previous preview trades)
        mockModel.find = makeFind([]);

        const trade = makeTrade({ side: 'SELL', price: 0.5, usdcSize: 10, size: 5 });
        const userPos = makePosition({ size: 10 });

        await postOrder(
            {},
            'sell',
            undefined,
            userPos,
            trade,
            100,
            50,
            '0xuser'
        );

        expect(mockModel.updateOne).toHaveBeenCalledWith(
            { _id: trade._id },
            {
                $set: expect.objectContaining({
                    bot: true,
                    previewMode: true,
                    botCopyTokens: 0,
                }),
            }
        );
    });
});

// ─── Live mode tests (PREVIEW_MODE=false) ────────────────────────────────────

describe('postOrder — PREVIEW_MODE=false', () => {
    let postOrder: (
        clobClient: unknown,
        condition: string,
        my_position: unknown,
        user_position: unknown,
        trade: unknown,
        my_balance: number,
        user_balance: number,
        userAddress: string
    ) => Promise<void>;

    let mockModel: ReturnType<typeof makeModel>;
    let mockClobClient: {
        getOrderBook: jest.Mock;
        createOrder: jest.Mock;
        postOrder: jest.Mock;
    };

    const setupLiveMode = (
        modelOverrides: Record<string, unknown> = {},
        orderBookOverrides: { asks?: unknown[]; bids?: unknown[] } = {}
    ) => {
        jest.resetModules();

        jest.mock('../logger', () => ({
            __esModule: true,
            default: {
                info: jest.fn(),
                warning: jest.fn(),
                error: jest.fn(),
                success: jest.fn(),
                orderResult: jest.fn(),
                separator: jest.fn(),
            },
        }));
        jest.mock('../../config/env', () => ({
            ENV: {
                PREVIEW_MODE: false,
                RETRY_LIMIT: 3,
                COPY_STRATEGY_CONFIG: {
                    strategy: 'FIXED',
                    copySize: 10,
                    maxOrderSizeUSD: 100,
                    minOrderSizeUSD: 1,
                },
                TRADE_MULTIPLIER: 1.0,
                COPY_PERCENTAGE: 10,
            },
        }));
        jest.mock('../../models/userHistory', () => ({
            getUserActivityModel: jest.fn(),
        }));
        jest.mock('../../config/copyStrategy', () => ({
            calculateOrderSize: jest.fn().mockReturnValue({
                finalAmount: 10,
                reasoning: 'FIXED $10',
                belowMinimum: false,
                cappedByMax: false,
                reducedByBalance: false,
            }),
            getTradeMultiplier: jest.fn().mockReturnValue(1.0),
            CopyStrategy: { FIXED: 'FIXED', PERCENTAGE: 'PERCENTAGE', ADAPTIVE: 'ADAPTIVE' },
        }));

        const defaultAsks = [{ price: '0.5', size: '100' }];
        const defaultBids = [{ price: '0.5', size: '100' }];

        mockClobClient = {
            getOrderBook: jest.fn().mockResolvedValue({
                asks: orderBookOverrides.asks !== undefined ? orderBookOverrides.asks : defaultAsks,
                bids: orderBookOverrides.bids !== undefined ? orderBookOverrides.bids : defaultBids,
            }),
            createOrder: jest.fn().mockResolvedValue({}),
            postOrder: jest.fn().mockResolvedValue({ success: true }),
        };

        mockModel = makeModel({ find: makeFind([]), ...modelOverrides });
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getUserActivityModel: getMock } = require('../../models/userHistory');
        (getMock as jest.Mock).mockReturnValue(mockModel);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        postOrder = require('../postOrder').default;
    };

    it('BUY success: updateOne called with myBoughtSize', async () => {
        setupLiveMode();

        const trade = makeTrade({ side: 'BUY', price: 0.5, usdcSize: 20 });

        await postOrder(
            mockClobClient,
            'buy',
            undefined,
            undefined,
            trade,
            100,
            50,
            '0xuser'
        );

        expect(mockModel.updateOne).toHaveBeenCalledWith(
            { _id: trade._id },
            expect.objectContaining({ bot: true, myBoughtSize: expect.any(Number) })
        );
    });

    it('BUY all retries exhausted: updateOne called with botExcutedTime=3', async () => {
        setupLiveMode();
        // All order posts fail without a balance error
        mockClobClient.postOrder.mockResolvedValue({ success: false, error: 'order failed' });

        const trade = makeTrade({ side: 'BUY', price: 0.5, usdcSize: 20 });

        await postOrder(
            mockClobClient,
            'buy',
            undefined,
            undefined,
            trade,
            100,
            50,
            '0xuser'
        );

        expect(mockModel.updateOne).toHaveBeenCalledWith(
            { _id: trade._id },
            expect.objectContaining({ bot: true, botExcutedTime: 3 })
        );
    });

    it('BUY price slippage too high: updateOne called with { bot: true } only', async () => {
        setupLiveMode({}, { asks: [{ price: '0.99', size: '100' }] });

        // trade.price = 0.5, market ask = 0.99, diff > 0.05 → slippage skip
        const trade = makeTrade({ side: 'BUY', price: 0.5, usdcSize: 20 });

        await postOrder(
            mockClobClient,
            'buy',
            undefined,
            undefined,
            trade,
            100,
            50,
            '0xuser'
        );

        expect(mockModel.updateOne).toHaveBeenCalledWith(
            { _id: trade._id },
            { bot: true }
        );
    });

    it('BUY insufficient balance error: updateOne called with botExcutedTime=3', async () => {
        setupLiveMode();
        mockClobClient.postOrder.mockResolvedValue({
            success: false,
            error: 'not enough balance to execute',
        });

        const trade = makeTrade({ side: 'BUY', price: 0.5, usdcSize: 20 });

        await postOrder(
            mockClobClient,
            'buy',
            undefined,
            undefined,
            trade,
            100,
            50,
            '0xuser'
        );

        expect(mockModel.updateOne).toHaveBeenCalledWith(
            { _id: trade._id },
            expect.objectContaining({ bot: true, botExcutedTime: 3 })
        );
    });

    it('SELL no position: updateOne called with { bot: true }', async () => {
        setupLiveMode();

        const trade = makeTrade({ side: 'SELL', price: 0.5, usdcSize: 10, size: 5 });

        await postOrder(
            mockClobClient,
            'sell',
            undefined, // no my_position
            undefined,
            trade,
            100,
            50,
            '0xuser'
        );

        expect(mockModel.updateOne).toHaveBeenCalledWith(
            { _id: trade._id },
            { bot: true }
        );
    });

    it('SELL success: updateOne called with { bot: true }', async () => {
        setupLiveMode();

        const trade = makeTrade({ side: 'SELL', price: 0.5, usdcSize: 10, size: 5 });
        const myPos = makePosition({ size: 20, avgPrice: 0.5 });
        const userPos = makePosition({ size: 10 });

        await postOrder(
            mockClobClient,
            'sell',
            myPos,
            userPos,
            trade,
            100,
            50,
            '0xuser'
        );

        // Should update with bot: true after successful sell
        expect(mockModel.updateOne).toHaveBeenCalledWith(
            { _id: trade._id },
            { bot: true }
        );
    });

    it('MERGE no position: updateOne called with { bot: true }', async () => {
        setupLiveMode();

        const trade = makeTrade({ side: 'SELL', price: 0.5, usdcSize: 10, size: 5 });

        await postOrder(
            mockClobClient,
            'merge',
            undefined, // no my_position
            undefined,
            trade,
            100,
            50,
            '0xuser'
        );

        expect(mockModel.updateOne).toHaveBeenCalledWith(
            { _id: trade._id },
            { bot: true }
        );
    });
});
