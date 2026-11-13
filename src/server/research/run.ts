import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { z, type ZodType } from "zod";

import { env } from "../../env.js";
import { checkRejected } from "../../app/_components/format.ts";
import { db } from "../db/index.ts";
import {
  briefs,
  decisions,
  filings,
  holdings as holdingsTable,
  researchRuns,
  settings as settingsTable,
  tickers,
  tickerUpdates,
} from "../db/schema.ts";
import {
  dossierPath,
  markCurrentViewStale,
  readDossier,
  replaceCurrentView,
  reviewBasis,
  saveDossier,
  thesisText,
  viewWithUnconfirmed,
} from "../dossier.ts";
import {
  FULL_REVIEW_FORMS,
  gaveUpOnFiling,
  syncFilings,
  UNREADABLE_RETRY_DAYS,
  type Filing,
} from "../edgar.ts";
import {
  fetchFmpData,
  fetchMarketContext,
  FmpRateLimitError,
  nextEarnings,
  num,
  pricePoints,
  priceSummary,
  pruneFmpCache,
  quoteDate,
  today,
  type FmpData,
  type Row,
} from "../fmp.ts";
import {
  errorMessage,
  addUsage,
  runModel,
  setupProblems,
  type RunModelOptions,
  type Usage,
} from "../model.ts";
import {
  currentReview,
  evidenceEntries,
  markUnknownLinks,
  needsRevision,
  sameProviderFallback,
  tickerHistory,
  thesisInDoubt,
  verificationSources,
  type StoredResult,
} from "../updates.ts";
import {
  computePortfolioFacts,
  packPosition,
  type PortfolioFacts,
} from "../portfolio.ts";
import { getSettings, modeLabel, providerLabel } from "../settings.ts";
import { positionSizeLine } from "../queue.ts";
import { ensureTicker, packDir, writePack } from "./pack.ts";
import {
  analystPrompt,
  analystSchema,
  BRIEF_PROMPT,
  briefSchema,
  reviewerFeedback,
  verifierPrompt,
  verifierSchema,
  webResearchPrompt,
  webResearchSchema,
  type AnalystResult,
  type BriefResult,
  type VerifierResult,
  type WebResearch,
} from "./prompts.ts";

const DAY_MOVE_PCT = 5;
const FIVE_DAY_MOVE_PCT = 10;
const FULL_REVIEW_EVERY_DAYS = 7;
const HEARTBEAT_MS = 60_000;
const STALE_RUN_MS = 10 * 60_000; // a run silent for this long has crashed, however long it ran
const STOP_CHECK_MS = 2_000;
const STOP_GRACE_MS = 5_000; // for a review that is already saving when the stop arrives
const WEB_FINDING_MAX_AGE_DAYS = 45;
const REVIEW_CONCURRENCY = 3;
const RECENT_RESULTS_DAYS = 3;

/** The run in progress, if any. Keeps a scheduled run and "Run research" from overlapping. */
export async function activeRun() {
  const cutoff = new Date(Date.now() - STALE_RUN_MS).toISOString();
  const [run] = await db
    .select()
    .from(researchRuns)
    .where(
      and(
        eq(researchRuns.status, "running"),
        gt(
          sql`coalesce(${researchRuns.heartbeatAt}, ${researchRuns.startedAt})`,
          cutoff,
        ),
      ),
    )
    .orderBy(desc(researchRuns.id))
    .limit(1);
  return run ?? null;
}

/**
 * The newest run as the app should describe it. A crash or reboot leaves the row as running, and
 * that must not lock the button. `message` is the last log line without its time, or without the
 * dash when that line is the end of a multi-line list of reviewer notes.
 */
/**
 * Stops the run in progress. The run is another process, so this marks its row and the run, which
 * reads that row every couple of seconds, ends its model calls and exits. Marking the row first means
 * the page shows the stop at once and a run that has already died is freed too. Reviews that finished
 * before the stop were saved as they finished, and stay.
 */
export async function stopRun() {
  const cutoff = new Date(Date.now() - STALE_RUN_MS).toISOString();
  const line = `${new Date().toLocaleTimeString("en-US", { hour12: false })} Stopped at your request.
`;
  const stopped = await db
    .update(researchRuns)
    .set({
      status: "stopped",
      finishedAt: new Date().toISOString(),
      logText: sql`coalesce(${researchRuns.logText}, '') || ${line}`,
    })
    .where(
      and(
        eq(researchRuns.status, "running"),
        gt(
          sql`coalesce(${researchRuns.heartbeatAt}, ${researchRuns.startedAt})`,
          cutoff,
        ),
      ),
    )
    .returning({ id: researchRuns.id });
  return stopped.length > 0;
}

/** Aborts its signal once this run's row says it was stopped. Stops asking when the run is over. */
function watchForStop(runId: number) {
  const controller = new AbortController();
  const timer = setInterval(() => {
    void db
      .select({ status: researchRuns.status })
      .from(researchRuns)
      .where(eq(researchRuns.id, runId))
      .then(([row]) => {
        if (row?.status === "running") return;
        clearInterval(timer);
        if (row?.status === "stopped") controller.abort();
      })
      .catch(() => undefined);
  }, STOP_CHECK_MS);
  timer.unref();
  return controller.signal;
}

export async function latestRun() {
  const [run] = await db
    .select()
    .from(researchRuns)
    .orderBy(desc(researchRuns.id))
    .limit(1);
  if (!run) return null;
  const stale =
    run.status === "running" &&
    Date.now() - Date.parse(run.heartbeatAt ?? run.startedAt) > STALE_RUN_MS;
  const lastLine = stale
    ? "This run stopped without finishing."
    : (run.logText.trim().split("\n").pop() ?? "");
  return {
    ...run,
    status: stale ? "failed" : run.status,
    lastLine,
    message: lastLine
      .replace(/^(?:\d{1,2}:\d{2}:\d{2}|-) /, "")
      .replace(/^Run failed: /, ""),
  };
}

/** What the first check objected to, kept because the revision replaces it. */
export type FirstPass = {
  concerns: string[];
  contradicted: { claim: string; note: string }[];
  // Absent on reviews saved before these were recorded.
  action?: string;
  conclusion_supported?: boolean;
};

type TickerOutcome = {
  ticker: string;
  depth: "LIGHT" | "FULL";
  result: AnalystResult;
  verification: VerifierResult | null;
  verifiedScore: number | null;
  analyst: { provider: string; model: string };
  verifier: { provider: string; model: string } | null;
  usedFallback: boolean;
  revisedAfterReview: boolean;
  previousAction?: string | null;
};

/**
 * The vendor data, filings and web findings given to a review, to look a cited link up in. A
 * filing's address is in its filing files, not in pack.json. Two files are left out because a model
 * wrote them: review.json is the analyst's own answer, and dossier.md carries the Current view an
 * earlier review wrote, so neither may vouch for a link.
 */
export function researchFilesText(dir: string) {
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (file) =>
        file.isFile() &&
        /\.(json|md|txt)$/.test(file.name) &&
        file.name !== "review.json" &&
        file.name !== "dossier.md",
    )
    .map((file) => readFileSync(path.join(dir, file.name), "utf8"))
    .join("\n");
}

/** Keep stored checks in order, then show any evidence the verifier did not check. */
export function proofChecks(update: Parameters<typeof evidenceEntries>[0]) {
  if (!update.verification) return null;
  return [
    ...update.verification.checks,
    ...evidenceEntries(update)
      .filter((entry) => !entry.check)
      .map((entry) => ({
        verdict: "not_checked" as const,
        claim: entry.claim,
      })),
  ];
}

/** Counts use the same claims shown in the proof strip, including unchecked evidence. */
export function verifiedCounts(
  verification: VerifierResult | null,
  evidence: AnalystResult["evidence"] = [],
) {
  const checks = proofChecks({
    result: { evidence },
    verification,
  } as Parameters<typeof evidenceEntries>[0]);
  if (!checks?.length) return null;
  return {
    verified: checks.filter((c) => c.verdict === "verified").length,
    total: checks.length,
  };
}

/** Verified checks divided by the same claims shown in the proof strip. Null without checks. */
export function verifiedScore(
  verification: VerifierResult | null,
  evidence: AnalystResult["evidence"] = [],
) {
  const counts = verifiedCounts(verification, evidence);
  return counts ? Number((counts.verified / counts.total).toFixed(4)) : null;
}

