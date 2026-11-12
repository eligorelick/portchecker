import "./test-env.ts";
// Regressions found by auditing real runs: each test names what went wrong and what must hold.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
  dossierSection,
  markCurrentViewStale,
  replaceableSection,
  replaceCurrentView,
  replaceSection,
  thesisText,
  viewWithUnconfirmed,
} from "./dossier.ts";
import { parsePositionsCsv } from "./csv.ts";
import {
  fundamentalContext,
  nextEarnings,
  priceSummary,
  quoteTimeEt,
  relativeToMarket,
  type FmpData,
} from "./fmp.ts";
import { buildQueue, runProgress } from "./queue.ts";
import * as queueFunctions from "./queue.ts";
import * as runFunctions from "./research/run.ts";
import * as updateFunctions from "./updates.ts";
import {
  analystSchema,
  briefSchema,
  dossierTemplate,
  reviewerFeedback,
  verifierSchema,
} from "./research/prompts.ts";
import {
  buildResearchContext,
  keyNumbers,
  latestFullPackDir,
  replacePackFolder,
} from "./research/pack.ts";
import {
  needsVerification,
  renderBriefMarkdown,
  renderWebResearch,
  resetsReviewClock,
  resultsDateFor,
  reviewDepth,
  verifiedScore,
  withCodeScores,
} from "./research/run.ts";
import {
  evidenceEntries,
  openCalls,
  sameProviderFallback,
  verificationSources,
  type UpdateView,
} from "./updates.ts";

const fmp = (overrides: Partial<FmpData>) =>
  ({
    quote: null,
    history: [],
    income: [],
    balance: [],
    cashFlow: [],
    keyMetrics: [],
    ratios: [],
    estimates: [],
    earnings: [],
    dividends: [],
    news: [],
    isFund: false,
    ...overrides,
  }) as unknown as FmpData;

const evidence = (claim: string) => ({ claim, source: "file:x", date: "d" });

void test("a review nobody checked has no score, rather than a score of zero", () => {
  // An unverified light review has no score; zero would imply a failed check.
  assert.equal(verifiedScore(null, [evidence("one"), evidence("two")]), null);
  const verification = {
    checks: [{ claim: "one", verdict: "verified", source: "s", note: "n" }],
  } as Parameters<typeof verifiedScore>[0];
  assert.equal(verifiedScore(verification, [evidence("one")]), 1);
  assert.equal(
    verifiedScore(verification, [evidence("one"), evidence("two")]),
    0.5,
  );
});

void test("a high word overlap cannot verify a different approval qualification", () => {
  const claim = "The acquisition received final regulatory approval in Q3";
  const checked =
    "The acquisition received conditional regulatory approval in Q3";
  const verification = {
    checks: [
      {
        claim: checked,
        verdict: "verified" as const,
        source: "file:filing",
        note: "Only conditional approval was granted.",
      },
    ],
  };
  const entries = evidenceEntries({
    result: { evidence: [evidence(claim)] },
    verification,
  } as never);
  assert.equal(entries[0]?.check, null);
  assert.equal(entries[1]?.check?.claim, checked);
  assert.equal(verifiedScore(verification as never, [evidence(claim)]), 0.5);
});

void test("reworded legacy checks do not lend their verdicts to another claim", () => {
  const pair = (claim: string, checked: string) =>
    evidenceEntries({
      result: { evidence: [evidence(claim)] },
      verification: {
        checks: [
          { claim: checked, verdict: "verified", source: "s", note: "" },
        ],
      },
    } as unknown as Parameters<typeof evidenceEntries>[0])[0]?.check;
  // A historical paraphrase is still visible as a separate check. Its word overlap is not proof
  // that every qualification in the evidence was checked (final vs conditional approval).
  assert.equal(
    pair(
      "Benzinga attributes Microsoft's rally to investors rotating into mega-cap AI leaders even as political concerns raised questions about future data centers",
      "Benzinga attributes Microsoft's rally to investors rotating into mega-cap AI leaders even as political concerns raised questions about the planned data centers",
    ),
    null,
  );
  assert.equal(
    pair(
      "Revenue rose 12 percent to 40 billion on strong cloud demand this quarter",
      "Revenue rose 15 percent to 40 billion on strong cloud demand this quarter",
    ),
    null,
  );
  assert.equal(
    pair("Margins widened on pricing", "Debt fell after the refinancing"),
    null,
  );
});

void test("a move a full review already saw does not buy another one", (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-11-09T22:00:00Z"),
  });
  const closeSeconds = Date.parse("2026-11-04T21:00:00Z") / 1000;
  const days = [100, 99, 98, 97, 96, 88].map((price, i) => ({
    date: `2026-11-0${9 - i}`,
    price,
  }));
  const moved = (changePercentage: number, history = days) =>
    fmp({ quote: { changePercentage, timestamp: closeSeconds }, history });
  const filing = { form: "8-K" } as Parameters<typeof reviewDepth>[1][number];

  // Reusing the same cached quote must not trigger another paid full review.
  assert.equal(
    reviewDepth(moved(6), [], "2026-11-04T21:36:00Z").depth,
    "LIGHT",
  );
  // A new filing still wins.
  assert.equal(
    reviewDepth(moved(6), [filing], "2026-11-04T21:36:00Z").depth,
    "FULL",
  );
  // A review from before the close has not seen the move.
  assert.equal(reviewDepth(moved(6), [], "2026-11-04T14:00:00Z").depth, "FULL");
  // No time on the quote means it cannot be proved seen, so it stays a trigger.
  assert.equal(
    reviewDepth(
      fmp({ quote: { changePercentage: 6 }, history: days }),
      [],
      "2026-11-04T21:36:00Z",
    ).depth,
    "FULL",
  );
  assert.equal(reviewDepth(moved(6), [], null).depth, "FULL");

  // 5-day return of 13.6%, on a newer quote. Reviewed yesterday, little has moved since: no review.
  const later = fmp({
    quote: {
      changePercentage: 1,
      timestamp: Date.parse("2026-11-09T21:00:00Z") / 1000,
    },
    history: days,
  });
  assert.equal(reviewDepth(later, [], "2026-11-08T16:00:00Z").depth, "LIGHT");
  // Reviewed before it moved: another look.
  assert.equal(
    reviewDepth(later, [], new Date(2026, 10, 4, 12).toISOString()).depth,
    "FULL",
  );
});

// Counted back from now, since a review over 7 days old is due whatever the quote says.
const hoursInto = (daysAgo: number, hour: number) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 5, 0, 0);
  return d;
};
const inSeconds = (d: Date) => d.getTime() / 1000;

void test("a full review on an older cached quote has not seen the next quote's move", () => {
  const pricedAt = inSeconds(hoursInto(1, 16));
  const drop = fmp({
    quote: { changePercentage: -8, timestamp: pricedAt },
    history: [],
  });
  // An evening run after this quote was priced, reading the quote cached that morning.
  const evening = hoursInto(1, 20).toISOString();
  assert.deepEqual(
    reviewDepth(drop, [], evening, inSeconds(hoursInto(2, 16))),
    { depth: "FULL", why: "day move of 8.0%" },
  );
  // The same quote already read supplies no new price information.
  assert.equal(reviewDepth(drop, [], evening, pricedAt).depth, "LIGHT");
  // Reviews saved before the quote time was recorded keep going by when they ran.
  assert.equal(reviewDepth(drop, [], evening).depth, "LIGHT");
  assert.equal(
    reviewDepth(drop, [], hoursInto(1, 7).toISOString()).depth,
    "FULL",
  );
});

void test("the move since a full review starts from the close that review read", () => {
  // Two moves of about 4.9%, so the day's move stays quiet and only the 5-day trigger can fire.
  const closes = [110.04, 104.9, 100, 100, 100, 100].map((price, i) => ({
    date: hoursInto(i, 12).toLocaleDateString("en-CA"),
    price,
  }));
  const rising = fmp({
    quote: { changePercentage: 4.9, timestamp: inSeconds(hoursInto(0, 16)) },
    history: closes,
  });
  const morning = hoursInto(1, 7).toISOString();
  const evening = hoursInto(1, 20).toISOString();
  // Before that day's open it read the close before, so the whole 10.04% is new to it.
  assert.deepEqual(
    reviewDepth(rising, [], morning, inSeconds(hoursInto(2, 16))),
    { depth: "FULL", why: "5-day move of 10.0%" },
  );
  // That evening it read the day's close, and only 4.9% has happened since.
  assert.equal(
    reviewDepth(rising, [], evening, inSeconds(hoursInto(1, 16))).depth,
    "LIGHT",
  );
  // With no saved quote time, the old rule stands.
  assert.equal(reviewDepth(rising, [], morning).depth, "LIGHT");
});

void test("the brief says what date its prices are from and names older quotes", () => {
  const opts = {
    brief: {
      date: "2026-11-05",
      summary: "Quiet day.",
      needs_attention: [],
      portfolio_observations: [],
      suggested_actions: [],
      nothing_to_do: true,
    },
    outcomes: [],
    failed: [],
    briefLabel: "stub",
  };
  const plain = renderBriefMarkdown(opts);
  assert.doesNotMatch(plain, /Prices as of/);
  const dated = renderBriefMarkdown({
    ...opts,
    quoteDates: { newest: "2026-11-04", stale: [] },
  });
  assert.equal(dated.split("\n")[2], "Prices as of 2026-11-04.");
  assert.equal(dated.replace("Prices as of 2026-11-04.\n\n", ""), plain);
  assert.equal(
    renderBriefMarkdown({
      ...opts,
      quoteDates: { newest: "2026-11-04", stale: ["AAA", "BBB"] },
    }).split("\n")[2],
    "Prices as of 2026-11-04. Older or stale quotes: AAA, BBB.",
  );
  // With no dated quote there is nothing true to say.
  assert.equal(
    renderBriefMarkdown({ ...opts, quoteDates: { newest: null, stale: [] } }),
    plain,
  );
});

