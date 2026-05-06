# Search Design

## Goal

Design a self-contained quantitative leader-discovery, account-tracking, risk-modeling, portfolio-construction, bet-sizing, and copytrader-configuration system for Polymarket copy trading.

The system starts from the official Polymarket trader leaderboard and expands the account universe through public trade-flow discovery. It tracks discovered accounts, reconstructs their trading behavior, calculates a full quantitative metric library, builds a portfolio of leaders using modern portfolio theory, and exports operational settings for the copytrader counterpart application.

The core objective is:

```text
discover active and profitable Polymarket leaders
+ keep a durable local record of observed accounts and trades
+ reconstruct wallet histories, position lifecycles, and current exposures
+ quantify edge, risk, liquidity, capacity, correlation, and regime behavior
+ allocate bankroll across leaders with portfolio constraints
+ size each copied bet to target high expected return while minimizing risk of ruin under explicit model assumptions
+ export copytrader settings through local JSON/config artifacts
```

The operational data plane is:

```text
public Polymarket APIs
+ local JSON snapshots
+ local JSONL append logs
+ local copytrader config artifacts
```

This is the runtime boundary for the operational research system. It supports disciplined discovery, measurement, paper trading, portfolio selection, live gating, demotion, and auditability. External research tools are introduced only when a specific question cannot be answered from public APIs and local artifacts.

## API Reference Basis

Use official Polymarket documentation as the API contract source.

```text
Trader leaderboard:
GET https://data-api.polymarket.com/v1/leaderboard

Core trade and profile surfaces:
GET https://data-api.polymarket.com/trades
GET https://data-api.polymarket.com/trades?eventId=...
GET https://data-api.polymarket.com/trades?market=...
GET https://data-api.polymarket.com/trades?user=...
GET https://data-api.polymarket.com/positions?user=...
GET https://data-api.polymarket.com/closed-positions?user=...

Order book and pricing surfaces when needed for execution realism:
GET /book or documented order-book endpoint for a token/market
GET spread, midpoint, last trade price, fee rate, tick size, live volume, and market metadata endpoints where available
```

The leaderboard endpoint returns ranked traders with fields such as `rank`, `proxyWallet`, `userName`, `vol`, `pnl`, and verification/profile metadata. Query dimensions include category, time period, ordering by PnL or volume, limit, offset, user, and username. These fields make the leaderboard the official seed source, not the complete qualification basis.

## Requirements Traceability

| Prompt requirement | Design coverage |
| --- | --- |
| Build a system around Polymarket leaders from the official leaderboard endpoint | `Leader and Account Universe` and `API Reference Basis` define the leaderboard as the official seed source and preserve leaderboard metadata in candidate records. |
| Pull all accounts that it can | `Leader and Account Universe` combines leaderboard pagination, category/time-period sweeps, global trade discovery, hot event sweeps, hot market sweeps, and dedupe into one expandable account universe. |
| Keep track of accounts and their trades | `Trade and Account Tracking`, `Local Artifact Data Plane`, and `Cache Retention and Refresh Cadence` define raw observations, per-wallet histories, snapshots, append logs, lifecycle records, and refresh rules. |
| Build full quantitative risk metrics | `Quantitative Metric Library` enumerates return, volatility, drawdown, tail risk, Sharpe, Sortino, Calmar, Kelly, hit rate, profit factor, concentration, liquidity, execution, holding-period, regime, and correlation metrics. |
| Form a modern portfolio theory portfolio that yields the highest returns | `Portfolio Construction` defines expected-return estimation, covariance estimation, max-Sharpe and max-return objectives, constraints, leader correlation handling, turnover control, and optimization outputs. |
| Calculate the amount of balance to use on each bet while minimizing risk of ruin | `Bet Sizing and Risk of Ruin` defines bankroll allocation, fractional Kelly, capped Kelly, CVaR and drawdown constraints, per-bet sizing, hard caps, liquidity caps, and local forced exits. It frames sizing as model-based optimization under assumptions. |
| Extract and apply settings to the copytrader counterpart application | `Copytrader Settings Export` defines promoted leaders, per-leader allocations, max notionals, event/market caps, trade filters, live gates, forced-exit settings, paper/live gates, and a config artifact schema. |
| Use whatever resources are actually needed | `System Boundaries` and `Research Escalation Criteria` keep runtime dependencies low while allowing targeted external research tools only when a concrete unanswered research need justifies them. |
| Full research and design | `Research Workflow`, `Backtest and Walk-Forward Validation`, `Shadow Execution`, `Monitoring`, `Demotion Rules`, and `Build Order` define the full quant research path from data collection through live guarded rollout. |

## System Boundaries

The runtime architecture is public-API and local-artifact based.

Runtime dependencies:

```text
- public Polymarket data/profile/market/orderbook APIs
- local filesystem
- JSON snapshots for latest state
- JSONL append logs for observations and audit
- local config artifacts consumed by the copytrader counterpart application
- deterministic batch workers or timer-driven local processes
```

External components outside the runtime dependency set:

```text
- Kafka or message broker
- new SQL database requirement
- database-first architecture
- full Polygon on-chain indexer
- direct CTF Exchange log indexing
- direct Neg Risk CTF Exchange indexing
- Conditional Token transfer indexing
- Dune, Goldsky, Allium, or The Graph dependency
- production-grade research warehouse
- distributed crawler fleet
- real-time microstructure simulator beyond public order-book snapshots
```

This boundary defines runtime dependencies. The quant loop covers discovery, backfill, lifecycle reconstruction, edge scoring, risk scoring, liquidity/capacity scoring, portfolio optimization, bankroll sizing, live gates, paper trading, demotion, and config export.

### Research Escalation Criteria

External systems can be added later for a specific research question, for example:

