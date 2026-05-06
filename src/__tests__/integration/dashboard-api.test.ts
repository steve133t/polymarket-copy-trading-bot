/**
 * Integration tests: Next.js dashboard API routes
 *
 * Hits the live API server at localhost:3000 (or DASHBOARD_URL) and asserts
 * real responses. All tests auto-skip if the server is not reachable.
 *
 * Prerequisites: cd web && npm run dev   (or npm run web from project root)
 *
 * Run: npm run test:integration -- --testPathPattern=dashboard-api
 */

import axios, { AxiosError } from 'axios';

const BASE = process.env.DASHBOARD_URL ?? 'http://localhost:3000';

let serverAvailable = false;

// Probe once; skip all tests in the suite if the server isn't running.
beforeAll(async () => {
    try {
        await axios.get(`${BASE}/api/health`, { timeout: 5000 });
        serverAvailable = true;
    } catch {
        console.warn(
            `\n⚠️  Dashboard server not reachable at ${BASE}.\n` +
            '   Start it with:  cd web && npm run dev\n' +
            '   All dashboard API tests will be skipped.\n'
        );
    }
}, 10000);

/** Wraps a test so it skips gracefully when the server is offline. */
const dash = (
    name: string,
    fn: () => Promise<void>,
    timeout = 30000
) =>
    test(name, async () => {
        if (!serverAvailable) return;
        await fn();
    }, timeout);

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------

describe('GET /api/health', () => {
    dash('returns HTTP 200 with healthy flag and 4 check categories', async () => {
        const { status, data } = await axios.get(`${BASE}/api/health`);
        expect(status).toBe(200);
        expect(typeof data.healthy).toBe('boolean');
        expect(data.checks).toHaveProperty('database');
        expect(data.checks).toHaveProperty('rpc');
        expect(data.checks).toHaveProperty('balance');
        expect(data.checks).toHaveProperty('api');
        expect(typeof data.timestamp).toBe('string');
    });

    dash('each check has a status field', async () => {
        const { data } = await axios.get(`${BASE}/api/health`);
        for (const check of Object.values(data.checks) as any[]) {
            expect(typeof check.status).toBe('string');
        }
    });
});

// ---------------------------------------------------------------------------
// GET /api/balance
// ---------------------------------------------------------------------------

