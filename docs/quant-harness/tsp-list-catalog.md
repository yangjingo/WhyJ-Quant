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

## Built-in research factors

Quant's `computeTspResearchFactors` evaluates the 77 registered TSP built-in research factor keys for one symbol. It reuses the daily calculation for the 17 overlapping technical fields. Results use WhyJ calculations and the pinned TSP scoring definitions. The existing WhyJ factor names and their formulas retain their own conventions. [TSP registry](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/factors/registry.py#L95) · [TSP scoring expressions](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/strategy/scoring.py#L88)

Only OHLCV and the trading date are required. Amount-dependent factors use explicitly supplied CNY amounts; VWAP and the TSP float-market-value score also need a known volume unit (`share` or `hand`). Turnover uses historical percentage points. Limit-up counts use the supplied per-date classified history and leave incomplete windows unavailable. Provider-normalized inputs and the price basis remain the caller's responsibility.

Financial factors accept dated, validated snapshots for the same symbol. The latest snapshot announced on a strictly earlier date determines eligibility. The previous report stays eligible on a new report's announcement date. PB uses close divided by positive BPS, while the other six facts preserve the eligible provider values. Missing input or an invalid denominator yields `null`. The calculator neither discovers provider data nor asserts historical coverage. [TSP financial gate](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/backtest/fundamentals.py#L81)