void test("a light review that changes the call gets checked", () => {
  const hold = { status: "no_change", action: "hold" } as Parameters<
    typeof needsVerification
  >[1];
  assert.equal(needsVerification("LIGHT", hold, null), false);
  assert.equal(needsVerification("LIGHT", hold, "hold"), false);
  // A call must not flip without a second pass checking the change.
  assert.equal(needsVerification("LIGHT", hold, "add"), true);
  assert.equal(needsVerification("FULL", hold, "hold"), true);
});

void test("the brief cannot drop, invent or relabel a call", () => {
  const outcome = (ticker: string, action: string, independent = action) =>
    ({
      ticker,
      verifiedScore: 0.9,
      result: {
        action,
        reasoning: `${ticker} reason`,
        would_change_my_mind: [],
      },
      verification: { independent_action: independent },
    }) as unknown as Parameters<typeof withCodeScores>[1][number];
  const row = (ticker: string, action: string) => ({
    ticker,
    action: action as "hold",
    size_hint: "small",
    reasoning: "brief words",
    urgency: "today" as const,
    verified_score: 0.1,
    models_agree: false,
  });
  const brief = withCodeScores(
    {
      date: "wrong",
      summary: "s",
      portfolio_observations: [],
      nothing_to_do: false,
      needs_attention: [
        { ticker: "AAA", why: "w" },
        { ticker: "GONE", why: "not held" },
      ],
      suggested_actions: [
        row("AAA", "sell"),
        row("BBB", "review"),
        row("GONE", "add"),
      ],
    },
    [
      outcome("AAA", "trim"),
      outcome("BBB", "hold", "add"),
      outcome("CCC", "sell"),
    ],
    "2026-11-04",
    new Set(["AAA", "BBB", "CCC"]),
  );
  assert.equal(brief.date, "2026-11-04");
  assert.deepEqual(
    brief.needs_attention.map((n) => n.ticker),
    ["AAA"],
  );
  const by = new Map(brief.suggested_actions.map((a) => [a.ticker, a]));
  assert.equal(by.has("GONE"), false);
  // The model may not turn a trim into a sell, but it may ask for a review on a disagreement.
  assert.equal(by.get("AAA")?.action, "trim");
  assert.equal(by.get("AAA")?.verified_score, 0.9);
  assert.equal(by.get("BBB")?.action, "review");
  assert.equal(by.get("BBB")?.models_agree, false);
  // A sell the model left out is added back from the review.
  assert.equal(by.get("CCC")?.action, "sell");
  assert.equal(by.get("CCC")?.reasoning, "CCC reason");
  assert.equal(by.get("CCC")?.size_hint, "");
});

void test("filtered web findings do not read as no news", () => {
  const finding = (date: string, url = "https://example.com/a") => ({
    claim: "c",
    url,
    publisher: "p",
    date,
    why_it_matters: "w",
  });
  const none = renderWebResearch({ findings: [] }, "2026-11-04");
  assert.match(none.markdown, /No material developments found/);
  const dropped = renderWebResearch(
    {
      findings: [
        finding("2020-01-01"),
        finding("not a date"),
        finding("2026-11-03", "ftp://bad"),
      ],
    },
    "2026-11-04",
  );
  assert.equal(dropped.kept, 0);
  assert.doesNotMatch(dropped.markdown, /No material developments/);
  assert.match(dropped.markdown, /3 findings .*left out/);
  const future = renderWebResearch(
    { findings: [finding("2027-06-01"), finding("2026-11-03")] },
    "2026-11-04",
  );
  assert.equal(future.kept, 1);
  assert.match(future.markdown, /1 finding .*left out/);
});

void test("results day is named even after next_earnings moves on", () => {
  const filing = (items: string, filedAt = "2026-11-04") =>
    ({ form: "8-K", items, filedAt }) as Parameters<
      typeof resultsDateFor
    >[0][0];
  assert.equal(
    resultsDateFor([filing("2.02,9.01")], [], "2026-11-04"),
    "2026-11-04",
  );
  assert.equal(
    resultsDateFor([], [{ date: "2026-11-03", epsActual: 2 }], "2026-11-04"),
    "2026-11-03",
  );
  assert.equal(resultsDateFor([filing("5.02")], [], "2026-11-04"), null);
  assert.equal(
    resultsDateFor([], [{ date: "2026-08-03", epsActual: 2 }], "2026-11-04"),
    null,
  );
  assert.equal(
    resultsDateFor([], [{ date: "2026-11-05", epsActual: null }], "2026-11-04"),
    null,
  );
});

void test("market comparisons use the same trading day", () => {
  const history = [101, 100].map((price, i) => ({
    date: `2026-11-0${4 - i}`,
    price,
  }));
  const aligned = relativeToMarket(
    fmp({ quote: { changePercentage: 5, quote_date: "2026-11-04" }, history }),
    {
      latest_date: "2026-11-04",
      start_1d_date: "2026-11-03",
      return_1d_pct: 2,
    },
  );
  assert.equal(aligned?.today_points, 3);
  // An intraday quote against SPY's previous close would mix two days.
  const intraday = relativeToMarket(
    fmp({
      quote: { changePercentage: 5, quote_date: "2026-11-05" },
      history,
    }),
    {
      latest_date: "2026-11-04",
      start_1d_date: "2026-11-03",
      return_1d_pct: 2,
    },
  );
  assert.equal(intraday?.today_points, 1 - 2);
  const noCommonDay = relativeToMarket(
    fmp({ quote: { changePercentage: 5, quote_date: "2026-11-05" }, history }),
    { latest_date: "2026-11-02", return_1d_pct: 2 },
  );
  assert.equal(noCommonDay?.today_points, null);
});

void test("quotes say when they were priced", () => {
  const seconds = Date.parse("2026-11-04T21:00:00Z") / 1000;
  assert.match(
    quoteTimeEt({ timestamp: seconds }) ?? "",
    /Nov 4, 2026.*4:00.*ET/,
  );
  assert.equal(quoteTimeEt({}), null);
});

void test("valuation labels and history say what they are", () => {
  const context = fundamentalContext(
    fmp({
      quote: { price: 100 },
      estimates: [
        { date: "2027-12-31", epsAvg: 6, revenueAvg: 120 },
        { date: "2026-12-31", epsAvg: 5, revenueAvg: 100 },
      ],
      // AMZN's median was 1.43% with two negative years dropped, against 0.31% on all five.
      keyMetrics: [
        { freeCashFlowYield: 0.03 },
        { freeCashFlowYield: -0.02 },
        { freeCashFlowYield: 0.01 },
        { freeCashFlowYield: -0.01 },
        { freeCashFlowYield: 0.02 },
      ],
      income: [
        { reportedCurrency: "USD", epsDiluted: 1, date: "2026-09-30" },
        { reportedCurrency: "USD", epsDiluted: 1, date: "2026-06-30" },
        { reportedCurrency: "USD", epsDiluted: 1, date: "2026-03-31" },
        { reportedCurrency: "USD", epsDiluted: 1, date: "2025-12-31" },
      ],
      ratiosTtm: { priceToEarningsRatioTTM: 40 },
    }),
    "2026-11-04",
  );
  // EXPE and SSNC: "2027 growth" was marked contradicted because the label did not name the year.
  assert.equal(context?.valuation.next_year_fiscal_year_end, "2027-12-31");
  assert.ok(
    Math.abs(
      (context?.valuation.fcf_yield_median_last_5_fiscal_years_pct ?? 0) - 1,
    ) < 1e-9,
  );
  // QCOM: the vendor figure missed the quarter filed that day, and the note blamed one-offs.
  assert.match(context?.data_notes.join(" ") ?? "", /lag/);
});

void test("monthly payers can reach a total return", () => {
  const history = [100, 90].map((price, i) => ({
    date: i ? "2025-11-04" : "2026-11-04",
    price,
  }));
  const monthly = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 9 - i, 1)).toISOString().slice(0, 10);
    return { date: d, dividend: 1 };
  });
  assert.equal(priceSummary(history, monthly)?.total_return_1y_pct, 23.33);
  assert.equal(
    priceSummary(history, monthly.slice(0, 8))?.total_return_1y_pct,
    null,
  );
});