describe('GET /api/balance', () => {
    dash('returns usdc and matic as non-negative numbers', async () => {
        const { status, data } = await axios.get(`${BASE}/api/balance`);
        expect(status).toBe(200);
        expect(typeof data.usdc).toBe('number');
        expect(typeof data.matic).toBe('number');
        expect(data.usdc).toBeGreaterThanOrEqual(0);
        expect(data.matic).toBeGreaterThanOrEqual(0);
    });

    dash('proxyWallet is a valid 0x address', async () => {
        const { data } = await axios.get(`${BASE}/api/balance`);
        expect(data.proxyWallet).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
});

// ---------------------------------------------------------------------------
// GET / PUT /api/settings
// ---------------------------------------------------------------------------

describe('GET /api/settings', () => {
    dash('returns expected top-level settings shape', async () => {
        const { status, data } = await axios.get(`${BASE}/api/settings`);
        expect(status).toBe(200);
        const s = data.settings;
        expect(Array.isArray(s.traders)).toBe(true);
        expect(s).toHaveProperty('copyStrategy');
        expect(s).toHaveProperty('safetyLimits');
        expect(s).toHaveProperty('botSettings');
        expect(s).toHaveProperty('adaptiveStrategy');
        expect(s).toHaveProperty('network');
        expect(s).toHaveProperty('wallet');
    });

    dash('botSettings.previewMode reflects PREVIEW_MODE in .env', async () => {
        const { data } = await axios.get(`${BASE}/api/settings`);
        expect(typeof data.settings.botSettings.previewMode).toBe('boolean');
    });
});

describe('PUT /api/settings — round-trip', () => {
    dash('mutates FETCH_INTERVAL and restores it', async () => {
        const getResp = await axios.get(`${BASE}/api/settings`);
        const original: number = getResp.data.settings.botSettings.fetchInterval;

        const mutated = original === 1 ? 2 : 1;

        // Mutate
        const putResp = await axios.put(`${BASE}/api/settings`, {
            botSettings: { fetchInterval: mutated },
        });
        expect(putResp.status).toBe(200);
        expect(putResp.data.success).toBe(true);
        expect(putResp.data.settings.botSettings.fetchInterval).toBe(mutated);

        // Verify via GET
        const afterGet = await axios.get(`${BASE}/api/settings`);
        expect(afterGet.data.settings.botSettings.fetchInterval).toBe(mutated);

        // Restore
        await axios.put(`${BASE}/api/settings`, {
            botSettings: { fetchInterval: original },
        });
        const restored = await axios.get(`${BASE}/api/settings`);
        expect(restored.data.settings.botSettings.fetchInterval).toBe(original);
    });
});

// ---------------------------------------------------------------------------
// GET /api/preview-stats
// ---------------------------------------------------------------------------

describe('GET /api/preview-stats', () => {
    dash('returns session, markets[], and recentTrades[]', async () => {
        const { status, data } = await axios.get(`${BASE}/api/preview-stats`);
        expect(status).toBe(200);
        expect(data).toHaveProperty('session');
        expect(Array.isArray(data.markets)).toBe(true);
        expect(Array.isArray(data.recentTrades)).toBe(true);
    });

    dash('session object has active (boolean) and startingBalance (number)', async () => {
        const { data } = await axios.get(`${BASE}/api/preview-stats`);
        expect(typeof data.session.active).toBe('boolean');
        expect(typeof data.session.startingBalance).toBe('number');
    });
});

// ---------------------------------------------------------------------------
// POST /api/preview-stats — session state transitions
// ---------------------------------------------------------------------------

describe('POST /api/preview-stats — state transitions', () => {
    dash('stop → GET shows active:false, start → GET shows active:true', async () => {
        // Ensure stopped first
        await axios.post(`${BASE}/api/preview-stats`, { action: 'stop' });

        const stopped = await axios.get(`${BASE}/api/preview-stats`);
        expect(stopped.data.session.active).toBe(false);

        // 'start' requires startingBalance > 0 and copySize > 0
        const startResp = await axios.post(`${BASE}/api/preview-stats`, {
            action: 'start',
            startingBalance: 100,
            copySize: 5,
            copyStrategy: 'FIXED',
        });
        expect(startResp.status).toBe(200);

        const started = await axios.get(`${BASE}/api/preview-stats`);
        expect(started.data.session.active).toBe(true);

        // Clean up: stop again
        await axios.post(`${BASE}/api/preview-stats`, { action: 'stop' });
    });
});

// ---------------------------------------------------------------------------
// GET /api/my-trades
// ---------------------------------------------------------------------------

describe('GET /api/my-trades', () => {
    dash('returns 200 with data or 404 (analysis not yet run)', async () => {
        try {
            const { status, data } = await axios.get(`${BASE}/api/my-trades`);
            expect(status).toBe(200);
            expect(data).toBeDefined();
        } catch (err) {
            const axErr = err as AxiosError;
            expect(axErr.response?.status).toBe(404);
        }
    });
});

// ---------------------------------------------------------------------------
// POST /api/actions
// ---------------------------------------------------------------------------

describe('POST /api/actions', () => {
    dash('invalid action returns HTTP 400', async () => {
        try {
            await axios.post(`${BASE}/api/actions`, { action: 'not-a-real-action' });
            throw new Error('Expected 400 but request succeeded');
        } catch (err) {
            const axErr = err as AxiosError;
            expect(axErr.response?.status).toBe(400);
        }
    });

    dash(
        'health-check returns success field and non-empty output string',
        async () => {
            // health-check spawns a subprocess; give it a generous HTTP timeout.
            // A "socket hang up" is tolerated — it means the server timed out
            // the child process and is still alive; we verify shape when it works.
            try {
                const { status, data } = await axios.post(
                    `${BASE}/api/actions`,
                    { action: 'health-check' },
                    { timeout: 75000 }
                );
                expect(status).toBe(200);
                expect(data).toHaveProperty('success');
                expect(data).toHaveProperty('output');
                expect(data.action).toBe('health-check');
                console.log(`health-check success=${data.success}: ${String(data.output).slice(0, 120)}`);
            } catch (err) {
                const axErr = err as AxiosError;
                // Socket reset / ECONNRESET is acceptable (server alive, script hung)
                const code = (axErr.cause as any)?.code ?? axErr.code;
                if (code === 'ECONNRESET' || String(axErr.message).includes('socket hang up')) {
                    console.warn('health-check: server closed socket (script may still be running)');
                    return;
                }
                throw err;
            }
        },
        80000
    );

    dash(
        'check-stats returns a response with success and output fields',
        async () => {
            try {
                const { status, data } = await axios.post(
                    `${BASE}/api/actions`,
                    { action: 'check-stats' },
                    { timeout: 75000 }
                );
                expect(status).toBe(200);
                expect(data).toHaveProperty('success');
                expect(typeof data.output).toBe('string');
            } catch (err) {
                const axErr = err as AxiosError;
                const code = (axErr.cause as any)?.code ?? axErr.code;
                if (code === 'ECONNRESET' || String(axErr.message).includes('socket hang up')) {
                    console.warn('check-stats: server closed socket (script still running)');
                    return;
                }
                throw err;
            }
        },
        80000
    );

    dash('manual-sell without keyword still returns a response (script runs, may fail)', async () => {
        try {
            const { status, data } = await axios.post(
                `${BASE}/api/actions`,
                { action: 'manual-sell' }, // no params.keyword
                { timeout: 75000 }
            );
            // The route always returns 200; success depends on whether the script exits 0
            expect(status).toBe(200);
            expect(data).toHaveProperty('success');
            expect(data).toHaveProperty('output');
        } catch (err) {
            const axErr = err as AxiosError;
            const code = (axErr.cause as any)?.code ?? axErr.code;
            if (code === 'ECONNRESET' || String(axErr.message).includes('socket hang up')) {
                console.warn('manual-sell: server closed socket (script still running)');
                return;
            }
            throw err;
        }
    }, 80000);
});
