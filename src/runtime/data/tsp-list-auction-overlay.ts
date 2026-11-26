import { fetchTspExtensionIntradaySeries, type SourceRequestOptions, type TspExtensionIntradaySeries } from "../../source/index.ts";

export interface TspListAuctionOverlayRequest {
  datasetId: string;
  date: string;
  symbols: readonly string[];
  fields: { price: string; matchedQuantity?: string; unmatchedQuantity?: string };
  timeBasis: "caller-confirmed-shanghai-wall-clock";
}

type AuctionRole = keyof TspListAuctionOverlayRequest["fields"];
type SeriesPoints = TspExtensionIntradaySeries["series"][number]["points"];

function auctionPoints(points: SeriesPoints, role: AuctionRole, ambiguous: { role: AuctionRole; time: string }[]) {
  const values = new Map<string, number | null>();
  for (const { time, value } of points ?? []) {
    const [hour, minute, second = "00"] = time.split(":");
    const aligned = hour!.padStart(2, "0") + ":" + minute + ":" + second;
    if (aligned < "09:15:00" || aligned > "09:25:00") continue;
    if (values.has(aligned)) {
      if (values.get(aligned) !== null) ambiguous.push({ role, time: aligned });
      values.set(aligned, null);
    } else {
      values.set(aligned, value);
    }
  }
  return values;
}

export async function readTspListAuctionOverlay(request: TspListAuctionOverlayRequest, options: SourceRequestOptions = {}) {
  const control = { ...options };
  control.signal?.throwIfAborted();
  const { datasetId, date, symbols, fields, timeBasis } = structuredClone(request);
  if (timeBasis !== "caller-confirmed-shanghai-wall-clock" || !fields || typeof fields !== "object" || Array.isArray(fields) ||
    Object.keys(fields).some(role => !["price", "matchedQuantity", "unmatchedQuantity"].includes(role))) {
    throw new Error("An explicit Shanghai auction field mapping is required");
  }
  const { price, matchedQuantity, unmatchedQuantity } = fields;
  const selected = [price, matchedQuantity, unmatchedQuantity].filter(field => field !== undefined);
  if (typeof price !== "string" || new Set(selected).size !== selected.length ||
    selected.some(field => typeof field !== "string" || !field.length || field.length > 256 ||
      field.trim() !== field || /[,\u0000-\u001f]/.test(field))) throw new Error("Invalid auction field mapping");

  const scope = { datasetId, date, symbols };
  const [priceSource, matchedSource, unmatchedSource] = await Promise.all([
    fetchTspExtensionIntradaySeries({ ...scope, field: price }, {}, control),
    matchedQuantity === undefined ? null : fetchTspExtensionIntradaySeries({ ...scope, field: matchedQuantity }, {}, control),
    unmatchedQuantity === undefined ? null : fetchTspExtensionIntradaySeries({ ...scope, field: unmatchedQuantity }, {}, control),
  ]);
  control.signal?.throwIfAborted();
  const rows = priceSource.series.map(({ symbol, points }, index) => {
    const ambiguous: { role: AuctionRole; time: string }[] = [];
    const price = auctionPoints(points, "price", ambiguous);
    const matched = auctionPoints(matchedSource?.series[index]?.points ?? null, "matchedQuantity", ambiguous);
    const unmatched = auctionPoints(unmatchedSource?.series[index]?.points ?? null, "unmatchedQuantity", ambiguous);
    const times = [...new Set([...price.keys(), ...matched.keys(), ...unmatched.keys()])].sort();
    return {
      symbol,
      status: [...price.values()].some(value => value !== null) ? "observed" as const : "unavailable-price" as const,
      ambiguous,
      points: times.map(time => {
        const quantity = unmatched.get(time) ?? null;
        return {
          time,
          price: price.get(time) ?? null,
          matchedQuantity: matched.get(time) ?? null,
          unmatchedQuantity: quantity,
          unmatchedSide: quantity === null ? null : quantity > 0 ? "buy" as const : quantity < 0 ? "sell" as const : "balanced" as const,
        };
      }),
    };
  });
  return {
    input: { price: priceSource, matchedQuantity: matchedSource, unmatchedQuantity: unmatchedSource, timeBasis },
    overlay: { producer: "whyj" as const, version: 1 as const, tradeDate: date, rows },
  };
}
