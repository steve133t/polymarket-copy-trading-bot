import { NextResponse } from 'next/server';
import { MongoClient } from 'mongodb';
import * as fs from 'fs';
import { parseEnvValue, ENV_PATH } from '@/lib/envUtils';

const MONGO_URI = process.env.MONGO_URI!;

const PAPER_SESSION_ID = 'default';
const PAPER_SESSIONS_COLLECTION = 'paper_trading_sessions';
const DEFAULT_STARTING_BALANCE = 100;

// Seed defaults from the bot's .env so the first paper session matches live config
const _botStrategy = (() => {
  const raw = (fs.existsSync(ENV_PATH)
    ? parseEnvValue(fs.readFileSync(ENV_PATH, 'utf-8'), 'COPY_STRATEGY')
    : process.env.COPY_STRATEGY || ''
  ).trim().replace(/^['"]|['"]$/g, '').toUpperCase();
  return raw === 'PERCENTAGE' ? 'PERCENTAGE' : raw === 'CAPITAL' ? 'CAPITAL' : 'FIXED';
})() as 'FIXED' | 'PERCENTAGE' | 'CAPITAL';

const _botCopySize = (() => {
  const fromFile = fs.existsSync(ENV_PATH)
    ? parseEnvValue(fs.readFileSync(ENV_PATH, 'utf-8'), 'COPY_SIZE')
    : '';
  return Number(fromFile || process.env.COPY_SIZE) || 5;
})();

const DEFAULT_COPY_STRATEGY = _botStrategy;
const DEFAULT_COPY_SIZE = _botCopySize;
const DEFAULT_MIN_BUY_SIZE = 1;
const MAX_PAPER_TRADES = 5000;
const MIN_BUY_USD = 1;
const MIN_SELL_TOKENS = 0.000001;
const RESOLVED_RESOLUTION_CACHE_MS = 5 * 60_000;
const UNRESOLVED_RESOLUTION_CACHE_MS = 5_000;

let client: MongoClient | null = null;
const resolutionCache = new Map<string, { expiresAt: number; result: ResolutionResult | null }>();

async function getDb() {
  if (!client) {
    client = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    await client.connect();
  }
  return client.db();
}

type PaperTrade = Record<string, unknown>;

type PaperSession = {
  _id: string;
  active: boolean;
  startingBalance: number;
  startedAt: number;
  copyStrategy: 'FIXED' | 'PERCENTAGE' | 'CAPITAL';
  copySize: number;
  minBuySize: number;
  maxTurnoverMultiple: number;
  slippageEnabled: boolean;
  slippageBps: number;
  lockProfits: boolean;
  excludedWallets: string[];
  createdAt?: Date;
  updatedAt?: Date;
};

type MarketEntry = {
  slug: string;
  title: string;
  outcome: string;
  buys: number;
  sells: number;
  skippedBuys: number;
  skippedSells: number;
  buyVolume: number;
  sellVolume: number;
  pnl: number;
  openTokens: number;
  costBasis: number;
  markPrice: number;
  marketValue: number;
  settledValue: number;
  unrealizedPnl: number;
  totalPnl: number;
  resolved: boolean;
  pendingResolution: boolean;
  resolutionValue: number | null;
  avgBuyPrice: number;
  avgSellPrice: number;
  wallets: WalletContribution[];
};

type ResolutionResult = {
  closed: boolean;
  resolved: boolean;
  outcomes: string[];
  outcomePrices: number[];
  closedTimestamp: number;
  pending: boolean;
};

type ResolutionBySlug = Record<string, ResolutionResult | null>;

type GammaMarket = {
  closed?: boolean;
  closedTime?: string;
  endDate?: string;
  outcomes?: string;
  outcomePrices?: string;
  umaResolutionStatus?: string | null;
};

type SimulatedTrade = {
  timestamp: number;
  side: string;
  title: string;
  outcome: string | null;
  price: number;
  rawPrice: number;
  usdcSize: number;
  requestedSize: number;
  slug: string;
  trackedAddress: string;
  executed: boolean;
  skippedReason: string | null;
};

type ReferencePosition = {
  openTokens: number;
};

type WalletContribution = {
  trackedAddress: string;
  buys: number;
  sells: number;
  skippedBuys: number;
  skippedSells: number;
  buyVolume: number;
  sellVolume: number;
  pnl: number;
  openTokens: number;
  costBasis: number;
  marketValue: number;
  unrealizedPnl: number;
  totalPnl: number;
};

type PaperWalletPosition = Omit<WalletContribution, 'trackedAddress' | 'marketValue' | 'unrealizedPnl' | 'totalPnl'>;

const defaultSession = (): PaperSession => ({
  _id: PAPER_SESSION_ID,
  active: false,
  startingBalance: DEFAULT_STARTING_BALANCE,
  startedAt: 0,
  copyStrategy: DEFAULT_COPY_STRATEGY,
  copySize: DEFAULT_COPY_SIZE,
  minBuySize: DEFAULT_MIN_BUY_SIZE,
  maxTurnoverMultiple: 0,
  slippageEnabled: false,
  slippageBps: 50,
  lockProfits: false,
  excludedWallets: [],
});

const getNumber = (value: unknown) => Number(value) || 0;

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

const clampPrice = (price: number) => Math.min(0.9999, Math.max(0.0001, price));

const getUserAddresses = () => {
  const envAddresses = fs.existsSync(ENV_PATH)
    ? parseEnvValue(fs.readFileSync(ENV_PATH, 'utf-8'), 'USER_ADDRESSES')
    : process.env.USER_ADDRESSES || '';

  return envAddresses
    .replace(/['"]/g, '')
    .split(',')
    .map(a => a.trim())
    .filter(Boolean);
};

const normalizeWalletList = (wallets: unknown): string[] => {
  if (!Array.isArray(wallets)) return [];
  return wallets
    .map(wallet => String(wallet).trim().toLowerCase())
    .filter(wallet => /^0x[a-f0-9]{40}$/.test(wallet));
};

const getRequestedBuySize = (trade: PaperTrade, session: PaperSession) => {
  const traderSize = getNumber(trade.usdcSize);
  if (session.copyStrategy === 'CAPITAL') {
    const trackedCapital = getNumber(trade.trackedCapital) || session.copySize;
    const scaledSize = trackedCapital > 0 ? traderSize * (session.startingBalance / trackedCapital) : 0;
    return scaledSize > 0 ? Math.max(scaledSize, session.minBuySize) : 0;
  }
  if (session.copyStrategy === 'PERCENTAGE') {
    const percentSize = traderSize * (session.copySize / 100);
    return percentSize > 0 ? Math.max(percentSize, session.minBuySize) : 0;
  }
  return session.copySize;
};

const getTrackedTokens = (trade: PaperTrade) => {
  const size = getNumber(trade.size);
  if (size > 0) return size;
  const price = getNumber(trade.price);
  return price > 0 ? getNumber(trade.usdcSize) / price : 0;
};

const getExecutionPrice = (rawPrice: number, side: string, session: PaperSession) => {
  if (!session.slippageEnabled || session.slippageBps <= 0) return clampPrice(rawPrice);
  const multiplier = side === 'BUY'
    ? 1 + session.slippageBps / 10000
    : 1 - session.slippageBps / 10000;
  return clampPrice(rawPrice * multiplier);
};

const getMarketKey = (trade: PaperTrade) => {
  const slug = String(trade.slug || trade.conditionId || 'unknown');
  const outcome = String(trade.outcome || '');
  return `${slug}__${outcome}`;
};

const getMarketCloseTimestamp = (slug: string) => {
  const match = slug.match(/-(5m|15m)-(\d+)$/);
  if (!match) return 0;
  const durationSeconds = match[1] === '15m' ? 15 * 60 : 5 * 60;
  return Number(match[2]) + durationSeconds;
};

const getTradeIdentity = (trade: PaperTrade) => [
  String(trade.transactionHash || ''),
  String(trade.timestamp || ''),
  String(trade.conditionId || ''),
  String(trade.asset || ''),
  String(trade.side || ''),
  String(trade.outcome || ''),
  String(trade.size || ''),
  String(trade.usdcSize || ''),
  String(trade.price || ''),
].join('|');

const createMarketEntry = (trade: PaperTrade): MarketEntry => {
  const slug = String(trade.slug || trade.conditionId || 'unknown');
  return {
    slug,
    title: String(trade.title || slug),
    outcome: String(trade.outcome || ''),
    buys: 0,
    sells: 0,
    skippedBuys: 0,
    skippedSells: 0,
    buyVolume: 0,
    sellVolume: 0,
    pnl: 0,
    openTokens: 0,
    costBasis: 0,
    markPrice: 0,
    marketValue: 0,
    settledValue: 0,
    unrealizedPnl: 0,
    totalPnl: 0,
    resolved: false,
    pendingResolution: false,
    resolutionValue: null,
    avgBuyPrice: 0,
    avgSellPrice: 0,
    wallets: [],
  };
};

const createWalletPosition = (): PaperWalletPosition => ({
  buys: 0,
  sells: 0,
  skippedBuys: 0,
  skippedSells: 0,
  buyVolume: 0,
  sellVolume: 0,
  pnl: 0,
  openTokens: 0,
  costBasis: 0,
});

const parseMarketResolution = (market: GammaMarket | null | undefined): ResolutionResult | null => {
  if (!market) return null;

  const outcomes = JSON.parse(String(market.outcomes || '[]')) as string[];
  const outcomePrices = (JSON.parse(String(market.outcomePrices || '[]')) as string[])
    .map(price => Number(price) || 0);
  const hasSettledPrices = outcomePrices.length > 0
    && outcomePrices.some(price => price >= 0.999)
    && outcomePrices.some(price => price <= 0.001);
  const status = String(market.umaResolutionStatus || '').toLowerCase();
  const closedTimestamp = Math.floor(
    Date.parse(String(market.closedTime || market.endDate || '')) / 1000
  ) || 0;
  const finalized = status === 'resolved' || (Boolean(market.closed) && hasSettledPrices);

  return {
    closed: Boolean(market.closed),
    resolved: finalized,
    outcomes,
    outcomePrices,
    closedTimestamp,
    pending: !finalized && (status === 'proposed' || hasSettledPrices),
  };
};

async function getMarketResolution(slug: string): Promise<ResolutionResult | null> {
  const cached = resolutionCache.get(slug);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  try {
    const eventResponse = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`, {
      cache: 'no-store',
    });
    if (!eventResponse.ok) throw new Error(`Gamma events API ${eventResponse.status}`);

    const events = await eventResponse.json();
    const eventMarket = Array.isArray(events) ? events[0]?.markets?.[0] : null;
    let result = parseMarketResolution(eventMarket);

    if (!result) {
      const directMarketResponse = await fetch(`https://gamma-api.polymarket.com/markets/slug/${encodeURIComponent(slug)}`, {
        cache: 'no-store',
      });

      if (directMarketResponse.ok) {
        result = parseMarketResolution(await directMarketResponse.json());
      }
    }

    if (!result) {
      const marketResponse = await fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`, {
        cache: 'no-store',
      });
      if (!marketResponse.ok) throw new Error(`Gamma markets API ${marketResponse.status}`);

      const markets = await marketResponse.json();
      result = parseMarketResolution(Array.isArray(markets) ? markets[0] : null);
    }

    if (!result) {
      resolutionCache.set(slug, { expiresAt: Date.now() + UNRESOLVED_RESOLUTION_CACHE_MS, result: null });
      return null;
    }

    const cacheMs = result.closed && result.resolved
      ? RESOLVED_RESOLUTION_CACHE_MS
      : UNRESOLVED_RESOLUTION_CACHE_MS;
    resolutionCache.set(slug, { expiresAt: Date.now() + cacheMs, result });
    return result;
  } catch {
    resolutionCache.set(slug, { expiresAt: Date.now() + UNRESOLVED_RESOLUTION_CACHE_MS, result: null });
    return null;
  }
}

async function getResolutionsForTrades(allTrades: PaperTrade[]): Promise<ResolutionBySlug> {
  const slugs = Array.from(new Set(
    allTrades
      .map(trade => String(trade.slug || trade.conditionId || ''))
      .filter(Boolean)
  ));
  const entries = await Promise.all(
    slugs.map(async slug => [slug, await getMarketResolution(slug)] as const)
  );
  return Object.fromEntries(entries);
}

async function getPaperSession(): Promise<PaperSession> {
  const db = await getDb();
  const session = await db
    .collection<PaperSession>(PAPER_SESSIONS_COLLECTION)
    .findOne({ _id: PAPER_SESSION_ID });
  return { ...defaultSession(), ...session };
}

async function fetchPaperTrades(session: PaperSession) {
  if (!session.active || session.startedAt <= 0) return [];

  const db = await getDb();
  const allTrades: PaperTrade[] = [];
  const excludedWallets = new Set((session.excludedWallets || []).map(wallet => wallet.toLowerCase()));

  for (const address of getUserAddresses()) {
    if (excludedWallets.has(address.toLowerCase())) continue;

    const collectionName = `user_activities_${address.toLowerCase()}`;
    const collections = await db.listCollections({ name: collectionName }).toArray();
    if (collections.length === 0) continue;

    const positionsCollectionName = `user_positions_${address.toLowerCase()}`;
    const positionsCollections = await db.listCollections({ name: positionsCollectionName }).toArray();
    let trackedCapital = 0;
    if (positionsCollections.length > 0) {
      const positions = await db
        .collection(positionsCollectionName)
        .find({}, { projection: { currentValue: 1, initialValue: 1 } })
        .toArray();
      trackedCapital = positions.reduce(
        (sum, position) => sum + Math.max(getNumber(position.currentValue), getNumber(position.initialValue)),
        0
      );
    }

    const col = db.collection(collectionName);
    const trades = await col
      .find({
        type: 'TRADE',
        timestamp: { $gte: session.startedAt },
      })
      .sort({ timestamp: -1 })
      .limit(MAX_PAPER_TRADES)
      .toArray();

    trades.forEach(t => allTrades.push({ ...t, trackedAddress: address, trackedCapital }));
  }

  const seen = new Set<string>();
  return allTrades
    .sort((a, b) => getNumber(a.timestamp) - getNumber(b.timestamp))
    .filter(trade => {
      const identity = getTradeIdentity(trade);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
}

function simulatePaperAccount(
  session: PaperSession,
  allTrades: PaperTrade[],
  resolutionBySlug: ResolutionBySlug = {}
) {
  const byMarket: Record<string, MarketEntry> = {};
  const referenceByMarket: Record<string, ReferencePosition> = {};
  const paperByWalletMarket: Record<string, PaperWalletPosition> = {};
  const settledMarkets = new Set<string>();
  const recentTrades: SimulatedTrade[] = [];

  let cashBalance = session.startingBalance;
  let totalBuyVolume = 0;
  let totalSellVolume = 0;
  let totalBuys = 0;
  let totalSells = 0;
  let redeemedValue = 0;
  let lockedProfit = 0;
  let skippedTrades = 0;

  const sweepExcessCashToLockbox = () => {
    if (!session.lockProfits) return;

    const excessCash = cashBalance - session.startingBalance;
    if (excessCash <= 0) return;

    cashBalance -= excessCash;
    lockedProfit += excessCash;
  };

  const settleResolvedMarkets = (timestamp: number, includeUnknownCloseTime = false) => {
    for (const [marketKey, entry] of Object.entries(byMarket)) {
      if (settledMarkets.has(marketKey) || entry.openTokens <= 0) continue;

      const resolution = resolutionBySlug[entry.slug];
      if (!resolution?.closed || !resolution.resolved) continue;

      const closeTimestamp = resolution.closedTimestamp || getMarketCloseTimestamp(entry.slug);
      if (!includeUnknownCloseTime && closeTimestamp <= 0) continue;
      if (closeTimestamp > timestamp) continue;

      const outcomeIndex = resolution.outcomes.findIndex(
        outcome => outcome.toLowerCase() === entry.outcome.toLowerCase()
      );
      if (outcomeIndex < 0) continue;

      const resolutionValue = resolution.outcomePrices[outcomeIndex] ?? 0;
      const proceeds = entry.openTokens * resolutionValue;
      const settledPnl = proceeds - entry.costBasis;

      cashBalance += proceeds;
      sweepExcessCashToLockbox();
      redeemedValue += proceeds;
      entry.pnl += settledPnl;
      entry.openTokens = 0;
      entry.costBasis = 0;
      entry.markPrice = resolutionValue;
      entry.marketValue = 0;
      entry.settledValue += proceeds;
      entry.unrealizedPnl = 0;
      entry.totalPnl = entry.pnl;
      entry.resolved = true;
      entry.pendingResolution = false;
      entry.resolutionValue = resolutionValue;

      for (const [walletMarketKey, wallet] of Object.entries(paperByWalletMarket)) {
        if (!walletMarketKey.endsWith(`__${entry.slug}__${entry.outcome}`) || wallet.openTokens <= 0) {
          continue;
        }
        const walletProceeds = wallet.openTokens * resolutionValue;
        wallet.pnl += walletProceeds - wallet.costBasis;
        wallet.openTokens = 0;
        wallet.costBasis = 0;
      }

      settledMarkets.add(marketKey);
    }
  };

  for (const trade of allTrades) {
    settleResolvedMarkets(getNumber(trade.timestamp));

    const key = getMarketKey(trade);
    const trackedAddress = String(trade.trackedAddress || '');
    const walletMarketKey = `${trackedAddress.toLowerCase()}__${key}`;
    byMarket[key] ||= createMarketEntry(trade);
    referenceByMarket[walletMarketKey] ||= { openTokens: 0 };
    paperByWalletMarket[walletMarketKey] ||= createWalletPosition();
    const entry = byMarket[key];
    const reference = referenceByMarket[walletMarketKey];
    const walletPosition = paperByWalletMarket[walletMarketKey];

    const side = String(trade.side || '');
    const rawPrice = clampPrice(getNumber(trade.botCopyPrice) || getNumber(trade.price));
    const executionPrice = getExecutionPrice(rawPrice, side, session);
    const trackedTokens = getTrackedTokens(trade);

    // When the bot ran in PREVIEW_MODE it already calculated the exact copy size —
    // use those values for accuracy instead of re-deriving from session config.
    const botCopySize = getNumber(trade.botCopySize);
    const botCopyTokens = getNumber(trade.botCopyTokens);
    const hasBotCalc = botCopySize > 0 && Boolean(trade.previewMode);

    const requestedSize = side === 'BUY'
      ? (hasBotCalc ? botCopySize : getRequestedBuySize(trade, session))
      : trackedTokens * executionPrice;

    entry.markPrice = getExecutionPrice(rawPrice, 'SELL', session);

    let executed = false;
    let skippedReason: string | null = null;
    let executedSize = 0;

    if (side === 'BUY') {
      const maxTurnover = session.maxTurnoverMultiple > 0
        ? session.startingBalance * session.maxTurnoverMultiple
        : Number.POSITIVE_INFINITY;
      const remainingTurnover = Math.max(0, maxTurnover - totalBuyVolume);
      const cappedRequestSize = Math.min(requestedSize, remainingTurnover);
      const spend = Math.min(cappedRequestSize, cashBalance);

      if (requestedSize < MIN_BUY_USD) {
        entry.skippedBuys++;
        walletPosition.skippedBuys++;
        skippedTrades++;
        skippedReason = 'below minimum';
      } else if (remainingTurnover < MIN_BUY_USD) {
        entry.skippedBuys++;
        walletPosition.skippedBuys++;
        skippedTrades++;
        skippedReason = 'turnover limit';
      } else if (spend < MIN_BUY_USD) {
        entry.skippedBuys++;
        walletPosition.skippedBuys++;
        skippedTrades++;
        skippedReason = 'insufficient cash';
      } else {
        const tokens = spend / executionPrice;
        cashBalance -= spend;
        entry.buys++;
        entry.buyVolume += spend;
        entry.openTokens += tokens;
        entry.costBasis += spend;
        walletPosition.buys++;
        walletPosition.buyVolume += spend;
        walletPosition.openTokens += tokens;
        walletPosition.costBasis += spend;
        totalBuys++;
        totalBuyVolume += spend;
        executedSize = spend;
        executed = true;
      }
      reference.openTokens += trackedTokens;
    } else if (side === 'SELL') {
      const referenceSellPercent = reference.openTokens > 0
        ? Math.min(1, trackedTokens / reference.openTokens)
        : 0;
      // If bot already calculated the sell token amount, use it directly (capped by our paper position)
      const sellTokens = hasBotCalc && botCopyTokens > 0
        ? Math.min(botCopyTokens, Math.max(0, walletPosition.openTokens))
        : Math.min(
            walletPosition.openTokens * referenceSellPercent,
            Math.max(0, walletPosition.openTokens)
          );

      if (trackedTokens <= MIN_SELL_TOKENS || referenceSellPercent <= 0) {
        entry.skippedSells++;
        walletPosition.skippedSells++;
        skippedTrades++;
        skippedReason = 'no tracked position';
      } else if (sellTokens <= MIN_SELL_TOKENS) {
        entry.skippedSells++;
        walletPosition.skippedSells++;
        skippedTrades++;
        skippedReason = 'no paper position';
      } else {
        const avgCost = walletPosition.openTokens > 0
          ? walletPosition.costBasis / walletPosition.openTokens
          : 0;
        const proceeds = sellTokens * executionPrice;
        const soldCostBasis = sellTokens * avgCost;

        cashBalance += proceeds;
        sweepExcessCashToLockbox();
        entry.sells++;
        entry.sellVolume += proceeds;
        entry.pnl += proceeds - soldCostBasis;
        entry.openTokens -= sellTokens;
        entry.costBasis -= soldCostBasis;
        walletPosition.sells++;
        walletPosition.sellVolume += proceeds;
        walletPosition.pnl += proceeds - soldCostBasis;
        walletPosition.openTokens -= sellTokens;
        walletPosition.costBasis -= soldCostBasis;
        totalSells++;
        totalSellVolume += proceeds;
        executedSize = proceeds;
        executed = true;
      }
      reference.openTokens = Math.max(0, reference.openTokens - trackedTokens);
    }

    entry.avgBuyPrice = entry.openTokens > 0 ? entry.costBasis / entry.openTokens : 0;
    entry.avgSellPrice = entry.sells > 0 ? entry.sellVolume / entry.sells : 0;

    recentTrades.push({
      timestamp: getNumber(trade.timestamp),
      side,
      title: String(trade.title || ''),
      outcome: trade.outcome != null ? String(trade.outcome) : null,
      price: round(executionPrice, 4),
      rawPrice: round(rawPrice, 4),
      usdcSize: round(executedSize),
      requestedSize: round(requestedSize),
      slug: String(trade.slug || ''),
      trackedAddress,
      executed,
      skippedReason,
    });
  }

  const lastTradeTimestamp = allTrades.reduce(
    (latest, trade) => Math.max(latest, getNumber(trade.timestamp)),
    Math.floor(Date.now() / 1000)
  );
  settleResolvedMarkets(Math.max(lastTradeTimestamp, Math.floor(Date.now() / 1000)), true);

  const markets = Object.values(byMarket)
    .map(m => {
      const resolution = resolutionBySlug[m.slug];
      const outcomeIndex = resolution?.outcomes.findIndex(
        outcome => outcome.toLowerCase() === m.outcome.toLowerCase()
      ) ?? -1;
      const resolutionValue = outcomeIndex >= 0
        ? resolution?.outcomePrices[outcomeIndex] ?? null
        : null;
      const pendingResolution = Boolean(resolution?.pending && resolutionValue !== null);
      const markPrice = pendingResolution ? Number(resolutionValue) : m.markPrice;
      const marketValue = m.openTokens * markPrice;
      const unrealizedPnl = marketValue - m.costBasis;
      const totalPnl = m.pnl + unrealizedPnl;
      return {
        ...m,
        buyVolume: round(m.buyVolume),
        sellVolume: round(m.sellVolume),
        pnl: round(m.pnl),
        openTokens: round(Math.max(0, m.openTokens), 4),
        costBasis: round(Math.max(0, m.costBasis)),
        markPrice: round(markPrice, 4),
        marketValue: round(marketValue),
        settledValue: round(m.settledValue),
        unrealizedPnl: round(m.resolved ? 0 : unrealizedPnl),
        totalPnl: round(m.resolved ? m.pnl : totalPnl),
        resolved: m.resolved,
        pendingResolution,
        resolutionValue: m.resolutionValue ?? resolutionValue,
        wallets: Object.entries(paperByWalletMarket)
          .filter(([walletMarketKey]) => walletMarketKey.endsWith(`__${m.slug}__${m.outcome}`))
          .map(([walletMarketKey, wallet]) => {
            const walletMarketValue = wallet.openTokens * markPrice;
            const walletUnrealizedPnl = walletMarketValue - wallet.costBasis;
            const trackedAddress = walletMarketKey.slice(0, walletMarketKey.length - `__${m.slug}__${m.outcome}`.length);
            return {
              trackedAddress,
              buys: wallet.buys,
              sells: wallet.sells,
              skippedBuys: wallet.skippedBuys,
              skippedSells: wallet.skippedSells,
              buyVolume: round(wallet.buyVolume),
              sellVolume: round(wallet.sellVolume),
              pnl: round(wallet.pnl),
              openTokens: round(Math.max(0, wallet.openTokens), 4),
              costBasis: round(Math.max(0, wallet.costBasis)),
              marketValue: round(walletMarketValue),
              unrealizedPnl: round(m.resolved ? 0 : walletUnrealizedPnl),
              totalPnl: round(m.resolved ? wallet.pnl : wallet.pnl + walletUnrealizedPnl),
            };
          })
          .filter(wallet => wallet.buys > 0 || wallet.sells > 0 || wallet.skippedBuys > 0 || wallet.skippedSells > 0)
          .sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl)),
      };
    })
    .sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl));

  const closedMarkets = markets.filter(m => (m.sells > 0 || m.resolved) && Math.abs(m.pnl) > 0.000001);
  const profitableMarkets = closedMarkets.filter(m => m.pnl > 0).length;
  const losingMarkets = closedMarkets.filter(m => m.pnl < 0).length;
  const openMarkets = markets.filter(m => m.openTokens > 0.000001 && !m.resolved).length;
  const pendingMarkets = markets.filter(m => m.openTokens > 0.000001 && m.pendingResolution).length;
  const resolvedMarkets = markets.filter(m => m.resolved).length;
  const realizedPnl = markets.reduce((sum, market) => sum + market.pnl, 0);
  const walletSummaries = Object.values(
    markets.reduce<Record<string, {
      trackedAddress: string;
      buys: number;
      sells: number;
      skippedTrades: number;
      buyVolume: number;
      sellVolume: number;
      realizedPnl: number;
      unrealizedPnl: number;
      totalPnl: number;
      marketValue: number;
      openMarkets: number;
      pendingMarkets: number;
      wins: number;
      losses: number;
      winRate: number;
    }>>((byWallet, market) => {
      for (const wallet of market.wallets) {
        byWallet[wallet.trackedAddress] ||= {
          trackedAddress: wallet.trackedAddress,
          buys: 0,
          sells: 0,
          skippedTrades: 0,
          buyVolume: 0,
          sellVolume: 0,
          realizedPnl: 0,
          unrealizedPnl: 0,
          totalPnl: 0,
          marketValue: 0,
          openMarkets: 0,
          pendingMarkets: 0,
          wins: 0,
          losses: 0,
          winRate: 0,
        };

        const summary = byWallet[wallet.trackedAddress];
        summary.buys += wallet.buys;
        summary.sells += wallet.sells;
        summary.skippedTrades += wallet.skippedBuys + wallet.skippedSells;
        summary.buyVolume += wallet.buyVolume;
        summary.sellVolume += wallet.sellVolume;
        summary.realizedPnl += wallet.pnl;
        summary.unrealizedPnl += wallet.unrealizedPnl;
        summary.totalPnl += wallet.totalPnl;
        summary.marketValue += wallet.marketValue;
        if (wallet.openTokens > 0.000001 && !market.resolved) summary.openMarkets++;
        if (wallet.openTokens > 0.000001 && market.pendingResolution) summary.pendingMarkets++;
        if ((market.resolved || wallet.sells > 0) && Math.abs(wallet.pnl) > 0.000001) {
          if (wallet.pnl > 0) summary.wins++;
          if (wallet.pnl < 0) summary.losses++;
        }
      }
      return byWallet;
    }, {})
  )
    .map(wallet => {
      const closedMarkets = wallet.wins + wallet.losses;
      return {
        ...wallet,
        buyVolume: round(wallet.buyVolume),
        sellVolume: round(wallet.sellVolume),
        realizedPnl: round(wallet.realizedPnl),
        unrealizedPnl: round(wallet.unrealizedPnl),
        totalPnl: round(wallet.totalPnl),
        marketValue: round(wallet.marketValue),
        winRate: closedMarkets > 0 ? round((wallet.wins / closedMarkets) * 100, 1) : 0,
      };
    })
    .sort((a, b) => b.totalPnl - a.totalPnl);
  const openPositionValue = markets
    .filter(m => !m.resolved)
    .reduce((sum, market) => sum + market.marketValue, 0);
  const openCostBasis = markets
    .filter(m => !m.resolved)
    .reduce((sum, market) => sum + market.costBasis, 0);
  const unrealizedPnl = openPositionValue - openCostBasis;
  const totalEquity = cashBalance + lockedProfit + openPositionValue;
  const totalPnl = totalEquity - session.startingBalance;

  return {
    summary: {
      totalTrades: allTrades.length,
      executedTrades: totalBuys + totalSells,
      skippedTrades,
      totalBuys,
      totalSells,
      totalBuyVolume: round(totalBuyVolume),
      turnoverLimit: Number.isFinite(session.startingBalance * session.maxTurnoverMultiple) && session.maxTurnoverMultiple > 0
        ? round(session.startingBalance * session.maxTurnoverMultiple)
        : 0,
      totalSellVolume: round(totalSellVolume),
      redeemedValue: round(redeemedValue),
      lockedProfit: round(lockedProfit),
      realizedPnl: round(realizedPnl),
      unrealizedPnl: round(unrealizedPnl),
      openPositionValue: round(openPositionValue),
      resolvedPositionValue: 0,
      totalPositionValue: round(openPositionValue),
      openCostBasis: round(openCostBasis),
      resolvedCostBasis: 0,
      startingBalance: round(session.startingBalance),
      cashBalance: round(cashBalance),
      totalEquity: round(totalEquity),
      totalPnl: round(totalPnl),
      returnPct: session.startingBalance > 0 ? round((totalPnl / session.startingBalance) * 100, 2) : 0,
      profitableMarkets,
      losingMarkets,
      openMarkets,
      pendingMarkets,
      resolvedMarkets,
      winRate: closedMarkets.length > 0
        ? round((profitableMarkets / closedMarkets.length) * 100, 1)
        : 0,
      estimatedTrades: 0,
    },
    recentTrades: recentTrades
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 50),
    markets,
    walletSummaries,
  };
}

export async function GET() {
  try {
    const session = await getPaperSession();
    const allTrades = await fetchPaperTrades(session);
    const resolutionBySlug = await getResolutionsForTrades(allTrades);
    const simulation = simulatePaperAccount(session, allTrades, resolutionBySlug);

    return NextResponse.json({
      session: {
        active: session.active,
        startingBalance: round(session.startingBalance),
        startedAt: session.startedAt,
        copyStrategy: session.copyStrategy,
        copySize: session.copySize,
        minBuySize: session.minBuySize,
        maxTurnoverMultiple: session.maxTurnoverMultiple,
        slippageEnabled: session.slippageEnabled,
        slippageBps: session.slippageBps,
        lockProfits: session.lockProfits,
        excludedWallets: session.excludedWallets,
        trackedWallets: getUserAddresses(),
      },
      summary: simulation.summary,
      recentTrades: simulation.recentTrades,
      markets: simulation.markets.slice(0, 20),
      walletSummaries: simulation.walletSummaries,
    });
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to fetch preview stats: ${error instanceof Error ? error.message : error}` },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const action = String(body.action || 'start');
    const db = await getDb();
    const collection = db.collection<PaperSession>(PAPER_SESSIONS_COLLECTION);

    if (action === 'stop') {
      await collection.updateOne(
        { _id: PAPER_SESSION_ID },
        { $set: { active: false, updatedAt: new Date() } },
        { upsert: true }
      );
      return NextResponse.json({ ok: true, session: await getPaperSession() });
    }

    if (action !== 'start' && action !== 'update') {
      return NextResponse.json({ error: `Invalid paper action: ${action}` }, { status: 400 });
    }

    const startingBalance = getNumber(body.startingBalance);
    const copyStrategy = body.copyStrategy === 'PERCENTAGE'
      ? 'PERCENTAGE'
      : body.copyStrategy === 'CAPITAL'
        ? 'CAPITAL'
        : 'FIXED';
    const copySize = getNumber(body.copySize);
    const minBuySize = Math.max(MIN_BUY_USD, getNumber(body.minBuySize) || DEFAULT_MIN_BUY_SIZE);
    const maxTurnoverMultiple = Math.max(0, getNumber(body.maxTurnoverMultiple));
    const slippageEnabled = Boolean(body.slippageEnabled);
    const slippageBps = Math.min(5000, Math.max(0, Math.round(getNumber(body.slippageBps))));
    const lockProfits = Boolean(body.lockProfits);
    const trackedWallets = new Set(getUserAddresses().map(wallet => wallet.toLowerCase()));
    const excludedWallets = normalizeWalletList(body.excludedWallets)
      .filter(wallet => trackedWallets.has(wallet));

    if (!Number.isFinite(startingBalance) || startingBalance < MIN_BUY_USD) {
      return NextResponse.json(
        { error: `Starting balance must be at least $${MIN_BUY_USD}` },
        { status: 400 }
      );
    }

    if (!Number.isFinite(copySize) || copySize <= 0) {
      return NextResponse.json(
        { error: 'Copy size must be greater than 0' },
        { status: 400 }
      );
    }

    if (copyStrategy === 'PERCENTAGE' && copySize > 1000) {
      return NextResponse.json(
        { error: 'Percentage copy size must be 1000% or less' },
        { status: 400 }
      );
    }

    if (copyStrategy === 'CAPITAL' && copySize < MIN_BUY_USD) {
      return NextResponse.json(
        { error: 'Fallback wallet capital must be at least $1' },
        { status: 400 }
      );
    }

    const now = new Date();
    const currentSession = await getPaperSession();
    const session: PaperSession = {
      _id: PAPER_SESSION_ID,
      active: true,
      startingBalance: round(startingBalance),
      startedAt: action === 'update' && currentSession.startedAt > 0
        ? currentSession.startedAt
        : Math.floor(now.getTime() / 1000),
      copyStrategy,
      copySize,
      minBuySize,
      maxTurnoverMultiple,
      slippageEnabled,
      slippageBps,
      lockProfits,
      excludedWallets,
      updatedAt: now,
      createdAt: now,
    };

    await collection.updateOne(
      { _id: PAPER_SESSION_ID },
      {
        $set: {
          active: session.active,
          startingBalance: session.startingBalance,
          startedAt: session.startedAt,
          copyStrategy: session.copyStrategy,
          copySize: session.copySize,
          minBuySize: session.minBuySize,
          maxTurnoverMultiple: session.maxTurnoverMultiple,
          slippageEnabled: session.slippageEnabled,
          slippageBps: session.slippageBps,
          lockProfits: session.lockProfits,
          excludedWallets: session.excludedWallets,
          updatedAt: session.updatedAt,
        },
        $setOnInsert: { createdAt: session.createdAt },
      },
      { upsert: true }
    );

    return NextResponse.json({ ok: true, session: await getPaperSession() });
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to update paper session: ${error instanceof Error ? error.message : error}` },
      { status: 500 }
    );
  }
}