```text
- on-chain logs if public API trade data cannot distinguish fills, transfers, and settlement behavior needed for a metric
- a research warehouse if local JSONL files become too large for repeatable walk-forward experiments
- a specialized indexer if account coverage from public APIs materially undercounts the account universe
- historical third-party data if public APIs cannot provide enough lookback for a statistically defensible covariance estimate
```

Local artifacts remain the operational data plane until a measured research gap requires a targeted external tool.

## Component Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                    ACCOUNT UNIVERSE DISCOVERY                │
├─────────────────────────────────────────────────────────────┤
│ Official leaderboard category/time-period/offset sweeps      │
│ Global /trades poller                                        │
│ Hot event /trades sweeper                                    │
│ Hot market /trades sweeper                                   │
│ Account normalization, dedupe, observation cache             │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    LOCAL ARTIFACT DATA PLANE                 │
├─────────────────────────────────────────────────────────────┤
│ candidates.json                                              │
│ observations.jsonl                                           │
│ wallet_trades/{wallet}.jsonl                                 │
│ position_snapshots/{wallet}.jsonl                            │
│ lifecycle/{wallet}.json                                      │
│ wallet_metrics.json                                          │
│ portfolio_state.json                                         │
│ copytrader_settings.json                                     │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    TRACKING AND RECONSTRUCTION               │
├─────────────────────────────────────────────────────────────┤
│ Per-wallet trade backfill                                    │
│ Raw observation retention                                    │
│ Current position snapshots                                   │
│ Closed-position ingestion where useful                       │
│ Weighted-average inventory and round-trip lifecycle records  │
│ Refresh cadence, score decay, and retention policy           │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    QUANT METRIC ENGINE                       │
├─────────────────────────────────────────────────────────────┤
│ Returns, volatility, drawdown, tail risk                     │
│ Sharpe, Sortino, Calmar, Kelly, hit rate, profit factor      │
│ Exposure concentration, liquidity, capacity, slippage         │
│ Holding-period, category/regime, covariance/correlation       │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    EDGE + RISK + LIQUIDITY SCORING           │
├─────────────────────────────────────────────────────────────┤
│ edgeScore, riskScore, liquidityScore                         │
│ capacityScore, executionScore, consistencyScore              │
│ regimeScore, correlationPenalty, copyabilityScore            │
│ eligibility, tier, rejection/demotion reasons                │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    PORTFOLIO AND BET SIZING                  │
├─────────────────────────────────────────────────────────────┤
│ Expected-return model                                        │
│ Covariance/correlation estimator                             │
│ Max-Sharpe and constrained max-return allocation             │
│ Fractional/capped Kelly and risk-of-ruin constraints          │
│ Per-leader, per-event, per-market, per-trade caps             │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    COPYTRADER SETTINGS EXPORT                │
├─────────────────────────────────────────────────────────────┤
│ promoted leaders                                             │
│ bankroll allocations                                         │
│ max notionals and exposure caps                              │
│ trade filters and live gates                                 │
│ forced exits and paper/live mode gates                       │
│ local JSON/config artifact consumed by counterpart app       │
└─────────────────────────────────────────────────────────────┘
```

## Leader and Account Universe

The account universe has four sources. All sources feed the same normalized candidate cache.

### Official Leaderboard Seed

The leaderboard is the official leader source:

```text
GET https://data-api.polymarket.com/v1/leaderboard
```

Sweep:

```text
category in OVERALL, POLITICS, SPORTS, CRYPTO, CULTURE, MENTIONS, WEATHER, ECONOMICS, TECH, FINANCE
timePeriod in DAY, WEEK, MONTH, ALL
orderBy in PNL, VOL
limit up to documented maximum
offset through documented pagination range
```

Persist:

```text
proxyWallet
rank
category
timePeriod
orderBy
vol
pnl
userName
xUsername
verifiedBadge
profileImage
leaderboardObservedAt
source = leaderboard
```

Leaderboard rank is a discovery signal. Qualification still depends on reconstructed trade behavior, current exposures, liquidity, copyability, and risk controls.

### Global Trade Discovery

Poll global recent trades:

```text
GET https://data-api.polymarket.com/trades
```

Extract:

```text
proxyWallet or user wallet field exposed by the endpoint
conditionId / market id
asset / token id
event id or slug when present
outcome
side
price
size
timestamp
transaction hash or trade id when present
source = global_trades
```

The global tape finds accounts currently trading even when they are not visible on leaderboard pages. It also gives recency evidence for score decay and activity scoring.

### Hot Event Sweeps

Find active events from public market/event metadata, live volume, recent trades, or locally observed activity. Query:

```text
GET /trades?eventId=...
```

Prioritize categories where copy trading can realistically enter and exit:

```text
- sports
- crypto
- weather
- breaking news
- economic releases
- high-volume short-dated politics/news markets
```

Lower priority does not mean ignored. Long-dated markets remain discoverable, but their copied trades face stricter holding-period, event-end, capital-lockup, and exit-liquidity gates.

### Hot Market Sweeps

For active condition IDs or token IDs, query:

```text
GET /trades?market=conditionId
```

Use market sweeps when an event contains many markets but only a subset has active flow. This also helps identify multiple leaders trading the same market, which matters for crowding and leader-correlation penalties.

### Account Dedupe and Observation Cache

Normalize wallet keys:

```text
lowercase 0x address
strip whitespace
validate address pattern when documented
preserve original display metadata separately
```

Merge duplicate observations by:

```text
wallet + trade id
wallet + transaction hash + asset + side + price + size + timestamp
wallet + source + market + approximate timestamp when no unique id exists
```

Candidate status:

```text
candidate        discovered but not yet fully refreshed
refresh_due      scheduled for trade/position refresh
qualified        passes hard eligibility and has enough evidence
watchlist        not enough evidence or temporarily below threshold
demoted          previously qualified but decayed or breached controls
rejected         failed hard rules with next review timestamp
```

The observation cache is append-only for audit and resumability. Snapshot files hold the current normalized state.

## Local Artifact Data Plane

Use local files or the app's existing runtime configuration as persistence and handoff. A conceptual layout:

```text
data/search/
  candidates.json
  observations.jsonl
  wallet_trades/
    0xabc....jsonl
  position_snapshots/
    0xabc....jsonl
  lifecycle/
    0xabc....json
  wallet_metrics.json
  score_history.jsonl
  portfolio_state.json
  promoted_leaders.json
  rejected_wallets.json
  copytrader_settings.json
