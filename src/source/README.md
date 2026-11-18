# Source Module

`src/source/` owns market data provider access for WhyJ Quant.

## Layout

- `src/source/index.ts`
  - public entrypoint for the rest of the app
- `src/source/src/`
  - provider adapters and cross-provider orchestration
- `src/source/tests/`
  - regression and module behavior tests

## Responsibilities

- normalize configured source selection
- fetch bars from AKShare, Tushare, TickFlow, LLMQuant, and Financial Datasets
- fall back across providers when one source is empty, stale, or unavailable
- fall back across AKShare upstream endpoints before falling through to another provider
- merge provider results with cache behavior only through injectable runtime deps
- expose source attribution metadata for TUI Overview

## Internal module split

| File | Responsibility |
|------|----------------|
| `src/source/src/source-contracts.ts` | shared source DTOs, runtime deps, provider options, and attribution labels |
| `src/source/src/source-providers.ts` | provider registry, symbol normalization, fallback order, and symbol search |
| `src/source/src/sources.ts` | cache-aware fetch facade and live fetch attribution over provider pulls |
| `src/source/src/akshare.ts` | AKShare fetch orchestration and compatibility re-exports |
| `src/source/src/akshare-global-bars.ts` | market-checked Python US/HK daily histories and exact native-block fallback dispatch |
| `src/source/src/sina-global-history.ts` | bounded Sina US/HK encoded history parsing, identity/window validation and native-free fetch |
| `src/source/src/sina-a-history.ts` | native-free A-share/index history, strict JSON qfq factors and date-effective adjustment |
| `src/source/src/sina-history-payload.ts` | shared identity-matched encoded payload, trailing-comment and selected OHLCV validation |
| `src/source/src/vendor/sina-history-decoder.js` | static MIT-licensed AKShare decoder; unknown return type validated by the owned adapter |
| `src/source/src/akshare-types.ts` | AKShare DTOs shared by parser, client, and tools |
| `src/source/src/akshare-normalize.ts` | AKShare payload parsers and row normalizers |
| `src/source/src/akshare-python.ts` | Python interpreter discovery and subprocess execution |
| `src/source/src/akshare-dependency.ts` | network-free import and optional MiniRacer runtime diagnosis |
| `src/source/src/eastmoney-fund-nav.ts` | bounded public fund HTTP and JSON literal parsing after an exact native DLL block; no JavaScript evaluation |
| `src/source/src/akshare-scripts.ts` | Python script payloads used by AKShare subprocess calls |
| `src/source/src/akshare-endpoints.ts` | AKShare public endpoint whitelists and endpoint types |
| `src/source/src/sina-index-client.ts` | Sina A-index quote fallback client |
| `src/source/src/tushare.ts` | Tushare-backed fetch |
| `src/source/src/tickflow.ts` | native TickFlow HTTP daily/minute bars, adjustment factors and quote snapshots |
| `src/source/src/llmquant.ts` | LLMQuant-backed market fetch |
| `src/source/src/financial-datasets.ts` | Financial Datasets-backed fetch |
| `src/source/src/http.ts` | shared JSON/text transport, body-inclusive deadline, cancellation and bounded UTF-8 text reads |

## Import rules

The [public entry inventory](../../docs/quant-harness/source-public-inventory.md) records the existing exports and their known in-repository consumers. It is a migration snapshot, not evidence of provider entitlement or external usage.

1. External callers import from `src/source/index.ts`.
2. Tests may import deep module paths when they are targeting one adapter directly.
3. Cross-provider policy belongs in `source-providers.ts`, not in individual adapters.
4. AKShare endpoint fallback belongs inside the AKShare adapter; runtime callers must not select Eastmoney/Sina/Tencent directly.
5. Provider-specific parsing or transport logic stays in the adapter file.
6. Raw provider adapters do not import storage; callers pass explicit provider options or rely on canonical environment variables.
7. Storage-backed cache/settings defaults live in `src/runtime/data/source-runtime.ts`, not in this module.

## Fallback model