void test("dossier headings match whole titles, in any case", () => {
  const body = dossierTemplate("AAA", "A");
  // Reads ignored case and writes did not, so an accepted thesis was appended and then ignored.
  const lower = body.replace("## Thesis (owner: me)", "## thesis");
  const accepted = replaceSection(lower, "Thesis", "- Pricing power");
  assert.equal(thesisText(accepted), "- Pricing power");
  assert.equal(accepted.match(/^## thesis/gim)?.length, 1);
  const upper = body.replace(
    "## Current view (owner: model)",
    "## Current View",
  );
  assert.equal(
    dossierSection(replaceCurrentView(upper, "New"), "Current view"),
    "New",
  );

  // A note of my own whose heading starts like a section must not be overwritten.
  const own = body.replace(
    "## What would break",
    "## Current view on margins\n\nMy note.\n\n## What would break",
  );
  const updated = replaceCurrentView(own, "New view");
  assert.match(updated, /## Current view on margins\n\nMy note\./);
  assert.equal(dossierSection(updated, "Current view"), "New view");

  // A heading of my own inside the thesis does not make the thesis read as blank.
  const nested = body.replace(
    /Why I own it[^\n]*/,
    "Intro.\n\n## Why I bought\n\nCheap in 2024.",
  );
  assert.match(thesisText(nested) ?? "", /Cheap in 2024/);

  // Writes still stop at any heading, so my own section after Current view survives.
  const after = body.replace(
    "## Watch items",
    "## My notes\n\nKeep this.\n\n## Watch items",
  );
  assert.match(replaceCurrentView(after, "New"), /## My notes\n\nKeep this\./);
});

void test("a rejected view is marked as out of date, once", () => {
  const body = replaceCurrentView(dossierTemplate("AAA", "A"), "Add modestly.");
  const once = markCurrentViewStale(body, "2026-11-04", "hold");
  const twice = markCurrentViewStale(once, "2026-11-05", "trim");
  const view = dossierSection(twice, "Current view") ?? "";
  assert.match(view, /Not updated on 2026-11-05/);
  assert.match(view, /trim/);
  assert.doesNotMatch(view, /2026-11-04/);
  assert.match(view, /Add modestly\./);
  assert.equal(thesisText(twice), thesisText(body));
  // A passing review clears the mark along with the old text.
  assert.doesNotMatch(replaceCurrentView(twice, "Fresh."), /Not updated/);
});

void test("a saved view names the claims the second check could not confirm", () => {
  const check = (claim: string, verdict: string) => ({
    claim,
    verdict,
    note: "",
    source: "",
  });
  const verification = {
    checks: [
      check("Revenue grew 16%", "verified"),
      check("Recurring revenue grew 18%", "unverified"),
      check("x".repeat(400), "unverified"),
      ...["a", "b", "c", "d", "e"].map((c) => check(c, "unverified")),
    ],
  };
  const text = viewWithUnconfirmed("The view.", verification.checks);
  assert.match(text, /^The view\./);
  assert.match(text, /could not confirm/);
  assert.match(text, /Recurring revenue grew 18%/);
  assert.doesNotMatch(text, /Revenue grew 16%/);
  assert.ok(text.length < 1400);
  assert.match(text, /and 2 more/);
  assert.equal(
    viewWithUnconfirmed("The view.", [check("a", "verified")]),
    "The view.",
  );
});

void test("an open call stays visible until it is decided or replaced", () => {
  const update = (ticker: string, action: string, createdAt: string) =>
    [ticker, { ticker, runId: 15, createdAt, result: { action } }] as const;
  const updates = new Map([
    update("OLD", "sell", "2026-11-03T10:00:00Z"),
    update("HOLD", "hold", "2026-11-03T10:00:00Z"),
    update("QUEUED", "sell", "2026-11-03T10:00:00Z"),
    update("DECIDED", "trim", "2026-11-03T10:00:00Z"),
    update("BEFORE", "add", "2026-11-03T10:00:00Z"),
    update("SOLD", "sell", "2026-11-03T10:00:00Z"),
  ]) as unknown as Map<string, UpdateView>;
  const open = openCalls(
    [{ ticker: "QUEUED" }],
    updates,
    [
      { ticker: "DECIDED", createdAt: "2026-11-03T12:00:00Z", date: "x" },
      { ticker: "BEFORE", createdAt: "2026-11-02T12:00:00Z", date: "x" },
    ],
    new Set(["OLD", "HOLD", "QUEUED", "DECIDED", "BEFORE"]),
  );
  assert.deepEqual(open.map((u) => u.ticker).sort(), ["BEFORE", "OLD"]);
});

void test("self-checking is only worth saying in Both mode", () => {
  const update = {
    usedFallback: true,
    analystProvider: "chatgpt",
    verifierProvider: "chatgpt",
  };
  assert.equal(sameProviderFallback({ ...update, providerMode: "both" }), true);
  // In ChatGPT mode a web research fallback used to print this falsely.
  assert.equal(
    sameProviderFallback({ ...update, providerMode: "chatgpt" }),
    false,
  );
});

void test("subset progress counts only the tickers being reviewed", () => {
  const log = [
    "10:00:00 19 tickers to review.",
    "10:00:01 ZZZ: Setup failed: no data",
    "10:00:02 Reviewing only: AAA, BBB.",
    "10:00:03 AAA: no_change, hold, verified n/a.",
  ].join("\n");
  assert.deepEqual(runProgress(log), { done: 1, total: 2 });
});

void test("a revision fixes facts without being told to change its mind", () => {
  assert.match(reviewerFeedback("- note"), /Keep your action unless/);
});

void test("a same-day light pack keeps the full pack, and context combines them", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "portchecker-context-"));
  const start = process.cwd();
  process.chdir(temp);
  try {
    const dir = path.join("data", "packs", "2026-11-04", "AAA");
    const put = (folder: string, name: string, text: string) => {
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, name), text);
    };
    mkdirSync(path.join("data", "dossiers"), { recursive: true });
    writeFileSync(path.join("data", "dossiers", "AAA.md"), "live dossier");

    put(dir, "pack.json", "morning numbers");
    put(dir, "dossier.md", "stale dossier");
    put(dir, "review.json", "morning review");
    put(dir, "web_research.md", "web");
    put(dir, "filing_sections_10-K_x.md", "sections");
    put(dir, "filing_10-K_x.txt", "full text");

    // A light pack on the same day must not destroy what the review on screen cites.
    replacePackFolder(dir, false);
    assert.equal(existsSync(dir), false);
    assert.ok(existsSync(`${dir}.full`));
    put(dir, "pack.json", "evening numbers");
    put(dir, "dossier.md", "stale dossier");
    assert.equal(latestFullPackDir("AAA"), `${dir}.full`);

    const context = buildResearchContext("AAA");
    assert.ok(context);
    const read = (name: string) =>
      readFileSync(path.join(context, name), "utf8");
    assert.equal(read("pack.json"), "evening numbers");
    assert.equal(read("dossier.md"), "live dossier");
    assert.equal(read("filing_10-K_x.txt"), "full text");
    assert.equal(read("web_research.md"), "web");
    assert.equal(read("review.json"), "morning review");
    assert.deepEqual(
      readdirSync(path.join("data", "packs")).filter((d) =>
        d.startsWith("2026"),
      ),
      ["2026-11-04"],
    );
    rmSync(context, { recursive: true, force: true });

    // A later full pack replaces both.
    replacePackFolder(dir, true);
    assert.equal(existsSync(`${dir}.full`), false);
    assert.equal(existsSync(dir), false);
    assert.equal(latestFullPackDir("AAA"), null);
  } finally {
    process.chdir(start);
    rmSync(temp, { recursive: true, force: true });
  }
});

// Found by attacking the numbers: each of these reached a review or a verified tick.

const incomeRow = (
  date: string,
  revenue: number,
  extra: Record<string, unknown> = {},
) => ({
  date,
  period: "Q3",
  fiscalYear: date.slice(0, 4),
  reportedCurrency: "USD",
  revenue,
  operatingIncome: revenue / 10,
  netIncome: revenue / 20,
  epsDiluted: 1,
  ...extra,
});
const quarters = (rows: Record<string, unknown>[]) =>
  ({
    isFund: false,
    quote: { price: 100, marketCap: 1000 },
    income: rows,
    cashFlow: [],
    ratios: [],
    keyMetrics: [],
    estimates: [],
    earnings: [],
    priceTargetConsensus: null,
    keyMetricsTtm: null,
    ratiosTtm: null,
  }) as never;

void test("growth compares the same quarter a year apart, not the row four back", () => {
  const dates = [
    "2026-09-30",
    "2026-03-31",
    "2025-12-31",
    "2025-09-30",
    "2025-06-30",
  ];
  const context = fundamentalContext(
    quarters([
      incomeRow(dates[0]!, 100),
      incomeRow(dates[1]!, 100),
      incomeRow(dates[2]!, 100),
      incomeRow(dates[3]!, 80),
      incomeRow(dates[4]!, 50),
    ]),
    "2026-11-04",
  );
  assert.equal(context?.growth.revenue_yoy_pct, 25);
});

void test("no growth is given when a year-ago quarter cannot be found", () => {
  const gap = fundamentalContext(
    quarters([
      incomeRow("2026-09-30", 100),
      incomeRow("2026-06-30", 100),
      incomeRow("2026-03-31", 100),
      incomeRow("2025-12-31", 100),
      incomeRow("2025-06-30", 50),
    ]),
    "2026-11-04",
  );
  assert.equal(gap?.growth.revenue_yoy_pct, null);
  const otherCurrency = fundamentalContext(
    quarters([
      incomeRow("2026-09-30", 100),
      incomeRow("2025-09-30", 50, { reportedCurrency: "EUR" }),
    ]),
    "2026-11-04",
  );
  assert.equal(otherCurrency?.growth.revenue_yoy_pct, null);
});

void test("a vendor row that does not add up is flagged, as QCOM's Q4 tax was", () => {
  const add = (pretax: number, tax: number, continuing: number, net: number) =>
    incomeRow("2026-09-27", 10_322, {
      incomeBeforeTax: pretax,
      incomeTaxExpense: tax,
      netIncomeFromContinuingOperations: continuing,
      netIncome: net,
    });
  const broken = fundamentalContext(
    quarters([add(1173, -8027, 13378, 1252)]),
    "2026-11-04",
  );
  assert.ok(broken?.data_notes.some((n) => n.includes("does not add up")));
  const fine = fundamentalContext(
    quarters([add(1173, -78, 1251, 1252)]),
    "2026-11-04",
  );
  assert.ok(!fine?.data_notes.some((n) => n.includes("does not add up")));
});

