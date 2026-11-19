import { isDailyDate } from "../market/bars.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";
import type { TspBreadthUniverse } from "./tsp-market-breadth.ts";

export const TSP_MARKET_LADDER_FORMULA_VERSION = 1;

export interface TspLimitLadderObservation {
  tradingDate: string;
  symbol: string;
  name: string | null;
  amountCny: number | null;
  upStreak: number | null;
  priorUpStreak: number | null;
  limitUp: boolean | null;
  brokenLimitUp: boolean | null;
}

const stockSymbol = /^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:4\d{5}|8(?!99)\d{5}|92\d{4})\.BJ)$/;
const countOrNull = (value: number | null) => value === null || (Number.isSafeInteger(value) && value >= 0);
const flagOrNull = (value: boolean | null) => value === null || typeof value === "boolean";

function roundRatio(value: number) {
  // An exact binary64 tie at four decimal places is an odd multiple of 1/32.
  if ((value * 32) % 2 === 1) {
    const lower = Math.floor(value * 10_000);
    return (lower + lower % 2) / 10_000;
  }
  return Number(value.toFixed(4));
}

/** Aggregate the fixed roster and its explicitly bound current and adjacent prior evidence. */
export function computeTspMarketLadder(universe: TspBreadthUniverse, previousTradingDate: string | null,
  observations: readonly TspLimitLadderObservation[]) {
  const { tradingDate, symbols } = universe;
  const roster = new Set(symbols);
  if (typeof tradingDate !== "string" || !isDailyDate(tradingDate) || !universe.id.trim() || !universe.revision.trim() ||
    (previousTradingDate !== null && (typeof previousTradingDate !== "string" || !isDailyDate(previousTradingDate) || previousTradingDate >= tradingDate)) ||
    roster.size !== symbols.length || symbols.some(symbol => !stockSymbol.test(symbol))) throw new Error("Invalid market ladder scope");

  const seen = new Set<string>();
  const tiers = new Map<number, TspLimitLadderObservation[]>();
  let streaksKnown = 0, priorStreaksKnown = 0, limitUpsKnown = 0, brokenLimitsKnown = 0;
  let observedLimitUps = 0, observedBrokenLimits = 0;
  let observedCandidates = 0, evaluatedCandidates = 0, observedPromotions = 0;
  for (const member of observations) {
    const { symbol, upStreak, priorUpStreak, limitUp, brokenLimitUp, amountCny, name } = member;
    if (member.tradingDate !== tradingDate || !roster.has(symbol) || seen.has(symbol) || !countOrNull(upStreak) || !countOrNull(priorUpStreak) ||
      !flagOrNull(limitUp) || !flagOrNull(brokenLimitUp) || (name !== null && typeof name !== "string") ||
      (amountCny !== null && (!Number.isFinite(amountCny) || amountCny < 0)) || (previousTradingDate === null && priorUpStreak !== null)) {
      throw new Error("Invalid or duplicate market ladder observation");
    }
    seen.add(symbol);
    const up = limitUp ?? (upStreak === null ? null : upStreak > 0);
    if ((upStreak !== null && up !== (upStreak > 0)) || (up === true && brokenLimitUp === true) ||
      (upStreak !== null && upStreak > 0 && priorUpStreak !== null && upStreak !== priorUpStreak + 1)) {
      throw new Error("Incompatible market ladder streak or limit flags");
    }

    if (upStreak !== null) {
      streaksKnown++;
      if (upStreak > 0) {
        const group = tiers.get(upStreak);
        if (group) group.push(member);
        else tiers.set(upStreak, [member]);
      }
    }
    if (priorUpStreak !== null) {
      priorStreaksKnown++;
      if (priorUpStreak > 0) {
        observedCandidates++;
        if (upStreak !== null || up === false) evaluatedCandidates++;
        if (upStreak === priorUpStreak + 1) observedPromotions++;
      }
    }
    if (up !== null) limitUpsKnown++;
    if (up === true) observedLimitUps++;
    if (brokenLimitUp !== null) brokenLimitsKnown++;
    if (brokenLimitUp === true) observedBrokenLimits++;
  }

  const ranked = [...tiers].sort(([left], [right]) => right - left).map(([boards, group]) => {
    const byAmount = group.filter((row): row is TspLimitLadderObservation & { amountCny: number } => row.amountCny !== null)
      .sort((left, right) => right.amountCny - left.amountCny || left.symbol.localeCompare(right.symbol));
    return { boards, count: group.length, amountObservations: byAmount.length,
      stocks: byAmount.slice(0, 5).map(({ symbol, name, amountCny }) => ({ symbol, name, amountCny })) };
  });
  const height = streaksKnown ? ranked[0]?.boards ?? 0 : null;
  const width = (minimum: number) => ranked.reduce((total, tier) => total + (tier.boards >= minimum ? tier.count : 0), 0);
  const observedLadder = { height, firstBoardCount: tiers.get(1)?.length ?? 0, twoOrMoreCount: width(2), threeOrMoreCount: width(3),
    fiveOrMoreCount: width(5), occupiedRungs: ranked.filter(tier => tier.boards >= 2).length };
  const complete = (known: number) => symbols.length > 0 && known === symbols.length;
  const ladder = complete(streaksKnown) ? { ...observedLadder, height: height!,
    completeness: height! >= 3 ? roundRatio(observedLadder.occupiedRungs / (height! - 1)) : 0 } : null;

  const promotionBasis = previousTradingDate === null ? "no-prior-session" : !complete(priorStreaksKnown) ? "partial-pool"
    : observedCandidates < 10 ? "small-pool" : evaluatedCandidates !== observedCandidates ? "partial-outcomes" : "measured";
  const sealComplete = complete(limitUpsKnown) && complete(brokenLimitsKnown);
  const sealPool = sealComplete ? observedLimitUps + observedBrokenLimits : null;
  const seal = sealPool ? observedLimitUps / sealPool : null;

  return {
    producer: "whyj" as const,
    formula: { id: "tsp_market_ladder" as const, version: TSP_MARKET_LADDER_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    tradingDate, previousTradingDate, universe: { id: universe.id, revision: universe.revision },
    coverage: { roster: symbols.length, observed: seen.size, streaksKnown, priorStreaksKnown, limitUpsKnown, brokenLimitsKnown },
    ladder, observedLadder, tiers: ranked,
    promotion: { fraction: promotionBasis === "measured" ? roundRatio(observedPromotions / observedCandidates) : null,
      basis: promotionBasis, observedCandidates, evaluatedCandidates, observedPromotions },
    seal: { fraction: seal === null ? null : roundRatio(seal), regimeFraction: sealPool === 0 ? 0.5 : seal,
      basis: sealPool === null ? "partial-events" as const : sealPool === 0 ? "regime-zero-events-default" as const : "measured" as const,
      denominator: sealPool, observedLimitUps, observedBrokenLimits },
  };
}