For ordinary A-share daily bars, fallback is deliberately layered:

1. AKShare tries Eastmoney (`stock_zh_a_hist`), Sina (`stock_zh_a_daily`), then Tencent (`stock_zh_a_hist_tx`).
2. Symbol classification keeps suffixed stocks, `.OF` funds, and known indexes on separate endpoint families.
3. Empty/error endpoint attempts are retained by `fetchFromAKShareDetailed()`.
4. If AKShare returns no bars or raises an adapter-level error, `source-providers.ts` tries Tushare.
5. `fetchBars()` may finally use date-matching provider cache; `fetchLiveBars()` never reads or writes cache.
6. Cross-provider `attempts.error` carries a stable failure category only; arbitrary provider exception text can contain private URLs, headers or response bodies and must not enter research/Agent output.

`SourceRuntimeDeps.loadCache()` returns bars/freshness/DatasetRef together from one snapshot. Cache, archive, preferred-source and credential ports receive the active AbortSignal; the storage-backed runtime implements them with async file I/O. `saveBars()` accepts the same signal and returns the reference for the exact returned observations. Storage adapters preserve immutable revisions; source does not construct paths or read paired metadata separately. Cancellation is rechecked after preference/settings reads, cache lookup, provider pull, lock acquisition and each commit boundary. Host replacements may still be synchronous, so their own JavaScript cannot be preempted by the facade.

US defaults to LLMQuant → Financial Datasets → AKShare `stock_us_daily`; HK defaults to LLMQuant → AKShare `stock_hk_daily`. The public Python adapter accepts only the matching market symbol, strips `.HK` for the Hong Kong endpoint, and returns unadjusted daily bars. It does not turn a data subscription failure into a verified subscription.

An explicit WinError 4551 from these two Python routes activates the independent Sina HTTP adapter. It accepts only the expected encoded-string declaration and trailing closed comments, then calls a static local decoder; network text is never evaluated. Successful routes are `sina_us_daily_native_free` / `sina_hk_daily_native_free`, with the original failed attempt retained. Dates are validated across the decoded history; OHLCV is validated for the requested window (last 30 observations when unbounded), rejecting the whole window if any selected row is invalid. Raw numeric precision remains unchanged. US amount is null; HK amount retains the provider value without unit certification. Other failures, successful empty responses and cancellation do not activate this fallback. Decoder provenance and license are recorded in [vendor/README.md](./src/vendor/README.md).

Explicit SH/SZ stocks whose source priority includes Sina, and known A indexes, can also use a native-free Sina route after the Python chain process times out or every completed attempt explicitly reports WinError 4551. The eligible Python chain has a 15-second limit to leave room inside Doctor's 30-second overall deadline; other paths retain their 30-second Python limit. Genuine empty responses and unrelated failures do not activate it. Stock OHLC is divided by the latest provider qfq factor effective on each observation date; missing factors fail the request, future factors are not backfilled. Index levels are unchanged. Volume, available amount and numeric precision are preserved. Actual endpoints are `sina_a_daily_qfq_native_free` / `sina_a_index_daily_native_free`; the shared payload module owns parsing for all four markets. BJ/ambiguous symbols keep existing routes. Current factors do not prove historically published or independently calibrated company actions.

The completed native-block attempts must include the matching stock/index Sina endpoint. An error for a fund endpoint cannot activate stock HTTP fallback; the full-suite regression covers this instrument boundary.

For `.OF` fund bars and dedicated fund NAV, empty data with every internal attempt explicitly failing with WinError 4551 activates the literal-only Eastmoney fallback. The successful endpoint is `eastmoney_fund_net_worth`; the logical provider family remains `akshare`. NAV/DCA callers archive the resolved endpoint, and generic bars preserve `unit-nav` rather than inferring stock prices or total return. Real empty responses and other failures retain their existing behavior. Exact Python endpoint diagnostics remain separate from successful fallback data checks.

