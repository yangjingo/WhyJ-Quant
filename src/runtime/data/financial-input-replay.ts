import { isDailyDate } from "../../market/bars.ts";
import { isAIndexSymbol, normalizeSymbol } from "../../market/symbols.ts";
import { loadFinancialObservationArchive, type FinancialObservationArchiveRef, type StoredFinancialDisclosureDate,
  type StoredReportFinancialIndicator } from "../../storage/index.ts";

export interface FinancialInputReplayRequest {
  symbol: string;
  tradingDates: readonly string[];
  references: readonly FinancialObservationArchiveRef[];
}

type CaptureEvidence = { ref: FinancialObservationArchiveRef; observedAt: string };
type Capture<Row> = CaptureEvidence & { instant: number; observedDate: string; rows: Row[] };
type UnavailableReason = "missing-report" | "missing-disclosure" | "ambiguous-report" | "ambiguous-disclosure" | "inconsistent-timing";

export type FinancialInputReplayRow = { tradingDate: string } & (
  | { status: "unavailable"; reason: UnavailableReason }
  | {
    status: "available";
    periodEnd: string;
    actualDisclosureDate: string;
    report: StoredReportFinancialIndicator;
    reportEvidence: CaptureEvidence[];
    disclosureEvidence: CaptureEvidence[];
  }
);

const shanghaiDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });

function latestPeriod<Row extends { periodEnd: string }>(captures: readonly Capture<Row>[], periodEnd: string, cutoff: string) {
  const rows: Row[] = [];
  const evidence: CaptureEvidence[] = [];
  let observedDate = "";
  let instant: number | undefined;
  for (const capture of captures) {
    if (instant !== undefined && capture.instant < instant) break;
    if (capture.observedDate >= cutoff) continue;
    const matching = capture.rows.filter(row => row.periodEnd === periodEnd);
    if (!matching.length) continue;
    rows.push(...matching);
    evidence.push({ ref: { ...capture.ref }, observedAt: capture.observedAt });
    observedDate = capture.observedDate;
    instant = capture.instant;
  }
  return { rows, evidence, observedDate };
}

/** Resolve the latest report eligible before each Shanghai trading date from exact, independently captured evidence. */
export async function replayFinancialResearchInputs(request: FinancialInputReplayRequest, signal?: AbortSignal): Promise<FinancialInputReplayRow[]> {
  const symbol = normalizeSymbol(request.symbol, "A");
  if (!/^(?:6\d{5}\.SH|[03]\d{5}\.SZ|(?:[48]\d{5}|92\d{4})\.BJ)$/.test(symbol) || isAIndexSymbol(symbol)) {
    throw new Error("Financial replay requires an A-share stock symbol");
  }
  const tradingDates = [...request.tradingDates];
  if (tradingDates.some((date, i) => typeof date !== "string" || !isDailyDate(date) || (i > 0 && date <= tradingDates[i - 1]!))) {
    throw new Error("Financial replay requires ordered unique trading dates");
  }
  const references = request.references.map(ref => ({ ...ref }));
  const revisions = new Set<string>();
  const reports: Capture<StoredReportFinancialIndicator>[] = [];
  const disclosures: Capture<StoredFinancialDisclosureDate>[] = [];
  const periods = new Set<string>();
  signal?.throwIfAborted();
  for (const ref of references) {
    if (revisions.has(ref.revision)) throw new Error("Duplicate financial research archive revision");
    revisions.add(ref.revision);
    const batch = await loadFinancialObservationArchive(ref, signal);
    if (batch.symbol !== symbol) throw new Error("Financial research archive symbol does not match the request");
    const instant = Date.parse(batch.observedAt);
    const capture = { ref, observedAt: batch.observedAt, instant, observedDate: shanghaiDate.format(instant) };
    if (batch.endpoint === "fina_indicator") {
      for (const { periodEnd } of batch.rows) periods.add(periodEnd);
      reports.push({ ...capture, rows: batch.rows });
    } else disclosures.push({ ...capture, rows: batch.rows });
  }

  const newestCapture = (left: CaptureEvidence & { instant: number }, right: CaptureEvidence & { instant: number }) =>
    right.instant - left.instant || left.ref.revision.localeCompare(right.ref.revision);
  reports.sort(newestCapture);
  disclosures.sort(newestCapture);
  const newestPeriods = [...periods].sort().reverse();
  return tradingDates.map((tradingDate): FinancialInputReplayRow => {
    signal?.throwIfAborted();
    let reason: UnavailableReason | undefined;
    for (const periodEnd of newestPeriods) {
      const report = latestPeriod(reports, periodEnd, tradingDate);
      if (!report.rows.length) continue;
      const disclosure = latestPeriod(disclosures, periodEnd, tradingDate);
      const actualDates = new Set(disclosure.rows.flatMap(row => row.actualDisclosureDate === null ? [] : [row.actualDisclosureDate]));
      const uniqueValues = new Set(report.rows.map(row => JSON.stringify(row)));
      const [actualDisclosureDate] = actualDates;
      const value = report.rows[0]!;
      if (uniqueValues.size > 1) reason ??= "ambiguous-report";
      else if (actualDates.size > 1) reason ??= "ambiguous-disclosure";
      else if (!actualDisclosureDate) reason ??= "missing-disclosure";
      else if (actualDisclosureDate > report.observedDate || actualDisclosureDate > disclosure.observedDate ||
        (value.announcementDate !== null && value.announcementDate > report.observedDate)) reason ??= "inconsistent-timing";
      else return { tradingDate, status: "available", periodEnd, actualDisclosureDate, report: { ...value },
        reportEvidence: report.evidence, disclosureEvidence: disclosure.evidence };
    }
    return { tradingDate, status: "unavailable", reason: reason ?? "missing-report" };
  });
}