/** One SQLite statement claims the shared pack workspace across processes. */
export async function claimRun(
  providerMode: string,
  startedAt = new Date().toISOString(),
) {
  const cutoff = new Date(Date.now() - STALE_RUN_MS).toISOString();
  const result = await db.all<{
    id: number;
  }>(sql`INSERT INTO research_runs (started_at, heartbeat_at, status, provider_mode)
    SELECT ${startedAt}, ${startedAt}, 'running', ${providerMode}
    WHERE NOT EXISTS (SELECT 1 FROM research_runs WHERE status = 'running' AND coalesce(heartbeat_at, started_at) > ${cutoff})
    RETURNING id`);
  return result[0] ?? null;
}

export function needsVerification(
  depth: string,
  result: Pick<AnalystResult, "status" | "action">,
  previousAction: string | null,
) {
  return (
    depth === "FULL" ||
    // Any status other than no_change buys a checker call, even on a light review.
    result.status !== "no_change" ||
    result.action !== "hold" ||
    // A hold that replaces an earlier call is a change of mind, so it gets checked too.
    (previousAction !== null && previousAction !== result.action)
  );
}

/** Future portfolio-weight conditions need headroom beyond the current rounded weight. */
export function fundWeightConditionIssues(
  result: Pick<
    AnalystResult,
    "next_proof_point" | "would_change_my_mind" | "dossier_current_view"
  >,
  weight: number | null,
): string[] {
  if (weight === null || !Number.isFinite(weight)) return [];
  const displayedWeight = Number(weight.toFixed(2));
  const issues = new Map<string, string>();
  for (const text of [
    result.next_proof_point,
    ...result.would_change_my_mind,
    result.dossier_current_view ?? "",
  ]) {
    for (const match of text.matchAll(
      /\b(?:portfolio\s+weight|(?:fund|portfolio)\s+allocation|position\s+weight)\b([^\.\n!?]{0,80}?)\b(above|over|exceeds?|below|under)\s+(\d+(?:\.\d+)?)\s*%/gi,
    )) {
      const between = match[1]!;
      if (
        /\b(?:not|never|without|remains?|stays?|continues?|still)\b/i.test(
          between,
        )
      )
        continue;
      if (/\b(?:fee|expense|yield|margin|distribution|price)\b/i.test(between))
        continue;
      if (
        /\b(?:is|already|currently|now|stands)\b/i.test(between) &&
        !/\b(?:rise|rises|if|would|trigger)\b/i.test(between)
      )
        continue;
      const threshold = Number(match[3]);
      const upward = /above|over|exceed/i.test(match[2]!);
      if (
        !/^exceed/i.test(match[2]!) &&
        !/\b(?:ris(?:e|es|ing)|increas(?:e|es|ing)|cross(?:es|ing)?|grow(?:s|ing)?|mov(?:e|es|ing)|go(?:es|ing)?|fall(?:s|ing)?|drop(?:s|ping)?|declin(?:e|es|ing)|pass(?:es|ing)?|reach(?:es|ing)?)\b/i.test(
          between,
        )
      )
        continue;
      if (
        (upward && threshold <= displayedWeight) ||
        (!upward && threshold >= displayedWeight)
      ) {
        issues.set(
          `${upward}:${threshold}`,
          `The future condition "${match[0]}" is already met or has no headroom at the current displayed ${displayedWeight}% portfolio weight. Clarify whether a review is due now or give a genuinely future condition; do not invent an owner allocation target.`,
        );
      }
    }
  }
  return [...issues.values()];
}

/** The price has moved this much since the last full review, or null if that cannot be told. */
function moveSince(
  fmp: FmpData,
  reviewedAt: string | null,
  seenQuoteAt: number | null,
  seenPrice: number | null,
) {
  if (!reviewedAt) return null;
  // Older rows saved only a quote time, so fall back to that date's close when no price was saved.
  const reviewDate =
    (seenQuoteAt === null ? null : quoteDate({ timestamp: seenQuoteAt })) ??
    new Date(reviewedAt).toLocaleDateString("en-CA");
  const points = pricePoints(fmp.history);
  const latest = num(fmp.quote?.price) ?? points[0]?.price;
  const then =
    seenPrice !== null && seenPrice > 0
      ? seenPrice
      : points.find((p) => p.date <= reviewDate)?.price;
  return !latest || !then ? null : Math.abs((latest - then) / then) * 100;
}

type ReviewForClock = {
  depth: string;
  verification?: { conclusion_supported: boolean } | null;
};

/**
 * A rejected review gets one more try the next day. A second rejection in a row goes back to the
 * usual schedule, or a ticker that keeps failing its check would get a full review every day.
 */
export function resetsReviewClock(
  depth: "LIGHT" | "FULL",
  rejected: boolean,
  previous: ReviewForClock | null | undefined,
) {
  if (depth !== "FULL") return false;
  return (
    !rejected ||
    (previous?.depth === "FULL" &&
      previous.verification?.conclusion_supported === false)
  );
}

export function reviewDepth(
  fmp: FmpData,
  newFilings: Pick<Filing, "form">[],
  lastFullReviewAt: string | null,
  seenQuoteAt: number | null = null,
  seenPrice: number | null = null,
): { depth: "LIGHT" | "FULL"; why: string } {
  const landed = newFilings.filter((f) => FULL_REVIEW_FORMS.has(f.form));
  if (landed.length) {
    return {
      depth: "FULL",
      why: `new filing: ${landed.map((f) => f.form).join(", ")}`,
    };
  }
  // Quotes are cached for the day, so a second run or a weekend run sees the same move again. A
  // full review has seen the quote it read, which an evening run can find older than the clock
  // suggests, and a 5-day move needs the price to have gone further since then, or it would buy a
  // full review every day for a week.
  const pricedAt = num(fmp.quote?.timestamp);
  const alreadySeen =
    lastFullReviewAt !== null &&
    pricedAt !== null &&
    pricedAt > 0 &&
    // Reviews saved before the quote time was recorded go by when they ran.
    (seenQuoteAt !== null
      ? pricedAt <= seenQuoteAt
      : Date.parse(lastFullReviewAt) >= pricedAt * 1000);
  if (!alreadySeen) {
    const dayMove = Math.abs(Number(fmp.quote?.changePercentage ?? 0));
    if (dayMove > DAY_MOVE_PCT) {
      return { depth: "FULL", why: `day move of ${dayMove.toFixed(1)}%` };
    }
    const fiveDay = Math.abs(priceSummary(fmp.history)?.return_5d_pct ?? 0);
    const since = moveSince(fmp, lastFullReviewAt, seenQuoteAt, seenPrice);
    if (
      fiveDay > FIVE_DAY_MOVE_PCT &&
      (since === null || since > DAY_MOVE_PCT)
    ) {
      return { depth: "FULL", why: `5-day move of ${fiveDay.toFixed(1)}%` };
    }
  }
  const ageDays = lastFullReviewAt
    ? (Date.now() - Date.parse(lastFullReviewAt)) / 86_400_000
    : Infinity;
  if (ageDays > FULL_REVIEW_EVERY_DAYS) {
    return {
      depth: "FULL",
      why: lastFullReviewAt
        ? `last full review was ${Math.floor(ageDays)} days ago`
        : "no full review on record",
    };
  }
  return { depth: "LIGHT", why: "nothing new" };
}

/** Renders findings to a file, so analyst and verifier work from the same text. */
export function renderWebResearch(research: WebResearch, today_: string) {
  const cutoff = Date.parse(today_) - WEB_FINDING_MAX_AGE_DAYS * 86_400_000;
  const latest = Date.parse(today_) + 86_400_000;
  const kept = research.findings.filter(
    (f) =>
      /^https?:\/\//.test(f.url) &&
      Date.parse(f.date) >= cutoff &&
      Date.parse(f.date) <= latest,
  );
  const dropped = research.findings.length - kept.length;
  const lines = [
    `# Web research found on ${today_}`,
    "",
    "Reported by a model from web pages. Cite as news:<url>.",
    "",
  ];
  // Findings that failed the date or link test are not the same as nothing happening.
  if (dropped) {
    lines.push(
      `${dropped} ${dropped === 1 ? "finding was" : "findings were"} left out for a missing or out-of-range date or a bad link, so this list may be incomplete.`,
      "",
    );
  } else if (!kept.length) {
    lines.push("No material developments found.");
  }
  for (const f of kept) {
    lines.push(
      `- ${f.claim}`,
      `  Source: ${f.publisher}, ${f.date}, ${f.url}`,
      `  Why it matters: ${f.why_it_matters}`,
    );
  }
  return { markdown: `${lines.join("\n")}\n`, kept: kept.length };
}

