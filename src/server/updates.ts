import { desc, eq } from "drizzle-orm";

import { sourceParts } from "../app/_components/format.ts";
import { db } from "./db/index.ts";
import {
  briefs,
  decisions,
  filings,
  researchRuns,
  tickerUpdates,
} from "./db/schema.ts";
import { buildQueue, type QueueItem } from "./queue.ts";
import type {
  AnalystResult,
  BriefResult,
  VerifierResult,
} from "./research/prompts.ts";
import type { FirstPass } from "./research/run.ts";

export type UpdateView = {
  id: number;
  runId: number;
  ticker: string;
  depth: string;
  createdAt: string;
  result: StoredResult;
  verification: VerifierResult | null;
  firstPass: FirstPass | null;
  verifiedScore: number | null;
  analystProvider: string;
  analystModel: string;
  verifierProvider: string | null;
  verifierModel: string | null;
  usedFallback: boolean;
  revisedAfterReview: boolean;
  /** Set when a later quiet day found nothing new since this review. */
  recheckedAt: string | null;
  /** The thesis this review judged against, so a newer one can be pointed out. */
  thesisAtReview: string | null;
  /** The call before this review, so a change of mind stays visible. */
  previousAction: string | null;
  /** The run's mode, which decides whether one provider checking itself is worth saying. */
  providerMode: string | null;
  /** When the quote this review read was priced, in Unix seconds. Null on older rows. */
  quotePricedAt: number | null;
};

/** Stored beside the analyst's own fields in result_json. */
export type StoredResult = Omit<AnalystResult, "evidence"> & {
  evidence: (AnalystResult["evidence"][number] & {
    link_not_in_files?: boolean;
  })[];
  is_fund?: boolean;
  thesis_at_review?: string | null;
  previous_action?: string | null;
  quote_priced_at?: number | null;
  quote_price?: number | null;
  condition_warnings?: string[];
  local_correction?: { at: string; notes: string[] };
};

