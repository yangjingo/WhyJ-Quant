# 数据源：可用行情怎样成为可用证据

量化研究最容易忽略的错误，并不是没有取到数据，而是取到一组看似合理、实际上口径不同的数据。同一个代码可能属于不同市场，同一个日期可能对应未收盘行情，同一段历史也可能因复权修订而改变。如果这些差异被统一数组掩盖，后面的计算越精确，结论反而越容易令人误信。

因此，数据层需要同时交付数值和解释数值所需的上下文。它既服务快速浏览，也服务固定版本的研究；两者共享来源适配，但不能共享一个含糊的“成功”。

## 分层的依据是责任，而不是供应商数量

Source 负责识别市场与标的、适配响应、安排兼容来源回退，并说明实际取得了什么。Runtime 绑定当前设置、凭证与存储；Storage 保存缓存和不可变观察版本；Quant 消费明确输入，不自行换源。界面展示来源、数据日期和缺项，不替数据层推断可靠性。

这条边界让供应商替换局限在接入层，也使研究者能追问：这次成功来自首选源、备用源，还是旧缓存？如果界面或计算模块各自实现回退，数据口径会随着入口改变，无法解释同一个问题为什么得到不同答案。

目前接入包括 AKShare、Tushare、TickFlow、Financial Datasets 和 LLMQuant Data，各自覆盖范围与可用权限不同。AKShare 内部还可能切换公开端点。逻辑供应商名称不足以描述实际路径，因此响应保留实际端点与尝试状态。港股链中存在 LLMQuant 路由，不等于已经确认该供应商的港股能力。当前公开导出及仓库内调用方见 [Source 接口清单](./source-public-inventory.md)；该快照不覆盖外部调用方，也不代表新接口已支持全部旧能力。