void test("results newer than the statements are stated, as NVO's and EXPE's were", () => {
  const data = {
    ...(quarters([incomeRow("2026-06-30", 100)]) as object),
    earnings: [
      { date: "2027-02-04", epsActual: null },
      { date: "2026-11-04", epsActual: 9.39 },
    ],
  };
  const context = fundamentalContext(data as never, "2026-11-04");
  assert.ok(
    context?.data_notes.some(
      (n) => n.includes("2026-11-04") && n.includes("2026-06-30"),
    ),
  );
  assert.equal(context?.growth.latest_quarter_end, "2026-06-30");
  const usual = {
    ...(quarters([incomeRow("2026-09-30", 100)]) as object),
    earnings: [{ date: "2026-11-04", epsActual: 9.39 }],
  };
  assert.deepEqual(
    fundamentalContext(usual as never, "2026-11-04")?.data_notes,
    [],
  );
});

void test("old cash flow quarters give no current yield", () => {
  const cash = (year: number) =>
    ["12-31", "09-30", "06-30", "03-31"].map((end) => ({
      date: `${year}-${end}`,
      reportedCurrency: "USD",
      operatingCashFlow: 10,
      freeCashFlow: 5,
    }));
  const data = (rows: object[]) => ({
    ...(quarters([incomeRow("2026-09-30", 100)]) as object),
    cashFlow: rows,
  });
  const old = fundamentalContext(data(cash(2020)) as never, "2026-11-04");
  assert.equal(old?.valuation.fcf_yield_ttm_pct, null);
  assert.equal(old?.growth.free_cash_flow_ttm, null);
  assert.ok(old?.data_notes.some((n) => n.includes("too old")));
  const current = fundamentalContext(data(cash(2025)) as never, "2026-03-31");
  assert.equal(current?.valuation.fcf_yield_ttm_pct, 2);
});

void test("the P/E range says how many years it rests on", () => {
  const data = {
    ...(quarters([]) as object),
    ratios: [
      { priceToEarningsRatio: 20 },
      { priceToEarningsRatio: -100 },
      { priceToEarningsRatio: 30 },
    ],
  };
  const context = fundamentalContext(data as never, "2026-11-04");
  assert.equal(context?.valuation.pe_fiscal_years_counted, 2);
  assert.equal(context?.valuation.pe_median_last_5_fiscal_years, 25);
});

void test("price history is sorted, one row a day, and a missing price is no price", () => {
  const up = priceSummary([
    { date: "2026-11-03", price: 100 },
    { date: "2026-11-04", price: 110 },
    { date: "2026-11-04", price: 110 },
  ]);
  assert.equal(up?.latest_price, 110);
  assert.equal(up?.return_1d_pct, 10);
  assert.equal(up?.trading_days, 2);
  for (const bad of [null, "", 0, -5, Number.NaN]) {
    const summary = priceSummary([
      { date: "2026-11-04", price: bad },
      { date: "2026-11-03", price: 100 },
      { date: "2026-11-02", price: 90 },
    ]);
    assert.equal(summary?.latest_price, 100);
    assert.equal(summary?.low_1y, 90);
  }
  // A row with no date, or a price that is not a number, is not a trading day.
  const undated = priceSummary([
    { price: 5 },
    { date: null, price: 6 },
    { date: "2026-11-05", price: true },
    { date: "2026-11-04", price: 110 },
    { date: "2026-11-03", price: "100" },
  ]);
  assert.equal(undated?.latest_date, "2026-11-04");
  assert.equal(undated?.return_1d_pct, 10);
  assert.equal(undated?.low_1y, 100);
  assert.equal(undated?.trading_days, 2);
});

void test("relative returns need the same period on both sides", () => {
  const history = Array.from({ length: 30 }, (_, i) => ({
    date: new Date(Date.parse("2026-11-04") - i * 86400000)
      .toISOString()
      .slice(0, 10),
    price: 100 + i,
  }));
  const spy = (latest_date: string) => ({
    latest_date,
    start_5d_date: history[5]!.date,
    start_1m_date: history[21]!.date,
    return_1d_pct: 1,
    return_5d_pct: 1,
    return_1m_pct: 1,
    return_3m_pct: 1,
    return_1y_pct: 1,
  });
  const fund = { history, quote: null } as never;
  const stale = relativeToMarket(fund, spy("2026-10-01"));
  assert.equal(stale?.["5_day_points"], null);
  assert.equal(stale?.["1_month_points"], null);
  assert.equal(stale?.["1_year_points"], null);
  const dayLate = relativeToMarket(fund, spy("2026-11-03"));
  assert.equal(dayLate?.["5_day_points"], null);
  assert.equal(dayLate?.["1_month_points"], -18.36);
  const same = relativeToMarket(fund, spy("2026-11-04"));
  assert.equal(same?.["5_day_points"], -5.76);
});

void test("a row with no actual has not been reported, whether null or left out", () => {
  const today = "2026-11-04";
  assert.deepEqual(nextEarnings([{ date: today }], today), { date: today });
  assert.deepEqual(nextEarnings([{ date: today, epsActual: null }], today), {
    date: today,
    epsActual: null,
  });
  assert.equal(nextEarnings([{ date: today, epsActual: 0 }], today), null);
});

const evidenceOf = (...claims: string[]) => ({
  evidence: claims.map((claim) => ({ claim, source: "fmp:x", date: "" })),
});
const verified = (...claims: string[]) => ({
  checks: claims.map((claim) => ({
    claim,
    verdict: "verified",
    note: "",
    source: "fmp:x",
  })),
});

void test("a verified tick never lands on a different claim", () => {
  for (const [claim, check] of [
    ["Revenue rose -10%", "Revenue rose 10%"],
    [
      "Operating cash flow fell by -$5 billion",
      "Operating cash flow fell by $5 billion",
    ],
    ["10", "Revenue rose 100%"],
    ["Revenue", "Revenue rose 100%"],
    ["", "Revenue rose 100%"],
    ["Revenue rose 10", "Revenue rose 100%"],
    // One fact of two was checked, so the tick would cover the unchecked one.
    [
      "AWS sales were $46 billion and income was $17 billion",
      "AWS sales were $46 billion",
    ],
  ] as const) {
    const [first] = evidenceEntries({
      result: evidenceOf(claim),
      verification: verified(check),
    } as never);
    assert.equal(first?.check, null, `${claim} against ${check}`);
    assert.equal(
      verifiedScore(verified(check) as never, evidenceOf(claim).evidence),
      0.5,
      `${claim} against ${check}`,
    );
  }
});

void test("case, whitespace and a final full stop do not change a claim", () => {
  for (const [claim, check] of [
    ["Revenue grew 12% to $5 billion.", "revenue grew 12% to $5 billion"],
    ["  Revenue  grew 12% this year ", "revenue grew 12% this year"],
    [
      "Long-term debt rose to $5 billion in the quarter",
      "LONG-TERM debt rose to $5 billion in the quarter.",
    ],
  ] as const) {
    const [first] = evidenceEntries({
      result: evidenceOf(claim),
      verification: verified(check),
    } as never);
    assert.ok(first?.check, `${claim} against ${check}`);
  }
});

void test("a bare SEC link counts as a filing, and a web summary of one does not", () => {
  const count = (source: string) =>
    verificationSources({
      checks: [{ claim: "x", verdict: "verified", note: "", source }],
    } as never);
  assert.deepEqual(
    count("https://www.sec.gov/Archives/edgar/data/1/report.htm"),
    {
      filing: 1,
      vendor: 0,
      web: 0,
      other: 0,
    },
  );
  assert.deepEqual(
    count("news:https://www.sec.gov/Archives/edgar/data/1/report.htm"),
    {
      filing: 0,
      vendor: 0,
      web: 1,
      other: 0,
    },
  );
  assert.equal(count("https://www.reuters.com/x")?.web, 1);
});

void test("a CSV quantity must be a real number", () => {
  const csv = [
    "Symbol,Description,Quantity,Market Value,Cost Basis",
    "X,x,Infinity,,50",
    "Y,y,1e309,,50",
    "Z,z,2,,50",
  ].join("\n");
  assert.deepEqual(
    parsePositionsCsv(csv).rows.map((h) => h.ticker),
    ["Z"],
  );
});

void test("key numbers name the quarter of a statement that lags the others", () => {
  const groups = keyNumbers({
    income_statement_quarterly: [incomeRow("2026-09-30", 100)],
    cash_flow_quarterly: [
      {
        date: "2026-06-30",
        period: "Q2",
        fiscalYear: "2026",
        reportedCurrency: "EUR",
        operatingCashFlow: 9,
        freeCashFlow: 5,
      },
    ],
  });
  const rows = groups.flatMap((g) => g.rows);
  const fcf = rows.find(([label]) =>
    String(label).startsWith("Free cash flow"),
  );
  assert.equal(fcf?.[0], "Free cash flow, Q2 2026");
  assert.match(String(fcf?.[1]), /^EUR /);
});

// Found by an independent review of this work.

void test("a stale mark never copies a section of mine into Current view", () => {
  const dossier = `# X

## Current view (owner: model)

Old view.

## My notes

Keep this once.

## Watch items

Nothing.
`;
  const once = markCurrentViewStale(dossier, "2026-11-04", "trim");
  const twice = markCurrentViewStale(once, "2026-11-05", "trim");
  assert.equal(twice.split("Keep this once.").length - 1, 1);
  assert.equal(twice.split("### My notes").length - 1, 0);
  assert.equal(twice.split("Old view.").length - 1, 1);
  assert.equal(twice.split("Not updated on").length - 1, 1);
  assert.match(twice, /Not updated on 2026-11-05/);
});

void test("what can be replaced stops at my own heading, what is read does not", () => {
  const dossier =
    "## Thesis (owner: me)\n\nMine.\n\n## Extra\n\nMore.\n\n## Current view\n\nV\n";
  assert.equal(replaceableSection(dossier, "Thesis"), "Mine.");
  assert.match(dossierSection(dossier, "Thesis") ?? "", /More\./);
  assert.equal(replaceableSection(dossier, "Missing"), null);
});

