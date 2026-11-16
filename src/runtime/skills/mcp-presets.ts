import type { McpServerConfig } from "../../agent/src/pi-mcp.ts";

/** Templates only. Installing a preset never connects; an explicit TSP read may use Pi's transport. */
export const MCP_PRESETS: ReadonlyArray<{ name: string; description: string; docs: string; setup: string; config: McpServerConfig }> = [
  { name: "tsp", description: "Optional A-share alerts and forward-adjusted daily observations",
    docs: "https://github.com/shy3130/tick-stock-panel/tree/ea4d38e0dc9259ad3500f3c248ab991cd12d3ea1/mcp-server",
    setup: "Install the TSP stdio bridge in a Python environment, set TSP_BASE and TSP_TOKEN, and replace python with that environment's executable if needed. Grant only read:market and read:analysis at the panel gateway, then explicitly enable this global Pi entry. Installing this disabled template does not start or download a server.",
    config: { command: "python", args: ["-m", "tsp_mcp_server.server"], enabled: false, exposure: "hidden",
      toolExposure: { get_recent_alerts: "deferred", get_kline: "deferred" },
      env: { TSP_BASE: "${TSP_BASE}", TSP_TOKEN: "${TSP_TOKEN}", TSP_SCOPES: "read:market,read:analysis" } } },
  { name: "financial-datasets", description: "US fundamentals, filings, prices and news",
    docs: "https://docs.financialdatasets.ai/mcp-server", setup: "Set FINANCIAL_DATASETS_API_KEY in the Pi process environment.",
    config: { url: "https://mcp.financialdatasets.ai/api", headers: { "X-API-KEY": "${FINANCIAL_DATASETS_API_KEY}" } } },
  { name: "tushare", description: "Chinese financial data",
    docs: "https://tushare.pro/document/1?doc_id=463", setup: "Replace YOUR_TUSHARE_TOKEN with the URL from your Tushare account, then enable this entry in Pi. Pi does not interpolate URL variables.",
    config: { url: "https://api.tushare.pro/mcp/token=YOUR_TUSHARE_TOKEN", enabled: false } },
  { name: "llmquant-data", description: "Financial knowledge, papers, filings, macro and market data",
    docs: "https://github.com/LLMQuant/data-mcp", setup: "Set LLMQUANT_API_KEY; install Node.js/npx. Pi downloads the stdio package through npx when it starts the server.",
    config: { command: "npx", args: ["-y", "@llmquant/data-mcp"], env: { LLMQUANT_API_KEY: "${LLMQUANT_API_KEY}" } } },
  { name: "web-search-prime", description: "Search news and public web sources",
    docs: "https://docs.bigmodel.cn/cn/coding-plan/mcp/search-mcp-server", setup: "Set ZHIPU_API_KEY in the Pi process environment; the account needs Web Search Prime access.",
    config: { url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp", headers: { Authorization: "Bearer ${ZHIPU_API_KEY}" } } },
  { name: "web-reader", description: "Read page content and metadata",
    docs: "https://docs.bigmodel.cn/cn/coding-plan/mcp/reader-mcp-server", setup: "Set ZHIPU_API_KEY in the Pi process environment; the account needs Web Reader access.",
    config: { url: "https://open.bigmodel.cn/api/mcp/web_reader/mcp", headers: { Authorization: "Bearer ${ZHIPU_API_KEY}" } } },
];