function scoreLabel(
  n: number | null,
  counts: ReturnType<typeof verifiedCounts> = null,
) {
  return n === null
    ? "n/a"
    : `${(n * 100).toFixed(0)}%${counts ? ` (${counts.verified} of ${counts.total})` : ""}`;
}

/** Brief markdown is rendered by code from stored results. */
export function renderBriefMarkdown(opts: {
  brief: BriefResult & { local_correction?: StoredResult["local_correction"] };
  outcomes: TickerOutcome[];
  failed: { ticker: string; reason: string }[];
  briefLabel: string;
  providerMode?: string;
  quoteDates?: { newest: string | null; stale: string[] };
  weights?: Map<string, number | null>;
  facts?: Pick<PortfolioFacts, "positions" | "total_value">;
  untracedFigures?: string[];
}) {
  const { brief, outcomes, failed, briefLabel, quoteDates } = opts;
  const lines: string[] = [`# Daily brief for ${brief.date}`, ""];
  if (brief.local_correction) {
    lines.push(
      "Local correction: " + brief.local_correction.notes.join(" "),
      "The original model checks are retained; these amendments were not reviewed by another model.",
      "",
    );
  }
  if (quoteDates?.newest) {
    const stale = quoteDates.stale.length
      ? ` Older or stale quotes: ${quoteDates.stale.join(", ")}.`
      : "";
    lines.push(`Prices as of ${quoteDates.newest}.${stale}`, "");
  }
  lines.push(brief.summary, "");

  lines.push("## Needs attention", "");
  if (brief.needs_attention.length) {
    for (const item of brief.needs_attention) {
      lines.push(`- **${item.ticker}**: ${item.why}`);
    }
  } else if (brief.suggested_actions.some((a) => a.action !== "hold")) {
    lines.push("See the suggested actions below.");
  } else {
    lines.push("Nothing needs attention today.");
  }
  lines.push("");

  lines.push("## Suggested actions", "");
  if (brief.suggested_actions.length) {
    lines.push(
      `| Ticker | Action | Size | Urgency | Verified | ${outcomes.some((o) => o.analyst.provider === o.verifier?.provider) ? "Second pass agrees" : "Models agree"} | Reasoning |`,
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const a of brief.suggested_actions) {
      const outcome = outcomes.find((o) => o.ticker === a.ticker);
      const rejected = checkRejected({
        verification: outcome?.verification ?? null,
      });
      const agree = rejected
        ? `${a.models_agree === false ? "no; " : ""}conclusion not supported`
        : a.models_agree === null
          ? "n/a"
          : a.models_agree
            ? "yes"
            : "no";
      const counts = outcome
        ? verifiedCounts(outcome.verification, outcome.result.evidence)
        : null;
      const sources = verificationSources(outcome?.verification ?? null);
      const caveat =
        a.action !== "hold" &&
        sources &&
        sources.web > sources.filing + sources.vendor
          ? " This action rests mainly on web summaries, not primary documents."
          : "";
      const cell = (text: string) =>
        text.replace(/\|/g, "\\|").replace(/\s+/g, " ");
      const context =
        a.action !== "hold" && opts.facts
          ? positionSizeLine(a.ticker, opts.facts)
          : null;
      const size = [a.size_hint, context].filter(Boolean).join(" ");
      lines.push(
        `| ${cell(a.ticker)} | ${cell(a.action)} | ${cell(size)} | ${cell(a.urgency.replace("_", " "))} | ${scoreLabel(a.verified_score, counts)} | ${agree} | ${cell(a.reasoning + caveat)} |`,
      );
    }
  } else {
    lines.push("No actions suggested.");
  }
  lines.push("");

  lines.push("## Portfolio observations", "");
  for (const o of brief.portfolio_observations) lines.push(`- ${o}`);
  lines.push("");

  lines.push("## Holdings", "");
  const sorted = [...outcomes].sort(
    (a, b) =>
      (opts.weights?.get(b.ticker) ?? -Infinity) -
        (opts.weights?.get(a.ticker) ?? -Infinity) ||
      a.ticker.localeCompare(b.ticker),
  );
  for (const o of sorted) {
    const weight = opts.weights?.get(o.ticker);
    const call =
      brief.suggested_actions.find((a) => a.ticker === o.ticker)?.action ??
      o.result.action;
    const label = [
      weight == null ? null : `${weight.toFixed(2)}%`,
      call,
      ...(o.verification
        ? [
            `verified ${scoreLabel(o.verifiedScore, verifiedCounts(o.verification, o.result.evidence))}`,
            checkRejected(o) ? "conclusion not supported" : null,
            o.verification.independent_action === o.result.action
              ? checkRejected(o)
                ? null
                : "second pass agrees"
              : `second pass says ${o.verification.independent_action}`,
          ]
        : ["not checked"]),
      `status ${o.result.status.replaceAll("_", " ")}`,
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`- **${o.ticker}** (${label}): ${o.result.headline}`);
  }
  lines.push("");

  if (failed.length) {
    lines.push("## Failed or skipped", "");
    for (const f of failed) lines.push(`- **${f.ticker}**: ${f.reason}`);
    lines.push("");
  }

  const describe = (who: { provider: string; model: string } | null) =>
    who ? `${providerLabel(who.provider)} (${who.model})` : "";
  const unique = (values: string[]) => [...new Set(values)].join(", ");
  const analysts = unique(outcomes.map((o) => describe(o.analyst)));
  const checkers = unique(
    outcomes.filter((o) => o.verifier).map((o) => describe(o.verifier)),
  );
  lines.push(
    "---",
    "",
    `Analyzed by ${analysts || "no model"}. Checked by ${checkers || "no model"}. Brief written by ${briefLabel}. Decision support only.`,
    "",
    "Verified is the share of claims the second pass found in what it was given. A claim not found is not shown to be wrong.",
    "",
  );
  if (
    outcomes.some((o) =>
      sameProviderFallback({
        usedFallback: o.usedFallback,
        analystProvider: o.analyst.provider,
        verifierProvider: o.verifier?.provider ?? null,
        providerMode: opts.providerMode ?? null,
      }),
    )
  ) {
    lines.push(
      "In Both mode, a fallback made one provider check its own work.",
      "",
    );
  }
  if (opts.untracedFigures?.length)
    lines.push(
      `Figures not traced to the brief inputs: ${opts.untracedFigures.join(", ")}. Check these against the source data.`,
      "",
    );
  return lines.join("\n");
}

function reviewWords(
  result: Pick<
    AnalystResult,
    "reasoning" | "would_change_my_mind" | "next_proof_point"
  >,
) {
  const condition = result.would_change_my_mind[0] || result.next_proof_point;
  return condition
    ? `${result.reasoning} What would change this: ${condition}`
    : result.reasoning;
}

/**
 * A model writes the brief, but its date and scores come from code, and it cannot change a call. It
 * may ask for a review when the two passes disagree or the final check failed. It cannot name a
 * holding I do not have, change a call, or drop a disputed hold or a thesis in doubt from Today.
 */