const labelEvidence = (claim: string) => ({
  evidence: [{ claim, source: "fmp:x", date: "" }],
});
const labelCheck = (claim: string) => ({
  checks: [{ claim, verdict: "verified", note: "", source: "fmp:x" }],
});
const paired = (claim: string, check: string) =>
  evidenceEntries({
    result: labelEvidence(claim),
    verification: labelCheck(check),
  } as never)[0]?.check !== null;

for (const [kind, claim, check] of [
  [
    "bare accounting signs",
    "Net income for the quarter was (10) million after tax.",
    "Net income for the quarter was 10 million after tax.",
  ],
  [
    "four-digit accounting signs",
    "Net income for the quarter was (1000) after tax.",
    "Net income for the quarter was 1000 after tax.",
  ],
  [
    "year-like accounting figures",
    "Net income for the quarter was (2026) million after tax.",
    "Net income for the quarter was 2026 million after tax.",
  ],
  [
    "scaled accounting figures",
    "Net income for the quarter was (10 million) after tax.",
    "Net income for the quarter was 10 million after tax.",
  ],
  [
    "foreign accounting signs",
    "Net income for the quarter was (€10) million after tax.",
    "Net income for the quarter was €10 million after tax.",
  ],
  [
    "Unicode minus signs",
    "Net income for the quarter was −10 million after tax.",
    "Net income for the quarter was 10 million after tax.",
  ],
  [
    "spaced minus signs",
    "Net income for the quarter was - 10 million after tax.",
    "Net income for the quarter was 10 million after tax.",
  ],
  [
    "typographic minus signs",
    "Net income for the quarter was –10 million after tax.",
    "Net income for the quarter was 10 million after tax.",
  ],
  [
    "detached currency minus signs",
    "Net income for the quarter was − € 10 million after tax.",
    "Net income for the quarter was €10 million after tax.",
  ],
  [
    "rate units",
    "Reported operating margin for the business increased by 10 basis points this quarter.",
    "Reported operating margin for the business increased by 10 percentage points this quarter.",
  ],
  [
    "currencies",
    "Reported revenue for the current quarter was 100 million dollars after the acquisition.",
    "Reported revenue for the current quarter was 100 million euros after the acquisition.",
  ],
  [
    "currency symbols",
    "Reported revenue for the current quarter was €100 million after the acquisition.",
    "Reported revenue for the current quarter was £100 million after the acquisition.",
  ],
  [
    "inclusion relationships",
    "Reported revenue for the current quarter includes $100 million in gains from the sale.",
    "Reported revenue for the current quarter excludes $100 million in gains from the sale.",
  ],
  [
    "omitted units",
    "The operating margin increased by 10 basis points this quarter.",
    "The operating margin increased by 10 points this quarter.",
  ],
  [
    "scales",
    "Revenue rose to $5 billion this quarter",
    "Revenue rose to $5 million this quarter",
  ],
  [
    "margins",
    "Gross margin reached 40% this quarter",
    "Operating margin reached 40% this quarter",
  ],
  [
    "multiples",
    "Trailing P/E is 25 for the company",
    "Forward P/E is 25 for the company",
  ],
  [
    "hyphenated periods",
    "Nine-month revenue rose 10% this year",
    "Three-month revenue rose 10% this year",
  ],
  [
    "periods",
    "Revenue rose 10% over nine months",
    "Revenue rose 10% over three months",
  ],
  [
    "growth bases",
    "Revenue grew 10% YoY this quarter",
    "Revenue grew 10% QoQ this quarter",
  ],
  [
    "counts",
    "Three directors resigned from the board",
    "Four directors resigned from the board",
  ],
  [
    "percentage signs",
    "Revenue changed (10%) this quarter",
    "Revenue changed 10% this quarter",
  ],
  [
    "detached percentage signs",
    "Revenue changed (10)% this quarter",
    "Revenue changed 10% this quarter",
  ],
  [
    "dollar signs",
    "Cash flow was ($5) this quarter",
    "Cash flow was $5 this quarter",
  ],
  [
    "subject and object",
    "Revenue exceeded expenses by $100 million.",
    "Expenses exceeded revenue by $100 million",
  ],
  [
    "repeated subjects",
    "Revenue exceeded expenses while revenue trailed income",
    "Revenue exceeded expenses while income trailed revenue",
  ],
] as const) {
  void test(`a verified tick keeps different ${kind} separate`, () => {
    assert.equal(paired(claim, check), false);
    assert.equal(
      verifiedScore(labelCheck(check) as never, labelEvidence(claim).evidence),
      0.5,
    );
    assert.equal(paired(check, claim), false);
  });
}

void test("nonidentical wording and figure formats keep their own check rows", () => {
  for (const [claim, check] of [
    [
      "Revenue rose to $5 billion in the quarter",
      "Revenue rose to $5 billion during the quarter",
    ],
    [
      "Margin reached 40% this quarter",
      "Gross margin reached 40% this quarter",
    ],
    [
      "Nine-month revenue rose 10% this year",
      "Nine month revenue rose 10% this year",
    ],
    [
      "Three directors resigned from the board this quarter",
      "Three directors left the board this quarter",
    ],
    [
      "Reported revenue for the current quarter includes $100 million in gains from the sale.",
      "Reported revenue for the current quarter included $100 million in gains from the sale.",
    ],
    ["Revenue rose to $5 billion", "Revenue rose to $5 billion (10-Q)"],
    ["The deal closes in (2026)", "The deal closes in 2026"],
    [
      "Cash was $ 5 and revenue $ 10 in (2026)",
      "Cash was $5 and revenue $10 in 2026",
    ],
    ["Revenue changed (10%) this quarter", "Revenue changed -10% this quarter"],
    ["Cash flow was ($5) this quarter", "Cash flow was -$5 this quarter"],
    [
      "Net income was (10) million after tax",
      "Net income was -10 million after tax",
    ],
    [
      "Net income was −10 million after tax",
      "Net income was - 10 million after tax",
    ],
    [
      "Net income was – € 10 million after tax",
      "Net income was -€10 million after tax",
    ],
  ])
    assert.equal(paired(claim!, check!), false, `${claim} against ${check}`);
});

void test("attention-only entries use the successful review and its real warnings", () => {
  const hold = briefOutcome();
  const brief = {
    ...emptyBrief(),
    nothing_to_do: false,
    needs_attention: [
      { ticker: "AAA", why: "Sell immediately: the thesis is broken." },
    ],
  };
  const result = stampBrief(brief, [hold]);
  assert.equal(result.needs_attention[0]?.why, hold.result.headline);
  assert.equal(buildQueue(result, [])[0]?.why, hold.result.headline);
  const duplicatedAdvice = stampBrief(
    { ...brief, summary: "Sell immediately: the thesis is broken." },
    [hold],
  );
  assert.doesNotMatch(duplicatedAdvice.summary, /Sell|broken/);
  const longerSummary = stampBrief(
    {
      ...brief,
      summary:
        "Markets were mixed. SELL   IMMEDIATELY: THE THESIS IS BROKEN! Keep watching earnings.",
    },
    [hold],
  );
  assert.doesNotMatch(longerSummary.summary, /SELL|BROKEN/);
  assert.equal(result.summary, brief.summary);
  const disputed = {
    ...hold,
    verification: {
      ...hold.verification!,
      independent_action: "trim" as const,
    },
  };
  assert.match(
    stampBrief(brief, [disputed]).needs_attention[0]!.why,
    /second pass would trim/,
  );
  const rejected = {
    ...hold,
    verification: { ...hold.verification!, conclusion_supported: false },
  };
  assert.match(
    stampBrief(brief, [rejected]).needs_attention[0]!.why,
    /final check/i,
  );
});

void test("filing excerpts count as primary evidence in the brief", () => {
  const verification = {
    ...labelCheck("Revenue is steady"),
    checks: [
      {
        claim: "Revenue is steady",
        verdict: "verified",
        source: "file:claim_excerpts.md",
        note: "",
      },
      {
        claim: "Demand is steady",
        verdict: "verified",
        source: "news:https://example.com",
        note: "",
      },
    ],
  };
  assert.deepEqual(verificationSources(verification as never), {
    filing: 1,
    vendor: 0,
    web: 1,
    other: 0,
  });
  const markdown = renderBriefMarkdown({
    brief: {
      date: "2026-11-05",
      summary: "Review the position.",
      needs_attention: [],
      portfolio_observations: [],
      nothing_to_do: false,
      suggested_actions: [
        {
          ticker: "AAA",
          action: "trim",
          size_hint: "",
          reasoning: "Demand is steady.",
          urgency: "today",
          verified_score: 1,
          models_agree: true,
        },
      ],
    },
    outcomes: [
      {
        ...briefOutcome("AAA", {
          verification: verifierSchema.parse({
            ticker: "AAA",
            ...verification,
            conclusion_supported: true,
            concerns: [],
            independent_action: "trim",
            independent_reason: "Demand is steady.",
          }),
        }),
        depth: "FULL",
        analyst: { provider: "chatgpt", model: "test" },
        verifier: { provider: "claude", model: "test" },
        usedFallback: false,
        revisedAfterReview: false,
      },
    ],
    failed: [],
    briefLabel: "test",
  });
  assert.doesNotMatch(markdown, /rests mainly on web summaries/);
});

void test("a check that adds a period or form stays separate from the original evidence", () => {
  const claim = "Revenue grew 16% to $4.9 billion";
  assert.ok(!paired(claim, `${claim} in Q3`));
  assert.ok(!paired(claim, `${claim} (10-Q)`));
  assert.ok(!paired(claim, `${claim}, per the 8-K filed 2026-11-04`));
  assert.ok(!paired(`${claim} in Q2`, `${claim} in Q3`));
  assert.ok(!paired(`${claim} in the 10-K`, `${claim} in the 10-Q`));
  // A year is a figure, since closing in 2026 and in 2027 are different claims.
  assert.ok(
    !paired(
      "The deal is expected to close in 2026",
      "The deal is expected to close in 2027",
    ),
  );
});