TickFlow 原生 HTTP 适配归 `src/source`，通过[供应商无关接口](../../src/source/README.md#provider-neutral-market-data-facade)提供日线、分钟线、复权因子和行情快照接口，不依赖 TSP 面板、Python 或 MCP。初始范围为沪深京标的；只有日线进入现有 `Bar` 取数链，分钟与快照保留独立时间戳。显式选择 TickFlow 才启用此来源，原有自动回退顺序不变。接口、响应上限及身份/单位证据边界见 [Source 模块](../../src/source/README.md#provider-neutral-market-data-facade)；日线样本成功不能代替其他权限验证。

统一 Source 还提供财务报表与行情订阅接口：财务记录保留报告期和公告日期，单位与币种未知时不推断；行情订阅须单独具备推送权限，断线后不自动重连。财务的报告期过滤不证明历史时点可获得，不能直接作为回测时点证据。当前尚未将推送接入界面或自动持久化。

Source 可通过 `getMarketDataCapabilities` 查询当前选定供应商在统一接口中实现了哪些操作。此查询不访问网络，账号权限和连接状态始终为未知；它不证明某个标的、周期或历史数据可用，也不描述旧取数接口的能力。设置界面仍需独立的连接测试和凭据管理接口。

统一 `fetchKlines` 增加显式交易日模式：Tushare 不复权 A 股日线返回交易日及供应商原始单位，不生成虚构时间戳；TickFlow 依据上海时区确定交易日并保留供应商时间戳。按日期窗口和股票代码范围的限制、不同复权能力与未知覆盖语义见 [Source 模块](../../src/source/README.md#provider-neutral-market-data-facade)。此模式不读取缓存、不切换供应商；不等于真实权限或完整历史已验证。

选定 Tushare 后，`fetchHistoricalMinuteBars` 通过 `stk_mins` 取单只 A 股的历史 1 分钟数据。请求使用包含首尾的上海日期，最多 31 天，结束日早于上海当天；支持的最早日期为 2010-01-01。结果保留供应商的原始上海墙钟标签、成交量（股）、成交额（元）、端点和取数时间。09:30 的原始开盘边界记录单独标记，并与 09:31、11:30、15:00 等记录一起保留。开盘边界标记只说明时间标签，覆盖和提供方最终状态仍为未知。能力声明不代表账号已获得分钟线权限。 [Tushare 历史分钟文档](https://tushare.pro/document/2?doc_id=370)

统一接口的 `fetchOrderBook({ symbol })` 可通过 TickFlow `/v1/depth` 查询单标的五档盘口。买卖价格按供应商顺序返回，零值原样保留；成交量单位、空档含义与实际账号权限尚未确认。该接口不缓存、不切换数据源，也未验证真实盘口权限；其他供应商当前明确报告未实现。

`fetchOrderBookBatch({ symbols })` 通过选定 TickFlow 的 `/v1/depth/batch` 提交一次有界请求，每批最多 100 个标的。响应保留规范化请求清单、缺少的标的、原始时间戳和盘口档位。能力元数据反映本地适配器上限，账号实际批量权限、配额和数据时效需用单独的回执确认。 [TickFlow Depth 资源](https://github.com/tickflow-org/tickflow/blob/main/tickflow/resources/depth.py)

`fetchDatedAuctionBenchmark(tradeDate)` 读取扶摇短线风向标的指定上海交易日。它使用独立的 `WHYJ_QUANT_FUYAO_API_KEY`，保留供应商选股顺序、标签和竞价涨幅百分点，允许空名单，并拒绝日期、标的身份或字段类型不匹配的响应。结果分别记录上海日期零点、供应商响应组装时刻和应用采集时刻。历史首发时间和覆盖范围未知。该入口独立于主行情路由，盘后收益由后续 WhyJ 计算。 [扶摇竞价接口](https://fuyao.aicubes.cn/docs/api-reference/auction/#短线风向标竞价基准)

`fetchDatedDragonTigerBoard(tradeDate, boardKind)` 用同一扶摇凭证读取指定交易日的全部榜、机构榜或游资榜。个股、机构和游资记录保留原始顺序和上榜区间，金额单位为元，涨跌幅和占比为小数。缺失交易所代码时保留原始 `ticker`，标的身份仍为空；同时保留上游计数、时间戳及实际采集时刻。响应交易日和榜单种类必须与请求一致。供应商时间戳单独记录，覆盖及发布时间未知。 [扶摇龙虎榜接口](https://fuyao.aicubes.cn/docs/api-reference/dragon-tiger-data/)

原生适配器每次调用均请求供应商，共享取数层当前仍有缓存命中与失败回退策略。[#261](https://github.com/yangjingo/WhyJ-Quant/issues/261) 单独跟踪取消普通日线查询的缓存替代，同时保留报告使用的不可变研究证据；该 issue 不等于策略已经变更。

## 回退提高可用性，也可能改变问题

### 现有日线适配统一入口

`createMarketDataSource({ source }).fetchDailyBars({ symbol, market, start, end, adjustment })` 查询选定源。日期是包含首尾的日历日期，结果保留原请求、实际来源及端点、取得时间、价格口径和已知单位。省略 `adjustment` 表示接受适配器现有口径，显式要求的口径与响应不符时返回错误。省略日期沿用各源的默认窗口。成交额缺失保留 `null`，覆盖始终为未知。

| 选定源 | 实现市场 | 现有上游与价格语义 |
| --- | --- | --- |
| AKShare | A、US、HK | A 股日线传入 `qfq`，指数点位与基金单位净值沿用各自端点。US/HK 通过 `stock_us_daily`、`stock_hk_daily` 或内置 Sina 路由，保留实际端点及原口径。 |
| Tushare | A | `daily`、`index_daily`、`fund_daily`、`fund_nav`。普通股票 `daily` 为未复权，成交量为手、成交额为千元。 |
| TickFlow | A | `/v1/klines` 使用日线和前复权请求，沿用旧适配器的 UTC+08:00 日期映射。已识别的指数按指数点位标记。 |
| LLMQuant Data | US | `/api/equity/historical` 的单独调整收盘价保留为 `adjClose`，OHLC 的复权口径仍为未知。 |
| Financial Datasets | US | `/prices/` 的分页沿用适配规则，独立 `adjusted_close` 保留为 `adjClose`，不会改写 OHLC。 |

例如 `{ symbol: "600000.SH", market: "A", start: "2026-11-13", end: "2026-11-13", adjustment: "unadjusted" }` 在 Tushare 映射为 `daily` 的 `ts_code`、`start_date=20261113`、`end_date=20261113`。同一请求要求前复权会拒绝返回未复权行情。LLMQuant 的 HK 路由仍缺少支持证据，选定源接口拒绝该市场。映射以确定性样例和现有客户端为依据，账号权限、历史覆盖和正式收盘时点需要独立证据。

这条入口复用供应商适配，按单次调用截止时间读取，不跨供应商回退，不读写普通缓存或归档。普通研究和浏览继续由 `fetchBars` 执行缓存、回退与固定版本策略。精确要求 TickFlow 未复权日线时，可使用现有交易日 K 线模式。

### 证券、净值和指数资料

选定 Tushare 后，`fetchHistoricalStockUniverse({ market: "A", tradeDate })` 通过 `bak_basic` 查询 2016 年起指定交易日的历史股票列表。每条保留股票代码、名称、上市日和供应商当日行业字段，结果保留端点、取数时间及未知覆盖。达到端点行数上限时报错，空列表保留为空。当日名单用于确定该供应商提供的样本范围，上市交易资格、全市场覆盖和实时成分需要独立证据。 [Tushare 股票历史列表](https://tushare.pro/document/2?doc_id=262)

统一接口的 `reference` 能力逐项声明支持的市场。证券查询、净值和指数有自己的字段和时间语义，共享选定供应商、实际端点、取得时间和未知覆盖状态。

| 操作 | 已接入来源 | 例子 |
| --- | --- | --- |
| `searchInstruments` | Tushare A 股 `stock_basic` | `keyword` 作为名称查询，`ts_code` 的后缀标识沪深京，`list_date` 转为上市日期。 |
| `fetchFundNav` | AKShare `fund_open_fund_info_em` 或内置东财净值路由、Tushare `fund_nav` | `270042.OF` 归一为一只开放式基金，按净值日保留单位净值。累计净值与调整后净值分别保留，缺失值为空。 |
| `fetchIndexMetadata` | AKShare `index_stock_info` | 指数代码、名称、发布日期。 |
| `fetchIndexConstituents` | AKShare 中证、Sina 等现有成分端点 | 保留实际返回的端点、成分代码、纳入日期和权重。空日期不说明成分何时生效。 |
| `fetchIndexQuotes` | AKShare 内置 Sina 指数快照或 `stock_zh_index_spot_em` | 以六位指数代码选择快照，保留端点和已有行情时间。缺失成交量、前收或时间分别为空。 |

Tushare 的开放式基金请求把 `270042.OF` 发给 `fund_nav`，将 `unit_nav` 与 `adj_nav` 放在各自字段中。若要求 Tushare 返回指数快照，则明确拒绝。当前实时性、历史覆盖、存活偏差和真实账号权限仍需要独立证据。既有基金详表与原始 AKShare 探针继续通过兼容入口访问。

### 价格、估值、日历和标的范围

| 操作 | 映射与证据边界 |
| --- | --- |
| `fetchPriceSnapshot` | Financial Datasets US `/prices/snapshot` 返回 `price`、`day_change`、`day_change_percent`、`time_milliseconds`，并核对 `ticker`。TickFlow A 股复用 `/v1/quotes`，在前收可用时计算日变动和百分比。两者都将供应商时间与应用取得时间分开。 |
| `fetchDailyValuation` | Tushare A 股股票 `daily_basic` 按 `ts_code` 和指定 `trade_date` 请求。PE、PE TTM、PB、总市值和流通市值分别保留，市场价值使用万元人民币原单位，空值保留。 |
| `fetchDailyTradingLimits` | Tushare `stk_limit` 按单个 A 股标的及最多 366 个自然日请求，保留按交易日排序的昨收及生效涨跌停价（人民币），返回实际端点、取得时间和未知覆盖。空价格保留为 `null`。信号容差由上层公式应用。 |
| `fetchReportFinancialIndicators` | Tushare `fina_indicator` 按单个 A 股标的和报告期范围取数。保留基本 EPS、BPS、ROE、毛利率、净利率、营业收入与营业总收入同比、归母净利润同比、资产负债率、公告日和更新标记。报告期范围包含首尾，达到 100 行时应缩小范围后重试。 |
| `fetchFinancialDisclosureDates` | Tushare `disclosure_date` 按同一标的和指定报告期取数。保留披露计划公告日、计划披露日、实际披露日和供应商的修正记录。未知日期保留为 `null`。 |
| `fetchTradingCalendar` | AKShare `tool_trade_date_hist_sina` 提供沪深日历日期，再按指定区间过滤。日历行只说明交易日，不证明某条行情已经收盘，也不保证区间完整。 |
| `fetchInstrumentUniverse` | AKShare 上交所 `stock_info_sh_name_code` 与深交所 `stock_info_sz_name_code` 各自返回主板名单的取得时间、端点和行数。这是当前主板名单，覆盖和历史成员状态未知。 |
| `fetchFundProfile`、`fetchFundPurchaseTerms`、`fetchFundPerformance` | AKShare 基金简介、申购状态和业绩分析只投影可核对字段，保留成功端点。申购表的 `手续费=0.13` 或 `0.13%` 均返回百分比数值 `0.13`，实际费率表仍由专用工具核对。 |

`fetchDailyMarketBars({ market: "A", tradeDate })` 和 `fetchDailyMarketBasics({ market: "A", tradeDate })` 在选定 Tushare 后分别查询 `daily` 与 `daily_basic` 的指定日截面。日线保留未复权 OHLC、除权昨收、供应商涨跌幅（百分数）、成交量（手）和成交额（千元）。每日报表保留两类换手率（百分数）、供应商量比、股本（万股）和市值（万元）。两个端点的观察时间和覆盖状态各自独立。达到 6,000 行上限时拒绝返回，以免将截断当作覆盖。停牌、缺行和空值保持上游状态。 [Tushare 日线](https://tushare.pro/document/2?doc_id=27) · [Tushare 每日指标](https://tushare.pro/document/2?doc_id=32)

`fetchDatedSectorCatalog` 用 Tushare `dc_index` 按交易日和行业或概念类型获取东方财富分类。`fetchDatedSectorMembers` 用 `dc_member` 按同一交易日和一个板块代码获取成分，文档起始日期为 2024-12-20。各自保留端点、分类口径、取数时间和未知覆盖。达到 5,000 行上限时返回错误，因为当次结果可能有截断。板块成员是供应商数据，WHYJ 排行由上层按当日市场观测计算。 [板块目录](https://tushare.pro/document/2?doc_id=362) · [板块成分](https://tushare.pro/document/2?doc_id=363)

估值中的 `close` 和实时报价的 `lastPrice` 各有时间含义。例子里请求 Tushare `600000.SH` 的 `2026-11-13` 估值会发出 `trade_date=20261113`，错日、重复或错标响应均失败。相同估值请求不会用报价供应商补数。映射依据见 [Tushare 每日指标](https://tushare.pro/document/2?doc_id=32) 与 [Financial Datasets OpenAPI](https://docs.financialdatasets.ai/api/openapi.json)。

财务取数保留提供商给出的各行及顺序，包括同一报告期的多行。同比增长字段使用文档中的百分比值，其他比率保留供应商原尺度。基本每股收益来自 `eps`，以 `basicEarningsPerShare` 保留报告期原值，负数、零和空值独立保留。基本 EPS 和每股净资产的币种均标为未知。两个响应各自记录端点和采集时间，覆盖仍为未知。实际披露日期描述财报披露，历史回放还需要证明所选财务指标版本当时可用。 [财务指标](https://tushare.pro/document/2?doc_id=79) · [财报披露计划](https://tushare.pro/document/2?doc_id=162)

选定 Tushare 后，`fetchDatedBenchmarkObservations({ market: "A", symbol, start, end })` 通过 `index_daily` 读取 `000001.SH` 或 `399001.SZ` 等沪深指数。单次范围最多包含 366 个自然日。每条按交易日保留收盘点位、昨收点位、点数变化及供应商涨跌幅。涨跌幅的单位为百分点，空值保持为空。响应保留端点、采集时间、请求范围及未知覆盖状态。 [Tushare 指数日线](https://tushare.pro/document/2?doc_id=95)

选定 TickFlow 时，同一接口通过 `/v1/klines` 读取沪深指数及北证 50 `899050.BJ` 的未复权日收盘点位。请求使用上海交易日边界，响应保留供应商原始时间戳。接口返回的昨收、点数变化及涨跌幅均为空，调用方可根据固定的相邻交易日点位计算所需收益。公开日线样本确认了北证 50 的指数身份与日期映射，配置账号的权限与历史覆盖仍需独立验证。 [TickFlow 官方 SDK](https://github.com/tickflow-org/tickflow)

`fetchDatedRiskWarnings({ market: "A", tradeDate })` 通过选定的 Tushare `stock_st` 读取指定交易日的风险警示名单。请求日期从 2000-01-01 起，返回值保留供应商股票名称、类型代码和类型名称，以及实际交易日、端点与采集时刻。达到 1,000 行上限的响应会报错，空列表仍为空，覆盖状态保留为未知。 [Tushare ST 股票列表](https://tushare.pro/document/2?doc_id=397)

`fetchDatedMoneyFlow({ market: "A", tradeDate })`通过选定的 Tushare `moneyflow`读取指定交易日的沪深个股资金流。自 2010 年起，保留小单、中单、大单和特大单的买卖量与金额，原始单位分别为手和万元。净流入量与金额保留供应商报告值，不从四档合计推算。`null`表示缺值，零保留为观测值。响应达到 6,000 行上限时拒绝，空列表保留且覆盖状态未知。账户权限仍取决于 Tushare。 [Tushare 个股资金流向](https://tushare.pro/document/2?doc_id=170)

`fetchDatedPopularityList(calendarDate)` 使用独立配置的扶摇凭据读取北京时间自然日的人气榜，包括周末。每个响应最多 30 条，保留供应商顺序、股票代码、简称和名次。`calendarDateTimestamp` 是该日上海零点，`observedAt` 是实际采集时刻。历史首发时间和覆盖范围保持未知。供应商限定一年内数据，超出范围返回错误，成功的空榜仍返回空列表。 [扶摇历史热股排行](https://fuyao.aicubes.cn/docs/api-reference/hot-list-data/#历史热股排行)

## 研究查询的失败与降级

浏览界面需要尽量给出有用结果；连接诊断需要回答指定源是否可用。这两个目标决定了不同的失败策略：普通研究允许在兼容来源中回退，凭证检查则只能检查所选源。否则，备用源成功会掩盖首选源鉴权失败，保存配置的绿灯就失去意义。

回退只能改变来源，不能改变研究对象。股票不能因代码相似被换成基金，港股不能被送入美股接口。响应声明了标的身份却与请求冲突时，整次响应应被拒绝；兼容旧响应若未声明身份，则保留“无法由响应独立确认”的限制。

结果区分新取数、新鲜缓存、陈旧缓存与不可用。普通缓存既要满足时效，也要覆盖实际请求区间；“今天抓过”不代表拥有去年全部数据。陈旧缓存可以帮助继续查看，但必须带原数据日期，不能伪装成实时成功。显式取消结束整次请求，不应又启动备用源。

同样，超时预算必须覆盖整条取数链。如果每个来源独享完整等待时间，来源越多，用户越难预测何时返回。当前普通取数按整次请求约束等待，Overview 另管一轮多标的刷新；两者的时限不能互相代替。

## 完整性不能靠响应成功推断

分页和截断是比报错更隐蔽的风险。收到第一批有效价格，只能证明这批行存在。Financial Datasets 的分页协议明确要求沿后续链接读取，直到结束；本地适配层还核对后续链接、重复游标与响应身份。明确需要后续页却未能取齐时，不把局部结果当成完整窗口。[1]

但没有分页标记也不证明交易日完整。这里应区分可发现的协议错误与无法由响应证明的事实：适配层能拒绝已声明的截断、矛盾价格或错标数据，不能凭空认证供应商没有遗漏。

缺失成交额也不能补成零。零表示观测到没有成交额，空值表示没有取得证据，二者会让量价指标产生不同解释。接口保留这种差别，比让所有列看起来整齐更重要。

Tushare 股票、指数和场内基金日线的成交量是必需数值：缺失、空字符串或无效值会拒绝整批供应商响应，明确返回的零值仍保留为零。共享取数链可按既有策略回退到其他供应商；基金净值的旧 `Bar` 表示不受此规则影响。模拟验证不代表实际供应商覆盖或权限。

<a id="ohlc-复权口径2026-10-11"></a>

## 固定版本解决复现，不自动解决历史可得性

前复权、未复权、单位净值和指数点位不能只因形状相同就混用。例如 Tushare 普通股票日线明确采用未复权口径；存在额外的调整收盘价字段，也不代表当前计算已经使用了它。[2]

本项目记录实际用于计算的价格口径。前复权历史可能随新事件重算，因此新响应与旧响应不能直接拼接成一条假连续曲线。旧版本继续保存，新的研究使用新的观察版本；未知口径仍保持未知。

这里有两个独立问题：今天能否重算当时保存的结果，以及当时是否真的能够取得这些数据。不可变归档回答前者；它记录应用何时观察到一份响应，却不证明供应商何时首次发布，也不自动修复存活偏差或公司行动。历史观察读取只选择截止前保存的完整响应，不以最新价格补洞。没有对应版本，就应承认无法重现。

<a id="research-data"></a>

## 已收盘研究需要更强的输入契约

快速浏览使用的价格序列，与严格研究使用的数据集承担不同责任。后者还要求有来源的交易日历、成交量和金额单位、复权声明及逐日收盘状态。这些信息应与价格在同一次响应中绑定，不能由下游根据日期或供应商名称猜出来。

当前严格价量研究只支持明确的 A 股上海时区收盘边界。盘中应选择此前已完成的交易日，非交易日依赖日历，而不是把周一至周五当作交易所日历。关键日期或连续样本缺失时，保留排除原因，不能自动退到一段更容易算出结果的历史。

现有内置供应商仍通过保守的兼容路径进入这套契约，不能默认产出具有完整收盘证明的指标。这是刻意保留的能力缺口：宁可让严格研究暂时不可用，也不把普通行情包装成已经核验的数据。更强接口存在，并不意味着所有接入方已经满足它。

## 与上下游交换什么

上游提供带身份、时间和口径的观察；数据层交付标准化数值、实际来源、尝试状态及已有证据；存储层交付可定位的固定版本；研究层决定这些证据能否满足当前问题。来源诊断只报告有限失败类别，避免把包含凭证的上游原始异常传播到模型或报告。

这种分工的代价是状态更多、部分请求会明确失败。收益是每次降级都可解释，每个结论都有适用范围。新增来源的重点也因此不是“又能调用一个 API”，而是能否完整说明身份、覆盖、时间、口径及失败语义。配置入口见[Quant 配置](../agent-runtime/configuration.md)，版本保留见[存储策略](../agent-runtime/storage.md)，消费这些输入的约束见[量化工具](./quant-tools-design.md)。

## 原始公告 PDF 的有界读取

`readDisclosurePdf` 显式读取巨潮、沪深交易所静态公告域名上的 HTTPS PDF 直链；不读取列表页、不发现“最新公告”，不携带认证信息或跟随到其他网站。请求最多 25 秒、3 次重定向、8 MiB；PDF 解析在独立线程中进行，最多 15 秒、400 页、保留 20 万字符，超限或无可读文字会保留不可用、空或截断状态。扫描件不自动 OCR；这些上限不是总内存沙箱。

结果分别记录原文件 SHA-256、提取文本摘要、请求/最终 URL、取得时间及页码。适配器返回文本快照，不保存原始 PDF 文件，也不把取得时间当成披露时间。表格的跨行关系可能丢失；页首带标签的股票代码只提供发行人核对线索，不认证公司身份、财务事实或计算口径。消费者仍须核对具体引用及指标，缺少匹配披露时不能用新闻摘要代替。

PDF 引擎固定为 `unpdf 1.9.1`，符合当前 Node 22 版本范围；通过 Bun 文本加载随构建嵌入，读取时才加载并启动可终止的工作线程，不依赖安装目录中的额外脚本。此处是数据层接口，Host 的不可变取证归档与 Dashboard 选择仍需下游集成；模拟解析不证明真实公告服务或用户 TSP 实例可用。

## References

1. Financial Datasets. [Understanding Pagination](https://docs.financialdatasets.ai/guides/pagination). 官方分页协议；不构成本仓库真实账号可用性的证明。
2. Tushare. [A 股日线行情](https://tushare.pro/document/2?doc_id=27). 接口口径与字段说明。
3. WhyJ-Quant. [Source 模块](../../src/source/README.md). 当前接入与模块职责；真实服务状态仍需当次验证。

运行时可显式调用 `collectObservations`，对当前选中的供应商请求一个标的的一类日线、分钟线或复权因子，并将非空结果写入不可变归档；`replayObservations` 使用返回的精确引用离线读取。空结果不生成归档，错误和取消向调用方报告，不切换其他供应商。该入口当前不由界面或后台调度器自动触发，也不实现 TSP 数据交换。详细提交和重放边界见[存储](../agent-runtime/storage.md#版本化行情观察归档)。
### 交易日观察记录

Source 可将选定供应商的交易日日线转换为版本 2 记录。Tushare 的来源时间戳为空，成交量和成交额分别保留手和千元单位。TickFlow 保留供应商时间戳，单位仍为未知。交易日模式写入独立的 v2 归档，历史覆盖、真实授权和收盘状态需要独立证据。

### TickFlow 指数历史分时

`fetchDatedIndexMinutes` 读取单个交易所限定的 A 股基准指数和已结束的上海日期。它使用历史 `/v1/klines`，请求 `1m`、`adjust=none` 和北京时间 09:25 至 15:05。结果保留指数点位 OHLC、原始毫秒时间戳、成交量、可空成交额与本地观测时间。数据尚无确认的时间标签口径和量额单位时保持 `provider-native`。

`fetchCurrentIndexMinutes` 只读取调用时的上海日期，并将 `requestedWindow` 的上界限制为请求时刻与 15:05 中较早的一个。09:25 前返回空列表且 `requestedWindow` 为 `null`，此时无需请求供应商。窗口内供应商返回空帧时保留已请求的边界。结果的 `finality` 为 `provisional`，保留原始时间标签和量额，不据此判定分钟已完成。

空响应保留准确日期。鉴权、错误标的、重复时间或区间外响应报错。调用成功只表示所返回的样本通过校验，覆盖状态为 `unknown`。实际账户的权限、留存和时间标签需要实盘样本确认。此 Source 计算不产生午休或昨收等派生值。 [TSP 分钟请求](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/services/kline_sync.py#L1366)

### TickFlow 指数历史日线

`fetchDatedIndexDailyBars` 读取一个交易所限定的 A 股基准指数和已结束的上海日期区间，最多 366 个日历日。它复用 `/v1/klines` 日线日期校验，以 `adjust=none` 保留指数点位 OHLC、原始毫秒时间戳、成交量、可空成交额及本地观测时间。量额与时间标签保留 `provider-native`。同一日期的重复 bar、区间外行和身份错配报错，空行保留查询区间。覆盖仍为 `unknown`。日线归档与图表指标消费通过独立接口衔接。 [TSP 指数日线](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/api/indices.py#L41)

`fetchDatedEtfDailyBars` 读取沪深 ETF 交易代码在已结束上海日期内的未复权日线，最多 366 个日历日。Tushare 使用 `fund_daily`，保留元、手、千元及交易日，源时间戳为空。TickFlow 使用 `/v1/klines` 的 `adjust=none`，保留供应商时间戳，价格和量额单位保持未知。两者均将空结果与查询范围一同返回，拒绝重复日期、区间外行及身份不符。代码段校验用于选择接口，标的存续和账户权限需由独立数据确认。 [Tushare ETF 日线](https://tushare.pro/document/2?doc_id=127) · [TickFlow API](https://api.tickflow.org/openapi.json) · [上交所代码段](https://big5.sse.com.cn/site/cht/www.sse.com.cn/lawandrules/guide/stock/jyglywznylc/zn/c/c_20260831_10830435.shtml) · [深交所代码段](https://www.szse.cn/marketServices/technicalservice/notice/t20230825_602945.html)

Storage 将上述 ETF 批次存入 `dated-etf-daily-archives-v1`，使用 `dated-etf-daily` 类型和内容 SHA-256 引用。读取时校验供应商、时间、单位、价格口径、日期顺序及内容摘要。固定归档支持空批次和可空成交额，行情修订生成新引用。普通股票、指数和 ETF 各自使用对应归档类型。

`valuation-quote-poll` 固定一轮 TickFlow 估值快照，可在同一次请求中包含普通 A 股及沪深 ETF。归档保留所请求的标的清单、上海交易日、供应商时间和逐条接收时间，以及原始报价和未知单位。零报价和空结果按原样保存。同一内容生成同一引用，修订生成新引用。普通股票轮询继续使用 `quote-poll`，两种归档引用各自校验。 [TickFlow 快照接口](https://api.tickflow.org/openapi.json)