export function withCodeScores(
  brief: BriefResult,
  outcomes: Pick<
    TickerOutcome,
    "ticker" | "result" | "verification" | "verifiedScore"
  >[],
  date: string,
  held: Set<string>,
  lastDecisions = new Map<string, { date: string; actionTaken: string }>(),
): BriefResult {
  const scores = (outcome: (typeof outcomes)[number]) => ({
    verified_score: outcome.verifiedScore,
    models_agree: outcome.verification
      ? outcome.verification.independent_action === outcome.result.action
      : null,
  });
  // No outcome means no review ran or it failed, so any call on that ticker is the brief writer's own.
  const reviewed = outcomes.filter((o) => held.has(o.ticker));
  const outcomeOf = (ticker: string) =>
    reviewed.find((o) => o.ticker === ticker);
  const listed = brief.suggested_actions.filter((a) => outcomeOf(a.ticker));
  const stands = (a: (typeof listed)[number]) => {
    const { result, verification } = outcomeOf(a.ticker)!;
    return (
      a.action === result.action ||
      (a.action === "review" &&
        verification !== null &&
        (verification.independent_action !== result.action ||
          needsRevision(verification)))
    );
  };
  const corrected = new Set(
    listed.filter((a) => !stands(a)).map((a) => a.ticker),
  );
  let repeatedDiscardedAdvice = false;
  const needsAttention = brief.needs_attention
    .filter((n) => outcomeOf(n.ticker))
    .map((n) => {
      const o = outcomeOf(n.ticker)!;
      // An attention row is also investment advice, so use the completed review's words.
      let why = o.result.headline ?? o.result.reasoning;
      if (thesisInDoubt(o.result))
        why = `${o.result.status.replace("thesis_", "Thesis ")}: ${why}`;
      if (o.verification && needsRevision(o.verification))
        why +=
          " The final check raised concerns about this review. " +
          (o.verification.concerns ?? []).join(" ");
      if (
        o.verification &&
        o.verification.independent_action !== o.result.action
      )
        why += ` The review says ${o.result.action}, but the second pass would ${o.verification.independent_action}. ${o.verification.independent_reason}`;
      const discarded = n.why
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[.!?]+$/, "");
      if (
        o.result.action === "hold" &&
        !thesisInDoubt(o.result) &&
        o.verification &&
        !needsRevision(o.verification) &&
        o.verification.independent_action === "hold" &&
        n.why.trim() !== why.trim() &&
        discarded &&
        brief.summary.toLowerCase().replace(/\s+/g, " ").includes(discarded)
      )
        repeatedDiscardedAdvice = true;
      return { ...n, why: why.trim() };
    });
  for (const o of reviewed) {
    if (needsAttention.some((n) => n.ticker === o.ticker)) continue;
    if (o.verification && needsRevision(o.verification)) {
      needsAttention.push({
        ticker: o.ticker,
        why: `${o.result.headline} The final check raised concerns about this review. ${(o.verification.concerns ?? []).join(" ")}`.trim(),
      });
    } else if (thesisInDoubt(o.result)) {
      needsAttention.push({
        ticker: o.ticker,
        why: `${o.result.status.replace("thesis_", "Thesis ")}: ${o.result.headline}`,
      });
    } else if (
      o.result.action === "hold" &&
      o.verification &&
      o.verification.independent_action !== "hold" &&
      !listed.some((a) => a.ticker === o.ticker)
    ) {
      needsAttention.push({
        ticker: o.ticker,
        why: `The review says hold, but the second pass would ${o.verification.independent_action}. ${o.verification.independent_reason}`,
      });
    }
  }
  const suggestedActions = [
    ...listed.map((a) => {
      const outcome = outcomeOf(a.ticker)!;
      if (!corrected.has(a.ticker)) {
        const verification = outcome.verification;
        const counts =
          verification && Array.isArray(verification.checks)
            ? verifiedCounts(verification, outcome.result.evidence)
            : null;
        const fullyChecked =
          verification &&
          !needsRevision(verification) &&
          counts &&
          counts.verified === counts.total;
        // Different judgments on verified facts are not missing evidence. Use the two completed
        // reviews rather than retaining a brief writer's invented factual-failure explanation.
        if (
          fullyChecked &&
          verification.independent_action !== outcome.result.action
        ) {
          return {
            ...a,
            reasoning: `The review says ${outcome.result.action}: ${reviewWords(outcome.result)} The second pass would ${verification.independent_action}: ${verification.independent_reason}`,
            ...scores(outcome),
          };
        }
        return { ...a, ...scores(outcome) };
      }
      // The brief's own words argued for the action it picked, and would now sit beside this one.
      return {
        ...a,
        action: outcome.result.action,
        size_hint: "",
        reasoning: reviewWords(outcome.result),
        urgency:
          outcome.result.action === "hold"
            ? ("no_rush" as const)
            : ("this_week" as const),
        ...scores(outcome),
      };
    }),
    ...reviewed
      .filter(
        (o) =>
          o.result.action !== "hold" &&
          !listed.some((a) => a.ticker === o.ticker),
      )
      .map((o) => ({
        ticker: o.ticker,
        action: o.result.action,
        size_hint: "",
        reasoning: reviewWords(o.result),
        urgency: "this_week" as const,
        ...scores(o),
      })),
    ...reviewed
      .filter(
        (o) =>
          o.result.action === "hold" &&
          o.verification &&
          (needsRevision(o.verification) ||
            o.verification.independent_action !== "hold") &&
          !listed.some((a) => a.ticker === o.ticker),
      )
      .map((o) => ({
        ticker: o.ticker,
        action: "review" as const,
        size_hint: "",
        reasoning: needsRevision(o.verification!)
          ? `The final check raised concerns about this review. ${(o.verification!.concerns ?? []).join(" ")}`.trim()
          : `The second pass favors ${o.verification!.independent_action}: ${o.verification!.independent_reason}`,
        urgency: "no_rush" as const,
        ...scores(o),
      })),
  ].map((a) => {
    const decision = lastDecisions.get(a.ticker);
    return decision
      ? {
          ...a,
          reasoning: `${a.reasoning} Last logged: ${decision.actionTaken}, ${decision.date}.`,
        }
      : a;
  });
  const attention = [
    ...new Set([
      ...needsAttention.map((n) => n.ticker),
      ...suggestedActions
        .filter((a) => a.action !== "hold")
        .map((a) => a.ticker),
    ]),
  ];
  const restoredAttention = attention.some(
    (ticker) =>
      !brief.needs_attention.some((n) => n.ticker === ticker) &&
      !listed.some(
        (a) => a.ticker === ticker && stands(a) && a.action !== "hold",
      ),
  );
  const restoredCalls = reviewed.some(
    (o) =>
      o.result.action !== "hold" &&
      !listed.some((original) => original.ticker === o.ticker),
  );
  return {
    ...brief,
    date,
    summary:
      attention.length &&
      (brief.nothing_to_do ||
        restoredAttention ||
        restoredCalls ||
        repeatedDiscardedAdvice ||
        corrected.size > 0)
        ? `Needs attention: ${attention.join(", ")}. ${attention.map((t) => outcomeOf(t)!.result.headline).join(" ")}`
        : brief.summary,
    nothing_to_do: brief.nothing_to_do && !attention.length,
    needs_attention: needsAttention,
    suggested_actions: suggestedActions,
  };
}

/** Figures absent from the inputs are a warning only; a match does not verify a claim. */
export function untracedFigures(
  brief: Pick<
    BriefResult,
    | "summary"
    | "needs_attention"
    | "portfolio_observations"
    | "suggested_actions"
  >,
  inputs: string,
) {
  const known = new Set<number>();
  const raw = new Set<number>();
  const scales: Record<string, number> = {
    thousand: 1e3,
    million: 1e6,
    billion: 1e9,
    trillion: 1e12,
    bn: 1e9,
    mn: 1e6,
  };
  // Only quoted text can contain thousands separators; JSON arrays use commas between values.
  const numbers = inputs.replace(/"(?:\\.|[^"\\])*"/g, (text) =>
    text.replaceAll(",", ""),
  );
  for (const token of numbers.match(/\d+(?:\.\d+)?/g) ?? []) {
    const value = Number(token);
    raw.add(value);
    known.add(value);
    if (value >= 1e6) known.add(value / 1e6).add(value / 1e9);
    if (value <= 1) known.add(value * 100);
  }
  for (const match of numbers.matchAll(
    /(\d+(?:\.\d+)?)\s*(thousand|million|billion|trillion|bn|mn)\b/gi,
  )) {
    raw.add(Number(match[1]) * scales[match[2]!.toLowerCase()]!);
  }
  const traced = (token: string) => {
    const scaleWord = /(thousand|million|billion|trillion|bn|mn)\b/i
      .exec(token)?.[1]
      ?.toLowerCase();
    const scale = scaleWord ? scales[scaleWord]! : null;
    const digits = token.replace(/[^\d.]/g, "");
    const value = Number(digits);
    const decimals = digits.split(".")[1]?.length ?? 0;
    // A round figure such as 58,000 for 58,322 matches at its own precision.
    const significant = decimals ? 0 : digits.replace(/0+$/, "").length || 1;
    // Explicit units compare with input values in that unit, never with every scaled alias.
    const candidates =
      scale === null ? [...known] : [...raw].map((n) => n / scale);
    return candidates.some(
      (n) =>
        Number(n.toFixed(decimals)) === value ||
        (significant > 0 &&
          value >= 100 &&
          Number(n.toPrecision(significant)) === value),
    );
  };
  const text = [
    brief.summary,
    ...brief.needs_attention.map((n) => n.why),
    ...brief.portfolio_observations,
    ...brief.suggested_actions.map((a) => a.reasoning),
  ].join("\n");
  return [
    ...new Set(
      text.match(
        /[$€£¥]\d[\d,]*(?:\.\d+)?(?:\s*(?:thousand|million|billion|trillion|bn|mn)\b)?|\d[\d,]*(?:\.\d+)?\s*(?:thousand|million|billion|trillion|bn|mn)\b|\d[\d,]*(?:\.\d+)?%|(?<![\d.,])\d+\.\d+/gi,
      ) ?? [],
    ),
  ].filter((token) => !traced(token));
}