void test("a verified tick never lands on the opposite claim", () => {
  const tail = "10% during the latest fiscal quarter";
  assert.ok(!paired(`Revenue increased ${tail}`, `Revenue decreased ${tail}`));
  assert.ok(!paired(`Revenue fell ${tail}`, `Revenue rose ${tail}`));
  assert.ok(
    !paired(
      `EPS came in above estimates by ${tail}`,
      `EPS came in below estimates by ${tail}`,
    ),
  );
  assert.ok(
    !paired(
      "The company has not been charged in the matter so far",
      "The company has been charged in the matter so far",
    ),
  );
  // Even a plausible synonym cannot establish that the exact evidence claim was checked.
  assert.ok(!paired(`Revenue grew ${tail}`, `Revenue rose ${tail}`));
});

void test("a corrected call in the brief does not keep the words of the call it replaced", () => {
  const outcome = {
    ticker: "AAA",
    result: {
      action: "hold",
      reasoning: "Fair price, so hold.",
      would_change_my_mind: [],
    },
    verification: {
      independent_action: "hold",
      checks: [],
      conclusion_supported: true,
    },
    verifiedScore: 1,
  };
  const row = (action: string) => ({
    ticker: "AAA",
    action,
    size_hint: "100% of shares",
    reasoning: "Liquidate the entire position.",
    urgency: "today",
    verified_score: null,
    models_agree: null,
  });
  const brief = (action: string) =>
    ({
      date: "x",
      summary: "",
      needs_attention: [],
      portfolio_observations: [],
      nothing_to_do: false,
      suggested_actions: [row(action)],
    }) as never;
  const stamp = (action: string) =>
    withCodeScores(
      brief(action),
      [outcome] as never,
      "2026-11-04",
      new Set(["AAA"]),
    ).suggested_actions[0];
  const corrected = stamp("sell");
  assert.equal(corrected?.action, "hold");
  assert.equal(corrected?.reasoning, "Fair price, so hold.");
  assert.equal(corrected?.size_hint, "");
  assert.equal(corrected?.verified_score, 1);
  // An agreeing call keeps the brief's words; an unsupported review label does not.
  assert.equal(stamp("hold")?.reasoning, "Liquidate the entire position.");
  assert.equal(stamp("review")?.action, "hold");
  assert.equal(stamp("review")?.reasoning, "Fair price, so hold.");
});

void test("the brief cannot invent a call on a ticker with no review today", () => {
  const brief = withCodeScores(
    {
      date: "x",
      summary: "",
      needs_attention: [],
      portfolio_observations: [],
      nothing_to_do: false,
      suggested_actions: [
        {
          ticker: "FAILED",
          action: "sell",
          size_hint: "",
          reasoning: "made up",
          urgency: "today",
          verified_score: 1,
          models_agree: true,
        },
      ],
    },
    [],
    "2026-11-04",
    new Set(["FAILED"]),
  );
  assert.deepEqual(brief.suggested_actions, []);
});

void test("a rejected review retries once, then goes back to the usual schedule", () => {
  const rejectedFull = {
    depth: "FULL",
    verification: { conclusion_supported: false },
  };
  const passedFull = {
    depth: "FULL",
    verification: { conclusion_supported: true },
  };
  assert.equal(resetsReviewClock("FULL", false, null), true);
  assert.equal(resetsReviewClock("FULL", false, rejectedFull), true);
  assert.equal(resetsReviewClock("LIGHT", false, passedFull), false);
  assert.equal(resetsReviewClock("LIGHT", true, rejectedFull), false);
  assert.equal(resetsReviewClock("FULL", true, null), false);
  assert.equal(resetsReviewClock("FULL", true, passedFull), false);
  assert.equal(resetsReviewClock("FULL", true, rejectedFull), true);
});

const briefOutcome = (
  ticker = "AAA",
  changes: Partial<Parameters<typeof withCodeScores>[1][number]> = {},
) => ({
  ticker,
  result: analystSchema.parse({
    ticker,
    status: "no_change",
    headline: "The review headline.",
    what_changed: [],
    evidence: [],
    action: "hold",
    confidence: 0.8,
    reasoning: "The review reasoning.",
    business_view: "Stable business.",
    valuation_view: "Fair price.",
    evidence_against: [],
    next_proof_point: "",
    would_change_my_mind: [],
    dossier_current_view: null,
  }),
  verification: verifierSchema.parse({
    ticker,
    checks: [],
    conclusion_supported: true,
    concerns: [],
    independent_action: "hold",
    independent_reason: "The independent reason.",
  }),
  verifiedScore: 0.93,
  ...changes,
});
const emptyBrief = () =>
  briefSchema.parse({
    date: "2026-11-05",
    summary: "A quiet day.",
    needs_attention: [],
    portfolio_observations: [],
    suggested_actions: [],
    nothing_to_do: true,
  });
const briefAction = (
  ticker: string,
  action: "hold" | "sell" | "review" = "sell",
) => ({
  ticker,
  action,
  size_hint: "All shares",
  reasoning: "Sell now.",
  urgency: "today" as const,
  verified_score: null,
  models_agree: null,
});
const stampBrief = (
  brief: ReturnType<typeof emptyBrief>,
  outcomes: ReturnType<typeof briefOutcome>[],
) =>
  withCodeScores(
    brief,
    outcomes,
    brief.date,
    new Set([...outcomes.map((o) => o.ticker), "FAILED"]),
  );

void test("corrected attention text and urgency follow the review, and failed tickers have no warning", () => {
  const brief = emptyBrief();
  brief.nothing_to_do = false;
  brief.suggested_actions = [briefAction("AAA"), briefAction("BBB", "hold")];
  brief.needs_attention = [
    { ticker: "AAA", why: "Sell now." },
    { ticker: "FAILED", why: "Dividend cut; sell." },
    { ticker: "BBB", why: "Keep these words." },
  ];
  const result = stampBrief(brief, [briefOutcome(), briefOutcome("BBB")]);
  assert.deepEqual(result.needs_attention, [
    { ticker: "AAA", why: "The review headline." },
    { ticker: "BBB", why: "The review headline." },
  ]);
  assert.equal(result.suggested_actions[0]?.urgency, "no_rush");
  assert.equal(result.suggested_actions[1]?.urgency, "today");
});

void test("review labels require a disputed or rejected final check", () => {
  const hold = briefOutcome();
  const sell = briefOutcome("SELL", {
    result: { ...hold.result, ticker: "SELL", action: "sell" },
    verification: { ...hold.verification!, independent_action: "sell" },
  });
  for (const outcome of [hold, sell, { ...hold, verification: null }]) {
    const brief = emptyBrief();
    brief.suggested_actions = [briefAction(outcome.ticker, "review")];
    const result = stampBrief(brief, [outcome]).suggested_actions[0]!;
    assert.equal(result.action, outcome.result.action);
    assert.equal(result.reasoning, outcome.result.reasoning);
  }
  for (const verification of [
    { ...hold.verification!, independent_action: "trim" as const },
    { ...hold.verification!, conclusion_supported: false },
    {
      ...hold.verification!,
      checks: [
        {
          claim: "x",
          verdict: "contradicted" as const,
          note: "x",
          source: "fmp:x",
        },
      ],
    },
  ]) {
    const brief = emptyBrief();
    brief.suggested_actions = [briefAction("AAA", "review")];
    assert.equal(
      stampBrief(brief, [{ ...hold, verification }]).suggested_actions[0]
        ?.reasoning,
      "Sell now.",
    );
  }
});

void test("a rejected hold or contradicted check cannot disappear behind an all-clear", () => {
  const hold = briefOutcome();
  for (const verification of [
    { ...hold.verification!, conclusion_supported: false },
    {
      ...hold.verification!,
      checks: [
        {
          claim: "Price",
          verdict: "contradicted" as const,
          source: "fmp:quote",
          note: "Different price",
        },
      ],
    },
  ]) {
    const outcome = { ...hold, verification };
    for (const suggested_actions of [
      [],
      [briefAction("AAA", "hold")],
      [briefAction("AAA", "review")],
    ]) {
      const result = stampBrief({ ...emptyBrief(), suggested_actions }, [
        outcome,
      ]);
      assert.equal(result.nothing_to_do, false);
      assert.match(result.needs_attention[0]!.why, /final check.*concerns/i);
      assert.equal(buildQueue(result, [])[0]?.ticker, "AAA");
    }
    const view = {
      ...outcome,
      createdAt: "2026-11-05T12:00:00Z",
    } as UpdateView;
    assert.equal(
      openCalls([], new Map([["AAA", view]]), [], new Set(["AAA"])).length,
      1,
    );
    assert.equal(
      openCalls(
        [],
        new Map([["AAA", view]]),
        [
          {
            ticker: "AAA",
            date: "2026-11-05",
            createdAt: "2026-11-05T13:00:00Z",
          },
        ],
        new Set(["AAA"]),
      ).length,
      0,
    );
  }
  const supported = stampBrief(emptyBrief(), [hold]);
  assert.equal(supported.nothing_to_do, true);
  assert.deepEqual(supported.needs_attention, []);
});

