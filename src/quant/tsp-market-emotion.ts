export const TSP_MARKET_EMOTION_FORMULA_VERSION = 1;

interface TermConfig {
  weight: number;
  low: number;
  high: number;
}
type Unit = "percentage-point" | "fraction" | "ratio" | "count";
function term<K extends string>(key: K, unit: Unit, weight: number, low: number, high: number) {
  return { key, unit, weight, low, high };
}

const defaults = {
  index: { label: "指数", inverted: false, terms: [term("avg_index_pct", "percentage-point", 1, -2.5, 2.5)] },
  profit: { label: "赚钱", inverted: false, terms: [
    term("up_pct", "percentage-point", 0.45, 20, 80),
    term("avg_pct", "fraction", 0.25, -0.02, 0.02),
    term("median_pct", "fraction", 0.20, -0.02, 0.02),
    term("strong_diff_pct", "percentage-point", 0.10, -8, 8),
  ] },
  money: { label: "量能", inverted: false, terms: [
    term("avg_vol_ratio", "ratio", 0.70, 0.6, 1.8),
    term("high_vol_pct", "percentage-point", 0.30, 2, 12),
  ] },
  speculation: { label: "投机", inverted: false, terms: [
    term("limit_up", "count", 0.25, 5, 90),
    term("seal_rate", "percentage-point", 0.35, 30, 85),
    term("max_boards", "count", 0.25, 1, 8),
    term("tier2_count", "count", 0.15, 0, 30),
  ] },
  resilience: { label: "抗跌", inverted: true, terms: [
    term("down_pct", "percentage-point", 0.55, 20, 80),
    term("strong_down_pct", "percentage-point", 0.45, 1, 12),
  ] },
  mainline: { label: "主线", inverted: false, terms: [
    term("mainline_avg", "fraction", 0.65, -0.005, 0.03),
    term("mainline_cover_pct", "percentage-point", 0.35, 1, 12),
  ] },
};

type Dimension = keyof typeof defaults;
export type TspEmotionMetric = typeof defaults[Dimension]["terms"][number]["key"];
export type TspEmotionMetrics = Partial<Record<TspEmotionMetric, number | null>>;
const dimensions = Object.keys(defaults) as Dimension[];
const thresholdDefaults = { strong: 70, warm: 55, neutral: 45, cold: 30 };
type Threshold = keyof typeof thresholdDefaults;
const labels = { strong: "强势", warm: "偏暖", neutral: "震荡", cold: "偏冷" } as const;
const thresholdOrder = Object.keys(thresholdDefaults) as Threshold[];

export interface TspEmotionOverrides {
  dimensions?: Partial<Record<Dimension, { weight?: number; terms?: Partial<Record<TspEmotionMetric, Partial<TermConfig>>> }>>;
  thresholds?: Partial<typeof thresholdDefaults>;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function clampScore(value: number) {
  return Math.max(0, Math.min(100, value));
}
function roundHalfEven(value: number) {
  const floor = Math.floor(value);
  return value - floor === 0.5 ? floor + (floor % 2) : Math.round(value);
}

/** Score the pinned six dimensions with an explicit availability boundary. */
export function computeTspMarketEmotion(metrics: TspEmotionMetrics, overrides: TspEmotionOverrides = {}) {
  const config = dimensions.map(key => {
    const definition = defaults[key], proposed = overrides.dimensions?.[key];
    const weight = finite(proposed?.weight) && proposed.weight >= 0 ? proposed.weight : 1;
    const terms = definition.terms.map(item => {
      const change = proposed?.terms?.[item.key];
      return { ...item, weight: finite(change?.weight) ? Math.max(0, change.weight) : item.weight,
        low: finite(change?.low) ? change.low : item.low, high: finite(change?.high) ? change.high : item.high };
    });
    return { key, label: definition.label, inverted: definition.inverted, weight, terms };
  });

  const thresholds = thresholdOrder.map(key => {
    const value = overrides.thresholds?.[key];
    return clampScore(finite(value) ? value : thresholdDefaults[key]);
  }).sort((left, right) => right - left);
  const resolvedThresholds = Object.fromEntries(thresholdOrder.map((key, index) => [key, thresholds[index]!])) as typeof thresholdDefaults;

  const radar = config.map(({ key, label, inverted, weight, terms }) => {
    let weighted = 0, termWeight = 0, observedTerms = 0;
    for (const item of terms) {
      if (!Object.hasOwn(metrics, item.key) || item.weight <= 0) continue;
      const input = metrics[item.key], span = item.high - item.low;
      const observed = finite(input) && finite(span) && span > 0;
      const value = observed ? clampScore(roundHalfEven((input - item.low) / span * 100)) : 50;
      weighted += value * item.weight;
      termWeight += item.weight;
      if (observed) observedTerms++;
    }
    if (!Number.isFinite(weighted) || !Number.isFinite(termWeight)) throw new Error("Emotion term weights exceed numeric range");
    const base = termWeight === 0 ? 50 : roundHalfEven(Math.abs(termWeight - 1) < 1e-9 ? weighted : weighted / termWeight);
    return { key, label, value: inverted ? 100 - base : base, weight, inverted, observedTerms };
  });
  const equal = radar.every(dim => Math.abs(dim.weight - radar[0]!.weight) < 1e-12);
  const totalWeight = radar.reduce((total, dim) => total + (equal ? 1 : dim.weight), 0);
  const weightedScore = radar.reduce((total, dim) => total + dim.value * (equal ? 1 : dim.weight), 0);
  if (!Number.isFinite(totalWeight) || !Number.isFinite(weightedScore)) throw new Error("Emotion dimension weights exceed numeric range");
  const observedDimensions = radar.filter(dim => dim.observedTerms > 0 && (equal || dim.weight > 0)).length;
  const score = observedDimensions ? roundHalfEven(weightedScore / totalWeight) : null;
  const label = score === null ? null : labels[thresholdOrder.find(key => score >= resolvedThresholds[key])!] ?? "冰点";
  return { score, label, radar, observedDimensions, config: { dimensions: config, thresholds: resolvedThresholds } };
}