Callers may configure `providers.akshare.sourcePriority`, override a `BarProviderAdapter`, or set a market
`fallbackOrder`. These are separate controls: endpoint order is internal to AKShare, while fallback order chooses
between top-level providers.

## Provider-neutral market data facade

`fetchDailyBars` on the factory result maps the existing daily adapters to a date-keyed series with the actual endpoint and price basis. Its selected-provider market mapping, units and compatibility boundaries are in the [provider guide](../../docs/quant-harness/source-data-providers.md#现有日线适配统一入口).

Import `createMarketDataSource` and the request/result types from `src/source/index.ts`. Runtime can bind local settings with `createConfiguredMarketDataSource`. The timestamp-mode facade implements the TickFlow slice for SH/SZ/BJ; the explicit trading-date daily mode additionally supports Tushare. Unsupported combinations fail instead of silently switching source. The established `fetchBars` route remains compatible and retains its own fallback and cache policy.

`getMarketDataCapabilities(source)` describes which selected-provider facade operations are implemented. It performs no I/O and returns independent data with connectivity and entitlement explicitly `unknown`. This is not a connection test or an entitlement, instrument, interval, freshness or completeness guarantee. Other providers' legacy APIs and the `fetchBars` pipeline are separate from this declaration.

| Method | Contract |
| --- | --- |
| `fetchKlines({ symbol, interval, adjustment, startTime?, endTime?, count? })` | Daily or minute OHLCV with millisecond timestamps, explicit period and price basis. |
| `fetchAdjustmentFactors({ symbols, startTime?, endTime? })` | Dated factors for each requested symbol; no local factor application. |
| `fetchQuotes({ symbols })` | Quote snapshots with source timestamps and explicit missing symbols. |
| `fetchOrderBook({ symbol })` | A single ordered bid/ask snapshot with source timestamp; TickFlow provides up to five levels per side. Zero values are retained, and volume units and empty-level semantics remain unknown. |
| `fetchFinancials({ symbols, kind, startDate?, endDate?, latest? })` | Income, balance sheet, cash flow, metrics or shares; report-period and announcement dates remain distinct. Currency and units are unknown. |
| `subscribeQuotes({ symbols }, handlers, options?)` | Explicit quote subscription; resolves only after provider acknowledgement, returns `close()` and `closed`, and reports failures without reconnecting. |

The factory returns `OrderBookMarketDataSource` and `OrderBookMarketDataCapabilities`, which extend the prior public types. Existing implementations of `MarketDataSource` and `MarketDataCapabilities` do not need the new member.

The factory also returns a `fetchKlines` overload for `{ timeMode: "trading-date", assetType: "stock", symbol, interval: "1d", adjustment, startDate, endDate }`. Dates are inclusive `YYYY-MM-DD` Shanghai trading dates over at most 366 calendar days (years 0001–9998); only SH/SZ/BJ stock-code patterns are accepted. Results retain the requested window, market, asset type and calendar timezone. Tushare supports `adjustment: "none"`; its returned `tradeDate` has `sourceTimestamp: null`, volume in hands and amount in thousands of CNY as documented by [Tushare](https://tushare.pro/document/2?doc_id=27). TickFlow supports `none` and `forward`; Shanghai timezone rules assign its actual timestamp to a trade date, and `sourceTimestamp` retains that timestamp. TickFlow's current timestamp adapter rejects non-positive epochs. Its units remain unknown. The distinct `dailyByTradingDate` capability describes this mode: Tushare's older timestamp-mode `klines` capability remains `not-implemented`. Existing facade interfaces and `ReturnType` behavior remain compatible. These results never assert that dates are complete, final, historically available, or entitled; suspended sessions may be absent. Neither mode caches or falls back. Date-mode results are not accepted by the timestamp-based `toBarObservations` converter or existing archive pipeline.

The result reports actual source, endpoint, observation time, and unknown units. Source time is retained per observation; retrieval time does not certify freshness or finality. Time windows use inclusive UTC milliseconds; no assumptions about calendar completeness. Direct facade calls always request the selected provider and do not read or write cache; this does not change the shared daily `fetchBars` cache policy tracked in [#261](https://github.com/yangjingo/WhyJ-Quant/issues/261).

The current TickFlow adapter maps these contracts to [TickFlow REST](https://docs.tickflow.org/zh-Hans/api-reference/openapi.json), using `WHYJ_QUANT_TICKFLOW_API_KEY` and optional `TICKFLOW_BASE_URL`. It does not use TSP, Python or MCP. Compact columns must align; malformed data, identity conflicts, duplicate timestamps and out-of-window rows fail. Bounded windows reaching the 10,000-row count cap fail as potentially truncated; use smaller windows. Batch factor/quote requests are limited to 100 symbols. Each response is limited to 8 MiB with timeout, cancellation and no redirects. Strict finality, calendar completeness and volume/amount units remain unverified. Financial dates filter reporting period, not publication; an announcement date alone does not establish point-in-time availability or revision history. Missing financial fields remain null; currency, magnitude and ratio units are not certified. WebSocket authentication uses the provider-required URL query key, never returned in diagnostic errors. Quote subscriptions do not reconnect, persist, or feed the UI automatically; closing or cancellation ends the stream. Stream permission is separate from snapshot access. Unified contracts and adapters for additional families and providers remain tracked by [#264](https://github.com/yangjingo/WhyJ-Quant/issues/264).
## Test rules

- put provider parsing tests in `src/source/tests/`
- when a live-source bug causes Overview to show empty quotes or wrong source labels, add a regression test in `sources.test.ts`
- test AKShare endpoint payloads, priorities, and embedded chain behavior in `akshare.test.ts`
- cover both endpoint-level and provider-level empty/error fallback paths
- keep tests deterministic; mock provider adapters instead of hitting network paths

## Related docs

- [Module Architecture](../../docs/agent-runtime/architecture.md)
- [Source Providers](../../docs/quant-harness/source-data-providers.md)
- [OhQuant Storage Policy](../../docs/agent-runtime/storage.md)

## Versioned bar and factor observations

`toBarObservations` and `toFactorObservations` convert existing selected-source facade results to version 1 per-record envelopes. Daily and intraday bars retain symbol, UTC-millisecond timestamp, interval, adjustment, OHLCV and nullable amount; factors retain symbol, timestamp and factor. Every record carries the actual Source provider, endpoint and retrieval time. Market, asset type, source-as-of time, units, finality, coverage, revision and quality remain `unknown`; factor basis is also `unknown`. Timestamps are UTC milliseconds, not a claim about an exchange-local session or completed bar. Conversion preserves order, rejects duplicate identities or malformed values, and does not apply factors, infer missing values, access the network or persist data.

`toTradingDateBarObservations` converts the dated daily result to a separate version 2 Source record with its Shanghai trade date, actual provider timestamp or null, requested date range, identity, source, price basis and provider-reported or unknown units. It checks timestamp/date consistency and does not fetch or persist data. The existing v1 archive, runtime collection and Host do not accept this format yet; those integrations require separate changes. It does not assert complete history or live entitlement.

For example, a `KlineResult` with interval `1d` yields `daily_bar`; `1m` and the other supported minute intervals yield `minute_bar`. A factor result keyed by `600000.SH` yields an `adjustment_factor` carrying that exact key. These records define a serialization boundary only: they are not a TSP transport, sync checkpoint, completeness guarantee, live permission check or point-in-time certificate. Quote, financial and other derived observations remain separate work under [#258](https://github.com/yangjingo/WhyJ-Quant/issues/258) and [#264](https://github.com/yangjingo/WhyJ-Quant/issues/264).

Version-1 bar and factor observations can be archived and replayed by exact reference using the separate Storage API; see [observation archives](../../docs/agent-runtime/storage.md#版本化行情观察归档). Source does not write storage or initiate synchronization. An archive batch is homogeneous by symbol, dataset, source, endpoint, retrieval time and, for bars, interval and adjustment; split a multi-symbol factor response before archiving. This does not add TSP transport or certify freshness or completeness.