void test("omitted disputed holds and damaged theses reach the queue without duplicating named calls", () => {
  const hold = briefOutcome();
  const disputed = {
    ...hold,
    verification: {
      ...hold.verification!,
      independent_action: "trim" as const,
    },
  };
  const result = stampBrief(emptyBrief(), [disputed]);
  assert.equal(result.nothing_to_do, false);
  assert.match(result.needs_attention[0]!.why, /second pass would trim/);
  assert.equal(buildQueue(result, [])[0]?.ticker, "AAA");
  for (const status of ["thesis_broken", "thesis_weakened"] as const) {
    const damaged = { ...hold, result: { ...hold.result, status } };
    const fixed = stampBrief(emptyBrief(), [damaged]);
    assert.equal(
      fixed.needs_attention[0]?.why,
      `${status.replace("thesis_", "Thesis ")}: The review headline.`,
    );
    const named = {
      ...emptyBrief(),
      needs_attention: [{ ticker: "AAA", why: "Existing warning." }],
    };
    assert.deepEqual(
      stampBrief(named, [damaged]).needs_attention,
      fixed.needs_attention,
    );
  }
  const named = {
    ...emptyBrief(),
    suggested_actions: [briefAction("AAA", "review")],
  };
  assert.deepEqual(stampBrief(named, [disputed]).needs_attention, []);
  for (const status of ["no_change", "watch", "thesis_strengthened"] as const)
    assert.deepEqual(
      stampBrief(emptyBrief(), [
        { ...hold, result: { ...hold.result, status } },
      ]).needs_attention,
      [],
    );
  assert.deepEqual(
    stampBrief(emptyBrief(), [{ ...hold, verification: null }]).needs_attention,
    [],
  );
});

void test("restored non-hold calls clear an incompatible all-clear and retain a change condition", () => {
  const hold = briefOutcome();
  const sell = {
    ...hold,
    result: {
      ...hold.result,
      action: "sell" as const,
      would_change_my_mind: ["A contract renewal would change this."],
    },
  };
  const result = stampBrief(emptyBrief(), [sell]);
  assert.equal(result.nothing_to_do, false);
  assert.doesNotMatch(result.summary, /quiet day/);
  assert.match(result.summary, /AAA/);
  assert.match(
    result.suggested_actions[0]!.reasoning,
    /What would change this: A contract renewal would change this\./,
  );
  assert.equal(result.suggested_actions[0]?.size_hint, "");
  const falseFlag = stampBrief(
    {
      ...emptyBrief(),
      nothing_to_do: false,
      summary:
        "Nothing needs attention today. Every holding can remain unchanged.",
    },
    [sell],
  );
  assert.match(falseFlag.summary, /^Needs attention: AAA\./);
  assert.doesNotMatch(
    falseFlag.summary,
    /Nothing needs attention|Every holding can remain unchanged/,
  );
  const wrong = {
    ...emptyBrief(),
    suggested_actions: [briefAction("AAA", "hold")],
  };
  assert.match(
    stampBrief(wrong, [sell]).suggested_actions[0]!.reasoning,
    /contract renewal/,
  );
  const next = {
    ...sell,
    result: {
      ...sell.result,
      would_change_my_mind: [],
      next_proof_point: "Next results.",
    },
  };
  assert.match(
    stampBrief(emptyBrief(), [next]).suggested_actions[0]!.reasoning,
    /What would change this: Next results\./,
  );
  const agreeing = { ...emptyBrief(), suggested_actions: [briefAction("AAA")] };
  assert.equal(
    stampBrief(agreeing, [sell]).suggested_actions[0]?.reasoning,
    "Sell now.",
  );
});

void test("named attention for disputed holds retains the useful model summary", () => {
  const hold = briefOutcome();
  const disputed = {
    ...hold,
    verification: {
      ...hold.verification!,
      independent_action: "trim" as const,
    },
  };
  const brief = {
    ...emptyBrief(),
    nothing_to_do: false,
    summary: "The review says hold, while the second pass favors trimming AAA.",
    needs_attention: [{ ticker: "AAA", why: "The two passes disagree." }],
  };
  assert.equal(stampBrief(brief, [disputed]).summary, brief.summary);
});

void test("a restored action reconciles all-clear prose even when attention already named it", () => {
  const hold = briefOutcome();
  const sell = { ...hold, result: { ...hold.result, action: "sell" as const } };
  const brief = {
    ...emptyBrief(),
    nothing_to_do: false,
    summary:
      "Nothing needs attention today. Every holding can remain unchanged.",
    needs_attention: [{ ticker: "AAA", why: "Check the next filing." }],
  };
  assert.match(stampBrief(brief, [sell]).summary, /^Needs attention: AAA\./);
});

void test("a thesis in doubt remains an open call until a later logged decision", () => {
  const base = {
    ticker: "AAA",
    createdAt: "2026-11-05T12:00:00Z",
    result: briefOutcome().result,
  } as UpdateView;
  const updates = new Map([
    [
      "AAA",
      { ...base, result: { ...base.result, status: "thesis_broken" as const } },
    ],
    ["BBB", { ...base, ticker: "BBB" }],
  ]);
  assert.deepEqual(
    openCalls([], updates, [], new Set(["AAA", "BBB"])).map((o) => o.ticker),
    ["AAA"],
  );
  assert.deepEqual(
    openCalls(
      [],
      updates,
      [
        {
          ticker: "AAA",
          date: "2026-11-05",
          createdAt: "2026-11-05T13:00:00Z",
        },
      ],
      new Set(["AAA", "BBB"]),
    ),
    [],
  );
});

void test("logged decisions annotate the brief without changing calls or verification", () => {
  const brief = {
    ...emptyBrief(),
    nothing_to_do: false,
    suggested_actions: [briefAction("AAA", "hold")],
  };
  const outcomes = [briefOutcome()];
  const baseline = stampBrief(brief, outcomes);
  const result = withCodeScores(
    brief,
    outcomes,
    brief.date,
    new Set(["AAA"]),
    new Map([["AAA", { date: "2026-11-04", actionTaken: "Held" }]]),
  );
  assert.equal(
    result.suggested_actions[0]?.reasoning,
    "Sell now. Last logged: Held, 2026-11-04.",
  );
  assert.deepEqual(
    {
      ...result.suggested_actions[0],
      reasoning: baseline.suggested_actions[0]?.reasoning,
    },
    baseline.suggested_actions[0],
  );
  assert.deepEqual(
    withCodeScores(brief, outcomes, brief.date, new Set(["AAA"]), new Map()),
    baseline,
  );
});

void test("brief holdings retain status and show weight, call and second pass in weight order", () => {
  const hold = briefOutcome("QCOM");
  const outcomes = [
    {
      ...hold,
      verification: {
        ...hold.verification!,
        independent_action: "trim" as const,
      },
    },
    briefOutcome("ZZZ", { verification: null }),
    briefOutcome("AAA"),
  ].map((o) => ({
    ...o,
    depth: "FULL" as const,
    analyst: { provider: "chatgpt", model: "stub" },
    verifier: o.verification ? { provider: "claude", model: "stub" } : null,
    usedFallback: false,
    revisedAfterReview: false,
  }));
  const opts = {
    brief: {
      ...emptyBrief(),
      suggested_actions: [briefAction("QCOM", "review")],
    },
    outcomes,
    failed: [],
    briefLabel: "stub",
  };
  const weights = new Map([
    ["QCOM", 3.25],
    ["ZZZ", 5],
    ["AAA", 5],
  ]);
  const markdown = renderBriefMarkdown({ ...opts, weights });
  assert.match(
    markdown,
    /QCOM\*\* \(3.25%, review, verified 93%, second pass says trim, status no change\)/,
  );
  assert.match(
    markdown,
    /ZZZ\*\* \(5.00%, hold, not checked, status no change\)/,
  );
  const holdings = markdown.split("## Holdings")[1]!;
  assert.ok(holdings.indexOf("AAA") < holdings.indexOf("ZZZ"));
  assert.ok(holdings.indexOf("ZZZ") < holdings.indexOf("QCOM"));
  const without = renderBriefMarkdown(opts).split("## Holdings")[1]!;
  assert.ok(without.indexOf("AAA") < without.indexOf("QCOM"));
  assert.doesNotMatch(without.split("\n\n")[0]!, /3.25%/);
  assert.equal(
    markdown.split("## Holdings")[0],
    renderBriefMarkdown(opts).split("## Holdings")[0],
  );
});

void test("size cells escape pipes and show code-computed position amounts", () => {
  const facts = {
    total_value: 58321.67,
    positions: [{ ticker: "AAA", value: 1234.56, weight_pct: 2.12 }],
  } as Parameters<typeof queueFunctions.positionSizeLine>[1];
  assert.equal(typeof queueFunctions.positionSizeLine, "function");
  assert.equal(
    queueFunctions.positionSizeLine("AAA", facts),
    "Now 2.12% ($1,234.56). 1% of the portfolio is $583.22.",
  );
  assert.equal(queueFunctions.positionSizeLine("MISSING", facts), null);
  const brief = {
    ...emptyBrief(),
    suggested_actions: [
      {
        ...briefAction("AAA"),
        size_hint: "1% | $583\nonly",
        reasoning: "A | B\nC",
      },
    ],
  };
  const markdown = renderBriefMarkdown({
    brief,
    outcomes: [],
    failed: [],
    briefLabel: "stub",
    facts,
  });
  const row = markdown.split("\n").find((line) => line.startsWith("| AAA"))!;
  assert.equal(row.match(/(?<!\\)\|/g)?.length, 8);
  assert.match(row, /\$583.22/);
  assert.match(row, /1% \\\| \$583 only/);
});

void test("brief figure tracing tolerates scaling and rounding and flags only unmatched figures", () => {
  assert.equal(typeof runFunctions.untracedFigures, "function");
  const inputs = JSON.stringify({
    total: 58321.67,
    revenue: 108800000000,
    share: 0.8947,
  });
  const brief = {
    ...emptyBrief(),
    summary: "$58,000 portfolio; $108.8 billion revenue; 89%. Q4 in 14 days.",
  };
  assert.deepEqual(runFunctions.untracedFigures(brief, inputs), []);
  brief.needs_attention = [{ ticker: "AAA", why: "19.40% growth." }];
  brief.portfolio_observations = ["$1.2 billion cash."];
  brief.suggested_actions = [
    {
      ...briefAction("AAA"),
      size_hint: "$999 proposal",
      reasoning: "A 7.77 multiple.",
    },
  ];
  assert.deepEqual(runFunctions.untracedFigures(brief, inputs), [
    "19.40%",
    "$1.2 billion",
    "7.77",
  ]);
});

