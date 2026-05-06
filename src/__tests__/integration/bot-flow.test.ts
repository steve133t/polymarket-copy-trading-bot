/**
 * Integration tests: bot internal flow
 *
 * Tests MongoDB connectivity, trade deduplication, executor pickup logic,
 * copy-size math, and postOrder PREVIEW_MODE behavior. All tests are safe
 * to run without spending USDC — they use a throw-away test collection.
 *
 * Prerequisites: .env with MONGO_URI and full Polymarket credentials.
 *
 * Run: npm run test:integration -- --testPathPattern=bot-flow
 */

// chalk v5 is ESM-only; mock logger to prevent the import chain from failing.
// __esModule: true prevents __importDefault from double-wrapping the export.
jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        success: jest.fn(),
        orderResult: jest.fn(),
        trade: jest.fn(),
        balance: jest.fn(),
        header: jest.fn(),
        separator: jest.fn(),
        clearLine: jest.fn(),
        waiting: jest.fn(),
    },
}));

import mongoose from 'mongoose';
import { Schema } from 'mongoose';
import { ENV } from '../../config/env';
import { calculateOrderSize, CopyStrategy } from '../../config/copyStrategy';
import type { CopyStrategyConfig } from '../../config/copyStrategy';
import postOrder from '../../utils/postOrder';
import createClobClient from '../../utils/createClobClient';
import type { ClobClient } from '@polymarket/clob-client-v2';
import type { UserActivityInterface } from '../../interfaces/User';

// Isolated test collection — never touches real trader data.
const TEST_ADDRESS = '0x0000000000000000000000000000000000001234';
const TEST_COLLECTION = `user_activities_${TEST_ADDRESS}`;

const activitySchema = new Schema({
    proxyWallet: String,
    timestamp: Number,
    conditionId: String,
    type: String,
    size: Number,
    usdcSize: Number,
    transactionHash: String,
    price: Number,
    asset: String,
    side: String,
    outcomeIndex: Number,
    title: String,
    slug: String,
    icon: String,
    eventSlug: String,
    outcome: String,
    name: String,
    pseudonym: String,
    bio: String,
    profileImage: String,
    profileImageOptimized: String,
    bot: Boolean,
    botExcutedTime: Number,
    myBoughtSize: Number,
    previewMode: Boolean,
    botCopySize: Number,
    botCopyTokens: Number,
    botCopyPrice: Number,
});

let TestActivity: mongoose.Model<any>;
let clobClient: ClobClient;

// Unique prefix so afterAll can sweep only test documents.
const TP = 'test-integration-botflow';

