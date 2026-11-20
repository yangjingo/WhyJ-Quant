import { fetchDatedPopularityList, type SourceRequestOptions } from "../../source/index.ts";
import { archivePopularityList, loadPopularityArchive, type PopularityArchiveRef } from "../../storage/index.ts";

export async function collectDatedPopularityList(calendarDate: string, options: SourceRequestOptions = {}) {
  const control = { ...options };
  const { rows, ...capture } = await fetchDatedPopularityList(calendarDate, {}, control);
  const ref = await archivePopularityList({ ...capture, rows }, control.signal);
  return { ...capture, ref, status: rows.length ? "archived" as const : "empty" as const, rowCount: rows.length };
}

export async function replayDatedPopularityList(ref: PopularityArchiveRef, signal?: AbortSignal) {
  const reference = { ...ref };
  return { ref: reference, observation: await loadPopularityArchive(reference, signal) };
}
