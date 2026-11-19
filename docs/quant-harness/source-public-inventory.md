# Source public entry inventory

The export table inventories the named public entry in this revision. It records direct repository consumers and selected-provider mappings. Real account access and coverage require separate evidence.

## Boundary and discovery

The selected-provider `createMarketDataSource` exposes K-lines, adjustment factors, quotes, financial records and quote subscriptions. It does not silently fall back or read the ordinary daily cache; unsupported providers fail explicitly. `getMarketDataCapabilities` reports implementation metadata, not connectivity or entitlement. Its normalized observation includes the actual source, endpoint, observation time and unknown units. See [implementation](../../src/source/src/market-data.ts).

Legacy `fetchBars` can use date-covering cache and provider fallback; `fetchLiveBars` bypasses cache but retains provider fallback and attempt attribution. Source receives cache and archive ports rather than importing storage. The two paths cannot be substituted merely because both return prices: adjustment, provenance, time/window and failure behavior must be preserved. See [legacy routing](../../src/source/src/sources.ts) and [provider routing](../../src/source/src/source-providers.ts).

Rows below enumerate the explicit named re-exports in [the public entry](../../src/source/index.ts). The consumer column records static named imports/re-exports whose relative specifier resolves directly to that entry, outside `src/source`; aliases are attributed to the original name. A dash means no such import was found, not that the export is unused. Tests are included. Namespace consumers are listed separately because identifying their per-export access requires further analysis. Dynamic imports, CommonJS, path aliases, transitive imports, generated code and external consumers are not established by this scan. Module-level tests can import internal paths directly and are outside this public-entry scan. The snapshot must be refreshed when interfaces or consumers change.

Classification describes the current public boundary; an unresolved mapping is not an approved migration. Types are listed with their owning family, not represented as callable operations.

## Canonical Source families

The selected HTTP or Python adapter is chosen by `createMarketDataSource`. `getMarketDataCapabilities` reports offline operation support for that selection. It performs no network request and declares no entitlement or live coverage. The cross-market daily request, Shanghai trading-date request and UTC instant K-line request are distinct. [Provider and field examples](./source-data-providers.md)

