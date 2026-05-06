import { trySellPosition } from '../autoResolver';

// Mock logger
jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        success: jest.fn(),
        header: jest.fn(),
        separator: jest.fn(),
        orderResult: jest.fn(),
    },
}));

// Mock ENV
jest.mock('../../config/env', () => ({
    ENV: {
        PROXY_WALLET: '0xtest',
        PRIVATE_KEY: 'deadbeef'.repeat(8),
        RPC_URL: 'http://localhost:8545',
        RETRY_LIMIT: 2,
        AUTO_RESOLVE_ENABLED: true,
        AUTO_RESOLVE_INTERVAL: 60,
        USDC_CONTRACT_ADDRESS: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
    },
}));

// Mock fetchData to avoid network calls
jest.mock('../../utils/fetchData', () => jest.fn().mockResolvedValue([]));

// Mock ethers to avoid real provider/wallet construction
jest.mock('ethers', () => {
    const actualEthers = jest.requireActual('ethers');
    return {
        ...actualEthers,
        ethers: {
            ...actualEthers.ethers,
            providers: {
                JsonRpcProvider: jest.fn().mockImplementation(() => ({
                    getFeeData: jest.fn().mockResolvedValue({ gasPrice: { mul: jest.fn().mockReturnValue({ div: jest.fn().mockReturnValue(BigInt(1)) }) } }),
                })),
            },
            Wallet: jest.fn().mockImplementation(() => ({})),
            Contract: jest.fn().mockImplementation(() => ({
                redeemPositions: jest.fn().mockResolvedValue({ hash: '0xtx', wait: jest.fn().mockResolvedValue({ status: 1, gasUsed: BigInt(100000) }) }),
            })),
        },
    };
});

// ─── helpers ──────────────────────────────────────────────────────────────────

const makePosition = (overrides: Partial<{
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    currentValue: number;
    curPrice: number;
    redeemable: boolean;
}> = {}) => ({
    asset: 'tok1',
    conditionId: 'c1',
    size: 5,
    avgPrice: 0.9,
    currentValue: 4.5,
    curPrice: 0.99,
    redeemable: true,
    ...overrides,
});

// ─── trySellPosition tests ────────────────────────────────────────────────────

