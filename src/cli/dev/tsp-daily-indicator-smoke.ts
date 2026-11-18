import { computeTspDailyIndicators, TSP_DAILY_INDICATOR_FORMULA_VERSION, TSP_INDICATOR_REVISION } from "../../quant/index.ts";
import { replayTradingDateObservations } from "../../runtime/data/observation-collection.ts";
import { createMarketDataSource, toTradingDateBarObservations, TSP_DAILY_INDICATOR_FIELDS, TSP_LIST_COLUMNS } from "../../source/index.ts";
import { archiveTradingDateObservations } from "../../storage/index.ts";

async function main() {
  const [symbol, startDate, endDate, ...extra] = process.argv.slice(2);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", dateStyle: "short" }).format(new Date());
  if (!symbol || !startDate || !endDate || extra.length || endDate >= today || !process.env.WHYJ_QUANT_TICKFLOW_API_KEY?.trim()) {
    throw new Error("Use a TickFlow environment credential and explicit symbol, start date and end date before today (Shanghai).");
  }

  const provider = createMarketDataSource({
    source: "tickflow", apiKey: process.env.WHYJ_QUANT_TICKFLOW_API_KEY, baseUrl: "https://api.tickflow.org", env: {},
  });
  const result = await provider.fetchKlines({ timeMode: "trading-date", symbol, startDate, endDate,
    interval: "1d", assetType: "stock", adjustment: "forward" }, { timeoutMs: 15_000 });
  if (result.data.length < 61) throw new Error(`Insufficient data: ${result.data.length} bars; longest warm-up needs 61 bars.`);
  const ref = await archiveTradingDateObservations(toTradingDateBarObservations(result));
  const observations = await replayTradingDateObservations(ref);
  observations.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const rows = computeTspDailyIndicators(observations.map(({ tradeDate, values }) => ({ date: tradeDate, ...values })));
  const latest = rows.at(-1)!;
  const keys = new Set<string>(TSP_DAILY_INDICATOR_FIELDS);
  if (keys.size !== TSP_DAILY_INDICATOR_FIELDS.length || Object.keys(latest).filter(key => key !== "date").length !== keys.size ||
      TSP_DAILY_INDICATOR_FIELDS.some(key => !Object.hasOwn(latest, key))) {
    throw new Error("Source daily catalog differs from computed fields.");
  }
  const fields = TSP_DAILY_INDICATOR_FIELDS.map(key => ({ key,
    finiteRows: rows.filter(row => row[key] !== null).length, latest: latest[key],
  }));
  const covered = new Set(TSP_LIST_COLUMNS.filter(column => column.rendererFields.length > 0 &&
    column.rendererFields.every(field => keys.has(field))).map(column => column.key));
  const allPanelKeys = [...new Set(TSP_LIST_COLUMNS.map(column => column.key))];
  const allFieldsAvailable = fields.every(field => field.latest !== null);
  console.log(JSON.stringify({
    status: allFieldsAvailable ? "passed" : "partial",
    source: result.source, endpoint: result.endpoint, observedAt: result.observedAt, symbol, adjustment: result.adjustment,
    requested: result.requested, rowCount: rows.length, firstTradeDate: rows[0]!.date, lastTradeDate: latest.date,
    archive: ref, coverage: result.coverage, finality: "unknown",
    formula: { version: TSP_DAILY_INDICATOR_FORMULA_VERSION, tspRevision: TSP_INDICATOR_REVISION },
    fields, panelFormulaKeys: [...covered], otherPanelKeys: allPanelKeys.filter(key => !covered.has(key)),
  }, null, 2));
  if (!allFieldsAvailable) process.exitCode = 1;
}

main().catch(error => {
  const message = error instanceof Error ? error.message : "Indicator probe failed";
  const key = process.env.WHYJ_QUANT_TICKFLOW_API_KEY;
  console.error(JSON.stringify({ status: "failed", error: key ? message.replaceAll(key, "[redacted]") : message }));
  process.exitCode = 1;
});
