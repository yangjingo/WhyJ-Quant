import { isDailyDate } from "../../../src/market/bars.ts";
import { collectTradingDateObservations, deriveTspArchiveIndicators } from "../../../src/runtime/data/observation-collection.ts";

const dayMs = 86_400_000;
const usage = 'Use "whyj --json observation collect-daily --symbol CODE --start YYYY-MM-DD --end YYYY-MM-DD [--adjustment none|forward]" '
  + 'or "whyj --json observation replay-daily --revision SHA256".';

function invalid() {
  return Object.assign(new Error(usage), { code: "invalid_arguments" });
}

function parseOptions(args: readonly string[], allowed: readonly string[]) {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (!allowed.includes(flag) || !value || value.startsWith("-") || options.has(flag)) throw invalid();
    options.set(flag, value);
  }
  return options;
}

export async function runObservationCommand(args: readonly string[], signal?: AbortSignal) {
  const [action, ...options] = args;
  if (action === "collect-daily") {
    const fields = parseOptions(options, ["--symbol", "--start", "--end", "--adjustment"]);
    const symbol = fields.get("--symbol"), startDate = fields.get("--start"), endDate = fields.get("--end");
    const adjustment = fields.get("--adjustment") ?? "none";
    if (!symbol || !/^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/.test(symbol) ||
      !startDate || !endDate || !isDailyDate(startDate) || !isDailyDate(endDate) ||
      startDate < "0001-01-01" || endDate > "9998-12-31" || startDate > endDate ||
      Date.parse(endDate) - Date.parse(startDate) > 365 * dayMs || (adjustment !== "none" && adjustment !== "forward")) {
      throw invalid();
    }
    try {
      return await collectTradingDateObservations({ timeMode: "trading-date", symbol, assetType: "stock",
        interval: "1d", adjustment, startDate, endDate }, { signal });
    } catch {
      throw Object.assign(new Error("Could not collect daily observations. Check the configured source and use whyj --json doctor --phase data."),
        { code: "observation_collection_failed" });
    }
  }
  if (action === "replay-daily") {
    const revision = parseOptions(options, ["--revision"]).get("--revision");
    if (!revision || !/^[a-f0-9]{64}$/.test(revision)) throw invalid();
    try {
      return await deriveTspArchiveIndicators({ version: 2, revision }, signal);
    } catch {
      throw Object.assign(new Error("Could not read the requested daily archive revision."), { code: "observation_archive_unavailable" });
    }
  }
  throw invalid();
}
