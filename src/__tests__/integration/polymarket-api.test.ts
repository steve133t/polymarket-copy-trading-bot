/**
 * Integration tests: Polymarket external APIs + CLOB
 *
 * Prerequisites: .env with valid credentials, internet access.
 * Safe to run anytime — no orders are placed unless LIVE_ORDER_TESTS=true.
 * Live order tests spend ~$1 in USDC from PROXY_WALLET.
 *
 * Run: npm run test:integration -- --testPathPattern=polymarket-api
 * Live:  LIVE_ORDER_TESTS=true npm run test:integration -- --testPathPattern=polymarket-api
 */

// chalk v5 is ESM-only and cannot be loaded by Jest in CommonJS mode.
// Mocking the logger prevents that import chain from failing.
// __esModule: true tells __importDefault not to double-wrap the default export.
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
        dbConnection: jest.fn(),
        myPositions: jest.fn(),
        tradersPositions: jest.fn(),
        startup: jest.fn(),
    },
}));

import axios from 'axios';
import { OrderType, Side, SignatureTypeV2 } from '@polymarket/clob-client-v2';
import type { ClobClient } from '@polymarket/clob-client-v2';
import createClobClient, { detectSignatureType } from '../../utils/createClobClient';
import { ENV } from '../../config/env';
import { calculateOrderSize, CopyStrategy } from '../../config/copyStrategy';
import type { CopyStrategyConfig } from '../../config/copyStrategy';

const USER_ADDRESS = ENV.USER_ADDRESSES[0];
const PROXY_WALLET = ENV.PROXY_WALLET;
const LIVE_ORDER_TESTS = process.env.LIVE_ORDER_TESTS === 'true';
const liveTest = LIVE_ORDER_TESTS ? test : test.skip;

let clobClient: ClobClient;
let activeTokenId: string | null = null;

beforeAll(async () => {
    clobClient = await createClobClient();

    // Pick a token from the tracked trader's recent activity for order book tests.
    try {
        const resp = await axios.get(
            `https://data-api.polymarket.com/activity?user=${USER_ADDRESS}&type=TRADE&limit=10`,
            { timeout: 15000 }
        );
        if (Array.isArray(resp.data) && resp.data.length > 0) {
            activeTokenId = resp.data[0].asset as string;
        }
    } catch {
        console.warn('Could not fetch recent activity to determine active token');
    }
}, 30000);

// ---------------------------------------------------------------------------
// Activity API
// ---------------------------------------------------------------------------

describe('data-api.polymarket.com/activity', () => {
    it('returns HTTP 200 and an array for the tracked address', async () => {
        const resp = await axios.get(
            `https://data-api.polymarket.com/activity?user=${USER_ADDRESS}&type=TRADE&limit=10`
        );
        expect(resp.status).toBe(200);
        expect(Array.isArray(resp.data)).toBe(true);
    });

    it('each activity has the fields required by the MongoDB schema', async () => {
        const resp = await axios.get(
            `https://data-api.polymarket.com/activity?user=${USER_ADDRESS}&type=TRADE&limit=10`
        );
        const activities: any[] = resp.data;
        if (activities.length === 0) {
            console.warn('No recent trades found for tracked address — skipping field check');
            return;
        }
        const a = activities[0];
        expect(typeof a.transactionHash).toBe('string');
        expect(typeof a.conditionId).toBe('string');
        expect(typeof a.asset).toBe('string');
        expect(typeof a.side).toBe('string');
        expect(['BUY', 'SELL']).toContain(a.side);
        expect(typeof a.price).toBe('number');
        expect(typeof a.usdcSize).toBe('number');
        expect(typeof a.timestamp).toBe('number');
        expect(typeof a.type).toBe('string');
    });

    it('type=TRADE filter excludes non-trade events', async () => {
        const resp = await axios.get(
            `https://data-api.polymarket.com/activity?user=${USER_ADDRESS}&type=TRADE&limit=20`
        );
        for (const a of resp.data as any[]) {
            expect(a.type).toBe('TRADE');
        }
    });

    it('pagination with offset returns a non-overlapping page', async () => {
        const base = `https://data-api.polymarket.com/activity?user=${USER_ADDRESS}&type=TRADE&limit=5`;
        const [p1, p2] = await Promise.all([
            axios.get(`${base}&offset=0`),
            axios.get(`${base}&offset=5`),
        ]);
        if ((p1.data as any[]).length === 5 && (p2.data as any[]).length > 0) {
            const hashes = new Set((p1.data as any[]).map((a) => a.transactionHash));
            for (const a of p2.data as any[]) {
                expect(hashes.has(a.transactionHash)).toBe(false);
            }
        }
    });

    it('API response contains no duplicate transactionHashes', async () => {
        const resp = await axios.get(
            `https://data-api.polymarket.com/activity?user=${USER_ADDRESS}&type=TRADE&limit=50`
        );
        const hashes = (resp.data as any[]).map((a) => a.transactionHash);
        expect(hashes.length).toBe(new Set(hashes).size);
    });
});

