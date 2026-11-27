import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ObservationListAuctionOverlayPreview } from "../src/client/contract";
import { AuctionOverlayResult, auctionOverlayManifest, ObservationListAuctionOverlay } from "../src/components/ObservationListAuctionOverlay";

const symbol = "600000.SH", date = "2025-06-18";
const input = { version: 1, datasetId: "auction_demo", date, symbols: [symbol],
  fields: { price: "auction_price", matchedQuantity: "matched", unmatchedQuantity: "unmatched" },
  timeBasis: "caller-confirmed-shanghai-wall-clock" } as const;

test("validates the exact CLI auction manifest for the authenticated Host call", () => {
  const { version: _, ...request } = input;
  expect(auctionOverlayManifest(input)).toEqual(request);
  for (const bad of [{ ...input, date: "2025-02-30" }, { ...input, timeBasis: null }, { ...input, version: 2 },
    { ...input, symbols: [symbol, symbol] }, { ...input, fields: { price: "bad,name" } },
    { ...input, fields: { ...input.fields, unmatchedQuantity: "matched" } }, { ...input, baseUrl: "http://ignored.invalid/" },
  ]) expect(() => auctionOverlayManifest(bad)).toThrow("清单需要");
});

test("projects observed auction prices, exact quantities and independent field receipts", () => {
  const receipt: ObservationListAuctionOverlayPreview["input"]["price"] = {
    source: "tsp", originalPublisher: "unknown", field: "auction_price", revision: "a".repeat(64), valueUnit: "unknown",
    observedAt: "2025-06-18T02:00:00Z", series: [{ symbol, status: "observed", pointCount: 1 }],
  };
  const preview: ObservationListAuctionOverlayPreview = {
    input: { datasetId: input.datasetId, timeBasis: input.timeBasis, price: receipt,
      matchedQuantity: { ...receipt, field: "matched", revision: "b".repeat(64) },
      unmatchedQuantity: { ...receipt, field: "unmatched", revision: "c".repeat(64) } },
    overlay: { producer: "whyj", version: 1, tradeDate: date, rows: [{ symbol, status: "observed", ambiguous: [],
      points: [{ time: "09:25:00", price: 10.1234, matchedQuantity: 0, unmatchedQuantity: -5, unmatchedSide: "sell" }] }] },
  };
  const html = renderToStaticMarkup(<AuctionOverlayResult result={preview} />);
  for (const text of ["集合竞价价格曲线", "09:25:00", "价格 10.1234", "匹配量 0", "未匹配量 -5", "卖方剩余",
    "TSP 字段来源", "单位未知", receipt.revision]) expect(html).toContain(text);

  const missing: ObservationListAuctionOverlayPreview = { ...preview, overlay: { ...preview.overlay, rows: [
    { symbol, status: "unavailable-price", ambiguous: [{ role: "matchedQuantity", time: "09:25:00" }], points: [
      { time: "09:25:00", price: null, matchedQuantity: null, unmatchedQuantity: 0, unmatchedSide: "balanced" },
    ] },
  ] } };
  const unavailable = renderToStaticMarkup(<AuctionOverlayResult result={missing} />);
  expect(unavailable).toContain("该标的暂无可用竞价价格");
  expect(unavailable).toContain("匹配量 重复时刻");
  expect(unavailable).toContain("未匹配量 0");
  expect(unavailable).toContain("平衡");
  expect(unavailable).not.toContain("集合竞价价格曲线");
  expect(renderToStaticMarkup(<ObservationListAuctionOverlay read={undefined} />)).toContain("当前服务不支持集合竞价读取");
});