| Current callable contract | Implemented mapping and observable response |
| --- | --- |
| Daily `fetchDailyBars` | Five built-in daily adapters use inclusive dates, native scope and actual endpoint. A US Financial Datasets day request sets `interval=day` and returns OHLCV with a separate optional adjusted close. Tushare raw daily cannot satisfy a forward-adjusted request. |
| Trading-date `fetchKlines` | TickFlow and Tushare A-share stocks. Tushare `daily.trade_date` maps to a session date and no instant. TickFlow maps `/v1/klines.timestamp` in Shanghai. A Tushare forward-adjusted request is unsupported, and neither output proves session coverage. |
| Instant `fetchKlines` | TickFlow `/v1/klines`. For a 5-minute raw request, `period=5m` and `adjust=none` select timestamped bars. A provided interval or adjustment is validated. Date-only Tushare results cannot satisfy this contract. |
| `fetchAdjustmentFactors` | TickFlow `/v1/klines/ex-factors`. `timestamp` and `ex_factor` map to a dated factor whose basis is unknown. This is not a dividend or split event ledger. |
| `fetchQuotes`, `fetchOrderBook`, `subscribeQuotes` | TickFlow `/v1/quotes`, `/v1/depth` and authenticated stream. Snapshot `last_price` and `prev_close` are distinct values, absent symbols are explicit, and depth levels retain provider order and zero values. Subscription setup requires an acknowledgement and does not establish tick delivery. |
| `fetchPriceSnapshot` | TickFlow quote projection for A shares and Financial Datasets `/prices/snapshot` for US equities. A latest-price result carries an actual or unknown timestamp, and the Financial Datasets subset cannot satisfy full OHLC or depth. |
| `fetchFinancials` | TickFlow `/v1/financials/{income,balance-sheet,cash-flow,metrics,shares}`. E.g. report `period_end` and `announce_date` map independently and `net_income` maps to `netIncome`. An announcement date does not establish availability at a modeled execution time. |
| `fetchDailyValuation` | Tushare `daily_basic` requires an exact stock trade date. `pe`, `pe_ttm`, `pb`, `total_mv`, and `circ_mv` have separate meanings. Dates are validated and monetary units remain native. |
| `fetchDailyTradingLimits` | Tushare `stk_limit` supplies one A-share stock's previous close and effective limit prices in CNY over a bounded inclusive trading-date range. Availability depends on the selected account. WhyJ rule thresholds are computed separately. |
| `fetchReportFinancialIndicators` | Tushare `fina_indicator` supplies provider ratios, per-share book value and report announcement metadata for one A-share stock and an inclusive report-period window. Retains same-period rows and rejects cap-saturated responses. |
| `fetchFinancialDisclosureDates` | Tushare `disclosure_date` supplies plan and actual disclosure dates and correction text for one A-share stock and one report period. These dates do not identify the release of a given ratio revision. |
| `fetchHistoricalStockUniverse` | Tushare `bak_basic` returns a provider-defined historical A-share list for one date. Preserves source and optional listing date and industry. Coverage is unknown; a saturated response fails. |
| `fetchHistoricalMinuteBars` | Tushare `stk_mins` returns past A-share one-minute bars for one symbol with a bounded date window. It preserves original Shanghai labels, shares, CNY, and an explicit 09:30 opening-boundary flag. Coverage and finality are unknown. |
| `searchInstruments`, `fetchInstrumentUniverse`, `fetchTradingCalendar` | Tushare A-share `stock_basic` searches by name, AKShare SH/SZ main-board rosters retain per-exchange endpoint evidence, and AKShare/Sina `tool_trade_date_hist_sina` returns dates. The roster is current and limited in scope. It is not a historical symbol master or market coverage guarantee. |
| `fetchFundNav`, `fetchFundProfile`, `fetchFundPurchaseTerms`, `fetchFundPerformance` | AKShare/Eastmoney and Tushare `fund_nav` provide open-fund NAV. AKShare `fund_info_ths` and Snowball supply profile fields, `fund_purchase_em` supplies current purchase terms and headline fee, and Snowball achievement/risk endpoints map to separate result arrays. Raw rank and tiered fee schedules retain their provider-specific contracts. |
| `fetchIndexMetadata`, `fetchIndexConstituents`, `fetchIndexQuotes` | AKShare `index_stock_info`, existing CSI/Sina constituent endpoints, and Sina or `stock_zh_index_spot_em` quotes. Membership, membership dates, published metadata and spot prices remain separate. |
| Source-level `fetchNews`, `readNewsDocument`, `readDisclosurePdf` | News uses Eastmoney `stock_news_em` and Yahoo Finance search or ticker news with explicit coverage and articles. Document readers preserve direct URL evidence and bounded extraction state. The PDF route covers explicit exchange and CNInfo URLs. No automatic filings discovery. |
| Source-level `fetchComparisonFx` | Frankfurter `/v2/rates` with ECB provenance. A USD/EUR request maps the provider rate to the portfolio's base-per-quote convention. No interpolation or broker-rate inference. |

Existing operations keep their specific failure contract. Selected daily and reference operations expose `SourceRequestError.code` for unsupported routes, incompatible daily price basis, deadline expiration and upstream failure where applicable. Those errors retain `Error` compatibility. Input and response validation can report additional errors and caller abort reasons are preserved. Known truncation, incompatible basis or provider failure cannot yield a partial series relabeled as complete.

### Documented capability gaps

Provider documentation is evidence of schemas, rather than evidence of working credentials or WhyJ adapter coverage. A future Core Source change needs a caller, concrete endpoint and semantic mapping before adding a route. The current scope covers shipped public observations and compatibility routes.