void test("brief figure tracing respects explicit scale words", () => {
  const inputs = JSON.stringify({ cash: 5000000, margin: 10 });
  for (const summary of [
    "Cash is $5 million.",
    "Cash is 5 million dollars.",
    "Cash is $0.005 billion.",
  ])
    assert.deepEqual(
      runFunctions.untracedFigures({ ...emptyBrief(), summary }, inputs),
      [],
      summary,
    );
  for (const [summary, token] of [
    ["Cash is $5 billion.", "$5 billion"],
    ["Cash is 5 billion dollars.", "5 billion"],
    ["Cash is $5 trillion.", "$5 trillion"],
  ])
    assert.deepEqual(
      runFunctions.untracedFigures(
        { ...emptyBrief(), summary: summary! },
        inputs,
      ),
      [token],
      summary,
    );
});

void test("synthetic portfolio observations trace their amounts, weights and dates", () => {
  const brief = emptyBrief();
  brief.portfolio_observations = [
    "Portfolio value is $58,321.67 using November 4 closes, up $1,143.56 (+2.00%). Cash is $10,000.00, or 17.15%, making deployment a substantial allocation decision.",
    "The five largest non-cash holdings represent 40.21%. BFND alone is 17.40%; AAA is the largest individual stock at 8.31%.",
    "Sector weights already look through funds: technology is 22.36%, financial services 12.24% and consumer cyclical 10.82%. Another 9.04% is in funds without a sector breakdown.",
    "BBB, a 2.46% holding, reports November 17, twelve days away, the only listed earnings within the next fourteen days.",
  ];
  const inputs = JSON.stringify({
    total_value: 58321.67,
    day_change_value: 1143.56,
    day_change_pct: 2,
    cash_value: 10000,
    cash_pct: 17.15,
    top5_pct: 40.21,
    positions: [17.4, 8.31, 2.46],
    sectors: [22.36, 12.24, 10.82, 9.04],
  });
  assert.deepEqual(runFunctions.untracedFigures(brief, inputs), []);
});

void test("brief verification counts include evidence without a matching check", () => {
  const verification = (verified: number, total: number) => ({
    ...briefOutcome().verification!,
    checks: Array.from({ length: total }, (_, i) => ({
      claim: `Claim ${i}`,
      verdict: i < verified ? ("verified" as const) : ("unverified" as const),
      source: "fmp:quote",
      note: "Found in quote",
    })),
  });
  assert.equal(typeof runFunctions.verifiedCounts, "function");
  for (const [verified, total, missing] of [
    [23, 29, 0],
    [16, 21, 1],
  ]) {
    const checks = verification(verified!, total!);
    const items = [
      evidence("Claim 0"),
      ...(missing ? [evidence("Not checked")] : []),
    ];
    assert.deepEqual(runFunctions.verifiedCounts(checks, items), {
      verified,
      total: total! + missing!,
    });
    assert.equal(
      verifiedScore(checks, items),
      Number((verified! / (total! + missing!)).toFixed(4)),
    );
  }
  assert.equal(runFunctions.verifiedCounts(null), null);
  assert.equal(runFunctions.verifiedCounts(verification(0, 0)), null);
  assert.deepEqual(
    runFunctions.verifiedCounts(verification(0, 0), [evidence("Not checked")]),
    { verified: 0, total: 1 },
  );
  const checks = verification(23, 29);
  const outcome = {
    ...briefOutcome(),
    verification: checks,
    verifiedScore: verifiedScore(checks),
    depth: "FULL" as const,
    analyst: { provider: "chatgpt", model: "stub" },
    verifier: { provider: "claude", model: "stub" },
    usedFallback: false,
    revisedAfterReview: false,
  };
  const markdown = renderBriefMarkdown({
    brief: {
      ...emptyBrief(),
      suggested_actions: [
        { ...briefAction("AAA"), verified_score: outcome.verifiedScore },
      ],
    },
    outcomes: [outcome],
    failed: [],
    briefLabel: "stub",
  });
  assert.match(markdown, /\| 79% \(23 of 29\) \|/);
  assert.match(markdown, /verified 79% \(23 of 29\)/);
  assert.match(
    markdown,
    /Verified is the share of claims the second pass found in what it was given\. A claim not found is not shown to be wrong\./,
  );
});

void test("omitted disputed holds get review rows while named rows retain their words", () => {
  const hold = briefOutcome();
  const disputed = {
    ...hold,
    verification: { ...hold.verification!, independent_action: "add" as const },
  };
  const restored = stampBrief(emptyBrief(), [disputed]).suggested_actions;
  assert.deepEqual(restored, [
    {
      ticker: "AAA",
      action: "review",
      size_hint: "",
      urgency: "no_rush",
      reasoning: "The second pass favors add: The independent reason.",
      verified_score: 0.93,
      models_agree: false,
    },
  ]);
  assert.deepEqual(stampBrief(emptyBrief(), [hold]).suggested_actions, []);
  assert.deepEqual(
    stampBrief(emptyBrief(), [{ ...hold, verification: null }])
      .suggested_actions,
    [],
  );
  const named = {
    ...emptyBrief(),
    suggested_actions: [
      {
        ...briefAction("AAA", "review"),
        reasoning: "Keep the model's wording.",
      },
    ],
  };
  assert.equal(
    stampBrief(named, [disputed]).suggested_actions[0]?.reasoning,
    "Keep the model's wording.",
  );
  const heldRow = { ...named, suggested_actions: [briefAction("AAA", "hold")] };
  assert.equal(stampBrief(heldRow, [disputed]).suggested_actions.length, 1);
  assert.equal(
    stampBrief(heldRow, [disputed]).suggested_actions[0]?.action,
    "hold",
  );
  assert.deepEqual(
    withCodeScores(emptyBrief(), [disputed], "2026-11-05", new Set())
      .suggested_actions,
    [],
  );
});

void test("saved brief calls mark rejected conclusions without implying agreement", () => {
  const hold = briefOutcome();
  for (const independent of ["hold", "trim"] as const) {
    const outcome = {
      ...hold,
      verification: {
        ...hold.verification!,
        conclusion_supported: false,
        independent_action: independent,
      },
      depth: "FULL" as const,
      analyst: { provider: "chatgpt", model: "stub" },
      verifier: { provider: "claude", model: "stub" },
      usedFallback: false,
      revisedAfterReview: false,
    };
    const brief = stampBrief(
      { ...emptyBrief(), suggested_actions: [briefAction("AAA", "hold")] },
      [outcome],
    );
    const markdown = renderBriefMarkdown({
      brief,
      outcomes: [outcome],
      failed: [],
      briefLabel: "stub",
    });
    assert.match(
      markdown.split("\n").find((line) => line.startsWith("| AAA"))!,
      /conclusion not supported/,
    );
    assert.match(markdown.split("## Holdings")[1]!, /conclusion not supported/);
    assert.doesNotMatch(markdown, /second pass agrees|\| yes \|/i);
    if (independent === "trim") {
      assert.match(markdown, /no; conclusion not supported/);
      assert.match(markdown, /second pass says trim/);
    }
  }
});

void test("saved evidence marks an absent link however the source writes it", () => {
  const known =
    "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/a.htm";
  const absent = "https://files.example/c?d=1";
  const marked = updateFunctions.markUnknownLinks(
    [
      `${absent}`,
      `News:${absent}`,
      `news: ${absent}`,
      `file:pack.json#news ${absent}`,
      `edgar:0000000001-26-000001 ${absent}`,
      `dossier; https://www.sec.gov.files.example/Archives/x`,
      `edgar:0000000001-26-000001 ${known}`,
      `${known}`,
      "file:pack.json#quote",
    ].map((source) => ({ ...evidence(source), source })),
    JSON.stringify({ new_filings: [{ url: known }] }),
  );
  assert.deepEqual(
    marked.map((item) => item.link_not_in_files ?? false),
    [true, true, true, true, true, true, false, false, false],
  );
});

void test("saved evidence marks only news links absent from the research files", () => {
  assert.equal(typeof updateFunctions.markUnknownLinks, "function");
  const known = "https://example.com/article?x=1&y=2";
  const absent = "https://example.com/mistyped";
  const items = [
    { ...evidence("Known news"), source: `news:${known}` },
    { ...evidence("Missing news"), source: `news:${absent}` },
    { ...evidence("Filing"), source: "edgar:accession" },
    { ...evidence("Vendor"), source: "file:pack.json" },
    {
      ...evidence("Shorter link is different"),
      source: "news:https://example.com/article",
    },
    { ...evidence("Two citations"), source: `news:${known}; news:${absent}` },
  ];
  const before = structuredClone(items);
  const marked = updateFunctions.markUnknownLinks(
    items,
    JSON.stringify({ news: [{ url: known }] }),
  );
  assert.deepEqual(
    marked.map((item) => item.link_not_in_files ?? false),
    [false, true, false, false, true, true],
  );
  assert.deepEqual(items, before);
  assert.deepEqual(
    marked.map(({ link_not_in_files: _flag, ...item }) => item),
    before,
  );
  assert.equal(
    updateFunctions.markUnknownLinks(
      [items[1]!],
      `Source: Publisher, 2026-11-05, ${absent}\n`,
    )[0]?.link_not_in_files,
    undefined,
  );
});