```

The exact path can follow the repository's existing config/data conventions. File contents should be deterministic enough for diff review and append logs should remain suitable for replay.

### candidates.json

```json
{
  "0xabc...": {
    "proxyWallet": "0xabc...",
    "firstSeenAt": "2026-05-07T00:00:00Z",
    "lastSeenAt": "2026-05-07T01:15:00Z",
    "sources": ["leaderboard", "global_trades", "hot_event_trades"],
    "leaderboard": [
      {
        "category": "CRYPTO",
        "timePeriod": "DAY",
        "orderBy": "PNL",
        "rank": "12",
        "vol": 4200.0,
        "pnl": 850.0
      }
    ],
    "seenTradeCount": 42,
    "status": "candidate",
    "lastRefreshAt": null,
    "nextRefreshAt": "2026-05-07T01:20:00Z"
  }
}
```

### observations.jsonl

```json
{"ts":"2026-05-07T01:15:00Z","source":"global_trades","proxyWallet":"0xabc...","conditionId":"...","assetId":"...","side":"BUY","size":100,"price":0.57}
```

### wallet_metrics.json

```json
{
  "0xabc...": {
    "asofTs": "2026-05-07T01:30:00Z",
    "tradesLast24h": 18,
    "tradesLast7d": 86,
    "medianHoldSeconds": 3600,
    "p90HoldSeconds": 14400,
    "maxCurrentOpenAgeSeconds": 1800,
    "closedRoundTrips": 41,
    "expectedReturnPerTrade": 0.026,
    "maxDrawdown": 0.083,
    "cvar95": -0.042,
    "sharpe": 1.35,
    "sortino": 2.1,
    "liquidityCapacityUsdc": 250.0,
    "copyabilityScore": 0.82,
    "eligible": true,
    "rejectionReasons": []
  }
}
```

## Trade and Account Tracking

Tracking has three layers:

```text
1. raw observations from discovery and refresh APIs
2. normalized per-wallet trade histories
3. reconstructed positions, round trips, metrics, scores, and portfolio state
```

### Raw Observations

Every API observation should be stored before it is transformed:

```text
source
fetch timestamp
request parameters
response pagination cursor
wallet
trade identifiers
market/event identifiers
asset identifiers
side, price, size, timestamp
raw payload hash
```

Raw retention allows bug fixes in lifecycle reconstruction without losing original evidence.

### Per-Wallet Histories

For every candidate above the minimum activity threshold, periodically fetch:

```text
GET /trades?user=wallet
GET /positions?user=wallet
GET /closed-positions?user=wallet
```

Use the closed-position endpoint where it improves realized PnL, settlement, and lifecycle labeling. Use the trade history as the primary behavioral source because copyability depends on entry/exit timing, size, liquidity, and market context.

### Position Snapshots

For each wallet refresh, persist current positions:

```text
wallet
asofTs
conditionId
assetId
outcome
size
avgPrice
currentPrice
notional
unrealizedPnl
marketEndTs
positionAgeEstimate
```

Position snapshots support:

```text
- stale-position rejection
- exposure concentration
- local forced-exit design
- comparison between leader open exposure and copytrader open exposure
- detection of silent exits missed by trade pagination gaps
```

### Lifecycle Reconstruction

Reconstruct inventory per `wallet + conditionId + assetId + outcome`.

For each trade:

```text
BUY  -> net_position += size
SELL -> net_position -= size
```

A position opens when exposure moves from near-zero to non-zero:

```python
if abs(previous_position) <= dust and abs(new_position) > dust:
    open_ts = trade.timestamp
```

A position closes when exposure returns to near-zero:

```python
if abs(previous_position) > dust and abs(new_position) <= dust:
    close_ts = trade.timestamp
    holding_period = close_ts - open_ts
