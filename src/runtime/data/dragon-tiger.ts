import { isDailyDate } from "../../market/bars.ts";
import { computeTspDragonTiger } from "../../quant/index.ts";
import { fetchDatedDragonTigerBoard, type DatedDragonTigerBoard, type DragonTigerBoardKind, type SourceRequestOptions } from "../../source/index.ts";
import { archiveDragonTigerBoard, loadDragonTigerArchive, type DragonTigerArchiveRef } from "../../storage/index.ts";

export async function collectDragonTigerBoard(
  tradeDate: string,
  boardKind: DragonTigerBoardKind,
  options: SourceRequestOptions = {},
) {
  const board = await fetchDatedDragonTigerBoard(tradeDate, boardKind, {}, options);
  const ref = await archiveDragonTigerBoard(board, options.signal);
  const { stocks, seats, ...provider } = board;
  return {
    ...provider, ref, status: stocks.length || seats.length ? "archived" as const : "empty" as const,
    stockRows: stocks.length, seatRows: seats.length,
  };
}

export interface DragonTigerReplayRequest {
  tradeDate: string;
  refs: readonly DragonTigerArchiveRef[];
}

/** Replay each board from its own capture and rank only the supplied disclosures. */
export async function replayTspDragonTiger(request: DragonTigerReplayRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { tradeDate, refs } = request;
  if (typeof tradeDate !== "string" || !isDailyDate(tradeDate) || !Array.isArray(refs) || refs.length < 1 || refs.length > 3) {
    throw new Error("Invalid dragon-tiger replay request");
  }
  const archiveRefs = refs.map(ref => ({ ...ref }));
  const input: Record<DragonTigerBoardKind, (DatedDragonTigerBoard & { ref: DragonTigerArchiveRef }) | null> =
    { all: null, org: null, hot_money: null };
  for (const ref of archiveRefs) {
    const board = await loadDragonTigerArchive(ref, signal);
    if (board.tradeDate !== tradeDate || input[board.boardKind]) throw new Error("Unexpected or duplicate dragon-tiger board");
    input[board.boardKind] = { ...board, ref };
  }
  signal?.throwIfAborted();
  const metrics = computeTspDragonTiger({
    tradeDate, all: input.all?.stocks ?? null, institutions: input.org?.stocks ?? null, hotMoney: input.hot_money?.seats ?? null,
  });
  return { input, metrics };
}