/** Stamp provenance from this run's files; later packs may replace them. */
export function markUnknownLinks(
  evidence: AnalystResult["evidence"],
  fileText: string,
): StoredResult["evidence"] {
  const trimmed = (url: string) => url.replace(/[),.;]+$/, "");
  const urls = (text: string) =>
    (text.match(/https?:\/\/[^\s<>"\\|]+/gi) ?? []).map(trimmed);
  // The files are read the page's way as well: its pattern keeps a "|" or a quote inside an
  // address, and a citation that copies such an address in full is not an unknown one. In
  // pack.json an address is a JSON string, so there it ends at the closing quote.
  const known = new Set([
    ...urls(fileText),
    ...(fileText.match(/https?:\/\/[^\s)]+/gi) ?? []).map(trimmed),
    ...(fileText.match(/https?:\/\/[^\s)"]+/gi) ?? []).map(trimmed),
  ]);
  // A source is read both as the files are and exactly as the page links it, whatever precedes the
  // link, so the page can never make clickable an address this check did not see.
  const linked = (source: string) => [
    ...urls(source),
    ...sourceParts(source).flatMap((part) =>
      part.url ? [trimmed(part.url)] : [],
    ),
  ];
  return evidence.map((item) =>
    linked(item.source).some((url) => !known.has(url))
      ? { ...item, link_not_in_files: true }
      : item,
  );
}

async function runModes() {
  const runs = await db
    .select({ id: researchRuns.id, mode: researchRuns.providerMode })
    .from(researchRuns);
  return new Map(runs.map((run) => [run.id, run.mode]));
}

function toView(
  row: typeof tickerUpdates.$inferSelect,
  modes: Map<number, string>,
): UpdateView {
  const result = JSON.parse(row.resultJson) as StoredResult;
  const stored = row.verificationJson
    ? (JSON.parse(row.verificationJson) as VerifierResult & {
        first_pass?: FirstPass | null;
      })
    : null;
  return {
    id: row.id,
    runId: row.runId,
    ticker: row.ticker,
    depth: row.reviewDepth,
    createdAt: row.createdAt,
    result,
    verification: stored,
    firstPass: stored?.first_pass ?? null,
    // Rows saved before this was fixed hold 0 for a review nobody checked.
    verifiedScore: stored ? row.verifiedScore : null,
    analystProvider: row.analystProvider,
    analystModel: row.analystModel,
    verifierProvider: row.verifierProvider,
    verifierModel: row.verifierModel,
    usedFallback: row.usedFallback,
    revisedAfterReview: row.revisedAfterReview,
    recheckedAt: null,
    thesisAtReview: result.thesis_at_review ?? null,
    previousAction: result.previous_action ?? null,
    providerMode: modes.get(row.runId) ?? null,
    quotePricedAt: result.quote_priced_at ?? null,
  };
}

/**
 * What the thesis tab says when the latest review may not answer my notes as they stand. A review
 * stores its thesis but not its break conditions. Saving a change to either clears the review clock,
 * which works for reviews already stored too, and a cleared clock means the next run is a full one.
 */
export function reviewBasisNotice(
  thesis: string | null,
  thesisAtReview: string | null,
  lastFullReviewAt: string | null | undefined,
) {
  if (!thesis) return null;
  if (thesis !== thesisAtReview) {
    return "The latest review ran before this version of your thesis. The next research run gives it a full review.";
  }
  return lastFullReviewAt === null
    ? "The next research run gives this holding a full review, against your thesis and break conditions as they stand now."
    : null;
}

const isQuiet = (view: UpdateView) =>
  view.depth === "LIGHT" &&
  !view.verification &&
  view.result.status === "no_change" &&
  view.result.action === "hold";

/**
 * The review to show for a ticker, given its updates newest first. A light review that found
 * nothing must not hide the last real one, so that stays on screen with a note of the recheck.
 */
export function currentReview(history: UpdateView[]) {
  const newest = history[0];
  if (!newest) return undefined;
  const real = history.find((view) => !isQuiet(view));
  return real && real !== newest
    ? { ...real, recheckedAt: newest.createdAt }
    : newest;
}

/** The review to show for every ticker. */
export async function latestUpdates() {
  const [rows, modes] = await Promise.all([
    db.select().from(tickerUpdates).orderBy(desc(tickerUpdates.id)),
    runModes(),
  ]);
  const byTicker = new Map<string, UpdateView[]>();
  // currentReview reads only as far as a ticker's first real review, so older rows stay unparsed.
  const settled = new Set<string>();
  for (const row of rows) {
    if (settled.has(row.ticker)) continue;
    const view = toView(row, modes);
    const history = byTicker.get(row.ticker) ?? [];
    history.push(view);
    byTicker.set(row.ticker, history);
    if (!isQuiet(view)) settled.add(row.ticker);
  }
  const latest = new Map<string, UpdateView>();
  for (const [ticker, history] of byTicker) {
    const review = currentReview(history);
    if (review) latest.set(ticker, review);
  }
  return latest;
}

export async function tickerHistory(ticker: string, limit = 30) {
  const [rows, modes] = await Promise.all([
    db
      .select()
      .from(tickerUpdates)
      .where(eq(tickerUpdates.ticker, ticker))
      .orderBy(desc(tickerUpdates.id))
      .limit(limit),
    runModes(),
  ]);
  return rows.map((row) => toView(row, modes));
}

export type SecondOpinion = "agree" | "disagree" | "second_pass_disagrees";

/** Null when there is nothing to say. One model agreeing with itself says little, so it stays quiet. */
export function secondOpinion(
  update: Pick<
    UpdateView,
    "result" | "verification" | "analystProvider" | "verifierProvider"
  >,
): SecondOpinion | null {
  if (!update.verification) return null;
  const twoModels =
    update.verifierProvider !== null &&
    update.verifierProvider !== update.analystProvider;
  if (update.verification.independent_action !== update.result.action) {
    return twoModels ? "disagree" : "second_pass_disagrees";
  }
  return twoModels ? "agree" : null;
}

type Check = VerifierResult["checks"][number];
export type EvidenceEntry = {
  claim: string;
  source: string;
  date?: string;
  check: Check | null;
  link_not_in_files?: boolean;
};

const normalizeClaim = (s: string) =>
  s.toLowerCase().replace(/\s+/g, " ").trim().replace(/\.$/, "");

/** Pairs each evidence item with the check for that claim. Leftover checks follow as their own rows. */
export function evidenceEntries(
  update: Pick<UpdateView, "result" | "verification">,
): EvidenceEntry[] {
  const remaining = [...(update.verification?.checks ?? [])];
  const take = (test: (c: Check) => boolean) => {
    const i = remaining.findIndex(test);
    return i < 0 ? null : (remaining.splice(i, 1)[0] ?? null);
  };
  // The verifier must copy evidence claims verbatim. Word overlap cannot establish factual identity;
  // a rephrased check remains visible separately, without lending its verdict to another claim.
  const entries: EvidenceEntry[] = update.result.evidence.map((item) => {
    const claim = normalizeClaim(item.claim);
    return { ...item, check: take((c) => normalizeClaim(c.claim) === claim) };
  });
  return [
    ...entries,
    ...remaining.map((check) => ({
      claim: check.claim,
      source: check.source,
      check,
    })),
  ];
}

export function reviewNewerThanBrief(
  update: Pick<UpdateView, "runId">,
  briefRunId: number | null,
): boolean {
  return briefRunId === null || update.runId > briefRunId;
}

/** Saved briefs retain history; only holdings still owned belong in the active queue. */
export function heldQueue<T extends Pick<QueueItem, "ticker" | "decision">>(
  queue: T[],
  held: Set<string>,
) {
  const current = queue.filter((item) => held.has(item.ticker));
  return {
    queue: current,
    openCount: current.filter((item) => !item.decision).length,
  };
}

export const thesisInDoubt = (result: Pick<AnalystResult, "status">) =>
  result.status === "thesis_weakened" || result.status === "thesis_broken";

/** A final failed check needs attention even when both passes recommend holding. */
export function needsRevision(verification: VerifierResult) {
  return (
    verification.conclusion_supported === false ||
    verification.checks?.some((c) => c.verdict === "contradicted") === true
  );
}

/**
 * Reviews on screen that need attention, are not waiting in the brief's queue, and have no decision
 * logged since. Without this a call can vanish from Today while the sidebar still shows it: the
 * brief failed, this ticker failed in a later run, or a run reviewed only some holdings.
 */
export function openCalls(
  queue: (Pick<QueueItem, "ticker"> & Partial<Pick<QueueItem, "decision">>)[],
  updates: Map<string, UpdateView>,
  decisionRows: { ticker: string; date: string; createdAt?: string | null }[],
  held: Set<string>,
) {
  // Only an entry still open covers its ticker. Once I have logged a decision on it, a review
  // made after that decision is a new call, and the decision test below is what settles it.
  const queued = new Set(
    queue.filter((item) => !item.decision).map((item) => item.ticker),
  );
  return [...updates.values()].filter(
    (update) =>
      (update.result.action !== "hold" ||
        thesisInDoubt(update.result) ||
        (update.verification != null &&
          (needsRevision(update.verification) ||
            update.verification.independent_action !==
              update.result.action))) &&
      held.has(update.ticker) &&
      !queued.has(update.ticker) &&
      !decisionRows.some(
        (d) =>
          d.ticker === update.ticker &&
          (d.createdAt ?? `${d.date}T23:59:59.999Z`) >= update.createdAt,
      ),
  );
}

/** The brief's review call wins when the passes disagree or the final check failed. */
export function listedActions(
  queue: Pick<QueueItem, "ticker" | "action">[],
  updates: Map<string, UpdateView>,
  briefRunId: number | null = Number.POSITIVE_INFINITY,
) {
  const actions = new Map<string, string>();
  for (const [ticker, update] of updates) {
    actions.set(ticker, update.result.action);
  }
  for (const item of queue) {
    const update = updates.get(item.ticker);
    if (item.action && (!update || !reviewNewerThanBrief(update, briefRunId))) {
      actions.set(item.ticker, item.action);
    }
  }
  return actions;
}

/** Accession number → document URL, so an edgar: source can link to the filing. */
export async function filingLinks() {
  const rows = await db
    .select({ accessionNo: filings.accessionNo, url: filings.primaryDocUrl })
    .from(filings);
  return Object.fromEntries(rows.map((r) => [r.accessionNo, r.url]));
}

/** The newest brief, and its suggestions merged into one list with my logged decisions applied. */
export async function loadBrief() {
  const [[row], decisionRows] = await Promise.all([
    db.select().from(briefs).orderBy(desc(briefs.id)).limit(1),
    db
      .select()
      .from(decisions)
      .orderBy(desc(decisions.date), desc(decisions.id)),
  ]);
  if (!row)
    return {
      brief: null,
      queue: [],
      openCount: 0,
      provider: null,
      runId: null,
      briefReadyAt: null,
      decisions: decisionRows,
    };
  const [run] = await db
    .select()
    .from(researchRuns)
    .where(eq(researchRuns.id, row.runId))
    .limit(1);
  const briefReadyAt = run?.finishedAt ?? run?.startedAt ?? null;
  const brief = JSON.parse(row.resultJson) as BriefResult & {
    failed?: { ticker: string; reason: string }[];
    used_fallback?: boolean;
    untraced_figures?: string[];
    local_correction?: StoredResult["local_correction"];
  };
  const queue = buildQueue(brief, decisionRows, briefReadyAt);
  return {
    brief,
    queue,
    openCount: queue.filter((item) => !item.decision).length,
    provider: row.provider,
    runId: row.runId,
    briefReadyAt,
    decisions: decisionRows,
  };
}

/** A check can cite several classes; count it once in each cited class. */
export function verificationSources(
  verification: VerifierResult | null,
): { filing: number; vendor: number; web: number; other: number } | null {
  if (!verification) return null;
  const counts = { filing: 0, vendor: 0, web: 0, other: 0 };
  for (const check of verification.checks) {
    if (check.verdict !== "verified") continue;
    const source = check.source.toLowerCase();
    // news: marks a model's summary of a web page, even of an SEC page. A bare SEC link is the
    // Document line of a filing in the pack.
    const secLink = /(?<!news:)https?:\/\/www\.sec\.gov\/archives\/\S*/g;
    const filing =
      /edgar:|\bfiling_(?:sections_|diff_)?|\bnew_8k_|\bclaim_excerpts\b/.test(
        source,
      ) || new RegExp(secLink).test(source);
    const vendor = /fmp:|\bpack\.json\b/.test(source);
    const web = /news:|https?:\/\/|\bweb_research\.md\b/.test(
      source.replace(secLink, ""),
    );
    if (filing) counts.filing++;
    if (vendor) counts.vendor++;
    if (web) counts.web++;
    if (/\bdossier(?:\.md)?\b/.test(source) || (!filing && !vendor && !web))
      counts.other++;
  }
  return counts;
}

/** In Both mode, a fallback made one provider check its own work. */
export function sameProviderFallback(
  update: Pick<
    UpdateView,
    "usedFallback" | "analystProvider" | "verifierProvider" | "providerMode"
  >,
): boolean {
  return (
    update.providerMode === "both" &&
    update.usedFallback &&
    update.verifierProvider !== null &&
    update.analystProvider === update.verifierProvider
  );
}
