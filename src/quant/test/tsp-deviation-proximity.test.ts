import { expect, test } from "bun:test";
import { computeTspDeviationProximity, type TspDeviationBoard } from "../index.ts";

test("uses every pinned board threshold and asymmetric long-window limits", () => {
  const table: [TspDeviationBoard, number][] = [
    ["SH", 0.20], ["SZ", 0.20], ["GEM", 0.30], ["STAR", 0.30], ["BJ", 0.40],
  ];
  for (const [board, short] of table) {
    const up = computeTspDeviationProximity(board, { deviate_3d: short, deviate_10d: 1, deviate_30d: 2 });
    const down = computeTspDeviationProximity(board, { deviate_3d: -short, deviate_10d: -0.5, deviate_30d: -0.7 });
    expect(up.windows.map(row => [row.direction, row.threshold, row.closeness]))
      .toEqual([["up", short, 1], ["up", 1, 1], ["up", 2, 1]]);
    expect(down.windows.map(row => [row.direction, row.threshold, row.closeness]))
      .toEqual([["down", short, 1], ["down", 0.5, 1], ["down", 0.7, 1]]);
    expect(down).toMatchObject({ tier: "triggered", dominantWindow: 3, maxCloseness: 1 });
  }
});

test("classifies the dominant unrounded ratio and keeps zero separate from missing", () => {
  const forTen = (value: number | null) =>
    computeTspDeviationProximity("SH", { deviate_3d: null, deviate_10d: value, deviate_30d: null });
  expect(forTen(null)).toMatchObject({ tier: "unavailable", dominantWindow: null, maxCloseness: null });
  expect(forTen(0)).toMatchObject({ tier: "below-watch", dominantWindow: 10, maxCloseness: 0 });
  expect(forTen(-0.25).tier).toBe("watch");
  expect(forTen(0.699_999_999).tier).toBe("watch");
  expect(forTen(0.70).tier).toBe("edge");
  expect(forTen(-0.50).tier).toBe("triggered");
  const mixed = computeTspDeviationProximity("BJ", { deviate_3d: 0.15, deviate_10d: null, deviate_30d: -0.6 });
  expect(mixed).toMatchObject({ tier: "edge", dominantWindow: 30 });
  expect(mixed.windows[1]).toEqual({ window: 10, deviation: null, direction: null, threshold: null, closeness: null });
  expect(() => forTen(Infinity)).toThrow("Invalid");
  expect(() => computeTspDeviationProximity("OTHER" as TspDeviationBoard,
    { deviate_3d: null, deviate_10d: null, deviate_30d: null })).toThrow("board");
});