describe('trySellPosition', () => {
    it('skips positions below MIN_SELL_TOKENS (1.0)', async () => {
        const position = makePosition({ size: 0.5 });
        const fakeClient = { getOrderBook: jest.fn(), updateBalanceAllowance: jest.fn().mockResolvedValue({}) };

        const result = await trySellPosition(fakeClient as any, position);

        expect(result.sold).toBe(0);
        expect(result.proceeds).toBe(0);
        // getOrderBook should NOT be called because we return early
        expect(fakeClient.getOrderBook).not.toHaveBeenCalled();
    });

    it('returns orderbookAvailable=true with sold=0 when position is below minimum', async () => {
        const position = makePosition({ size: 0.9 });
        const fakeClient = { getOrderBook: jest.fn(), updateBalanceAllowance: jest.fn().mockResolvedValue({}) };

        const result = await trySellPosition(fakeClient as any, position);

        expect(result.orderbookAvailable).toBe(true);
        expect(result.sold).toBe(0);
    });

    it('marks orderbookAvailable=false when getOrderBook throws', async () => {
        const position = makePosition({ size: 5 });
        const fakeClient = {
            getOrderBook: jest.fn().mockRejectedValue(new Error('Market closed')),
            updateBalanceAllowance: jest.fn().mockResolvedValue({}),
        };

        const result = await trySellPosition(fakeClient as any, position);

        expect(result.orderbookAvailable).toBe(false);
        expect(result.sold).toBe(0);
    });

    it('marks orderbookAvailable=false when order book has no bids', async () => {
        const position = makePosition({ size: 5 });
        const fakeClient = {
            getOrderBook: jest.fn().mockResolvedValue({ bids: [] }),
            updateBalanceAllowance: jest.fn().mockResolvedValue({}),
        };

        const result = await trySellPosition(fakeClient as any, position);

        expect(result.orderbookAvailable).toBe(false);
        expect(result.sold).toBe(0);
    });

    it('marks orderbookAvailable=false when bids is undefined', async () => {
        const position = makePosition({ size: 5 });
        const fakeClient = {
            getOrderBook: jest.fn().mockResolvedValue({}),
            updateBalanceAllowance: jest.fn().mockResolvedValue({}),
        };

        const result = await trySellPosition(fakeClient as any, position);

        expect(result.orderbookAvailable).toBe(false);
        expect(result.sold).toBe(0);
    });

    it('attempts sell when bids are available and returns sold > 0 on success', async () => {
        const position = makePosition({ size: 5, asset: 'tok1' });
        const fakeClient = {
            getOrderBook: jest.fn().mockResolvedValue({
                bids: [{ price: '0.95', size: '10' }],
            }),
            updateBalanceAllowance: jest.fn().mockResolvedValue({}),
            createMarketOrder: jest.fn().mockResolvedValue({}),
            postOrder: jest.fn().mockResolvedValue({ success: true }),
        };

        const result = await trySellPosition(fakeClient as any, position);

        expect(result.sold).toBeGreaterThan(0);
        expect(result.proceeds).toBeGreaterThan(0);
        expect(result.orderbookAvailable).toBe(true);
    });

    it('exhausts retries and returns sold=0 when all orders fail', async () => {
        const position = makePosition({ size: 5 });
        const fakeClient = {
            getOrderBook: jest.fn().mockResolvedValue({
                bids: [{ price: '0.95', size: '10' }],
            }),
            updateBalanceAllowance: jest.fn().mockResolvedValue({}),
            createMarketOrder: jest.fn().mockResolvedValue({}),
            postOrder: jest.fn().mockResolvedValue({ success: false, error: 'generic failure' }),
        };

        const result = await trySellPosition(fakeClient as any, position);

        // RETRY_LIMIT = 2, so postOrder called 2 times and sold=0
        expect(fakeClient.postOrder).toHaveBeenCalledTimes(2);
        expect(result.sold).toBe(0);
    });
});

// ─── Resolved position threshold logic ───────────────────────────────────────

describe('Resolved position detection threshold logic', () => {
    const RESOLVED_HIGH = 0.99;
    const RESOLVED_LOW = 0.01;

    it('identifies a WIN position (curPrice >= 0.99)', () => {
        const positions = [
            { curPrice: 0.99 },
            { curPrice: 1.0 },
            { curPrice: 0.995 },
        ];

        for (const pos of positions) {
            expect(pos.curPrice >= RESOLVED_HIGH).toBe(true);
        }
    });

    it('identifies a LOSS position (curPrice <= 0.01)', () => {
        const positions = [
            { curPrice: 0.01 },
            { curPrice: 0.0 },
            { curPrice: 0.005 },
        ];

        for (const pos of positions) {
            expect(pos.curPrice <= RESOLVED_LOW).toBe(true);
        }
    });

    it('does not classify mid-range positions as resolved', () => {
        const positions = [
            { curPrice: 0.5 },
            { curPrice: 0.02 },
            { curPrice: 0.98 },
        ];

        for (const pos of positions) {
            const isResolved = pos.curPrice >= RESOLVED_HIGH || pos.curPrice <= RESOLVED_LOW;
            expect(isResolved).toBe(false);
        }
    });

    it('correctly filters a mixed list for resolved positions', () => {
        const allPositions = [
            { curPrice: 0.99, asset: 'win' },
            { curPrice: 0.5, asset: 'mid' },
            { curPrice: 0.01, asset: 'loss' },
            { curPrice: 0.75, asset: 'mid2' },
        ];

        const resolved = allPositions.filter(
            (p) => p.curPrice >= RESOLVED_HIGH || p.curPrice <= RESOLVED_LOW
        );

        expect(resolved).toHaveLength(2);
        expect(resolved.map((p) => p.asset)).toEqual(['win', 'loss']);
    });
});