```

For partial exits, weighted-average cost is the default accounting method:

```text
avg_entry_price = total_cost / shares
realized_pnl_on_sell = shares_sold * (sell_price - avg_entry_price)
```

FIFO can be added later for lot-level research if weighted-average accounting materially distorts round-trip results.

Lifecycle records:

```text
wallet
conditionId
eventId
assetId
outcome
category
openTs
closeTs
holdingPeriodSeconds
entryNotional
exitNotional
weightedAvgEntryPrice
weightedAvgExitPrice
realizedPnlEstimate
realizedReturn
maxPositionSize
tradeCount
leaderEntryTradeIds
leaderExitTradeIds
isCurrentlyOpen
markPriceAtRefresh
unrealizedPnlEstimate
liquidityAtEntry
liquidityAtExit
copyDelaySecondsAssumption
copySlippageEstimate
```

### Cache Retention and Refresh Cadence

Suggested retention:

```yaml
raw_observations_retention_days: 180
wallet_trade_history_retention_days: 365
position_snapshot_retention_days: 90
score_history_retention_days: 365
rejected_wallet_retention_days: 90
```

Suggested cadence:

```yaml
global_trades_poll_seconds: 15
hot_event_sweep_seconds: 60
hot_market_sweep_seconds: 60
leaderboard_sweep_minutes: 15
candidate_refresh_minutes: 10
qualified_wallet_refresh_minutes: 3
watchlist_refresh_minutes: 30
rejected_wallet_recheck_hours: 24
portfolio_rebuild_minutes: 30
copytrader_settings_export_minutes: 5
```

Refresh priority:

```text
recently seen active wallets
qualified wallets with live allocation
wallets with open copied positions
leaderboard wallets with high recent PnL or volume
watchlist wallets close to promotion threshold
rejected wallets only after cool-down
```

The process resumes from snapshots and append logs after restart.

## Hard Eligibility and Risk Qualification

Hard rules protect the copytrader from stale, illiquid, and structurally uncopyable behavior.

Default rejection rules:

```text
any current open position older than 24 hours
p95 closed holding period above 24 hours without explicit long-horizon strategy approval
closed round trips below the minimum evidence threshold
recent trade count below the activity threshold
recent notional below the minimum capacity threshold
single-event exposure above cap
market liquidity below minimum copy size
copy slippage estimate erases expected edge
wallet behavior mostly passive maker fills that cannot be followed
score data too stale
```

Suggested requirements:

```yaml
last_trade_age_max_minutes: 360
min_trades_last_24h: 10
min_trades_last_7d: 50
min_active_days_last_14d: 5
min_notional_last_7d: 1000
max_position_age_seconds: 86400
preferred_p90_hold_seconds: 21600
preferred_median_hold_seconds: 7200
max_unclosed_position_fraction: 0.10
max_single_event_exposure_fraction: 0.25
min_closed_round_trips: 30
min_copyable_liquidity_usdc: 5000
max_expected_copy_slippage: 0.03
```

Preferred holding profile:

```text
median hold < 2h
p75 hold < 6h
p90 hold < 12h
p99 hold < 24h
```

Risk classes:

```text
Tier A: passes hard filters, strong score, copyable size, portfolio-eligible
Tier B: passes hard filters, smaller allocation or more evidence required
Tier C: active but insufficient round trips, low edge, or limited liquidity
Rejected: stale positions, long holds, low activity, noisy behavior, or uncopyable execution
```

## Quantitative Metric Library

Metrics are computed at wallet, market, event, category, regime, and portfolio levels. Every metric record includes `asofTs`, lookback window, sample size, and data-quality flags.

### Return Metrics

```text
realized PnL
unrealized PnL
total PnL
return on deployed capital
return on peak capital
return per trade
return per round trip
return per active day
return per holding-hour
annualized or normalized return where statistically meaningful
gross return before execution adjustment
net return after spread, fees, expected copy slippage, and forced-exit assumptions
```

### Volatility Metrics

```text
trade-return volatility
daily-return volatility
downside volatility
exponentially weighted volatility
realized volatility by category
volatility of edge after execution costs
```

### Drawdown Metrics

```text
max drawdown
average drawdown
drawdown duration
time to recovery
current drawdown
drawdown by category
drawdown after copied execution assumptions
```

### Tail-Risk Metrics

```text
VaR 95 / 99
CVaR 95 / 99
worst trade
worst day
left-tail skew
loss streak distribution
probability of loss exceeding configured bankroll fraction
scenario loss under forced exit
scenario loss under liquidity collapse
```

### Risk-Adjusted Performance

```text
Sharpe ratio
Sortino ratio
Calmar ratio
Omega ratio where useful
information ratio against the discovered leader universe
expected return / CVaR
expected return / max drawdown
```

### Kelly and Sizing Inputs

```text
win probability
loss probability
average win
average loss
payoff ratio
full Kelly fraction
fractional Kelly fraction
capped Kelly fraction
Kelly confidence haircut from sample size
Kelly haircut from drawdown and tail risk
```

### Trade Quality Metrics

```text
hit rate
profit factor
average win / average loss
median win / median loss
win/loss streaks
entry price improvement relative to market midpoint
exit price improvement relative to market midpoint
post-entry adverse excursion
post-entry favorable excursion
leader timing edge measured after assumed copy delay
```

### Exposure Concentration Metrics

```text
single-market exposure
single-event exposure
single-category exposure
single-outcome exposure
open-position fraction
top-N exposure concentration
Herfindahl-Hirschman concentration index across events and categories
crowding score with other promoted leaders
```

### Liquidity and Capacity Metrics

```text
market 24h volume
event live volume
order book depth within configured price bands
bid/ask spread
available depth at target copy size
leader trade size relative to depth
copy size relative to depth
exit depth estimate
capacity before expected slippage exceeds threshold
capacity before copy order materially changes price
capacity by leader and by market
```

### Execution and Slippage Metrics

```text
expected slippage at target size
spread paid on entry
spread paid on exit
estimated fee drag
copy delay sensitivity
fill probability under limit order rules
marketable order price impact
missed trade rate
partial fill rate in paper or shadow mode
forced-exit execution cost
```

### Holding-Period Metrics

```text
median hold
p75 / p90 / p95 / p99 hold
maximum open age
maximum closed hold
holding-period return
holding-period drawdown
fraction of positions closed within 1h / 6h / 12h / 24h
stale open-position rate
capital lockup duration
```

### Regime and Category Metrics

```text
performance by category
performance by event type
performance by market duration
performance by market liquidity bucket
performance before / during / after high-news periods
sports pregame and live behavior
crypto range-bound and breakout behavior
weather and economic release behavior
category-specific drawdown and tail risk
```

### Correlation and Covariance Across Leaders

Build leader return series on aligned time buckets and event/market exposure buckets:

```text
leader daily return covariance
leader intraday return covariance
event-overlap correlation
market-overlap correlation
category-overlap correlation
drawdown co-occurrence
tail-loss co-occurrence
copied-trade signal correlation
crowding correlation when multiple leaders enter the same outcome
```

Use shrinkage when samples are small:

```text
sample covariance
exponentially weighted covariance
Ledoit-Wolf-style shrinkage toward diagonal or constant-correlation target
category-factor covariance approximation
stress covariance from tail-loss windows
```

## Edge + Risk + Liquidity Scoring

The scorer emits a score vector with formal sub-score outputs. Scores are normalized to `0.0` through `1.0` where higher is better, except explicit penalties.

```json
{
  "proxyWallet": "0xabc...",
  "asofTs": "2026-05-07T01:30:00Z",
  "edgeScore": 0.74,
  "riskScore": 0.82,
  "liquidityScore": 0.81,
  "capacityScore": 0.69,
  "executionScore": 0.76,
  "holdingPeriodScore": 0.88,
  "activityScore": 0.79,
  "consistencyScore": 0.66,
  "regimeScore": 0.71,
  "correlationPenalty": 0.12,
  "copyabilityScore": 0.82,
  "eligible": true,
  "tier": "A",
  "rejectionReasons": []
}
```

### Edge Score

Inputs:

```text
net expected return after spread, fees, expected copy slippage, and delay
realized return per trade
return per active day
profit factor
hit rate adjusted for payoff ratio
average win / average loss
timing edge after copy delay
sample-size confidence
```

Output:

```text
edgeScore
expectedReturnPerTrade
expectedReturnPerDollar
edgeConfidence
```

### Risk Score

Inputs:

```text
max drawdown
CVaR
loss streaks
current drawdown
stale position rate
open-position fraction
single-event concentration
tail-loss co-occurrence with promoted leaders
```

Output:

```text
riskScore
drawdownScore
tailRiskScore
concentrationScore
stalePositionPenalty
```

### Liquidity and Capacity Score

Inputs:

```text
order book depth
spread
market volume
exit depth
leader size relative to depth
copy size relative to depth
market end time
liquidity collapse frequency
```

Output:

```text
liquidityScore
capacityScore
maxCopyNotionalByMarket
expectedSlippageAtTargetSize
```

### Execution Score

Inputs:

```text
copy delay sensitivity
fill probability
partial-fill probability
slippage sensitivity
marketable order cost
forced-exit cost
```

Output:

```text
executionScore
limitOrderViability
marketOrderCostEstimate
copyDelayHaircut
```

### Combined Copyability Score

Example formula:

```text
copyabilityScore =
    + 0.24 * edgeScore
    + 0.20 * riskScore
    + 0.16 * liquidityScore
    + 0.12 * capacityScore
    + 0.10 * executionScore
    + 0.08 * holdingPeriodScore
    + 0.05 * activityScore
    + 0.05 * consistencyScore
    + 0.04 * regimeScore
    - 0.04 * correlationPenalty
