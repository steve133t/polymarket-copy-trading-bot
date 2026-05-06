# Polymarket Copy Trading Bot

> **Copy the best, automate success.** Mirror trades from top Polymarket traders with intelligent position sizing, real-time execution, and a live analytics dashboard.

<div align="center">

![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)
![Next.js](https://img.shields.io/badge/Next.js-16-black)

</div>

---

## Features

| Feature | Description |
|---|---|
| 🖥️ **Web Dashboard** | Full analytics interface — charts, trader table, settings, paper trading |
| 📄 **Paper Trading Mode** | Simulate trades with real market data before going live |
| 📊 **Trader Analytics** | P&L, ROI, win rate, volume charts for every tracked trader |
| ⚡ **Real-time Execution** | Monitors trades every second, executes instantly |
| 👥 **Multi-Trader Support** | Track and copy trades from multiple wallets simultaneously |
| 📈 **3 Copy Strategies** | FIXED, PERCENTAGE, or ADAPTIVE position sizing |
| 🎚️ **Tiered Multipliers** | Different multipliers per trade size range |
| 🔄 **Trade Aggregation** | Combine small trades into one executable order |
| 🔁 **Auto-Redeem** | Native Polymarket feature — enable in app settings (see below) |
| 💾 **MongoDB Storage** | Persistent trade and position history |
| 🐳 **Docker Support** | Production-ready containerized deployment |

---

## Table of Contents

- [Quick Start](#quick-start)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the Bot](#running-the-bot)
- [Web Dashboard](#web-dashboard)
- [Paper Trading](#paper-trading)
- [Copy Strategies](#copy-strategies)
- [Finding Traders](#finding-traders)
- [CLI Commands](#cli-commands)
- [Troubleshooting](#troubleshooting)
- [Safety](#safety)

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/steve133t/polymarket-copy-trading-bot.git
cd polymarket-copy-trading-bot
npm install

# 2. Configure
cp .env.example .env
# Edit .env with your wallet, traders, MongoDB, RPC URL

# 3. Create web env file
echo "MONGO_URI=your_mongo_uri" > web/.env.local
echo "USER_ADDRESSES=0xYourTrackedTrader" >> web/.env.local

# 4. Install web dependencies
cd web && npm install && cd ..

# 5. Start the dashboard
npm run web        # http://localhost:3000

# 6. Start the bot (separate terminal)
npm start
```

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js v18+** | [Download](https://nodejs.org/) |
| **MongoDB Atlas** | [Free tier](https://www.mongodb.com/cloud/atlas/register) — whitelist `0.0.0.0/0` in Network Access |
| **Polygon wallet** | MetaMask or any Web3 wallet |
| **pUSD on Polymarket** | Deposit USDC via polymarket.com — it converts automatically |
| **POL (MATIC)** | ~$2–5 worth for gas fees |
| **Polygon RPC URL** | Free from [Alchemy](https://alchemy.com) or [Infura](https://infura.io) |

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/steve133t/polymarket-copy-trading-bot.git
cd polymarket-copy-trading-bot
```

### 2. Install bot dependencies

```bash
npm install
```

### 3. Install web dashboard dependencies

```bash
cd web
npm install
cd ..
```

### 4. Configure environment files

```bash
# Root .env — for the bot
cp .env.example .env
```

Edit `.env`:

```env
# ── Traders to copy ──────────────────────────────────────────────────
USER_ADDRESSES = 0xTraderWalletAddress

# ── Your wallet ──────────────────────────────────────────────────────
PROXY_WALLET = '0xYourPolygonWalletAddress'
PRIVATE_KEY = 'yourPrivateKeyWithout0xPrefix'

# ── Database ─────────────────────────────────────────────────────────
MONGO_URI = 'mongodb+srv://user:password@cluster.mongodb.net/polymarket'

# ── Blockchain ───────────────────────────────────────────────────────
RPC_URL = 'https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY'

# ── Copy strategy ────────────────────────────────────────────────────
COPY_STRATEGY = 'FIXED'
COPY_SIZE = 5              # $5 per trade

# ── Safety ───────────────────────────────────────────────────────────
PREVIEW_MODE = true        # Start with paper trading!
MAX_ORDER_SIZE_USD = 100
MIN_ORDER_SIZE_USD = 1
```

Create `web/.env.local` — for the Next.js dashboard:

```env
MONGO_URI=mongodb+srv://user:password@cluster.mongodb.net/polymarket
USER_ADDRESSES=0xTraderWalletAddress
```

> **Note:** `web/.env.local` is separate from the root `.env`. Next.js only reads its own env file.

---

## Configuration Reference

| Variable | Description | Default |
|---|---|---|
| `USER_ADDRESSES` | Trader wallet(s) to copy, comma-separated | — |
| `PROXY_WALLET` | Your Polygon wallet address | — |
| `PRIVATE_KEY` | Private key (no 0x prefix) | — |
| `MONGO_URI` | MongoDB connection string | — |
| `RPC_URL` | Polygon RPC endpoint | — |
| `COPY_STRATEGY` | `FIXED`, `PERCENTAGE`, or `ADAPTIVE` | `PERCENTAGE` |
| `COPY_SIZE` | USD amount (FIXED) or % (PERCENTAGE/ADAPTIVE) | `10` |
| `MAX_ORDER_SIZE_USD` | Cap per single trade | `100` |
| `MIN_ORDER_SIZE_USD` | Skip trades below this | `1` |
| `PREVIEW_MODE` | `true` = paper trade, `false` = live | `false` |
| `FETCH_INTERVAL` | Seconds between trade checks | `1` |
| `TOO_OLD_TIMESTAMP` | Ignore trades older than X hours | `1` |
| `RETRY_LIMIT` | Retries on failed orders | `3` |
| `TRADE_AGGREGATION_ENABLED` | Combine small trades | `false` |
| `TRADE_AGGREGATION_WINDOW_SECONDS` | Aggregation wait window | `300` |
| `AUTO_RESOLVE_ENABLED` | Auto-close resolved positions | `false` |
| `AUTO_RESOLVE_INTERVAL` | Seconds between resolve checks | `60` |
| `USDC_CONTRACT_ADDRESS` | pUSD contract address (pre-set to `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` for v2) | `0xC011...` |
| `TIERED_MULTIPLIERS` | Size-based multiplier ranges | — |
| `MAX_POSITION_SIZE_USD` | Max position per market | — |
| `MAX_DAILY_VOLUME_USD` | Daily spend cap | — |

---

## Running the Bot

### Start the web dashboard

```bash
npm run web
```

Opens at **http://localhost:3000**

### Start the trading bot

```bash
# Development (ts-node, no build needed)
npm start

# Production (compile first)
npm run build
node dist/index.js
```

### Run both together

Open two terminals:
- Terminal 1: `npm run web`
- Terminal 2: `npm start`

---

## Web Dashboard

The dashboard has four tabs:

### Traders

Analyzes all wallets in `USER_ADDRESSES` and displays:

- **P&L bar chart** — profit/loss per trader
- **ROI bar chart** — return on investment
- **Win rate gauge** — % of profitable trades
- **Daily & monthly line charts** — performance over time
- **Volume sparklines** — trade frequency
- **Risk score meter** — volatility indicator
- **Active positions pie** — current open positions
- **Sortable trader table** — all stats in one view, expandable rows

Use the **Time Range Filter** (7d / 30d / 90d / All) to adjust the analysis window.

Click **Analyze & Refresh** in Settings → Quick Actions to pull fresh data from Polymarket.

### My Trades

Shows your bot's executed trades, P&L, and position history.

### Paper

Live paper trading stats — see the [Paper Trading](#paper-trading) section below.

### Settings

Configure everything without editing files:

- **Traders** — add/remove wallet addresses
- **Copy Strategy** — switch between FIXED/PERCENTAGE/ADAPTIVE
- **Safety Limits** — max order size, daily caps, position limits
- **Bot Settings** — intervals, preview mode, aggregation, auto-resolve
- **Wallet** — view USDC and MATIC balances
- **Quick Actions** — health check, analyze traders, close resolved positions, manual sell

All settings write directly to `.env`. Restart the bot after changing strategy settings.

---

## Paper Trading

Paper trading lets you test the bot against live Polymarket activity **without spending any money**.

### Enable it

Set in your `.env`:

```env
PREVIEW_MODE = true
```

Restart the bot. It will now monitor trades and log what it *would* have done — without executing anything.

### View stats on the dashboard

Go to **http://localhost:3000** → click **📄 Paper**

The Paper tab shows (auto-refreshing every 10 seconds):

| Metric | Description |
|---|---|
| **Realized P&L** | Sell proceeds minus buy cost — your net profit/loss |
| **Market Win Rate** | % of markets where you came out ahead |
| **Would've Spent** | Total USD your buys would have cost |
| **Would've Received** | Total USD your sells would have returned |
| **Per-Market P&L** | WIN / LOSS / OPEN badge per market with in/out amounts |
| **Recent Trades** | Live feed of the last 50 detected trades |

### How P&L is calculated

The bot stores `botCopySize` — the exact amount it *would* have traded based on your COPY_STRATEGY settings — separate from the tracked trader's size. So if you're set to FIXED $5, the P&L shows your $5 results, not the tracker's $500 position.

```
Realized P&L = Total sell proceeds − Total buy cost
Win Rate     = Profitable markets ÷ (Profitable + Losing markets)
```

### Moving from paper to live

Once you're satisfied with paper results:

1. Set `PREVIEW_MODE = false` in `.env`
2. Ensure your `PROXY_WALLET` has pUSD (deposit via polymarket.com) and POL for gas
3. Restart the bot

---

## Copy Strategies

### FIXED

Copies a fixed USD amount per trade regardless of trader's size.

```env
COPY_STRATEGY = 'FIXED'
COPY_SIZE = 5       # $5 per trade
```

Best for: beginners, predictable spending.

### PERCENTAGE

Copies a percentage of the trader's position size.

```env
COPY_STRATEGY = 'PERCENTAGE'
COPY_SIZE = 10      # 10% of trader's trade size
```

Best for: proportional scaling with the trader.

### ADAPTIVE

Scales the percentage dynamically based on trade size — smaller trades get a higher %, larger trades get a lower %.

```env
COPY_STRATEGY = 'ADAPTIVE'
COPY_SIZE = 10               # Base %
ADAPTIVE_MIN_PERCENT = 5     # Floor for large trades
ADAPTIVE_MAX_PERCENT = 20    # Ceiling for small trades
ADAPTIVE_THRESHOLD_USD = 500 # Size where scaling kicks in
```

Best for: advanced users copying high-volume traders.

### Tiered Multipliers

Override the strategy with size-based multiplier tiers:

```env
TIERED_MULTIPLIERS = 1-10:2.0,10-100:1.0,100-500:0.2,500-1000:0.1,1000+:0.01
```

Ranges are the **trader's** order size in USD. This lets you capture small trades at higher multipliers and scale down for large ones.

---

## Finding Traders

### Option 1: Polymarket Leaderboard

1. Go to [polymarket.com/leaderboard](https://polymarket.com/leaderboard)
2. Sort by Profit or Volume
3. Copy a wallet address from a trader's profile URL
4. Add to `USER_ADDRESSES` in `.env`

### Option 2: Predictfolio

1. Visit [predictfolio.com](https://predictfolio.com)
2. Browse top performers with win rate and P&L details
3. Copy wallet address

### What to look for

✅ **Good signs:**
- Positive P&L over 30+ days
- Win rate above 55%
- Consistent activity (not just one lucky bet)
- Trade sizes you can proportionally copy
- Active in the last 7 days

❌ **Red flags:**
- One massive win with no other history
- Win rate below 45%
- Only trades exotic or illiquid markets
- Inactive for weeks

### High-frequency crypto up/down traders

Polymarket runs 5-minute crypto markets (Bitcoin Up or Down, Ethereum Up or Down). Some traders specialize in these with high win rates. To find them:

1. Search for traders with many REDEEM activities (winning resolutions)
2. Compare REDEEMs (wins) to BUYs (spend) for real ROI
3. Look for traders with 60%+ win rate on short-window markets

> **Tip:** The bot's Trader Analytics tab does this analysis for you after running `npm run analyze`.

---

## CLI Commands

```bash
npm run web              # Start web dashboard (http://localhost:3000)
npm start                # Start copy trading bot
npm run analyze          # Analyze all tracked traders, generate reports
npm run analyze:my       # Analyze your own trade history
npm run health           # System health check (MongoDB, CLOB, wallet)
npm run stats            # View current positions and P&L
npm run close:resolved   # Close positions that have resolved
npm run redeem           # Redeem winning positions for USDC
npm run close:stale      # Close old inactive positions
npm run build            # Compile TypeScript to dist/
```

---

## Auto-Redeem (Polymarket Native Feature)

Polymarket has a built-in auto-redeem feature that automatically redeems your winning positions once a market resolves — no gas or manual action needed.

**How to enable it:**
1. Go to [polymarket.com](https://polymarket.com) and connect your wallet
2. Open **Settings** (top-right menu)
3. Toggle **Auto-Redeem** to on

> Once enabled, Polymarket will automatically convert your winning YES/NO tokens to USDC after each market resolves. There is no bot-side implementation needed.

---

## Troubleshooting

### Bot won't start

**"USER_ADDRESSES is not defined"**
- Check `.env` exists and has correct spelling
- Remove quotes if on Windows: `USER_ADDRESSES = 0xAddress`

**"MongoDB connection failed"**
- Verify `MONGO_URI` connection string
- In MongoDB Atlas: Network Access → Add `0.0.0.0/0`
- Check username/password in the URI

**"CLOB client failed"**
- Verify `PROXY_WALLET` and `PRIVATE_KEY` are correct
- Ensure the wallet has signed into Polymarket at least once
- `maker address not allowed, please use the deposit wallet flow` — your proxy wallet is not yet registered with Polymarket v2. Log into polymarket.com and complete a deposit (any amount). This registers the wallet as an authorized maker. Required once per wallet.

### Dashboard issues

**Paper tab shows MongoDB error**
- Ensure `web/.env.local` exists with `MONGO_URI=...`
- Restart the Next.js dev server (`Ctrl+C` then `npm run web`) — env files only load at startup

**Traders tab shows empty charts**
- Run `npm run analyze` first to generate trader reports
- Or use the **Analyze & Refresh** button in Settings → Quick Actions

**Settings changes not taking effect**
- Bot must be restarted after `.env` changes
- Dashboard settings save to `.env` — verify the file was updated

### Trades not executing

**"Insufficient balance"**
- Ensure `PROXY_WALLET` has USDC on Polygon
- Ensure wallet has POL for gas

**"Price slippage too high"**
- Market moved between trader's trade and your execution
- Normal for volatile markets — bot will retry next cycle

**Orders stuck / not retrying**
- Fixed in this version: `botExcutedTime` resets to 0 on failure so the trade retries automatically

### Paper trading shows tracker's sizes instead of my sizes

- Fixed in this version: the bot now stores `botCopySize` (your actual copy amount based on COPY_STRATEGY) alongside each paper trade
- Old trades stored before this fix will show tracker sizes

---

## Docker

```bash
cp .env.docker.example .env.docker
# Edit .env.docker with your settings
docker-compose up -d
```

See [Docker Guide](./docs/DOCKER.md) for full instructions.

---

## Safety

⚠️ **This bot trades real money. Use at your own risk.**

**Before going live:**
- [ ] Run in `PREVIEW_MODE = true` for at least 48 hours
- [ ] Verify paper P&L matches your expectations
- [ ] Start with a small amount ($50–$100)
- [ ] Use a **dedicated wallet** — never your main wallet
- [ ] Set `MAX_ORDER_SIZE_USD` and `MAX_DAILY_VOLUME_USD` limits
- [ ] Keep your `PRIVATE_KEY` secret — never share or commit it

**Ongoing:**
- Monitor the bot daily
- Check that trades are executing at expected sizes
- Review P&L weekly
- Research traders before adding them

---

## Documentation

| Doc | Description |
|---|---|
| [Quick Start](./docs/QUICK_START.md) | Step-by-step setup guide |
| [Docker Guide](./docs/DOCKER.md) | Production deployment |
| [Multi-Trader Guide](./docs/MULTI_TRADER_GUIDE.md) | Copying multiple traders |
| [Tiered Multipliers](./docs/TIERED_MULTIPLIERS.md) | Size-based multiplier config |
| [Position Tracking](./docs/POSITION_TRACKING.md) | How positions are tracked |
| [Simulation Guide](./docs/SIMULATION_GUIDE.md) | Backtesting strategies |
| [Funding Guide](./docs/FUNDING_GUIDE.md) | How to fund your wallet |

---

## What's New (This Fork)

This fork adds significant improvements over the original:

### Polymarket V2 Migration

- **New client package**: upgraded from `@polymarket/clob-client` (v1) to `@polymarket/clob-client-v2`
- **New exchange contract**: `0xE111180000d2663C0091e4f400237545B87B996B` (was `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`)
- **pUSD collateral**: Polymarket v2 uses pUSD (`0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`) instead of USDC.e. Deposit USDC via polymarket.com and it converts automatically.
- **viem wallet integration**: signing now uses viem for compatibility with the v2 client
- **One-time deposit registration**: before placing any orders, the proxy wallet must be registered by completing a deposit on polymarket.com. Orders will fail with `maker address not allowed` until this is done.

### Bug Fixes

- **PREVIEW_MODE not enforced** — `ENV.PREVIEW_MODE` was never parsed from `.env`. Fixed and now properly skips order execution.
- **Race condition on trade failure** — `botExcutedTime` was set before execution, so failed trades were permanently skipped. Now resets to `0` on failure so trades retry.
- **Analyze script pagination crash** — Polymarket API returns 400 when paginating past offset 5000. Fixed with graceful break.
- **TradersTable React key warning** — Duplicate `className` attribute and missing `key` on fragments. Both fixed.
- **Paper P&L showing tracker sizes** — Preview mode was logging the tracked trader's trade size, not the bot's calculated copy size. Fixed by running `calculateOrderSize` inside the preview block and storing `botCopySize`.

### New Features

#### Paper Trading Dashboard (`/api/preview-stats` + `PreviewStatsView`)

- New **📄 Paper** tab in the dashboard
- Shows realized P&L, market win rate, per-market breakdown with WIN/LOSS/OPEN badges
- Per-market table: amount in, amount out, net P&L per position
- Recent trades feed (last 50 detected trades)
- Auto-refreshes every 10 seconds with live countdown
- Uses actual `botCopySize` for accurate P&L — not the tracker's larger amounts

#### Analyze & Refresh Button

- Added to Settings → Quick Actions
- Runs `npm run analyze` on the server and reloads the Traders tab
- No need to drop to the terminal to refresh trader data

#### Copy Strategy Accuracy

- Preview mode now runs `calculateOrderSize()` with your actual COPY_STRATEGY config
- Stores `botCopySize`, `botCopyTokens`, and `botCopyPrice` per paper trade
- Dashboard uses `botCopySize` when available, falls back to tracker size for older records

#### Web Environment Fix

- Added `web/.env.local` support — Next.js reads its own env file, not the root `.env`
- Dashboard now correctly connects to MongoDB for paper trade stats

---

## License

Educational and research purposes. Users are responsible for compliance with local laws and Polymarket Terms of Service.

---

**Disclaimer:** Trading involves significant risk of loss. Past performance does not guarantee future results. Only invest what you can afford to lose. The developers are not responsible for financial losses incurred while using this software.