// The summary is model text shaped by web pages and filings, so it is never built into a command.
// Each notifier reads it from an environment variable or takes it as a plain argument.
function notify(message: string) {
  const text = message.slice(0, 200);
  const commands: Partial<Record<NodeJS.Platform, [string, string[]]>> = {
    darwin: [
      "osascript",
      [
        "-e",
        'display notification (system attribute "PORTCHECKER_NOTICE") with title "Portchecker"',
      ],
    ],
    linux: ["notify-send", ["--", "Portchecker", text]],
    win32: [
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(8000, 'Portchecker', $env:PORTCHECKER_NOTICE, 'Info'); Start-Sleep 9; $n.Dispose()",
      ],
    ],
  };
  const command = commands[process.platform];
  if (!command) return;
  const child = spawn(command[0], command[1], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, PORTCHECKER_NOTICE: text },
  });
  child.on("error", () => undefined); // A missing notifier should not matter.
  child.unref();
}

export function writeBriefFile(date: string, markdown: string) {
  mkdirSync(path.join("data", "briefs"), { recursive: true });
  writeFileSync(path.join("data", "briefs", `${date}.md`), markdown);
}

/** Every model call in a run goes through this, so spend totals and fallback notes cannot be skipped. */
type ModelCaller = <S extends ZodType>(
  step: string,
  opts: RunModelOptions<S>,
) => ReturnType<typeof runModel<S>>;

/**
 * A pass with nothing to show has usually failed to read its files. Saving it would replace the
 * last real review with an empty one, so it counts as a failed ticker. A quiet light review may
 * legitimately cite nothing, but not one that drops an earlier call: that is a change, and it
 * would go on to be checked against nothing and shown as agreed.
 */
export function unusablePass(
  depth: string,
  result: Pick<AnalystResult, "evidence" | "status" | "action">,
  verification?: Pick<VerifierResult, "checks">,
  previousAction: string | null = null,
) {
  // The same test that sends a review to the second check.
  const claimsSomething = needsVerification(depth, result, previousAction);
  if (!result.evidence.length && claimsSomething) {
    return "The analyst returned no evidence, which usually means it could not read the pack files.";
  }
  if (verification && result.evidence.length && !verification.checks.length) {
    return "The second pass returned no checks, which usually means it could not read the pack files.";
  }
  return null;
}

function stopIfUnusable(...pass: Parameters<typeof unusablePass>) {
  const problem = unusablePass(...pass);
  if (problem) throw new Error(problem);
}

/** Results day, which a new filing or a just-filled earnings row shows after next_earnings moves on. */
export function resultsDateFor(
  newFilings: Pick<Filing, "form" | "items" | "filedAt">[],
  earnings: Row[],
  date: string,
) {
  const filing = newFilings.find(
    (f) =>
      f.form.startsWith("8-K") &&
      (f.items ?? "").split(",").some((item) => item.trim() === "2.02"),
  );
  if (filing) return filing.filedAt;
  const reported = earnings.find(
    (e) =>
      num(e.epsActual) !== null &&
      String(e.date) <= date &&
      Date.parse(date) - Date.parse(String(e.date)) <=
        RECENT_RESULTS_DAYS * 86_400_000,
  );
  return reported ? String(reported.date) : null;
}