```

Hard rejections override the weighted score.

## Portfolio Construction

The portfolio layer allocates bankroll across promoted leaders and optionally across categories. It uses leader expected returns and covariance estimates to maximize expected performance under practical risk, liquidity, and copytrader constraints.

### Return Model

Expected return per leader should combine:

```text
recent net return after execution costs
longer-lookback net return
category-adjusted return
regime-adjusted return
paper-traded copied return
shadow-execution copied return
score-decayed return estimate
sample-size confidence haircut
```

Example:

```text
mu_i =
    0.35 * recent_net_return_i
  + 0.25 * paper_copied_return_i
  + 0.15 * shadow_copied_return_i
  + 0.15 * long_lookback_net_return_i
  + 0.10 * category_regime_adjusted_return_i

mu_i = mu_i * sample_confidence_i * score_decay_i
```

### Covariance Estimation

Estimate covariance from aligned leader returns:

```text
daily return buckets
intraday return buckets
event-level PnL buckets
category-level PnL buckets
copied-trade signal overlap
tail-loss windows
```

Use shrinkage for stability:

```text
Sigma = alpha * sample_covariance + (1 - alpha) * shrinkage_target
```

Shrink toward a diagonal matrix when leader samples are sparse and toward a category-factor model when event/category overlap explains co-movement.

### Constraints

Portfolio constraints:

```text
sum(weights) <= configured bankroll deployment fraction
weight_i >= 0 unless short-copying is explicitly supported
weight_i <= per-leader allocation cap
event exposure <= event cap
market exposure <= market cap
category exposure <= category cap
expected portfolio CVaR <= CVaR budget
expected portfolio drawdown <= drawdown budget
risk-of-ruin estimate <= configured threshold
turnover <= turnover budget
minimum liquidity capacity per allocated leader
no allocation to leaders with stale scores or hard rejection flags
correlation cluster allocation cap
```

Example defaults:

```yaml
max_total_bankroll_deployed: 0.35
max_per_leader_weight: 0.08
max_per_event_weight: 0.12
max_per_market_weight: 0.05
max_per_category_weight: 0.20
max_pairwise_leader_correlation: 0.65
max_correlation_cluster_weight: 0.15
max_expected_cvar95: 0.06
max_expected_drawdown: 0.12
max_turnover_per_rebuild: 0.20
max_risk_of_ruin: 0.01
```

### Objective Functions

Support multiple objective functions for research and production gating:

```text
maximize Sharpe:
max_w (w' mu - rf) / sqrt(w' Sigma w)

maximize expected return subject to risk:
max_w w' mu
subject to drawdown, CVaR, risk-of-ruin, liquidity, and allocation constraints

