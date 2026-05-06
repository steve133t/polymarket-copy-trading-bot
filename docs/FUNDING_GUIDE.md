# 💰 Wallet Funding & Setup Guide

This guide will help you set up your wallet with the necessary funds and permissions to run the Polymarket Copy Trading Bot.

## Your Wallet Address

```
<YOUR_PROXY_WALLET>
```

## Prerequisites

Your trading wallet needs:

1. **pUSD** (Polymarket v2 collateral — deposit USDC via polymarket.com to get pUSD)
2. **POL** (for gas fees on Polygon)
3. **Allowance** (permission for Polymarket to spend your pUSD)
4. **Wallet registration** (complete at least one deposit on polymarket.com — required for v2)

---

## Step 1: Get POL (formerly MATIC) for Gas Fees

You need POL to pay for transaction fees on Polygon network.

**Note:** MATIC was rebranded to POL in September 2024. Most exchanges still show it as "MATIC" or "POL (MATIC)" during the transition.

### Recommended Amount

- **Minimum:** ~$5 worth of POL (~10 POL at current prices)
- **Recommended:** $10-20 worth of POL

### How to Get POL

**Option A: Buy Directly on Exchange**

1. Buy POL/MATIC on Coinbase, Binance, or Kraken
    - Look for "POL" or "MATIC" (both names are used during transition)
2. Withdraw to your wallet address on **Polygon Network**
3. ⚠️ **Important:** Select "Polygon" or "Polygon PoS" network, NOT "Ethereum"!

**Option B: Bridge from Ethereum**

1. Visit [Polygon Bridge](https://wallet.polygon.technology/polygon/bridge)
2. Connect your wallet
3. Bridge ETH or USDC to Polygon
4. Swap for POL on Polygon using [QuickSwap](https://quickswap.exchange)

---

## Step 2: Get pUSD via Polymarket

Polymarket v2 uses **pUSD** as its collateral token — not USDC.e. You cannot buy or bridge pUSD directly. Instead, you deposit USDC (or USDC.e) through the Polymarket UI and it is automatically converted to pUSD for you.

### Recommended Amount

- **Minimum:** $100 (for testing)
- **Recommended:** $500-1000 (for meaningful trading)

### How to Get pUSD

1. Go to [polymarket.com](https://polymarket.com) and connect your wallet
2. Click your profile → **Deposit**
3. Deposit USDC or USDC.e — Polymarket converts it to pUSD automatically
4. The pUSD balance will appear in your Polymarket account and in your proxy wallet

### Important Notes

✅ **No bridging needed**: Just deposit USDC via the Polymarket UI — done
✅ **Token**: pUSD contract on Polygon: `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`
✅ **Gas Token**: POL (formerly MATIC)

⚠️ **Warning**: Do not attempt to acquire pUSD by swapping on a DEX — use the Polymarket deposit flow only.

---

## Step 3: Set pUSD Allowance for Polymarket ⚡ **CRITICAL STEP**

**This is why you're getting "not enough balance / allowance" errors!**

You must give Polymarket permission to spend your pUSD. This is a one-time setup.

### Automatic Setup (Recommended)

Run the built-in script:

```bash
npm run check-allowance
```

or

```bash
yarn check-allowance
```

This script will:

1. ✅ Check your current pUSD balance
2. ✅ Check your current allowance
3. ✅ Automatically set unlimited allowance if needed
4. ✅ Show you the transaction link to verify

### What the script does:

```
🔍 Checking pUSD balance and allowance...

💵 pUSD Decimals: 6
💰 Your pUSD Balance: 249.89 pUSD
✅ Current Allowance: 0 pUSD
📍 Polymarket Exchange: 0xE111180000d2663C0091e4f400237545B87B996B

⚠️  Allowance is insufficient or zero!
📝 Setting unlimited allowance for Polymarket...

⏳ Transaction sent: 0xabc123...
⏳ Waiting for confirmation...

✅ Allowance set successfully!
✅ New Allowance: 115792089237316195423570985008687907853269984665640564039457 pUSD
```

---

## Step 3.5: Register Your Wallet (v2 Required) ⚡ **CRITICAL STEP**

Before the Polymarket CLOB will accept any orders from your proxy wallet, it must be registered through Polymarket's deposit flow. If you skip this, every order placement will return:

```
maker address not allowed, please use the deposit wallet flow
```

**Fix:** Log into [polymarket.com](https://polymarket.com) and complete at least one deposit. This registers your proxy wallet as an authorized maker automatically. You only need to do this once per wallet — subsequent runs of the bot will work without repeating it.

---

## Step 4: Verify Your Setup

Run the check script to verify everything is set up correctly:

```bash
npm run check-allowance
```

You should see:

```
✅ Your pUSD Balance: 249.89 pUSD
✅ Current Allowance: XXXXX pUSD
✅ Allowance is already sufficient!
```

Check your wallet on [Polygonscan](https://polygonscan.com/address/<YOUR_PROXY_WALLET>)

---

## Troubleshooting

### Error: "not enough balance / allowance"

**This is your current issue!**

**Cause:** Either no pUSD or no allowance set

**Solution:**

1. Run `npm run check-allowance` to diagnose
2. If balance is 0: Deposit USDC via polymarket.com to get pUSD (see Step 2)
3. If allowance is 0: The script will automatically set it
4. You need POL for the approval transaction (~$0.01)

### Error: "INSUFFICIENT_FUNDS" during allowance setup

**Cause:** Not enough POL for gas fees

**Solution:**

1. Get more POL (see Step 1)
2. Minimum ~0.01 POL needed for approval transaction

### Transaction Stuck or Pending

**Cause:** Network congestion or low gas price

**Solution:**

1. Wait 5-10 minutes
2. Check transaction on [Polygonscan](https://polygonscan.com)
3. If still pending after 30 minutes, speed up transaction in your wallet

---

## Recommended Wallet Balance

For smooth operation of the bot:

| Asset    | Minimum      | Recommended   | Purpose         |
| -------- | ------------ | ------------- | --------------- |
| **pUSD** | $100         | $500-1000     | Trading capital |
| **POL**  | 10 POL (~$5) | 50 POL (~$25) | Gas fees        |

**Note:** With `TRADE_MULTIPLIER = 2.0`, your effective buying power is 2x your balance!

---

## Quick Reference

**Your Wallet:** `<YOUR_PROXY_WALLET>`

**Network:** Polygon (Chain ID: 137)

**pUSD Contract:** `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`

**Polymarket Exchange (v2):** `0xE111180000d2663C0091e4f400237545B87B996B`

**Block Explorer:** [Polygonscan](https://polygonscan.com/address/<YOUR_PROXY_WALLET>)

---

## Next Steps

Once your wallet is funded and allowance is set:

1. ✅ Run `npm run check-allowance` to verify
2. ✅ Start the bot with `npm start`
3. ✅ Monitor the logs for successful trades
4. ✅ Check your positions on [Polymarket](https://polymarket.com)

**Ready to trade!** 🚀