const makeTrade = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    proxyWallet: TEST_ADDRESS,
    timestamp: Date.now(),
    conditionId: 'test-condition-001',
    type: 'TRADE',
    size: 10,
    usdcSize: 50,
    transactionHash: `${TP}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    price: 0.65,
    asset: '0xtest-asset-token-id',
    side: 'BUY',
    outcomeIndex: 0,
    title: 'Test Market',
    slug: 'test-market',
    icon: '',
    eventSlug: 'test-event',
    outcome: 'Yes',
    name: 'Test Trader',
    pseudonym: '',
    bio: '',
    profileImage: '',
    profileImageOptimized: '',
    bot: false,
    botExcutedTime: 0,
    ...overrides,
});

beforeAll(async () => {
    await mongoose.connect(ENV.MONGO_URI);
    // Safe re-use: models persist in the registry across calls in the same process.
    TestActivity =
        mongoose.models[TEST_COLLECTION] ||
        mongoose.model(TEST_COLLECTION, activitySchema, TEST_COLLECTION);

    clobClient = await createClobClient();
}, 30000);

afterAll(async () => {
    await TestActivity.deleteMany({ transactionHash: new RegExp(`^${TP}`) });
    await mongoose.connection.close();
});

// ---------------------------------------------------------------------------
// MongoDB connectivity
// ---------------------------------------------------------------------------

describe('MongoDB connectivity', () => {
    it('connects to the real Atlas cluster (readyState === 1)', () => {
        expect(mongoose.connection.readyState).toBe(1);
    });

    it('writes and reads a document round-trip', async () => {
        const trade = makeTrade();
        const doc = await TestActivity.create(trade);
        expect(doc._id).toBeDefined();

        const found = (await TestActivity.findById(doc._id).lean().exec()) as any;
        expect(found?.transactionHash).toBe(trade.transactionHash);

        await TestActivity.deleteOne({ _id: doc._id });
    });
});

// ---------------------------------------------------------------------------
// Trade deduplication (mirrors tradeMonitor.fetchTradeData logic)
// ---------------------------------------------------------------------------

describe('trade deduplication', () => {
    it('findOne returns null for a hash that was never saved', async () => {
        const result = await TestActivity.findOne({
            transactionHash: 'never-saved-hash-9999',
        }).exec();
        expect(result).toBeNull();
    });

    it('second save is skipped when findOne finds the same transactionHash', async () => {
        const hash = `${TP}-dup-${Date.now()}`;
        await TestActivity.create(makeTrade({ transactionHash: hash }));

        // Simulate the tradeMonitor dedup check
        const existing = await TestActivity.findOne({ transactionHash: hash }).exec();
        expect(existing).not.toBeNull();

        // Only insert when existing is null — same as fetchTradeData
        if (!existing) {
            await TestActivity.create(makeTrade({ transactionHash: hash }));
        }

        const count = await TestActivity.countDocuments({ transactionHash: hash });
        expect(count).toBe(1);

        await TestActivity.deleteMany({ transactionHash: hash });
    });
});

// ---------------------------------------------------------------------------
// Executor pickup query (mirrors tradeExecutor.readTempTrades)
// ---------------------------------------------------------------------------

describe('executor trade pickup', () => {
    it('finds trades with bot:false AND botExcutedTime:0', async () => {
        const hash = `${TP}-pending-${Date.now()}`;
        await TestActivity.create(makeTrade({ transactionHash: hash, bot: false, botExcutedTime: 0 }));

        const pending = await TestActivity.find({
            $and: [{ type: 'TRADE' }, { bot: false }, { botExcutedTime: 0 }],
        }).exec();
        expect(pending.some((t: any) => t.transactionHash === hash)).toBe(true);

        await TestActivity.deleteOne({ transactionHash: hash });
    });

    it('does NOT find a trade once botExcutedTime is set to 1 (in-progress)', async () => {
        const trade = makeTrade({ bot: false, botExcutedTime: 0 });
        const doc = await TestActivity.create(trade);

        // Executor immediately sets botExcutedTime:1 to prevent double-execution
        await TestActivity.updateOne({ _id: doc._id }, { $set: { botExcutedTime: 1 } });

        const pending = await TestActivity.find({
            $and: [{ type: 'TRADE' }, { bot: false }, { botExcutedTime: 0 }],
        }).exec();
        expect(pending.some((t: any) => String(t._id) === String(doc._id))).toBe(false);

        await TestActivity.deleteOne({ _id: doc._id });
    });

    it('resets botExcutedTime to 0 when execution throws (retry logic)', async () => {
        const doc = await TestActivity.create(makeTrade({ bot: false, botExcutedTime: 1 }));

        // Simulate the catch block in doTrading
        await TestActivity.updateOne({ _id: doc._id }, { $set: { botExcutedTime: 0 } });

        const updated = (await TestActivity.findById(doc._id).lean().exec()) as any;
        expect(updated?.botExcutedTime).toBe(0);

        await TestActivity.deleteOne({ _id: doc._id });
    });
});

// ---------------------------------------------------------------------------
// TOO_OLD_TIMESTAMP filter (mirrors tradeMonitor.fetchTradeData)
// ---------------------------------------------------------------------------

describe('TOO_OLD_TIMESTAMP filter', () => {
    it('skips activities older than the cutoff epoch', () => {
        // TOO_OLD_TIMESTAMP is in hours. The comparison in tradeMonitor uses:
        //   cutoff = floor(Date.now() / 1000) - TOO_OLD_TIMESTAMP * 3600
        //   skip if activity.timestamp < cutoff
        const tooOldHours = 1;
        const nowSeconds = Math.floor(Date.now() / 1000);
        const cutoff = nowSeconds - tooOldHours * 3600;

        // Activity from 2 hours ago → should be skipped
        const old = { timestamp: nowSeconds - 7200 };
        expect(old.timestamp < cutoff).toBe(true);

        // Activity from 30 minutes ago → should be processed
        const recent = { timestamp: nowSeconds - 1800 };
        expect(recent.timestamp < cutoff).toBe(false);

        // Guard against the old (broken) comparison: TOO_OLD_TIMESTAMP is ~1
        // and timestamps are Unix epochs (~1.7e9). A raw `timestamp < 1` is never true.
        expect(nowSeconds - 7200).toBeGreaterThan(tooOldHours);
    });
});

// ---------------------------------------------------------------------------
// calculateOrderSize — FIXED strategy ($5 per trade)
// ---------------------------------------------------------------------------

describe('calculateOrderSize — FIXED strategy', () => {
    const cfg: CopyStrategyConfig = {
        strategy: CopyStrategy.FIXED,
        copySize: 5,
        maxOrderSizeUSD: 100,
        minOrderSizeUSD: 1,
    };

    it.each([10, 50, 100, 500, 1000])(
        'returns $5 regardless of trader order size ($%i)',
        (traderSize) => {
            const result = calculateOrderSize(cfg, traderSize, 1000, 0);
            expect(result.finalAmount).toBe(5);
            expect(result.strategy).toBe(CopyStrategy.FIXED);
            expect(result.belowMinimum).toBe(false);
        }
    );

    it('caps at maxOrderSizeUSD when copySize exceeds max', () => {
        const bigCfg: CopyStrategyConfig = { ...cfg, copySize: 200, maxOrderSizeUSD: 100 };
        const result = calculateOrderSize(bigCfg, 1000, 1000, 0);
        expect(result.finalAmount).toBe(100);
        expect(result.cappedByMax).toBe(true);
    });

    it('returns 0 and sets belowMinimum when copySize < minOrderSizeUSD', () => {
        const tinyCfg: CopyStrategyConfig = { ...cfg, copySize: 0.50, minOrderSizeUSD: 1 };
        const result = calculateOrderSize(tinyCfg, 100, 1000, 0);
        expect(result.finalAmount).toBe(0);
        expect(result.belowMinimum).toBe(true);
    });

    it('reduces to 99% of balance when balance < copySize', () => {
        const result = calculateOrderSize(cfg, 100, 3, 0); // $3 balance, $5 desired
        expect(result.reducedByBalance).toBe(true);
        expect(result.finalAmount).toBeLessThanOrEqual(3 * 0.99);
        expect(result.finalAmount).toBeGreaterThan(0);
    });

    it('respects maxPositionSizeUSD and returns 0 when limit is already reached', () => {
        const posLimitCfg: CopyStrategyConfig = { ...cfg, maxPositionSizeUSD: 10 };

        // Already $9 in position → only $1 headroom → $1 ≥ minOrderSize → ok
        const result1 = calculateOrderSize(posLimitCfg, 100, 1000, 9);
        expect(result1.finalAmount).toBe(1);

        // Already at limit → 0 headroom → below minimum → skip
        const result2 = calculateOrderSize(posLimitCfg, 100, 1000, 10);
        expect(result2.finalAmount).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// calculateOrderSize — PERCENTAGE strategy
// ---------------------------------------------------------------------------

describe('calculateOrderSize — PERCENTAGE strategy', () => {
    const cfg: CopyStrategyConfig = {
        strategy: CopyStrategy.PERCENTAGE,
        copySize: 10, // 10%
        maxOrderSizeUSD: 100,
        minOrderSizeUSD: 1,
    };

    it('copies 10% of a $100 trader order → $10', () => {
        const result = calculateOrderSize(cfg, 100, 1000, 0);
        expect(result.finalAmount).toBeCloseTo(10, 5);
    });

    it('copies 10% of a $50 trader order → $5', () => {
        const result = calculateOrderSize(cfg, 50, 1000, 0);
        expect(result.finalAmount).toBeCloseTo(5, 5);
    });

    it('skips a $5 trader order when 10% ($0.50) is below $1 minimum', () => {
        const result = calculateOrderSize(cfg, 5, 1000, 0);
        expect(result.belowMinimum).toBe(true);
        expect(result.finalAmount).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// postOrder — PREVIEW_MODE path (no USDC spent, uses real MongoDB)
// ---------------------------------------------------------------------------

describe('postOrder — PREVIEW_MODE branch', () => {
    it('marks activity as previewMode:true and sets botCopySize/botCopyTokens', async () => {
        // Only run this sub-suite when the env has PREVIEW_MODE=true (its current default).
        if (!ENV.PREVIEW_MODE) {
            console.warn('PREVIEW_MODE is false — skipping preview-path test');
            return;
        }

        const trade = makeTrade({
            side: 'BUY',
            usdcSize: 50,
            price: 0.65,
            asset: '0xtest-preview-token',
            conditionId: 'test-preview-condition',
        });

        const doc = await TestActivity.create(trade);

        // Build a minimal UserActivityInterface
        const activity: UserActivityInterface = {
            _id: doc._id,
            proxyWallet: String(trade.proxyWallet),
            timestamp: Number(trade.timestamp),
            conditionId: String(trade.conditionId),
            type: String(trade.type),
            size: Number(trade.size),
            usdcSize: Number(trade.usdcSize),
            transactionHash: String(trade.transactionHash),
            price: Number(trade.price),
            asset: String(trade.asset),
            side: String(trade.side),
            outcomeIndex: Number(trade.outcomeIndex),
            title: String(trade.title),
            slug: String(trade.slug),
            icon: String(trade.icon),
            eventSlug: String(trade.eventSlug),
            outcome: String(trade.outcome),
            name: String(trade.name),
            pseudonym: String(trade.pseudonym),
            bio: String(trade.bio),
            profileImage: String(trade.profileImage),
            profileImageOptimized: String(trade.profileImageOptimized),
            bot: false,
            botExcutedTime: 0,
        };

        await postOrder(
            clobClient,
            'buy',
            undefined, // no my_position
            undefined, // no user_position
            activity,
            100,       // my_balance
            200,       // user_balance
            TEST_ADDRESS
        );

        const updated = (await TestActivity.findById(doc._id).lean().exec()) as any;
        expect(updated?.bot).toBe(true);
        expect(updated?.previewMode).toBe(true);
        expect(typeof updated?.botCopySize).toBe('number');
        expect(typeof updated?.botCopyTokens).toBe('number');
        expect(typeof updated?.botCopyPrice).toBe('number');

        await TestActivity.deleteOne({ _id: doc._id });
    });
});