maximize return / CVaR:
max_w (w' mu) / portfolio_CVaR

minimize variance for target return:
min_w w' Sigma w
subject to w' mu >= target_return

maximize robust return:
max_w conservative_mu' w - lambda * w' Sigma w - penalties
```

The production allocation should prefer robust constrained optimization over pure maximum historical return, because copy trading is exposed to delay, liquidity, stale signals, and leader crowding.

### Leader Correlation Handling

If two leaders often trade the same event, same outcome, or lose during the same windows, treat them as correlated even if their daily return series is short.

Correlation controls:

```text
cluster leaders by event overlap, category overlap, copied-signal overlap, and return covariance
cap total allocation per cluster
penalize leaders whose edge duplicates an already allocated leader
prefer lower-correlation leaders when expected returns are similar
stress-test simultaneous forced exits across correlated leaders
```

### Portfolio Outputs

```json
{
  "generatedAt": "2026-05-07T01:30:00Z",
  "bankrollUsdc": 10000,
  "maxTotalDeploymentUsdc": 3500,
  "objective": "max_return_subject_to_cvar_drawdown_ruin",
  "leaders": [
    {
      "proxyWallet": "0xabc...",
      "weight": 0.045,
      "allocationUsdc": 450,
      "maxOpenNotionalUsdc": 450,
      "maxTradeNotionalUsdc": 75,
      "expectedReturn": 0.026,
      "cvar95": -0.041,
      "correlationCluster": "crypto_short_horizon_1"
    }
  ],
  "portfolioRisk": {
    "expectedReturn": 0.018,
    "volatility": 0.047,
    "cvar95": -0.052,
    "maxDrawdownEstimate": 0.097,
    "riskOfRuinEstimate": 0.006
  }
}
```

## Bet Sizing and Risk of Ruin

Bet sizing converts portfolio leader allocations into trade-level copy sizes. The sizing engine optimizes for expected return while minimizing risk of ruin under explicit model assumptions. It does not claim certainty; it emits constrained sizes with assumptions, confidence, and hard caps.

### Bankroll Definitions

```text
bankroll = total capital assigned to the copytrader
active_risk_bankroll = bankroll fraction allowed to be exposed
leader_allocation = portfolio weight assigned to a leader
leader_remaining_capacity = allocation minus current copied exposure
event_remaining_capacity = event cap minus current event exposure
market_remaining_capacity = market cap minus current market exposure
liquidity_capacity = maximum size before expected slippage exceeds threshold
```

### Kelly Base

For a binary simplified payoff model:

```text
full_kelly_fraction = (b * p - q) / b
where:
p = estimated win probability
q = 1 - p
b = net payoff ratio after spread, fees, slippage, and forced-exit assumptions
```

Use haircuts:

```text
fractional_kelly = full_kelly_fraction * kelly_fraction
capped_kelly = min(fractional_kelly, per_trade_kelly_cap)
confidence_adjusted_kelly = capped_kelly * sample_confidence * score_confidence
```

Default controls:

```yaml
kelly_fraction: 0.25
per_trade_kelly_cap: 0.02
per_leader_open_exposure_cap: 0.08
per_event_open_exposure_cap: 0.12
per_market_open_exposure_cap: 0.05
min_trade_notional_usdc: 5
max_trade_notional_usdc_global: 100
max_trade_notional_as_leader_trade_fraction: 0.25
max_depth_consumption_fraction: 0.10
```

### Risk-of-Ruin Model

Estimate risk of ruin using conservative simulations and closed-form approximations where appropriate:

```text
inputs:
  bankroll
  per-trade size distribution
  leader expected returns
  leader covariance/correlation
  win/loss distribution
  CVaR and drawdown estimates
  forced-exit loss assumptions
  liquidity shock assumptions
  concurrent exposure assumptions

outputs:
  riskOfRuinEstimate
  probabilityDrawdownExceedsThreshold
  expectedMaxDrawdown
  worstScenarioLoss
  allowedSizeMultiplier
```

Ruin definition should be configurable:

```yaml
ruin_bankroll_fraction: 0.50
max_daily_loss_fraction: 0.05
max_weekly_loss_fraction: 0.12
max_open_loss_fraction: 0.08
max_risk_of_ruin: 0.01
```

The size multiplier is reduced until the risk estimate fits the configured budget.

### Per-Bet Sizing Formula

For a leader trade:

```text
candidate_size =
    bankroll
  * leader_weight
  * trade_confidence
  * confidence_adjusted_kelly_multiplier
  * regime_multiplier
  * score_decay_multiplier
```

Final size:

```text
final_size = min(
  candidate_size,
  leader_remaining_capacity,
  event_remaining_capacity,
  market_remaining_capacity,
  liquidity_capacity,
  global_max_trade_notional,
  leader_trade_fraction_cap,
  ruin_allowed_size
)
```

Reject the trade if:

```text
final_size < minimum trade notional
expected net edge <= 0 after execution assumptions
copying breaches any leader/event/market/category cap
risk-of-ruin estimate exceeds threshold after adding the trade
market liquidity is below threshold
leader score is stale or demoted
market end time or holding-period expectation violates gates
```

### Local Forced Exits

The copytrader must enforce local exit rules even if the leader does not exit:

```yaml
forced_exit:
  soft_exit_after_minutes: 360
  hard_exit_after_minutes: 1440
  exit_before_market_close_minutes: 10
  exit_if_leader_exits: true
  exit_if_leader_reverses: true
  exit_if_market_liquidity_collapses: true
  exit_if_wallet_demoted: true
  exit_if_daily_loss_cap_hit: true
```

Forced-exit costs feed back into expected return, CVaR, and risk-of-ruin estimates.

## Live Trade Gates

Every promoted wallet remains subject to trade-level gates.

Market filters:

```yaml
max_market_end_time_from_now_hours: 24
preferred_market_end_time_from_now_hours: 6
min_liquidity_usdc: 10000
min_24h_volume_usdc: 5000
max_spread: 0.04
max_expected_slippage: 0.03
min_expected_net_edge: 0.005
```

Position rules:

```yaml
max_total_open_exposure_fraction: 0.35
max_leader_open_exposure_fraction: 0.08
max_event_open_exposure_fraction: 0.12
max_market_open_exposure_fraction: 0.05
max_category_open_exposure_fraction: 0.20
max_correlated_cluster_exposure_fraction: 0.15
```

Reject a copied trade if:

```text
the market is too illiquid
spread is too wide
expected slippage erases edge
the market end time is outside allowed bounds
the leader's wallet has become stale since last qualification
copying would breach exposure limits
the trade duplicates an already crowded correlated signal
paper or live drawdown gates are currently closed
```

## Copytrader Settings Export

The settings export is the operational bridge to the counterpart application. It should be deterministic, reviewable, and directly consumable by the copytrader runtime or by an adapter that updates existing runtime config.

Exported settings:

```text
promoted leaders
per-leader allocation
per-leader max open notional
per-leader max trade notional
per-market caps
per-event caps
per-category caps
correlation-cluster caps
trade filters
live gates
forced-exit settings
paper/live mode gates
demotion and pause rules
score as-of timestamps
data-quality flags
```

Example artifact:

```json
{
  "schema": "polymarket_copytrader_settings",
  "generatedAt": "2026-05-07T01:30:00Z",
  "mode": "paper",
  "bankroll": {
    "currency": "USDC",
    "totalBankroll": 10000,
    "maxTotalDeploymentFraction": 0.35,
    "dailyLossLimitFraction": 0.05,
    "weeklyLossLimitFraction": 0.12,
    "ruinBankrollFraction": 0.5,
    "maxRiskOfRuin": 0.01
  },
  "leaders": [
    {
      "proxyWallet": "0xabc...",
      "tier": "A",
      "enabled": true,
      "allocationFraction": 0.045,
      "maxOpenNotionalUsdc": 450,
      "maxTradeNotionalUsdc": 75,
      "minCopyScore": 0.75,
      "copyDelayAssumptionSeconds": 10,
      "scoreAsOf": "2026-05-07T01:30:00Z",
      "demoteIfScoreBelow": 0.65,
      "pauseIfNoRefreshMinutes": 15
    }
  ],
  "marketFilters": {
    "minLiquidityUsdc": 10000,
    "min24hVolumeUsdc": 5000,
    "maxSpread": 0.04,
    "maxExpectedSlippage": 0.03,
    "maxMarketEndTimeFromNowHours": 24,
    "minExpectedNetEdge": 0.005
  },
  "exposureCaps": {
    "maxTotalOpenExposureFraction": 0.35,
    "maxPerLeaderFraction": 0.08,
    "maxPerEventFraction": 0.12,
    "maxPerMarketFraction": 0.05,
    "maxPerCategoryFraction": 0.2,
    "maxPerCorrelationClusterFraction": 0.15
  },
  "betSizing": {
    "method": "fractional_capped_kelly_with_ruin_constraint",
    "kellyFraction": 0.25,
    "perTradeKellyCap": 0.02,
    "maxDepthConsumptionFraction": 0.1,
    "maxTradeNotionalAsLeaderTradeFraction": 0.25
  },
  "forcedExit": {
    "softExitAfterMinutes": 360,
    "hardExitAfterMinutes": 1440,
    "exitBeforeMarketCloseMinutes": 10,
    "exitIfLeaderExits": true,
    "exitIfLeaderReverses": true,
    "exitIfMarketLiquidityCollapses": true,
    "exitIfWalletDemoted": true,
    "exitIfDailyLossCapHit": true
  },
  "liveModeGates": {
    "requirePaperPositiveNetPnl": true,
    "minPaperTrades": 100,
    "minPaperActiveDays": 7,
    "maxPaperDrawdownFraction": 0.08,
    "manualApprovalRequired": true
  }
}
```

Promotion should be explicit and reversible. Live mode should require separate approval after paper and shadow metrics satisfy configured gates.

## Research Workflow

### Paper Trading

Paper trading consumes the exported settings and simulates copytrader behavior:

```text
observe promoted leader trade
apply live gates
compute target size
simulate fill using order book, spread, and slippage assumptions
track copied position lifecycle
force local exits when rules trigger
compare copied return to leader return
write paper execution logs
```

Paper metrics:

```text
paper net PnL
paper return on deployed capital
paper hit rate
paper profit factor
paper drawdown
paper CVaR
missed trade rate
partial fill rate
slippage error
leader-to-copy return decay
forced-exit cost
```

### Backtest and Walk-Forward Validation

Backtests replay stored observations and wallet histories.

Walk-forward process:

```text
train metrics on lookback window
select leaders and portfolio weights
export simulated settings
replay next out-of-sample window
measure copied execution after slippage and gates
roll forward and repeat
```

Required outputs:

```text
out-of-sample return
out-of-sample drawdown
out-of-sample CVaR
leader turnover
allocation turnover
promotion precision
demotion effectiveness
risk-of-ruin calibration
category/regime robustness
```

### Shadow Execution

Shadow execution runs beside live market data without placing orders:

```text
consume real-time leader events
apply the same gates and sizing
record what would have been submitted
record estimated available liquidity
record whether the order would likely fill
compare estimated fill to subsequent market prices
```

Shadow mode is the final validation step before live allocation.

### Score Decay

Scores decay when evidence becomes stale:

```text
score_decay = exp(-minutes_since_last_refresh / half_life_minutes)
activity_decay = exp(-minutes_since_last_trade / activity_half_life_minutes)
edge_decay increases after drawdown, missed exits, or regime shift
```

Suggested defaults:

```yaml
score_half_life_minutes: 180
activity_half_life_minutes: 360
max_score_age_minutes_for_live_copy: 15
max_position_snapshot_age_minutes_for_live_copy: 5
```

### Demotion Rules

Demote or pause leaders when:

```text
hard eligibility fails
current open position age breaches 24h
copyability score falls below threshold
paper or live drawdown exceeds limit
CVaR exceeds risk budget
expected edge turns negative after execution costs
market behavior shifts to low-liquidity or long-horizon trades
missed-trade or partial-fill rate exceeds threshold
leader correlation cluster becomes crowded
data refresh becomes stale
```

Demotion should update:

```text
candidates.json
wallet_metrics.json
score_history.jsonl
portfolio_state.json
copytrader_settings.json
```

### Monitoring Metrics

Operational monitoring:

```text
API fetch success rate
pagination completeness
candidate count by source
qualified / watchlist / rejected counts
refresh lag
score age
settings export age
copytrader config load success
```

Quant monitoring:

```text
live copied PnL
paper copied PnL
leader-to-copy slippage
expected and realized edge variance
drawdown
CVaR
risk-of-ruin estimate drift
exposure by leader/event/market/category
correlation cluster exposure
forced exits
demotions
```

## Promotion Workflow

Promotion is file-based and auditable.

```text
1. Discovery loop writes candidates and raw observations locally.
2. Tracking worker refreshes wallet histories and position snapshots.
3. Lifecycle worker reconstructs positions and round trips.
4. Quant engine computes metric library.
5. Scorer emits edge, risk, liquidity, capacity, execution, and copyability scores.
6. Portfolio optimizer selects leaders and weights.
7. Bet-sizing engine converts weights into per-leader and per-trade limits.
8. Settings exporter writes copytrader config artifacts.
9. Paper and shadow workflows validate copied behavior.
10. Manual approval enables live allocation within configured gates.
```

Promotion record fields:

```text
proxyWallet
tier
copyabilityScore
edgeScore
riskScore
liquidityScore
capacityScore
executionScore
asofTs
discoverySources
leaderboardRankings
lastTradeAt
tradesLast24h
tradesLast7d
medianHoldSeconds
p90HoldSeconds
maxCurrentOpenAgeSeconds
closedRoundTrips
expectedReturn
cvar95
maxDrawdown
correlationCluster
portfolioWeight
maxOpenNotional
maxTradeNotional
status
rejectionReasons
demotionReasons
notes
```

Promotion should be idempotent. Re-running qualification and optimization should update generated files without manual cleanup.

## Build Order

### Public API Discovery

```text
- sweep official leaderboard across categories, time periods, order modes, and offsets
- poll global /trades
- poll /trades by hot event
- poll /trades by hot market
- normalize and dedupe accounts
- write candidate cache and observation log locally
```

Success condition:

```text
The system discovers a broad account universe from both official leaders and active public trade flow.
```

### Wallet Tracking

```text
- backfill /trades?user=... for candidates
- fetch /positions?user=...
- fetch /closed-positions?user=... where useful
- write per-wallet trade histories and position snapshots
- reconstruct lifecycle records
- enforce retention and refresh cadence
```

Success condition:

```text
The system maintains current account histories, open exposures, and reconstructed round trips from local artifacts.
```

### Metric Engine

```text
- compute returns, volatility, drawdown, tail risk, risk-adjusted returns, Kelly inputs, trade quality, exposure, liquidity, execution, holding-period, regime, and correlation metrics
- attach sample-size and data-quality flags
- write wallet_metrics.json and score_history.jsonl
```

Success condition:

```text
The system can distinguish profitable, risky, stale, crowded, illiquid, and operationally uncopyable leaders.
```

### Scoring and Promotion

```text
- compute formal score vector
- apply hard eligibility rules
- assign Tier A/B/C/Rejected
- export promoted_leaders.json
- support manual review and reversible promotion
```

Success condition:

```text
The system produces a reviewable leader universe suitable for portfolio construction and paper trading.
```

### Portfolio Optimization

```text
- estimate expected returns
- estimate covariance and correlation clusters
- run constrained max-Sharpe and constrained max-return objectives
- apply exposure, drawdown, CVaR, liquidity, risk-of-ruin, and turnover constraints
- write portfolio_state.json
```

Success condition:

```text
The system produces leader allocations that target high expected return while staying within explicit risk budgets.
```

### Bet Sizing and Settings Export

```text
- convert portfolio weights into bankroll allocations
- compute fractional/capped Kelly sizes
- apply CVaR, drawdown, liquidity, hard caps, and risk-of-ruin constraints
- export copytrader_settings.json
```

Success condition:

```text
The copytrader counterpart can consume deterministic settings for leaders, allocations, caps, gates, and forced exits.
```

### Paper Trading, Shadow Execution, and Live Guarded Rollout

```text
- run paper trading from exported settings
- run walk-forward validation
- run shadow execution against live opportunities
- enable live allocation only after configured gates and manual approval
- monitor live metrics and demote leaders automatically when controls trigger
```

Success condition:

```text
Live copying follows only recently qualified, liquid, risk-controlled leaders and remains bounded by local risk controls.
```

## External Components Outside Runtime Scope

The runtime excludes:

```text
- Kafka or streaming infrastructure
- new SQL database schema
- warehouse-backed analytics
- direct Polygon RPC indexing
- CTF Exchange OrderFilled log reconstruction
- Neg Risk CTF Exchange indexing
- Conditional Token transfer indexing
- Dune/Goldsky/Allium/The Graph integrations
- full historical Polymarket account universe from chain history
- automatic promotion to live trading without review
- multi-process distributed crawlers
```

These are outside the operational boundary unless a research task identifies a measured gap that requires one of them.

Decision question before adding infrastructure:

```text
Can the current public Polymarket APIs plus local artifacts answer the research question with enough accuracy for copytrader settings?
```

If yes, keep the local artifact data plane. If no, add the narrowest external research component that answers the specific gap and keep the runtime export contract unchanged.
