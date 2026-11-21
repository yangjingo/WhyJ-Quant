# TSP list-column catalog

Source exposes `TSP_LIST_COLUMNS`, `TSP_LIST_CATALOG_VERSION` and `TSP_LIST_CATALOG_REVISION` as a versioned inventory of the 59 watchlist and 55 screener built-in column declarations at TSP revision `f9cb383c5918c6a88a412f3ce43d59fe81b94ccc`. The two lists contain 64 distinct keys; hidden defaults are retained. The catalog records labels and default visibility per list. `rendererFields` lists direct `r.field` references in each shared renderer case, including fields used for styling; it excludes implicit dependencies and helper internals and is not necessarily the displayed value or the actual data producer. `unresolved` means that shared rendering did not establish the mapping, including columns handled by their owning panel.

The pinned declarations are [watchlist](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/frontend/src/lib/watchlist-columns.ts) and [screener](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/frontend/src/lib/screener-columns.ts); renderer references come from [stock-table primitives](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/frontend/src/components/stock-table/primitives.tsx). The fixture captures the pinned declarations for offline regression and is not a substitute for re-auditing a newer TSP revision.

This inventory describes display metadata. See the [Source interface inventory](./source-public-inventory.md) for provider mappings and the daily formula catalog below for the supported derivations. Other TSP panels, extension tables, upstream producers, units, point-in-time semantics and synchronization remain open under [#258](https://github.com/yangjingo/WhyJ-Quant/issues/258). The provider-neutral Source migration was delivered under [#264](https://github.com/yangjingo/WhyJ-Quant/issues/264).

For the separately audited market dashboard widgets and their producers, see [TSP dashboard audit](./tsp-dashboard-audit.md).

`computeTspIndicators` provides the pinned TSP full-series RSI6/14/24 and ATR14 formulas as a separate pure calculation, identified by `TSP_INDICATOR_FORMULA_VERSION` and `TSP_INDICATOR_REVISION`. Unlike WhyJ's existing Wilder-seeded RSI and ATR, TSP initializes exponential averages from the first observation, uses `1e-12` for zero RSI loss, and produces values without a full warm-up window. Inputs must be finite, positive OHLC values with nonnegative volume and strictly increasing valid dates; missing or malformed rows are rejected. The caller must establish price adjustment, completeness, finality and calendar gaps: this function neither infers nor fills them. Its offline synthetic fixture was generated from the pinned TSP pipeline with Polars 1.44.1 and compares every output row within `1e-9`; it does not establish live data availability or TSP synchronization.

## Chart price levels

Quant's `computeTspPriceLevels` returns eleven groups as of the last supplied trading date, including volume profile, pivot points, price extrema and swings, Bollinger, three Keltner horizons, ATR bands, gaps, Fibonacci levels and round numbers. It reuses the daily WhyJ calculations and follows the TSP group definitions and rounding. It needs ordered OHLCV for one symbol on a consistent price basis. Historical extrema use intraday high and low, while the separate 60-day daily indicator uses close. [Pinned TSP price-level definitions](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/indicators/levels.py#L566)

When historical turnover is absent, the profile uses accumulated volume. The result identifies a volume-only, turnover-decay or partial-turnover basis. Groups without sufficient history are empty, and future observations are outside the selected `asOf` history. [TSP volume profile](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/indicators/levels.py#L62)

## Completed daily OHLCV fields

Source exports `TSP_DAILY_INDICATOR_FIELDS` for the 37 outputs of the pinned TSP daily OHLCV calculation. This catalog maps to direct renderer references for 31 of the 64 list keys. Quant exposes `computeTspDailyIndicators` with upstream field names, `TSP_DAILY_INDICATOR_FORMULA_VERSION` and `TSP_INDICATOR_REVISION`. The authenticated archive read includes the full result in `daily`, with WhyJ as producer and the provider recorded in the input metadata. The original four-field series remains available to existing clients. [Pinned pipeline](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/indicators/pipeline.py#L370)

- Previous close, price change, fractional return and amplitude use the preceding observation. Momentum uses 5/10/20/30/60 preceding observations. The 20-day annualized volatility uses sample deviation scaled by `sqrt(252)`.
- MA and EMA use 5/10/20/30/60 observations. The 60-day extrema use **close**, including the current observation. MACD uses EMA 12/26/9 with a doubled histogram, Bollinger Bands use MA20 plus or minus two sample deviations, and KDJ uses a nine-bar OHLC range.
- Volume averages use 5/10 bars. The 5-day ratio uses the five volumes before the current bar, without session-length scaling. Warm-up, a zero volume denominator, and a flat KDJ range produce null where applicable. The synthetic reference normalizes TSP non-finite outputs to null. The caller supplies the adjustment basis and the completed-date window, and missing sessions are never filled.

The opt-in command-line probe uses an existing `WHYJ_QUANT_TICKFLOW_API_KEY` process credential. Set `OHQUANT_DIR` to a disposable workspace if the archive should be isolated. Request at least 61 returned bars and end before the current Shanghai date.

```sh
bun run src/cli/dev/tsp-daily-indicator-smoke.ts 600000.SH 2026-07-01 2026-11-17
```

The probe requests forward-adjusted A-share daily bars, archives and replays the response, then emits JSON with source endpoint, returned dates, archive and formula identity, per-field availability and direct renderer mappings. Coverage and finality remain unknown. The other list keys include raw observations, fundamentals, exchange-specific signals, strategy output and user state. They require their own source or computation evidence under #258.

## Daily signals

`computeTspDailySignals` reproduces the pinned 20 daily seeds from WhyJ's indicator series. Moving-average and MACD crossings compare the current bar with the preceding bar, and the Bollinger threshold rules check the current bar. The 60-day high and low use the trailing close extrema including the current bar. The volume surge threshold is a 5-day volume ratio of at least two. Each rule returns `true`, `false`, or `null` for missing inputs or an incomplete warm-up. [TSP seed definitions](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/strategy/signal_seeds.py)

Limit-up, limit-down, broken-limit-up and limit-down recovery consume separately supplied raw prices and effective daily limit thresholds. Their availability is independent of the technical rules. A caller can provide raw OHLC from the same date and symbol along with the verified threshold; an adjusted bar alone does not identify it. The result describes historical rule state, with alert delivery and intraday tracking managed separately.

`computeTspLimitStreaks` counts consecutive closing limit-up and limit-down sessions for one symbol. Supply the ordered exchange sessions and the two WhyJ closing-limit flags for each observed date. A verified non-hit yields zero and sets the next run's starting point. A missing session or unknown flag leaves that direction unknown until a verified reset, including at the start of a window. Non-trading days are outside the calendar and leave the run intact. The result carries a separate formula version through `TSP_LIMIT_STREAK_FORMULA_VERSION`. [Pinned TSP daily pipeline](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/indicators/pipeline.py)

## Completed-minute features and signals

`computeTspIntraday` calculates 11 numeric features and four crossing events for one A-share symbol. The input uses a single price basis, Shanghai minute-start labels for completed bars (09:30–11:29 and 13:00–14:59), volume in shares, amount in CNY, and optional previous closes keyed by trading date. Ratio and distance fields use fractions. Source adapters must establish units, finality and timestamp semantics before calling this calculator. [Pinned features](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/strategy/intraday_features.py) · [Pinned crossing rules](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/strategy/intraday_signals.py)

- The 1/3/5-minute volume ratios compare adjacent equally sized windows inside each continuous session. VWAP and the day's extremes accumulate across lunch and reset each trading date. The opening range is available after the 30th consecutive morning bar.
- Crossings use a strict current comparison and an inclusive previous comparison. The previous bar may be the last morning bar at the afternoon reopening, provided both adjoining minutes are available. First bars, gaps and missing operands make the affected signal unavailable (`null`).
- A missing minute invalidates the affected day's cumulative values from the gap onward. A volume window can recover as consecutive complete minutes arrive. A complete opening range already calculated stays available. Provider-observed zero is kept separate from missing data. These explicit availability rules apply before projection onto any event-only consumer.

## Completed-session stock price deviation

`computeTspPriceDeviation` returns the 3, 10 and 30-session stock return minus its eligible index return as a fraction. The caller supplies an ordered trading calendar and closes on a consistent basis for each series. The result names the selected index and the start date used for each comparison. The five board mappings preserve the pinned primary and alternate index codes. Callers can choose and identify the alternate explicitly. Missing stock or index endpoints yield `null` at the original window; later observations cannot change an earlier result. [Pinned TSP deviation pipeline](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/indicators/pipeline.py#L1116)

## Auction watchlist performance

`computeTspAuctionPerformance` reproduces the pinned watchlist's three price changes: close divided by open, close divided by the previous trading session's close, and next trading session close divided by current close, each minus one. The caller supplies the calendar revision and the exact neighboring sessions, plus unadjusted prices. Missing prices remain null for the specific change. A later price cannot substitute for a missing neighbor. Raw close comparisons can include corporate-action effects. [Pinned TSP calculation](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/services/auction_benchmark.py)

The WhyJ result keeps watchlist order and records the formula version, calendar and fractional return unit. The high-open marker uses the provider's auction return in percentage points with an inclusive threshold of five. Missing auction returns leave the marker unavailable. The marker identifies a threshold crossing and carries no estimate of future returns. [TSP feature guide](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/docs/features.md)

## Dragon-tiger recap rankings

`computeTspDragonTiger` ranks the five largest positive and negative net amounts on the all-stock board, plus up to five institution and hot-money entries by descending net amount. Amounts remain signed CNY values. Ties keep provider order. Missing amounts are excluded, and an empty observed board is distinct from an unavailable board. The result identifies each record by its board position and keeps one-day and three-day records separate. [Pinned TSP recap](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/services/dragon_tiger.py)

## Built-in research factors

Quant's `computeTspResearchFactors` evaluates the 77 registered TSP built-in research factor keys for one symbol. It reuses the daily calculation for the 17 overlapping technical fields. Results use WhyJ calculations and the pinned TSP scoring definitions. The existing WhyJ factor names and their formulas retain their own conventions. [TSP registry](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/factors/registry.py#L95) · [TSP scoring expressions](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/strategy/scoring.py#L88)

Only OHLCV and the trading date are required. Amount-dependent factors use explicitly supplied CNY amounts; VWAP and the TSP float-market-value score also need a known volume unit (`share` or `hand`). Turnover uses historical percentage points. Limit-up counts use the supplied per-date classified history and leave incomplete windows unavailable. Provider-normalized inputs and the price basis remain the caller's responsibility.

Financial factors accept dated, validated snapshots for the same symbol. The latest snapshot announced on a strictly earlier date determines eligibility. The previous report stays eligible on a new report's announcement date. PB uses close divided by positive BPS, while the other six facts preserve the eligible provider values. Missing input or an invalid denominator yields `null`. The calculator neither discovers provider data nor asserts historical coverage. [TSP financial gate](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/backtest/fundamentals.py#L81)

## Cross-sectional factor information

`computeTspFactorInformation` evaluates a dated factor against subsequent simple close-to-close returns for a fixed exchange calendar and price basis. The caller supplies one observation per symbol and session, including explicit nulls for unknown data. WhyJ records the pinned TSP revision, the result formula version, the rebalancing period, and the number of usable price and factor rows. The result is a historical diagnostic. Use observations that were eligible on their signal dates.

Daily returns use exact offsets in the supplied exchange calendar, even when the selected universe has no rows for a session. Weekly and monthly returns use the first observed price date in each week or month, including the first observed date of a partial window. A missing price for a symbol on the target date excludes that pair. A null factor on the outcome date leaves the outcome close eligible.

Rank IC correlates the average ranks of factor and return within each paired cross-section. Constant ranks and fewer than two pairs leave a date without a valid IC. Annual and full-window summaries use population dispersion, a strict positive IC win rate and an IR only when dispersion exceeds `1e-8`. Decay uses the pinned 1-, 3- and 5-session method, which ranks the full eligible factor cross-section before filtering absent outcomes for each horizon. The decay values can therefore differ from daily IC even at horizon one. Correlations are summarized before display rounding. [Pinned TSP factor implementation](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/backtest/factor.py)

## Factor group returns and turnover

`computeTspFactorGroups` reuses the validated price panel and exact rebalance endpoints from the information calculation. It assigns average ranks before filtering missing outcomes, so equal factors stay in one bucket and an absent outcome only affects the observed group weights. Weights can be equal or based on the pinned factor-strength rank. Each measured group return deducts two commissions, one stamp tax and two slippage charges. An explicit commission overrides the legacy fee fraction.

NAV starts at one. A group with no paired outcome in a period carries its NAV and reports a null period return. Group performance uses the pinned calendar-year annualization and derives the Sharpe and win rate from successive recorded NAV values. Sharpe uses 252, 52 or 12 periods per year for daily, weekly or monthly rebalancing. Turnover averages half the absolute weight changes between successive observed positions of the highest observed group.

The 50/50 theoretical spread pairs the highest and lowest observed group paths and applies the pinned spread cost. It carries `executableShort: false` and reports no spread when fewer than two groups have outcomes. Group and spread diagnostics describe the supplied historical panel. [Pinned TSP group and spread methods](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/backtest/factor.py)

## Factor IC by market state

Optional market observations attach the previous exchange session's state and score to each priced evaluation date. Strong and lean-strong form the strong bucket, range keeps its own bucket, and lean-weak and weak form the weak bucket. Each bucket keeps the priced date count and mean score independently of the count and statistics of its valid unrounded IC samples.

A priced first day without a preceding session is reported under `unclassifiedAtStart`. Once the predecessor is known, missing prior-session observations fail the diagnostic, including inside the calendar when the selected factor universe has no prices. The caller supplies an exact exchange calendar and, when available, its immediately preceding date. [Pinned TSP alignment](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/backtest/regime_alignment.py)

## Backtest trade robustness

`computeTspBacktestRobustness` summarizes realized trade returns and holding durations. Its Sortino uses zero as the target, includes all finite observations in the downside deviation denominator and uses 252 periods per year by default. An explicit periodic return series changes the Sortino sample while leaving the trade statistics and simulation on realized trades. With fewer than two returns the pinned Sortino is zero. A sufficient sample without downside has an unavailable ratio.

The seed-42 NumPy-compatible PCG64 sampler draws with replacement from finite trades. The default is 1,000 simulations, with the pinned sample-size reduction for large inputs. The simulation measures peaks from the first post-trade equity and floors simulated returns at -99.99%. The observed best, worst and median figures retain the original returns. P50 is the median signed maximum drawdown, and P95 is its adverse fifth percentile. Fewer than three trades produce unavailable percentiles. The diagnostic describes the supplied sample. [TSP robustness implementation](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/backtest/engine.py)
