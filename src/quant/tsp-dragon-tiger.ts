import { isDailyDate } from "../market/bars.ts";
import { TSP_INDICATOR_REVISION } from "./tsp-indicators.ts";

export const TSP_DRAGON_TIGER_FORMULA_VERSION = 1;
const LEADER_COUNT = 5;

interface StockIdentity {
  symbol: string | null;
  ticker: string | null;
  name: string | null;
  rangeDays: 1 | 3 | null;
}

export interface TspDragonTigerInput {
  tradeDate: string;
  all: readonly (StockIdentity & { netValueCny: number | null; changeFraction: number | null })[] | null;
  institutions: readonly (StockIdentity & { institutionalNetValueCny: number | null })[] | null;
  hotMoney: readonly { name: string | null; netValueCny: number | null }[] | null;
}

function comparableRows<Row, Identity>(
  rows: readonly Row[],
  readAmount: (row: Row) => number | null,
  readIdentity: (row: Row) => Identity,
) {
  return rows.flatMap((row, sourceRow) => {
    const netValueCny = readAmount(row);
    if (netValueCny === null) return [];
    if (!Number.isFinite(netValueCny)) throw new Error("Invalid dragon-tiger net amount");
    return [{ ...readIdentity(row), netValueCny, sourceRow }];
  });
}

const descending = (left: { netValueCny: number }, right: { netValueCny: number }) => right.netValueCny - left.netValueCny;
const stockIdentity = ({ symbol, ticker, name, rangeDays }: StockIdentity) => ({ symbol, ticker, name, rangeDays });

/** Rank provider board records without adding or merging disclosures across windows. */
export function computeTspDragonTiger(input: TspDragonTigerInput) {
  if (!isDailyDate(input.tradeDate)) throw new Error("Invalid dragon-tiger trade date");
  const all = input.all && comparableRows(input.all, row => row.netValueCny, row => ({
    ...stockIdentity(row), changeFraction: row.changeFraction,
  }));
  const institutions = input.institutions && comparableRows(input.institutions, row => row.institutionalNetValueCny, stockIdentity);
  const hotMoney = input.hotMoney && comparableRows(input.hotMoney, row => row.netValueCny, ({ name }) => ({ name }));

  return {
    producer: "whyj" as const,
    formula: { id: "tsp_dragon_tiger" as const, version: TSP_DRAGON_TIGER_FORMULA_VERSION, revision: TSP_INDICATOR_REVISION },
    tradeDate: input.tradeDate,
    amountUnit: "CNY" as const,
    all: all === null ? null : {
      comparableCount: all.length,
      leadingNetBuys: all.filter(row => row.netValueCny > 0).sort(descending).slice(0, LEADER_COUNT),
      leadingNetSells: all.filter(row => row.netValueCny < 0).sort((a, b) => descending(b, a)).slice(0, LEADER_COUNT),
    },
    institutions: institutions === null ? null : {
      comparableCount: institutions.length,
      leaders: institutions.sort(descending).slice(0, LEADER_COUNT),
    },
    hotMoney: hotMoney === null ? null : {
      comparableCount: hotMoney.length,
      leaders: hotMoney.sort(descending).slice(0, LEADER_COUNT),
    },
  };
}
