# Source public entry inventory

Snapshot: main `ee9aa3ff98e6b3fd64640a10d5cff908f3b0beff`. This is a repository inventory, not a provider capability certification or permission to remove an export.

## Boundary and discovery

The selected-provider `createMarketDataSource` exposes K-lines, adjustment factors, quotes, financial records and quote subscriptions. It does not silently fall back or read the ordinary daily cache; unsupported providers fail explicitly. `getMarketDataCapabilities` reports implementation metadata, not connectivity or entitlement. Its normalized observation includes the actual source, endpoint, observation time and unknown units. See [implementation](../../src/source/src/market-data.ts).

Legacy `fetchBars` can use date-covering cache and provider fallback; `fetchLiveBars` bypasses cache but retains provider fallback and attempt attribution. Source receives cache and archive ports rather than importing storage. The two paths cannot be substituted merely because both return prices: adjustment, provenance, time/window and failure behavior must be preserved. See [legacy routing](../../src/source/src/sources.ts) and [provider routing](../../src/source/src/source-providers.ts).

Rows below enumerate the explicit named re-exports in [the public entry](../../src/source/index.ts). The consumer column records static named imports/re-exports whose relative specifier resolves directly to that entry, outside `src/source`; aliases are attributed to the original name. A dash means no such import was found, not that the export is unused. Tests are included. Namespace consumers are listed separately because identifying their per-export access requires further analysis. Dynamic imports, CommonJS, path aliases, transitive imports, generated code and external consumers are not established by this scan. Module-level tests can import internal paths directly and are outside this public-entry scan. The snapshot must be refreshed when interfaces or consumers change.

Classification describes the current public boundary; an unresolved mapping is not an approved migration. Types are listed with their owning family, not represented as callable operations.

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
| `createMarketDataSource` | value | Selected-provider facade | `src/runtime/data/source-runtime.ts` |
| `getMarketDataCapabilities` | value | Selected-provider facade | — |
| `MarketDataCapabilities` | type | Type | — |
| `MarketDataSource` | type | Type | — |
| `SourceConnection` | type | Type | — |
| `SourceRequestOptions` | type | Type | — |
| `KlineInterval` | type | Type | — |
| `KlineAdjustment` | type | Type | — |
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

These files import the public entry as a namespace; their individual member use is not included in the named-consumer column.

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
| `TSP_LIST_CATALOG_REVISION` | value | Utility / metadata | catalog test |
| `TSP_LIST_CATALOG_VERSION` | value | Utility / metadata | catalog test |
| `TSP_LIST_COLUMNS` | value | Utility / metadata | catalog test |
| `TspListColumn` | type | Utility / metadata | — |

These four additive exports identify the pinned display-column inventory; they do not certify a provider capability. See [TSP list catalog](./tsp-list-catalog.md). The earlier 104-export snapshot above remains tied to its stated revision.

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
| `TradingDateKlineRequest` | type | Market data facade | Source tests |
| `TradingDateKline` | type | Market data facade | — |
| `TradingDateKlineResult` | type | Market data facade | — |
| `TradingDateMarketDataSource` | type | Market data facade | — |
| `TradingDateMarketDataCapabilities` | type | Market data facade | — |

These additive types represent a session date separately from any provider timestamp; they do not establish complete history or entitlement.

## Versioned bar and factor observation conversion

| Export | Kind | Classification | Static consumers |
| --- | --- | --- | --- |
| `toBarObservations` | value | Observation conversion | Source tests |
| `toFactorObservations` | value | Observation conversion | Source tests |
| `toTradingDateBarObservations` | value | Observation conversion | Source tests |
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
| `IndexReference` | type | Published index metadata | — |
| `IndexMemberReference` | type | Current index membership observation | — |
| `IndexQuoteObservation` | type | Index spot observation | — |