/** Runs the daily job. Pass tickers to review only those: the rest still count in portfolio facts. */
export async function runResearch(only: string[] = []): Promise<boolean> {
  const settings = await getSettings();
  const date = today();
  const startedAt = new Date().toISOString();

  const run = await claimRun(settings.provider_mode, startedAt);
  if (!run) {
    console.error(
      "Another research run is in progress, so this one did not start.",
    );
    return false;
  }
  // Ends with the process, so a run that dies stops checking in and frees the button.
  setInterval(() => {
    void db
      .update(researchRuns)
      .set({ heartbeatAt: new Date().toISOString() })
      .where(eq(researchRuns.id, run.id))
      .catch(() => undefined);
  }, HEARTBEAT_MS).unref();
  const stop = watchForStop(run.id);
  const stopped = new Promise<void>((resolve) =>
    stop.addEventListener("abort", () => resolve(), { once: true }),
  );

  // Fail fast, with a message the dashboard can show.
  const problems = await setupProblems(settings);
  if (!env.FMP_API_KEY) problems.push("Add FMP_API_KEY to .env.");
  if (!env.SEC_USER_AGENT) problems.push("Add SEC_USER_AGENT to .env.");
  if (problems.length) {
    const message = problems.join(" ");
    await db
      .update(researchRuns)
      .set({
        finishedAt: startedAt,
        status: "failed_setup",
        logText: message,
      })
      .where(eq(researchRuns.id, run.id));
    console.error(message);
    notify(`Research run could not start: ${message}`);
    return false;
  }

  const runId = run.id;
  const runFolder = packDir(date);

  let logText = "";
  const record = async (line: string) => {
    logText += `${new Date().toLocaleTimeString("en-US", { hour12: false })} ${line}\n`;
    console.log(line);
    await db
      .update(researchRuns)
      .set({ logText })
      .where(eq(researchRuns.id, runId));
  };
  // After a stop, a review whose call was ended still reports that step as failed and names the
  // next one. Neither happened, so the log ends with what was true before the stop and its last line.
  const log = async (line: string) => {
    if (!stop.aborted) await record(line);
  };

  const usage: Usage = { inputTokens: 0, outputTokens: 0, webSearches: 0 };
  const callModel: ModelCaller = async (step, opts) => {
    const r = await runModel({
      ...opts,
      signal: stop,
      onUsage: (delta) => {
        addUsage(usage, delta);
      },
    });
    if (r.usedFallback) {
      await log(
        `FALLBACK on ${step}: used ${providerLabel(r.provider)}. The first provider failed: ${r.fallbackReason ?? "unknown error"}`,
      );
    }
    return r;
  };

  let reviewed = 0;
  try {
    mkdirSync(runFolder, { recursive: true });
    await log(`Run ${runId} started in ${modeLabel(settings)} mode.`);

    const allRows = await db.select().from(holdingsTable);
    const names = new Map<string, string>();
    for (const row of allRows) names.set(row.ticker, row.name);
    const stockTickers = [...names.keys()].filter((t) => t !== "CASH").sort();
    await log(`${stockTickers.length} tickers to review.`);
    const notHeld = only.filter((t) => !names.has(t));
    const heldCash = only.includes("CASH") && names.has("CASH");
    if (only.length && !only.some((t) => stockTickers.includes(t))) {
      throw new Error(
        heldCash
          ? "Nothing to review: CASH is cash, so it is not reviewed."
          : `Nothing to review: ${notHeld.join(", ")} not in your holdings.`,
      );
    }
    if (heldCash) await log("CASH is cash, so it is not reviewed.");
    if (notHeld.length) {
      await log(
        `Not in your holdings, so not reviewed: ${notHeld.join(", ")}.`,
      );
    }

    const market = await fetchMarketContext().catch(async (error) => {
      await log(
        `Market data unavailable, so moves cannot be compared with the S&P 500. ${errorMessage(error)}`,
      );
      return null;
    });

    const failed: { ticker: string; reason: string }[] = [];
    const fundSectors = new Map<string, Row[]>();
    const earnings = new Map<string, Row[]>();
    const fmpByTicker = new Map<string, FmpData>();
    const sectors = new Map<string, string | null>();
    const quotes = new Map<string, Record<string, unknown>>();

    // Fetch market data first: the analyst prompt needs each position's portfolio weight.
    for (const ticker of stockTickers) {
      stop.throwIfAborted();
      try {
        const row = await ensureTicker(ticker, names.get(ticker) ?? ticker);
        sectors.set(ticker, row.sector);
        const fmp = await fetchFmpData(ticker);
        // No price at all means a wrong or delisted symbol, so a review would only waste model calls.
        if (!fmp.quote) {
          const reason =
            "No market data for this symbol. Check it under Holdings.";
          failed.push({ ticker, reason });
          await log(`${ticker}: ${reason}`);
          continue;
        }
        quotes.set(ticker, fmp.quote);
        if (fmp.isFund) fundSectors.set(ticker, fmp.fundSectors);
        if (fmp.earnings.length) earnings.set(ticker, fmp.earnings);
        if (!row.cik && row.secLookupError && !fmp.isFund) {
          const reason = `Setup failed: ${row.secLookupError}`;
          failed.push({ ticker, reason });
          await log(`${ticker}: ${reason}`);
          continue;
        }
        fmpByTicker.set(ticker, fmp);
      } catch (error) {
        const reason =
          error instanceof FmpRateLimitError
            ? `Skipped: ${error.message}`
            : `Setup failed: ${errorMessage(error)}`;
        failed.push({ ticker, reason });
        await log(`${ticker}: ${reason}`);
      }
    }
    // Only once this run has prices: with none, old quotes are all the portfolio can show.
    if (quotes.size) await pruneFmpCache();
    const facts: PortfolioFacts = computePortfolioFacts(
      allRows,
      quotes,
      sectors,
      date,
      fundSectors,
      earnings,
    );

    const extraNotes = facts.missing_prices.length
      ? [
          `Portfolio totals and weights leave out ${facts.missing_prices.join(", ")}, which had no price in this run, so the weights here read too high.`,
        ]
      : [];

    // A row at zero shares is not a position, so a review would only spend model calls on it. Its
    // quote was still fetched, so it does not read as missing a price.
    for (const { ticker, quantity } of facts.positions) {
      if (quantity !== 0 || !fmpByTicker.has(ticker)) continue;
      fmpByTicker.delete(ticker);
      const reason =
        "Skipped: this row has zero shares. Delete it under Holdings if you no longer own it.";
      failed.push({ ticker, reason });
      await log(`${ticker}: ${reason}`);
    }

    const outcomes: TickerOutcome[] = [];
    const queue = stockTickers.filter(
      (t) => fmpByTicker.has(t) && (!only.length || only.includes(t)),
    );
    if (only.length && queue.length) {
      await log(`Reviewing only: ${queue.join(", ")}.`);
    }
    const reviewNext = async (ticker: string) => {
      const fmp = fmpByTicker.get(ticker);
      if (!fmp) return;
      try {
        outcomes.push(
          await reviewTicker({
            runId,
            ticker,
            date,
            fmp,
            market,
            facts,
            extraNotes,
            log,
            callModel,
          }),
        );
        reviewed = outcomes.length;
      } catch (error) {
        // Its model call was ended on purpose, so this is not a failure to report.
        if (stop.aborted) return;
        const reason = errorMessage(error);
        failed.push({ ticker, reason });
        await log(`${ticker}: FAILED. ${reason}`);
      } finally {
        await db
          .update(researchRuns)
          .set({ usageJson: JSON.stringify(usage) })
          .where(eq(researchRuns.id, runId));
      }
    };
    // A few at a time: one review waits minutes on models, so this mostly saves idle time.
    const reviews = Promise.all(
      Array.from({ length: REVIEW_CONCURRENCY }, async () => {
        for (let t = queue.shift(); t && !stop.aborted; t = queue.shift())
          await reviewNext(t);
      }),
    );
    await Promise.race([reviews, stopped]);
    if (stop.aborted) {
      // The reviews whose calls were just ended finish at once. Wait briefly for any that is saving.
      await Promise.race([
        reviews,
        new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS)),
      ]);
      stop.throwIfAborted();
    }
    outcomes.sort((a, b) => a.ticker.localeCompare(b.ticker));

    // With nothing reviewed, a brief would only spend a model call saying so.
    if (!outcomes.length) {
      // A subset run fetches every holding, so name a failure on what was asked for.
      const first = failed.find((f) => only.includes(f.ticker)) ?? failed[0];
      throw new Error(
        first
          ? `No holding could be reviewed. ${first.ticker}: ${first.reason}`
          : "No holding could be reviewed.",
      );
    }

    // A brief of only some holdings would replace the day's full brief and drop its other calls, so
    // these reviews appear on Today beside the existing brief instead.
    if (only.length) {
      await log(
        `Finished. ${outcomes.length} reviewed, ${failed.length} failed or skipped. Kept the existing brief, since this run covered only some holdings.`,
      );
      await db
        .update(researchRuns)
        .set({
          status: "finished",
          finishedAt: new Date().toISOString(),
          usageJson: JSON.stringify(usage),
        })
        .where(eq(researchRuns.id, runId));
      return true;
    }

    writeFileSync(
      path.join(runFolder, "portfolio_facts.json"),
      JSON.stringify({ ...facts, market_context: market }, null, 2),
    );
    writeFileSync(
      path.join(runFolder, "ticker_results.json"),
      JSON.stringify(
        {
          results: outcomes.map((o) => ({
            ticker: o.ticker,
            review_depth: o.depth,
            verification_sources: verificationSources(o.verification),
            previous_action: o.previousAction ?? null,
            result: o.result,
            verification: o.verification && {
              verified_score: o.verifiedScore,
              contradicted_checks: o.verification.checks.filter(
                (c) => c.verdict === "contradicted",
              ).length,
              unverified_checks: o.verification.checks.filter(
                (c) => c.verdict === "unverified",
              ).length,
              conclusion_supported: o.verification.conclusion_supported,
              concerns: o.verification.concerns,
              independent_action: o.verification.independent_action,
              independent_reason: o.verification.independent_reason,
            },
            revised_after_review: o.revisedAfterReview,
          })),
          failed,
        },
        null,
        2,
      ),
    );

    await log("Writing the brief.");
    const briefRun = await callModel("brief", {
      role: "brief",
      workingDirectory: runFolder,
      prompt: BRIEF_PROMPT,
      schema: briefSchema,
    });

    // Decisions are reader context only and must never enter a model's files or prompt.
    const decisionRows = await db
      .select({
        ticker: decisions.ticker,
        date: decisions.date,
        actionTaken: decisions.actionTaken,
      })
      .from(decisions)
      .orderBy(desc(decisions.date), desc(decisions.id));
    const lastDecisions = new Map<
      string,
      { date: string; actionTaken: string }
    >();
    for (const decision of decisionRows)
      if (!lastDecisions.has(decision.ticker))
        lastDecisions.set(decision.ticker, decision);

    const brief = withCodeScores(
      briefRun.data,
      outcomes,
      date,
      new Set(stockTickers),
      lastDecisions,
    );
    const untraced = untracedFigures(
      brief,
      ["portfolio_facts.json", "ticker_results.json"]
        .map((name) => readFileSync(path.join(runFolder, name), "utf8"))
        .join("\n"),
    );
    if (untraced.length)
      await log(
        `Brief figures not found in its inputs: ${untraced.join(", ")}.`,
      );
    const briefLabel = `${providerLabel(briefRun.provider)} (${briefRun.model})${briefRun.usedFallback ? ", fallback used" : ""}`;
    const markdown = renderBriefMarkdown({
      brief,
      outcomes,
      failed,
      briefLabel,
      providerMode: settings.provider_mode,
      quoteDates: facts.quote_dates,
      weights: new Map(facts.positions.map((p) => [p.ticker, p.weight_pct])),
      facts,
      untracedFigures: untraced,
    });

    const [briefRow] = await db
      .insert(briefs)
      .values({
        runId,
        date,
        provider: briefRun.provider,
        model: briefRun.model,
        resultJson: JSON.stringify({
          ...brief,
          failed,
          used_fallback: briefRun.usedFallback,
          untraced_figures: untraced,
        }),
        markdown,
      })
      .returning();
    writeBriefFile(date, markdown);
    console.log(`\n${brief.summary}\n`);
    const attention = [
      ...new Set([
        ...brief.needs_attention.map((n) => n.ticker),
        ...brief.suggested_actions
          .filter((a) => a.action !== "hold")
          .map((a) => a.ticker),
      ]),
    ];
    if (attention.length)
      notify(`Needs attention: ${attention.join(", ")}. ${brief.summary}`);

    await log(
      `Finished. ${outcomes.length} reviewed, ${failed.length} failed or skipped.`,
    );
    await db
      .update(researchRuns)
      .set({
        status: "finished",
        finishedAt: new Date().toISOString(),
        usageJson: JSON.stringify(usage),
        briefId: briefRow?.id,
      })
      .where(eq(researchRuns.id, runId));
    return true;
  } catch (error) {
    if (stop.aborted) {
      // Whoever stopped the run has already marked it stopped. This adds what was kept.
      const saved = reviewed
        ? `${reviewed} ${reviewed === 1 ? "review" : "reviews"} finished before the stop and ${reviewed === 1 ? "is" : "are"} saved.`
        : "No review had finished, so nothing new was saved.";
      await record(`Stopped at your request. ${saved} No brief was written.`);
      await db
        .update(researchRuns)
        .set({ usageJson: JSON.stringify(usage) })
        .where(eq(researchRuns.id, runId));
      return true;
    }
    const message = reviewed
      ? `The brief was not written, but ${reviewed} ${reviewed === 1 ? "review was" : "reviews were"} saved. ${errorMessage(error)}`
      : errorMessage(error);
    notify(`Research run failed: ${message}`);
    await log(`Run failed: ${message}`);
    await db
      .update(researchRuns)
      .set({
        status: "failed",
        finishedAt: new Date().toISOString(),
        usageJson: JSON.stringify(usage),
      })
      .where(eq(researchRuns.id, runId));
    return false;
  }
}