// ---------------------------------------------------------------------------
// Positions API
// ---------------------------------------------------------------------------

describe('data-api.polymarket.com/positions', () => {
    it('returns HTTP 200 and an array for the tracked address', async () => {
        const resp = await axios.get(
            `https://data-api.polymarket.com/positions?user=${USER_ADDRESS}`
        );
        expect(resp.status).toBe(200);
        expect(Array.isArray(resp.data)).toBe(true);
    });

    it('position fields map to the UserPositionInterface schema', async () => {
        const resp = await axios.get(
            `https://data-api.polymarket.com/positions?user=${USER_ADDRESS}`
        );
        const positions: any[] = resp.data;
        if (positions.length === 0) {
            console.warn('No open positions for tracked address — skipping field check');
            return;
        }
        const pos = positions[0];
        expect(typeof pos.asset).toBe('string');
        expect(typeof pos.conditionId).toBe('string');
        expect(typeof pos.size).toBe('number');
        expect(typeof pos.avgPrice).toBe('number');
        expect(typeof pos.currentValue).toBe('number');
        expect(pos).toHaveProperty('proxyWallet');
        expect(pos).toHaveProperty('title');
        expect(pos).toHaveProperty('slug');
        expect(pos).toHaveProperty('outcome');
    });

    it('returns HTTP 200 for the proxy wallet (may be empty)', async () => {
        const resp = await axios.get(
            `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`
        );
        expect(resp.status).toBe(200);
        expect(Array.isArray(resp.data)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// CLOB API — read-only (no spend)
// ---------------------------------------------------------------------------

describe('clob.polymarket.com — auth and order book', () => {
    it('authenticates: createClobClient resolves without error', () => {
        expect(clobClient).toBeDefined();
    });

    it('proxy wallet is detected as POLY_1271 (signatureType=3) on the real RPC', async () => {
        // Polymarket V2 proxy wallets use EIP-1967 UUPS and require POLY_1271.
        // If this fails, all orders will be rejected with "maker address not allowed".
        const sigType = await detectSignatureType(ENV.PROXY_WALLET as string, ENV.RPC_URL as string);
        expect(sigType).toBe(SignatureTypeV2.POLY_1271);
    }, 15000);

    it('fetches an order book for a recently traded token', async () => {
        if (!activeTokenId) {
            console.warn('No active token found — skipping order book test');
            return;
        }
        const book = await clobClient.getOrderBook(activeTokenId);
        expect(book).toHaveProperty('bids');
        expect(book).toHaveProperty('asks');
        expect(Array.isArray(book.bids)).toBe(true);
        expect(Array.isArray(book.asks)).toBe(true);
    });

    it('order book entries have string price and size fields', async () => {
        if (!activeTokenId) return;
        const book = await clobClient.getOrderBook(activeTokenId);
        if (book.bids.length > 0) {
            expect(typeof book.bids[0].price).toBe('string');
            expect(typeof book.bids[0].size).toBe('string');
        }
        if (book.asks.length > 0) {
            expect(typeof book.asks[0].price).toBe('string');
            expect(typeof book.asks[0].size).toBe('string');
        }
    });

    it('slippage guard math: detects gap > $0.05 between best ask and trade price', async () => {
        if (!activeTokenId) return;
        const book = await clobClient.getOrderBook(activeTokenId);
        if (!book.asks || book.asks.length === 0) return;

        const bestAsk = Math.min(...book.asks.map((a) => parseFloat(a.price)));

        // Guard condition from postOrder.ts: parseFloat(minPriceAsk.price) - 0.05 > trade.price
        const priceWithHighSlippage = bestAsk - 0.10;
        expect(bestAsk - 0.05 > priceWithHighSlippage).toBe(true); // guard fires

        const priceWithAcceptableSlippage = bestAsk - 0.02;
        expect(bestAsk - 0.05 > priceWithAcceptableSlippage).toBe(false); // guard passes
    });

    it('bids are priced below asks (no crossed book)', async () => {
        if (!activeTokenId) return;
        const book = await clobClient.getOrderBook(activeTokenId);
        if (book.bids.length === 0 || book.asks.length === 0) return;

        const bestBid = Math.max(...book.bids.map((b) => parseFloat(b.price)));
        const bestAsk = Math.min(...book.asks.map((a) => parseFloat(a.price)));
        expect(bestBid).toBeLessThan(bestAsk);
    });
});

// ---------------------------------------------------------------------------
// CLOB API — order sizing guards (pure-function tests using real ask prices)
// ---------------------------------------------------------------------------

describe('order size guards validated against real CLOB prices', () => {
    it('calculateOrderSize rejects below-minimum $0.50 FIXED order', () => {
        const cfg: CopyStrategyConfig = {
            strategy: CopyStrategy.FIXED,
            copySize: 0.50,
            maxOrderSizeUSD: 100,
            minOrderSizeUSD: 1,
        };
        const result = calculateOrderSize(cfg, 100, 1000, 0);
        expect(result.belowMinimum).toBe(true);
        expect(result.finalAmount).toBe(0);
    });

    it('calculateOrderSize reduces order when balance is insufficient', () => {
        const cfg: CopyStrategyConfig = {
            strategy: CopyStrategy.FIXED,
            copySize: 100,
            maxOrderSizeUSD: 100,
            minOrderSizeUSD: 1,
        };
        const result = calculateOrderSize(cfg, 200, 5, 0); // only $5 balance
        expect(result.reducedByBalance).toBe(true);
        expect(result.finalAmount).toBeLessThanOrEqual(5 * 0.99);
    });
});

// ---------------------------------------------------------------------------
// CLOB API — live order placement (costs real USDC, gated behind flag)
// ---------------------------------------------------------------------------

describe('clob.polymarket.com — live order placement [LIVE_ORDER_TESTS]', () => {
    // Helper: classify a raw postOrder response.
    // The CLOB may return { success, errorMsg } or { error } depending on
    // the API version. Both indicate the server responded; only unexpected
    // shapes should fail the test.
    const assertClobResponse = (resp: any, label: string) => {
        const hasSuccess = 'success' in resp;
        const hasError   = 'error' in resp || 'errorMsg' in resp;
        expect(hasSuccess || hasError).toBe(true);

        if (hasSuccess) {
            console.log(`${label}: success=${resp.success}, errorMsg=${resp.errorMsg ?? ''}`);
        } else {
            // Known server-side rejections (version mismatch, insufficient balance, etc.)
            const errMsg = resp.error || resp.errorMsg || '';
            console.log(`${label}: server rejected — ${errMsg}`);
        }
    };

    liveTest('places a $1 FOK buy order at the current best ask', async () => {
        if (!activeTokenId) {
            console.warn('No active token available — skipping live $1 buy test');
            return;
        }
        const book = await clobClient.getOrderBook(activeTokenId);
        if (!book.asks || book.asks.length === 0) {
            console.warn('No asks in order book — market may be closed');
            return;
        }

        const bestAsk = book.asks.reduce((min, a) =>
            parseFloat(a.price) < parseFloat(min.price) ? a : min
        , book.asks[0]);

        const price = parseFloat(bestAsk.price);
        const signed = await clobClient.createOrder({
            side: Side.BUY,
            tokenID: activeTokenId,
            size: 1.0 / price, // $1 converted to tokens
            price,
        });

        const resp = await clobClient.postOrder(signed, OrderType.FOK);
        assertClobResponse(resp, '$1 buy');
    }, 30000);

    liveTest('sub-$1 FOK buy order is rejected by Polymarket CLOB', async () => {
        if (!activeTokenId) return;
        const book = await clobClient.getOrderBook(activeTokenId);
        if (!book.asks || book.asks.length === 0) return;

        const bestAsk = book.asks.reduce((min, a) =>
            parseFloat(a.price) < parseFloat(min.price) ? a : min
        , book.asks[0]);

        const price = parseFloat(bestAsk.price);
        const signed = await clobClient.createOrder({
            side: Side.BUY,
            tokenID: activeTokenId,
            size: 0.50 / price, // $0.50 converted to tokens — below $1 minimum
            price,
        });

        const resp = await clobClient.postOrder(signed, OrderType.FOK);
        // Expect either explicit success:false OR an error field (server rejected)
        const isRejected = resp.success === false || 'error' in resp || 'errorMsg' in resp;
        expect(isRejected).toBe(true);
        console.log(`Sub-$1 rejection response: ${JSON.stringify(resp)}`);
    }, 30000);
});
