/**
 * Find profitable traders for short-window crypto up/down markets only.
 * Targets: eth-updown-5m, btc-updown-5m, eth-updown-15m, btc-updown-1h, etc.
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const c = {
    cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
    green: (s: string) => `\x1b[32m${s}\x1b[0m`,
    red: (s: string) => `\x1b[31m${s}\x1b[0m`,
    yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
    gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
    bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

// Real slug patterns from Polymarket: eth-updown-5m-<unixts>, btc-updown-15m-<unixts>, sol-updown-1h-<unixts>
const SLUG_PATTERNS = [
    /^(eth|btc|sol|xrp|doge)-updown-(5m|15m|1h|30m)-\d+/i,
];

const isCryptoUpDownSlug = (slug: string) => SLUG_PATTERNS.some((p) => p.test(slug || ''));

interface TraderStats {
    address: string;
    totalSpent: number;
    totalReceived: number;
    pnl: number;
    roi: number;
    cryptoTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    lastActivity: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Step 1: Find recent crypto up/down events (each event groups many short-window markets)
async function findRecentCryptoMarkets(): Promise<string[]> {
    console.log(c.cyan('📡 Fetching recent crypto up/down markets...'));
    const conditionIds = new Set<string>();

    // Fetch markets across multiple pages, both active and recently closed
    const queries = [
        'https://gamma-api.polymarket.com/markets?limit=500&active=true&closed=false&order=startDate&ascending=false',
        'https://gamma-api.polymarket.com/markets?limit=500&closed=true&order=endDate&ascending=false',
        'https://gamma-api.polymarket.com/markets?limit=500&closed=true&order=endDate&ascending=false&offset=500',
        'https://gamma-api.polymarket.com/markets?limit=500&closed=true&order=endDate&ascending=false&offset=1000',
        'https://gamma-api.polymarket.com/markets?limit=500&closed=true&order=endDate&ascending=false&offset=1500',
    ];

    for (const url of queries) {
        try {
            const res = await axios.get(url, { timeout: 15000 });
            if (Array.isArray(res.data)) {
                res.data.forEach((m: any) => {
                    if (m.slug && isCryptoUpDownSlug(m.slug) && m.conditionId) {
                        conditionIds.add(m.conditionId);
                    }
                });
            }
        } catch (e: any) {
            console.log(c.yellow(`  ⚠️  Query failed: ${e.message}`));
        }
        await sleep(300);
    }

    console.log(c.green(`  ✅ Found ${conditionIds.size} crypto up/down markets`));
    return Array.from(conditionIds);
}

// Step 2: Get traders from trades on each market
async function findTradersInMarkets(conditionIds: string[]): Promise<Set<string>> {
    console.log(c.cyan(`\n🔎 Scanning ${conditionIds.length} markets for active traders...`));
    const traders = new Set<string>();

    for (let i = 0; i < conditionIds.length; i++) {
        const conditionId = conditionIds[i];
        try {
            const res = await axios.get(
                `https://data-api.polymarket.com/trades?market=${conditionId}&limit=500`,
                { timeout: 10000 }
            );
            if (Array.isArray(res.data)) {
                res.data.forEach((t: any) => {
                    if (t.proxyWallet) traders.add(String(t.proxyWallet).toLowerCase());
                });
            }
        } catch {
            // skip on error
        }

        if ((i + 1) % 25 === 0) {
            console.log(c.gray(`  Scanned ${i + 1}/${conditionIds.length} — ${traders.size} traders found`));
        }
        await sleep(80);
    }

    console.log(c.green(`  ✅ Collected ${traders.size} unique traders\n`));
    return traders;
}

// Step 3: For each trader, compute crypto up/down P&L
async function analyzeTrader(address: string): Promise<TraderStats | null> {
    try {
        const all: any[] = [];
        let offset = 0;
        const LIMIT = 500;

        while (offset < 5000) {
            try {
                const res = await axios.get(
                    `https://data-api.polymarket.com/activity?user=${address}&limit=${LIMIT}&offset=${offset}`,
                    { timeout: 10000 }
                );
                if (!Array.isArray(res.data) || res.data.length === 0) break;
                all.push(...res.data);
                if (res.data.length < LIMIT) break;
                offset += LIMIT;
            } catch {
                break;
            }
        }

        const crypto = all.filter((a) => a.slug && isCryptoUpDownSlug(a.slug));
        if (crypto.length < 10) return null;

        let totalSpent = 0;
        let totalReceived = 0;
        let cryptoTrades = 0;
        let lastActivity = 0;

        const positions: Record<string, { spent: number; received: number }> = {};

        for (const act of crypto) {
            const ts = Number(act.timestamp) || 0;
            if (ts > lastActivity) lastActivity = ts;
            const usd = Number(act.usdcSize) || 0;
            const key = `${act.conditionId || ''}__${act.outcome || ''}`;

            if (act.type === 'TRADE') {
                cryptoTrades++;
                if (!positions[key]) positions[key] = { spent: 0, received: 0 };
                if (act.side === 'BUY') {
                    totalSpent += usd;
                    positions[key].spent += usd;
                } else {
                    totalReceived += usd;
                    positions[key].received += usd;
                }
            } else if (act.type === 'REDEEM') {
                totalReceived += usd;
                if (!positions[key]) positions[key] = { spent: 0, received: 0 };
                positions[key].received += usd;
            }
        }

        let wins = 0;
        let losses = 0;
        for (const p of Object.values(positions)) {
            if (p.spent === 0) continue;
            const net = p.received - p.spent;
            if (net > 0) wins++;
            else if (net < 0) losses++;
        }

        const pnl = totalReceived - totalSpent;
        const roi = totalSpent > 0 ? (pnl / totalSpent) * 100 : 0;
        const winRate = wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0;

        return {
            address,
            totalSpent,
            totalReceived,
            pnl,
            roi,
            cryptoTrades,
            wins,
            losses,
            winRate,
            lastActivity,
        };
    } catch {
        return null;
    }
}

async function main() {
    console.log(c.bold(c.cyan('\n🎯 Crypto Up/Down Trader Finder\n')));
    console.log(c.gray('Targets: eth-updown-5m, btc-updown-5m, eth-updown-15m, btc-updown-1h, etc.\n'));

    const markets = await findRecentCryptoMarkets();
    if (markets.length === 0) {
        console.log(c.red('No crypto up/down markets found.'));
        return;
    }

    const traders = await findTradersInMarkets(markets);
    if (traders.size === 0) {
        console.log(c.red('No traders found.'));
        return;
    }

    const traderList = Array.from(traders).slice(0, 300);
    console.log(c.cyan(`📊 Analyzing P&L for ${traderList.length} traders...`));
    const results: TraderStats[] = [];

    let done = 0;
    const BATCH = 8;
    for (let i = 0; i < traderList.length; i += BATCH) {
        const batch = traderList.slice(i, i + BATCH);
        const stats = await Promise.all(batch.map(analyzeTrader));
        stats.forEach((s) => {
            if (s) results.push(s);
        });
        done += batch.length;
        if (done % 40 === 0 || done >= traderList.length) {
            console.log(c.gray(`  Analyzed ${Math.min(done, traderList.length)}/${traderList.length} (${results.length} qualified)`));
        }
    }

    const ranked = results
        .filter((r) => r.totalSpent >= 50 && r.cryptoTrades >= 30)
        .sort((a, b) => b.roi - a.roi);

    console.log(c.bold(c.green(`\n✅ Top profitable crypto up/down traders\n`)));
    console.log(
        c.gray(
            'Rank  Address                                       ROI       P&L           Trades  Win%   Last Active'
        )
    );
    console.log(c.gray('─'.repeat(115)));

    const top = ranked.slice(0, 25);
    top.forEach((t, idx) => {
        const days = ((Date.now() / 1000 - t.lastActivity) / 86400).toFixed(1);
        const pnlStr = (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(2);
        const pnlColored = t.pnl >= 0 ? c.green(pnlStr.padStart(12)) : c.red(pnlStr.padStart(12));
        const roiStr = (t.roi >= 0 ? '+' : '') + t.roi.toFixed(1) + '%';
        const roiColored = t.roi >= 0 ? c.green(roiStr.padStart(8)) : c.red(roiStr.padStart(8));
        console.log(
            `${String(idx + 1).padStart(3)}.  ${t.address}  ${roiColored}  ${pnlColored}  ${String(t.cryptoTrades).padStart(6)}  ${t.winRate.toFixed(1).padStart(5)}%  ${days}d ago`
        );
    });

    const outDir = path.join(process.cwd(), 'trader_analysis_results');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `crypto_updown_traders_${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify(ranked, null, 2));
    console.log(c.gray(`\n💾 Full results saved to ${outPath}`));

    if (top.length > 0) {
        const best = top[0];
        console.log(c.bold(c.green(`\n🏆 Best trader: ${best.address}`)));
        console.log(
            `   ${best.cryptoTrades} crypto trades · ${best.winRate.toFixed(1)}% win rate · ${best.roi.toFixed(1)}% ROI · $${best.pnl.toFixed(2)} P&L`
        );
        console.log(c.gray(`\n   Add to .env:  USER_ADDRESSES = ${best.address}`));
    }
}

main().catch((e) => {
    console.error(c.red('Error:'), e.message);
    process.exit(1);
});