| Family | Current disposition and owner |
| --- | --- |
| Intraday trades or a separate cumulative session series, exchange definitions and non-A trading calendars | Documented in provider catalogs for some markets. TickFlow minute OHLCV and one A-share calendar are implemented. Tick/trade rows, session totals and market hours need separate Source contracts with start/end and missing-session semantics. |
| Dividends, split and capital events, suspensions and daily price limits | Tushare documents distinct endpoints. The current factor interface cannot answer the event history or tradability question. Source owns any future typed event mapping. |
| Additional statements, company profiles, valuation histories and factor data | TickFlow implements the five current report/metric kinds and Tushare exact-date stock valuation. Tushare, AKShare, Financial Datasets and LLMQuant list more families. Source owns future mapping of units, period, disclosure and revision. Quant owns derived indicators. |
| Fund holdings, complete instrument/exchange catalogs, sector or concept membership, fund flows, institutional/insider holdings | Distinct reference datasets documented by some providers. Raw AKShare compatibility tables and current index/member reads do not certify these capabilities. Source owns any product-scoped additions. |
| Macro series, automated evidence discovery, FX beyond ECB, derivatives, crypto and commodities | Catalogued upstream where applicable. The current product Source scope implements explicit document reads and ECB conversion. Further additions require bounded coverage and use cases. |
| Account holdings and brokerage actions | Product account and execution scope. Excluded from market Source. |