async function reviewTicker(opts: {
  runId: number;
  ticker: string;
  date: string;
  fmp: FmpData;
  market: Awaited<ReturnType<typeof fetchMarketContext>> | null;
  facts: PortfolioFacts;
  extraNotes: string[];
  log: (line: string) => Promise<void>;
  callModel: ModelCaller;
}): Promise<TickerOutcome> {
  const {
    runId,
    ticker,
    date,
    fmp,
    market,
    facts,
    extraNotes,
    log,
    callModel,
  } = opts;
  let usedFallback = false;
  const call: ModelCaller = async (step, options) => {
    const r = await callModel(`${ticker} ${step}`, options);
    usedFallback ||= r.usedFallback;
    return r;
  };
  const [row] = await db
    .select()
    .from(tickers)
    .where(eq(tickers.ticker, ticker));
  const requestName = `review_request:${ticker}`;
  const [request] = await db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.key, requestName));
  const requestGeneration = request?.value ?? "";
  const sameRequest = sql`coalesce((SELECT value FROM settings WHERE key = ${requestName}), '') = ${requestGeneration}`;

  let newFilings: Filing[] = [];
  if (row?.cik) {
    newFilings = await syncFilings(ticker, row.cik, row.lastFullReviewAt);
    if (newFilings.length) {
      await log(
        `${ticker}: new filings: ${newFilings.map((f) => `${f.form} ${f.filedAt}`).join(", ")}`,
      );
    }
  } else {
    await log(`${ticker}: not in SEC's company list, so no filings to check.`);
  }

  const history = await tickerHistory(ticker);
  const lastFull = row?.lastFullReviewAt ?? null;
  // The review that set the clock. A rejected one did not, so its quote does not count as seen.
  const clockReview =
    lastFull === null
      ? undefined
      : history.find((v) => v.depth === "FULL" && v.createdAt <= lastFull);
  const { depth, why } = reviewDepth(
    fmp,
    newFilings,
    lastFull,
    clockReview?.quotePricedAt ?? null,
    clockReview?.result.quote_price ?? null,
  );
  await log(`${ticker}: ${depth} review (${why}).`);

  const position = facts.positions.find((p) => p.ticker === ticker);
  const previous = currentReview(history);
  const previousAction = previous?.result.action ?? null;

  const { dir, written, unread } = await writePack({
    runId,
    ticker,
    date,
    fmp,
    market,
    position: packPosition(facts, ticker),
    includeFilings: depth === "FULL",
    newFilings,
    extraNotes: facts.quote_dates.stale.includes(ticker)
      ? [
          ...extraNotes,
          `This quote is dated ${position?.quote_date}, older than the rest of the portfolio or more than 4 days old, so its price, position value and day move describe that date, not today.`,
        ]
      : extraNotes,
    previousReview: previous && {
      run_id: previous.runId,
      date: new Date(previous.createdAt).toLocaleDateString("en-CA"),
      depth: previous.depth,
      status: previous.result.status,
      action: previous.result.action,
      headline: previous.result.headline,
      reasoning: previous.result.reasoning,
      verified_score: previous.verifiedScore,
      conclusion_supported: previous.verification?.conclusion_supported ?? null,
      second_pass_action: previous.verification?.independent_action ?? null,
    },
  });
  await log(`${ticker}: pack has ${written.length} files.`);
  if (unread.size) {
    await log(
      `${ticker}: could not read ${[...unread].join(", ")}. Will retry next run.`,
    );
  }

  // Recent web findings go into a file that the analyst and verifier both read. Best effort:
  // the review still runs on FMP and EDGAR data if this fails.
  if (depth === "FULL") {
    try {
      await log(`${ticker}: searching the web for recent developments.`);
      const company = fmp.profile?.companyName;
      const next = nextEarnings(fmp.earnings, date);
      const spy = market?.sp500_proxy_spy;
      const moveDate = quoteDate(fmp.quote ?? undefined);
      // The run log records a fallback here. The review's own label is about who analyzed and checked.
      const search = await callModel(`${ticker} web research`, {
        role: "research",
        workingDirectory: dir,
        prompt: webResearchPrompt({
          ticker,
          name: typeof company === "string" ? company : ticker,
          date,
          movePct: num(fmp.quote?.changePercentage),
          moveDate,
          // A market move from another trading day says nothing about this one.
          marketMovePct:
            spy && (!moveDate || spy.latest_date === moveDate)
              ? spy.return_1d_pct
              : null,
          nextEarningsDate: next ? String(next.date) : null,
          resultsDate: resultsDateFor(newFilings, fmp.earnings, date),
        }),
        schema: webResearchSchema,
        webSearch: true,
      });
      const { markdown, kept } = renderWebResearch(search.data, date);
      writeFileSync(path.join(dir, "web_research.md"), markdown);
      await log(`${ticker}: ${kept} web findings.`);
    } catch (error) {
      await log(
        `${ticker}: web research failed, continuing without it. ${errorMessage(error)}`,
      );
      // Otherwise this pack reads the same as one where no search was due.
      writeFileSync(
        path.join(dir, "web_research.md"),
        `# Web research on ${date}\n\nThe web search failed, so recent news was not checked. Nothing here says whether anything happened.\n`,
      );
    }
  }

  // From the pack's copy, so the prompt and dossier.md agree if I save a thesis during this review.
  const packDossier = readFileSync(path.join(dir, "dossier.md"), "utf8");
  const thesis = thesisText(packDossier);
  const hasThesis = thesis !== null;
  const basePrompt = analystPrompt({
    depth,
    date,
    quantity: position?.quantity ?? 0,
    weightPct: position?.weight_pct ?? null,
    hasThesis,
  });

  await log(`${ticker}: analyzing.`);
  // Bind identity at the model boundary so schema retries also cover a different holding.
  const holdingAnalystSchema = analystSchema.extend({
    ticker: z.literal(ticker),
  });
  const holdingVerifierSchema = verifierSchema.extend({
    ticker: z.literal(ticker),
  });
  let analyst = await call("analyst", {
    role: "analyst",
    workingDirectory: dir,
    prompt: basePrompt,
    schema: holdingAnalystSchema,
  });
  let result = analyst.data;
  stopIfUnusable(depth, result, undefined, previousAction);

  // Verify, and revise once if the reviewer found problems.
  let revised = false;
  let firstPass: FirstPass | null = null;

  const verify = () => {
    writeFileSync(
      path.join(dir, "review.json"),
      JSON.stringify(result, null, 2),
    );
    return call("verifier", {
      role: "verifier",
      avoidProvider: analyst.provider,
      workingDirectory: dir,
      prompt: verifierPrompt(ticker, hasThesis, date),
      schema: holdingVerifierSchema,
    });
  };
  let verifier: Awaited<ReturnType<typeof verify>> | null = null;

  if (needsVerification(depth, result, previousAction)) {
    await log(`${ticker}: verifying.`);
    verifier = await verify();
    stopIfUnusable(depth, result, verifier.data, previousAction);
    const conditionIssues = fmp.isFund
      ? fundWeightConditionIssues(result, position?.weight_pct ?? null)
      : [];
    if (needsRevision(verifier.data) || conditionIssues.length) {
      const { checks, concerns } = verifier.data;
      const contradicted = checks.filter((c) => c.verdict === "contradicted");
      const notes = [
        ...contradicted.map((c) => `- Contradicted: ${c.claim} (${c.note})`),
        ...concerns.map((c) => `- ${c}`),
        ...conditionIssues.map((c) => `- Future condition: ${c}`),
      ].join("\n");
      firstPass = {
        concerns: [
          ...concerns,
          ...conditionIssues.map((c) => `Future condition: ${c}`),
        ],
        contradicted: contradicted.map((c) => ({
          claim: c.claim,
          note: c.note,
        })),
        action: result.action,
        conclusion_supported: verifier.data.conclusion_supported,
      };
      await log(
        `${ticker}: reviewer found problems, revising once. ${notes.slice(0, 400)}`,
      );
      analyst = await call("analyst revision", {
        role: "analyst",
        workingDirectory: dir,
        prompt: `${basePrompt}${reviewerFeedback(notes)}`,
        schema: holdingAnalystSchema,
      });
      result = analyst.data;
      // A revision answers a failed check, so it has to cite something whatever the depth: an
      // empty one is judged as a full review is.
      stopIfUnusable("FULL", result, undefined, previousAction);
      verifier = await verify();
      stopIfUnusable("FULL", result, verifier.data, previousAction);
      revised = true;
    }
  }

  const verification = verifier?.data ?? null;
  const conditionWarnings = fmp.isFund
    ? fundWeightConditionIssues(result, position?.weight_pct ?? null)
    : [];
  const score = verifiedScore(verification, result.evidence);
  await db.insert(tickerUpdates).values({
    runId,
    ticker,
    reviewDepth: depth,
    resultJson: JSON.stringify({
      ...result,
      evidence: markUnknownLinks(result.evidence, researchFilesText(dir)),
      is_fund: fmp.isFund,
      thesis_at_review: thesis,
      previous_action: previousAction,
      quote_priced_at: num(fmp.quote?.timestamp),
      quote_price: num(fmp.quote?.price),
      ...(conditionWarnings.length
        ? { condition_warnings: conditionWarnings }
        : {}),
    } satisfies StoredResult),
    verificationJson: verification
      ? JSON.stringify({ ...verification, first_pass: firstPass })
      : null,
    verifiedScore: score,
    analystProvider: analyst.provider,
    analystModel: analyst.model,
    verifierProvider: verifier?.provider ?? null,
    verifierModel: verifier?.model ?? null,
    usedFallback,
    revisedAfterReview: revised,
    createdAt: new Date().toISOString(),
  });

  // I changed the thesis or its break conditions while the models worked. Saving this view would
  // also clear the full review my save asked for.
  const dossierNow = readDossier(ticker);
  const thesisMoved =
    dossierNow !== null && reviewBasis(dossierNow) !== reviewBasis(packDossier);
  if (thesisMoved) {
    await log(
      `${ticker}: the thesis or its break conditions changed during this review, so its Current view was not saved and a full review stays due.`,
    );
  }

  // A rejected review marks the old view stale even when it offered no new one.
  const failedCheck = verification !== null && needsRevision(verification);
  if ((result.dossier_current_view || failedCheck) && !thesisMoved) {
    const dossier = dossierNow;
    if (!verification) {
      await log(
        `${ticker}: kept previous Current view: no final verification.`,
      );
    } else if (conditionWarnings.length) {
      await log(
        `${ticker}: kept previous Current view: a future allocation condition is already met or has no headroom.`,
      );
    } else if (
      dossier !== null &&
      !failedCheck &&
      result.dossier_current_view
    ) {
      saveDossier(
        ticker,
        replaceCurrentView(
          dossier,
          viewWithUnconfirmed(result.dossier_current_view, verification.checks),
        ),
      );
      await log(`${ticker}: updated ${dossierPath(ticker)}.`);
    } else if (dossier !== null) {
      saveDossier(ticker, markCurrentViewStale(dossier, date, result.action));
      await log(
        `${ticker}: kept previous Current view: final verification rejected the review.`,
      );
    }
  }

  // A conclusion the evidence does not support has not dealt with a new filing, so it stays pending
  // and the clock keeps running. Giving up after a few days keeps this from costing a review a day.
  const rejected = verification !== null && !verification.conclusion_supported;
  if (rejected) {
    await log(
      `${ticker}: the final check did not support this conclusion, so new filings stay pending.`,
    );
  }
  // A completed FULL review resets the 7-day clock even if the model returned no view.
  if (resetsReviewClock(depth, rejected, previous) && !thesisMoved) {
    await db
      .update(tickers)
      .set({ lastFullReviewAt: new Date().toISOString() })
      .where(and(eq(tickers.ticker, ticker), sameRequest));
  }
  const dealtWith = (f: Filing) =>
    f.form === "4" || (!rejected && !thesisMoved && !unread.has(f.accessionNo));
  const gaveUp: Filing[] = [];
  for (const f of newFilings) {
    if (!dealtWith(f) && (await gaveUpOnFiling(f, date))) gaveUp.push(f);
  }
  if (gaveUp.length) {
    await log(
      `${ticker}: stopped retrying ${gaveUp.map((f) => `${f.form} ${f.filedAt}`).join(", ")} after ${UNREADABLE_RETRY_DAYS} days.`,
    );
  }
  const processed = newFilings.filter(
    (f) => dealtWith(f) || gaveUp.includes(f),
  );
  if (processed.length)
    await db
      .update(filings)
      .set({ processedAt: new Date().toISOString() })
      .where(
        and(
          eq(filings.ticker, ticker),
          inArray(
            filings.accessionNo,
            processed.map((f) => f.accessionNo),
          ),
          sameRequest,
        ),
      );

  await log(
    `${ticker}: ${result.status}, ${result.action}, verified ${scoreLabel(score)}.`,
  );
  // A save may land during any of the awaits above, including after filings were marked done.
  const [finalRequest] = await db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.key, requestName));
  const finalDossier = readDossier(ticker);
  if (
    (finalRequest?.value ?? "") !== requestGeneration ||
    (finalDossier !== null &&
      reviewBasis(finalDossier) !== reviewBasis(packDossier))
  ) {
    await db.batch([
      db
        .update(tickers)
        .set({ lastFullReviewAt: null })
        .where(eq(tickers.ticker, ticker)),
      ...(newFilings.length
        ? [
            db
              .update(filings)
              .set({ processedAt: null })
              .where(
                and(
                  eq(filings.ticker, ticker),
                  inArray(
                    filings.accessionNo,
                    newFilings.map((f) => f.accessionNo),
                  ),
                ),
              ),
          ]
        : []),
    ]);
  }
  return {
    ticker,
    depth,
    result,
    verification,
    verifiedScore: score,
    analyst: { provider: analyst.provider, model: analyst.model },
    verifier: verifier && {
      provider: verifier.provider,
      model: verifier.model,
    },
    usedFallback,
    revisedAfterReview: revised,
    previousAction,
  };
}