See [TickFlow](https://docs.tickflow.org/llms.txt), [Tushare](https://tushare.pro/document/2?doc_id=27), [AKShare](https://akshare.akfamily.xyz/data/stock/stock.html), [Financial Datasets](https://docs.financialdatasets.ai/llms.txt) and [LLMQuant Data](https://docs.llmquantdata.com/llms.txt) for the upstream catalogs. Deterministic fixtures here cover request mapping and counterexamples. Previously recorded live examples are attached to their specific provider delivery issues. No additional live entitlement checks were run for this audit.

### Calling and migration boundaries

1. New selected-provider callers use the factory and its capability metadata. Runtime owns credentials and cancellation. The caller specifies a market and the intended semantic operation.
2. Research callers that use cache, fallbacks, archived observations or finality checks keep the existing Runtime binding. Selected raw observations and legacy cache results are not interchangeable. Report replay only reads its fixed references.
3. Provider-named entry points stay available for CLI/TUI/Desktop and downstream source consumers. Move a caller where its request and output contracts match, with a module-specific test. Raw AKShare probes and legacy fund detail rows keep their original schemas and endpoint options.
4. News, document reads and FX are neutral Source-level functions with their own source or URL rules. They share the Source public entry without inheriting the selected market-data account. Unsupported regions, aliases, endpoint entitlements and return shapes require bounded Source work before moving a consumer.

## `./src/akshare.ts`

Legacy AKShare operations and DTOs; individual facade mappings remain unresolved.

| Export | Kind | Classification | Direct named consumers |
| --- | --- | --- | --- |
| `AKSHARE_PUBLIC_INDEX_ENDPOINTS` | value | Utility / metadata | `src/runtime/data/installed-akshare-index-schema.ts`, `src/runtime/data/tool-probe-schema.ts`, `src/runtime/data/tool-probe.ts`, `src/runtime/test/tool-probe-schema.test.ts`, `src/runtime/workspace/command-preflight.ts`, `src/tools/akshare-index-tools.ts`, `src/tools/registry.ts` |
| `fetchAkshareAIndexSpot` | value | Provider-specific operation | `src/app/workbench/market.ts`, `src/tools/akshare-index-tools.ts` |
| `fetchAkshareIndexConstituents` | value | Provider-specific operation | `src/tools/akshare-index-tools.ts` |
| `fetchAkshareIndexInfo` | value | Provider-specific operation | `src/tools/akshare-index-tools.ts` |
| `fetchAkshareIndexRows` | value | Provider-specific operation | `src/runtime/data/tool-probe.ts`, `src/tools/akshare-index-tools.ts` |
| `buildAkshareArtifactReferenceLine` | value | Utility / metadata | `src/artifact/src/reference-data.ts` |
| `classifyAkshareBarSymbol` | value | Utility / metadata | — |
| `fetchFromAKShare` | value | Provider-specific operation | — |
| `fetchFromAKShareDetailed` | value | Provider-specific operation | `src/runtime/dev/check-data-providers.ts` |
| `fetchAkshareFundHistory` | value | Provider-specific operation | — |
| `fetchAkshareFundNav` | value | Provider-specific operation | `src/runtime/data/fund-data.ts`, `src/runtime/dev/check-data-providers.ts`, `src/tools/akshare-fund-tools.ts` |
| `fetchAkshareFundProfile` | value | Provider-specific operation | — |
| `fetchAkshareFundPurchase` | value | Provider-specific operation | `src/runtime/data/fund-data.ts` |
| `fetchAkshareFundPerformance` | value | Provider-specific operation | — |
| `fetchAkshareRows` | value | Provider-specific operation | `src/runtime/data/tool-probe.ts`, `src/tools/akshare-fund-endpoint-tools.ts`, `src/tools/akshare-fund-tools.ts` |
| `AkshareArtifactReferenceLine` | type | Type | `src/artifact/src/reference-data.ts` |
| `AkshareBarInstrument` | type | Type | — |
| `AkshareBarSource` | type | Type | — |
| `AkshareBarsOptions` | type | Type | — |
| `AkshareBarsResult` | type | Type | — |
| `AkshareFundHistory` | type | Type | `src/storage/test/fixtures/fund-nav.ts`, `src/tools/akshare-fund-tools.ts` |
| `AkshareIndexConstituent` | type | Type | `src/tools/akshare-index-tools.ts` |
| `AkshareIndexConstituentsResult` | type | Type | `src/tools/akshare-index-tools.ts` |
| `AkshareIndexInfoResult` | type | Type | — |
| `AkshareIndexInfoRow` | type | Type | `src/tools/akshare-index-tools.ts` |
| `AkshareIndexQuote` | type | Type | `src/tools/akshare-index-tools.ts` |
| `AkshareIndexRowsResult` | type | Type | — |
| `AksharePublicFundEndpoint` | type | Type | `src/runtime/data/tool-probe.ts`, `src/tools/akshare-fund-endpoint-tools.ts` |
| `AksharePublicIndexEndpoint` | type | Type | `src/runtime/data/akshare-index-parameters.ts`, `src/runtime/data/akshare-index-signatures.generated.ts`, `src/runtime/data/installed-akshare-index-schema.ts`, `src/runtime/data/tool-probe.ts`, `src/tools/akshare-index-tools.ts` |
| `AkshareRowsResult` | type | Type | `src/runtime/test/tool-probe.test.ts`, `src/tools/akshare-fund-tools.ts` |
| `FundAchievementRow` | type | Type | `src/tools/akshare-fund-tools.ts` |
| `FundNavDaily` | type | Type | `src/tools/akshare-fund-tools.ts` |
| `FundRiskAnalysisRow` | type | Type | `src/tools/akshare-fund-tools.ts` |

## `./src/financial-datasets.ts`

Provider-specific Financial Datasets operations; facade mapping unresolved.

| Export | Kind | Classification | Direct named consumers |
| --- | --- | --- | --- |
| `fetchFromFinancialDatasets` | value | Provider-specific operation | — |
| `fetchFinancialDatasetsSnapshot` | value | Provider-specific operation | — |

## `./src/akshare-global-bars.ts`

Legacy AKShare global daily bars; facade mapping unresolved.

| Export | Kind | Classification | Direct named consumers |
| --- | --- | --- | --- |
| `fetchFromAKShareGlobal` | value | Provider-specific operation | — |
| `fetchFromAKShareGlobalDetailed` | value | Provider-specific operation | `src/runtime/dev/check-data-providers.ts` |

## `./src/market-data.ts`

Selected-provider facade and its DTOs; only TickFlow currently implements it.

| Export | Kind | Classification | Direct named consumers |
| --- | --- | --- | --- |
| `createMarketDataSource` | value | Selected-provider facade | `src/runtime/data/source-runtime.ts`, `tests/contracts/observation-archive.test.ts` |
| `getMarketDataCapabilities` | value | Selected-provider facade | — |
| `MarketDataCapabilities` | type | Type | — |
| `MarketDataSource` | type | Type | — |
| `SourceConnection` | type | Type | — |
| `SourceRequestOptions` | type | Type | `src/runtime/data/observation-collection.ts` |
| `KlineInterval` | type | Type | `src/runtime/data/observation-collection.ts` |
| `KlineAdjustment` | type | Type | `src/runtime/data/observation-collection.ts` |
| `TimeWindow` | type | Type | — |
| `KlineRequest` | type | Type | — |
| `FactorRequest` | type | Type | — |
| `QuoteRequest` | type | Type | — |
| `Kline` | type | Type | — |
| `AdjustmentFactor` | type | Type | — |
| `Quote` | type | Type | — |
| `ObservationResult` | type | Type | — |
| `KlineResult` | type | Type | — |
| `QuoteResult` | type | Type | — |
| `FinancialKind` | type | Type | — |
| `FinancialRequest` | type | Type | — |
| `FinancialRecord` | type | Type | — |
| `QuoteSubscriptionRequest` | type | Type | — |
| `QuoteEvent` | type | Type | — |
| `QuoteSubscription` | type | Type | — |
| `QuoteSubscriptionHandlers` | type | Type | — |

## `./src/llmquant.ts`

Provider-specific LLMQuant operation; facade mapping unresolved.

| Export | Kind | Classification | Direct named consumers |
| --- | --- | --- | --- |
| `fetchFromLlmQuant` | value | Provider-specific operation | — |

## `./src/frankfurter.ts`

FX comparison operation; facade mapping unresolved.

| Export | Kind | Classification | Direct named consumers |
| --- | --- | --- | --- |
| `fetchComparisonFx` | value | Legacy / other operation | `src/runtime/data/tool-probe.ts`, `src/runtime/dev/check-portfolio-comparison.ts`, `src/runtime/research/portfolio-comparison.ts` |

## `./src/akshare-dependency.ts`

AKShare environment diagnostic; utility, not a market-data facade operation.

| Export | Kind | Classification | Direct named consumers |
| --- | --- | --- | --- |
| `checkAkshareDependency` | value | Utility / metadata | `src/cli/doctor.ts`, `src/runtime/data/data-readiness.ts`, `src/runtime/data/tool-probe.ts` |

## `./src/akshare-python.ts`

Python subprocess utility; not a market-data facade operation.

| Export | Kind | Classification | Direct named consumers |
| --- | --- | --- | --- |
| `runPython` | value | Utility / metadata | `src/runtime/data/installed-akshare-index-schema.ts` |

## `./src/mainboard-universe.ts`

Main-board universe and DTOs; facade mapping unresolved.

| Export | Kind | Classification | Direct named consumers |
| --- | --- | --- | --- |
| `fetchMainboardUniverse` | value | Legacy / other operation | `src/runtime/research/mainboard-scan.ts` |
| `MainboardMember` | type | Type | — |
| `MainboardUniverse` | type | Type | `src/runtime/research/mainboard-scan.ts`, `src/runtime/test/mainboard-scan.test.ts` |

## `./src/news.ts`

News operations and scope normalization; facade mapping unresolved.

| Export | Kind | Classification | Direct named consumers |
| --- | --- | --- | --- |
| `fetchNews` | value | Legacy / other operation | `src/runtime/data/tool-probe.ts`, `src/runtime/evaluation/news-evaluation.ts`, `src/runtime/research/news-research.ts`, `src/runtime/test/news-headline-qualification.test.ts`, `src/runtime/test/news-research.test.ts` |
| `normalizeNewsScope` | value | Utility / metadata | `src/runtime/data/tool-probe.ts`, `src/runtime/evidence/news-answer-evidence.ts`, `src/runtime/research/news-research.ts` |

## `./src/news-document.ts`

News document reading; facade mapping unresolved.

| Export | Kind | Classification | Direct named consumers |
| --- | --- | --- | --- |
| `readNewsDocument` | value | Legacy / other operation | `src/runtime/research/news-research.ts` |

## `./src/disclosure-pdf.ts`

Bounded public disclosure reader; facade mapping unresolved.

| Export | Kind | Classification | Direct named consumers |
| --- | --- | --- | --- |
| `readDisclosurePdf` | value | Legacy / other operation | `src/app/services/research.ts`, `src/app/services/test/thesis-sources.test.ts`, `tests/app/dev/report-preview-fixture.ts` |

## `./src/sina-index-client.ts`

Provider-specific index quote operation; facade mapping unresolved.

| Export | Kind | Classification | Direct named consumers |
| --- | --- | --- | --- |
| `fetchSinaAIndexSpotQuotes` | value | Provider-specific operation | `src/runtime/data/tool-probe.ts` |

## `./src/sources.ts`

Legacy daily routing, cache/fallback orchestration, utilities and DTOs; facade mapping unresolved.

| Export | Kind | Classification | Direct named consumers |
| --- | --- | --- | --- |
| `SOURCE_LABELS` | value | Utility / metadata | `src/runtime/workspace/overview-data.ts` |
| `fetchBars` | value | Legacy / other operation | `src/runtime/data/source-runtime.ts`, `src/runtime/dev/measure-data-refresh.ts`, `src/runtime/research/alpha-research.ts`, `src/runtime/research/portfolio-comparison.ts` |
| `fetchLiveBars` | value | Legacy / other operation | `apps/tui/dev/measure-terminal-refresh.ts`, `src/runtime/data/source-runtime.ts`, `src/runtime/dev/overview/measure-overview-refresh.ts` |
| `filterBarsByDate` | value | Utility / metadata | — |
| `formatRefreshMinute` | value | Utility / metadata | `src/runtime/workspace/overview-refresh.ts`, `src/runtime/workspace/overview.ts` |
| `formatSourceLabels` | value | Utility / metadata | — |
| `normalizeBarSeries` | value | Utility / metadata | — |
| `providerOrderFor` | value | Utility / metadata | `src/runtime/research/news-research.ts` |
| `pullBarsFromProviders` | value | Legacy / other operation | `src/runtime/data/data-readiness.ts`, `src/runtime/dev/check-data-providers.ts` |
| `searchSymbols` | value | Legacy / other operation | `src/runtime/data/source-runtime.ts` |
| `BarsFetchResult` | type | Type | `src/runtime/data/source-runtime.ts`, `src/runtime/dev/measure-public-source-facade.ts`, `src/runtime/research/alpha-research.ts`, `src/runtime/research/mainboard-scan.ts`, `src/runtime/test/mainboard-scan.test.ts`, `src/runtime/test/thesis-price-check.test.ts`, `src/tools/shared/analysis-observation.ts`, `src/tools/shared/data-time-evidence.ts` |
| `BarProviderAdapter` | type | Type | `apps/tui/dev/measure-terminal-refresh.ts`, `src/runtime/dev/measure-data-refresh.ts`, `src/runtime/dev/overview/measure-overview-refresh.ts` |
| `DataSource` | type | Type | `src/runtime/data/analysis-data.ts`, `src/runtime/data/archive-analysis-data.ts`, `src/runtime/data/source-runtime.ts`, `src/tools/data-tools.ts`, `src/tools/shared/analysis-observation.ts` |
| `LiveFetchResult` | type | Type | — |
| `LiveBarsFetchResult` | type | Type | `src/runtime/data/source-runtime.ts`, `src/runtime/dev/overview/measure-public-overview-periodic.ts`, `src/runtime/dev/overview/measure-public-overview-runtime.ts`, `src/runtime/dev/overview/public-overview-evidence.ts`, `src/runtime/test/overview-data.test.ts`, `src/runtime/test/overview-refresh.test.ts`, `src/runtime/test/overview-retention.test.ts`, `src/runtime/workspace/overview-data.ts` |
| `ProviderAttempt` | type | Type | — |
| `PullBarsResult` | type | Type | — |
| `PullSource` | type | Type | `src/runtime/workspace/overview-data.ts` |
| `SourceBarsRequest` | type | Type | — |
| `SourceFetchOptions` | type | Type | `src/runtime/data/source-runtime.ts` |
| `SourceProviderOptions` | type | Type | `src/runtime/data/data-readiness.ts`, `src/runtime/data/source-runtime.ts`, `src/runtime/dev/check-data-providers.ts` |
| `SourceRuntimeDeps` | type | Type | `src/runtime/data/source-runtime.ts`, `src/runtime/dev/measure-data-refresh.ts` |

## `./src/tushare.ts`

Provider-specific Tushare operations and endpoint constant; facade mapping unresolved.

| Export | Kind | Classification | Direct named consumers |
| --- | --- | --- | --- |
| `DEFAULT_TUSHARE_BASE_URL` | value | Utility / metadata | `src/runtime/data/tool-probe.ts` |
| `fetchFromTushare` | value | Provider-specific operation | — |
| `fetchTushareSnapshot` | value | Provider-specific operation | — |
| `searchTushareSymbols` | value | Provider-specific operation | `src/runtime/data/tool-probe.ts` |

## `./src/source-providers.ts`

Legacy provider routing and research bars; facade mapping unresolved.

| Export | Kind | Classification | Direct named consumers |
| --- | --- | --- | --- |
| `fetchResearchBars` | value | Legacy / other operation | `src/runtime/data/source-runtime.ts` |

## `./src/workspace-prices.ts`

Workspace price aggregation, validation and DTO; facade mapping unresolved.

| Export | Kind | Classification | Direct named consumers |
| --- | --- | --- | --- |
| `fetchWorkspacePrices` | value | Legacy / other operation | `src/app/research-workspace/manager.ts` |
| `validateWorkspaceScope` | value | Utility / metadata | `src/app/research-workspace/manager.ts` |
| `WorkspacePrices` | type | Type | `src/app/research-workspace/manager.ts` |

## Namespace imports

These files import or re-export the public entry as a namespace. Their individual member use is outside the named-consumer column.

- `apps/tui/test/research-workflow.test.ts`
- `src/artifact/test/report-comparison.test.ts`
- `src/artifact/test/report-fund.test.ts`
- `src/cli/doctor.ts`
- `src/runtime/test/research-task-matrix.test.ts`
- `src/runtime/test/tool-probe.test.ts`
- `src/tools/test/fund-dca-tools.test.ts`

## Pinned TSP list metadata

| Export | Kind | Classification | Static consumers |
| --- | --- | --- | --- |
| `TSP_DAILY_INDICATOR_FIELDS` | value | Utility / derived-field metadata | `src/cli/dev/tsp-daily-indicator-smoke.ts`, `src/quant/test/tsp-indicators.test.ts`, `src/runtime/data/observation-collection.ts` |
| `TSP_LIST_CATALOG_REVISION` | value | Utility / metadata | — |
| `TSP_LIST_CATALOG_VERSION` | value | Utility / metadata | — |
| `TSP_LIST_COLUMNS` | value | Utility / metadata | `src/cli/dev/tsp-daily-indicator-smoke.ts` |
| `TspListColumn` | type | Utility / metadata | — |

These exports identify pinned display columns and daily OHLCV derivations. Provider capability is tracked independently. See [TSP list catalog](./tsp-list-catalog.md).

## Order book facade types

| Export | Kind | Classification | Static consumers |
| --- | --- | --- | --- |
| `OrderBookRequest` | type | Market data facade | — |
| `OrderBookLevel` | type | Market data facade | — |
| `OrderBook` | type | Market data facade | — |
| `OrderBookMarketDataCapabilities` | type | Market data facade | — |
| `OrderBookMarketDataSource` | type | Market data facade | — |

These additive types describe the selected-source `fetchOrderBook` operation. They do not change the earlier inventory snapshot or establish entitlement.

## Trading-date K-line facade types

| Export | Kind | Classification | Static consumers |
| --- | --- | --- | --- |
| `TradingDateKlineRequest` | type | Market data facade | `src/runtime/data/observation-collection.ts`, `src/runtime/test/trading-date-collection.test.ts` |
| `TradingDateKline` | type | Market data facade | — |
| `TradingDateKlineResult` | type | Market data facade | `src/storage/test/trading-date-archive.test.ts` |
| `TradingDateMarketDataSource` | type | Market data facade | — |
| `TradingDateMarketDataCapabilities` | type | Market data facade | — |

These additive types represent a session date separately from any provider timestamp; they do not establish complete history or entitlement.

## Versioned bar and factor observation conversion

| Export | Kind | Classification | Static consumers |
| --- | --- | --- | --- |
| `toBarObservations` | value | Observation conversion | `src/runtime/data/observation-collection.ts`, `tests/contracts/observation-archive.test.ts` |
| `toFactorObservations` | value | Observation conversion | `src/runtime/data/observation-collection.ts`, `tests/contracts/observation-archive.test.ts` |
| `toTradingDateBarObservations` | value | Observation conversion | `src/runtime/data/observation-collection.ts`, `src/storage/test/trading-date-archive.test.ts` |
| `ObservationEnvelopeBase` | type | Observation contract | — |
| `BarObservation` | type | Observation contract | — |
| `FactorObservation` | type | Observation contract | — |
| `BarOrFactorObservation` | type | Observation contract | — |
| `TradingDateBarObservation` | type | Observation contract | — |

These additive exports preserve facade provenance and unknowns; they do not implement TSP synchronization. See [Source guide](../../src/source/README.md#versioned-bar-and-factor-observations).

## Selected daily series

| Export | Kind | Classification | Static consumers |
| --- | --- | --- | --- |
| `DailyBarsMarketDataCapabilities` | type | Selected daily capability | — |
| `DailyBarsMarketDataSource` | type | Extended Source facade | — |
| `DailyBarsRequest` | type | Selected daily request | — |
| `DailyBarsResult` | type | Selected daily series with provenance | — |

The factory adds `fetchDailyBars` for existing daily adapters. The [provider guide](./source-data-providers.md#现有日线适配统一入口) records the mapping and compatibility boundary.

## Canonical market reference operations

| Export | Kind | Classification | Static consumers |
| --- | --- | --- | --- |
| `UnifiedMarketDataCapabilities` | type | Factory capability contract | — |
| `UnifiedMarketDataSource` | type | Factory facade | — |
| `MarketReferenceCapabilities` | type | Per-provider reference capabilities | — |
| `MarketReferenceResult` | type | Reference observation with provenance | — |
| `MarketReferenceSource` | type | Reference facade operations | — |
| `InstrumentReference` | type | Instrument identity | — |
| `FundNavObservation` | type | Fund NAV observation | — |
| `FundDetailObservation` | type | Fund profile, purchase or performance observation | — |
| `FundProfile` | type | Known fund profile fields | — |
| `FundPurchaseTerms` | type | Current subscription, redemption and headline fee | — |
| `FundPerformance` | type | Period performance and risk observations | — |
| `IndexReference` | type | Published index metadata | — |
| `IndexMemberReference` | type | Current index membership observation | — |
| `IndexQuoteObservation` | type | Index spot observation | — |
| `MarketObservation` | type | Valuation, price or calendar observation with provenance | — |
| `MarketObservationCapabilities` | type | Per-provider observation capabilities | — |
| `MarketObservationSource` | type | Observation facade operations | — |
| `DailyValuation` | type | Date-specific market valuation | — |
| `DailyTradingLimit` | type | Date-specific exchange threshold observation | — |
| `ReportFinancialIndicator` | type | Report-period provider values with announcement and update metadata | — |
| `FinancialDisclosureDate` | type | Report-period schedule and actual disclosure observation | — |
| `HistoricalMinuteBar` | type | Dated historical minute observation with its original time label | — |
| `HistoricalMinuteObservation` | type | Historical minute window with units and original rows | — |
| `PriceSnapshot` | type | Last price and day change | — |
| `TradingCalendar` | type | Calendar dates and time zone | — |
| `InstrumentUniverse` | type | Roster with per-exchange provenance | — |
| `HistoricalStockUniverse` | type | Provider-defined A-share roster for a fixed date | — |
| `SourceRequestError` | value | Selected request failure | — |
| `SourceErrorCode` | type | Stable selected failure category | — |
