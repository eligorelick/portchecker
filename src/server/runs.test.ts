import "./test-env.ts";
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { client } from "./db/index.ts";
import {
  activeRun,
  claimRun,
  latestRun,
  needsVerification,
  renderBriefMarkdown,
  resultsDateFor,
  reviewDepth,
  unusablePass,
  withCodeScores,
  fundWeightConditionIssues,
} from "./research/run.ts";
import {
  currentReview,
  evidenceEntries,
  loadBrief,
  secondOpinion,
  tickerHistory,
  verificationSources,
} from "./updates.ts";

// Review depth compares local calendar dates; keep the clock on a fixed local afternoon.
const NOW = new Date(2026, 10, 9, 18).getTime();

await client.executeMultiple(
  "CREATE TABLE research_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,heartbeat_at TEXT,started_at TEXT,finished_at TEXT,status TEXT,provider_mode TEXT,usage_json TEXT,log_text TEXT DEFAULT '',brief_id INTEGER);" +
    "CREATE TABLE briefs (id INTEGER PRIMARY KEY, run_id INTEGER, date TEXT, provider TEXT, model TEXT, result_json TEXT, markdown TEXT);" +
    "CREATE TABLE decisions (id INTEGER PRIMARY KEY, ticker TEXT, date TEXT, action_taken TEXT, note TEXT, created_at TEXT);" +
    "CREATE TABLE ticker_updates (id INTEGER PRIMARY KEY, run_id INTEGER, ticker TEXT, review_depth TEXT, result_json TEXT, verification_json TEXT, verified_score REAL, analyst_provider TEXT, analyst_model TEXT, verifier_provider TEXT, verifier_model TEXT, used_fallback INTEGER DEFAULT 0, revised_after_review INTEGER DEFAULT 0, created_at TEXT);",
);
beforeEach(async () => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  await client.executeMultiple(
    "DELETE FROM research_runs; DELETE FROM ticker_updates; DELETE FROM briefs; DELETE FROM decisions;",
  );
});
afterEach(() => mock.timers.reset());
after(() => client.close());

const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60_000).toISOString();
const running = (heartbeat: string, log = "") =>
  client.execute({
    sql: "INSERT INTO research_runs (started_at, heartbeat_at, status, provider_mode, log_text) VALUES (?,?,?,?,?)",
    args: [heartbeat, heartbeat, "running", "chatgpt", log],
  });

void test("runs: a silent run frees the button and reads as failed", async () => {
  await running(minutesAgo(11), "10:00:00 AAA: analyzing.\n");
  assert.equal(await activeRun(), null);
  const run = await latestRun();
  assert.equal(run?.status, "failed");
  assert.equal(run?.message, "This run stopped without finishing.");
  assert.ok(await claimRun("chatgpt"), "a crashed run does not block the next");
});

void test("runs: a run that checked in recently still holds the button", async () => {
  await running(minutesAgo(9), "10:00:00 AAA: analyzing.\n- a reviewer note\n");
  assert.ok(await activeRun());
  const run = await latestRun();
  assert.equal(run?.status, "running");
  assert.equal(run?.message, "a reviewer note");
  assert.equal(await claimRun("chatgpt"), null);
});

void test("runs: the message drops the log time", async () => {
  await running(minutesAgo(1), "10:00:00 AAA: analyzing.\n");
  assert.equal((await latestRun())?.message, "AAA: analyzing.");
});

const fmp = (overrides: Record<string, unknown>) =>
  ({ quote: null, history: [], ...overrides }) as never;

void test("depth: a Form 4 alone does not buy a full review", () => {
  const quiet = fmp({ quote: { changePercentage: 0, timestamp: 1 } });
  const form = (f: string) => [{ form: f }] as never;
  assert.equal(
    reviewDepth(quiet, form("4"), "2026-11-04T12:00:00Z").depth,
    "LIGHT",
  );
  assert.equal(
    reviewDepth(quiet, form("10-Q"), "2026-11-04T12:00:00Z").depth,
    "FULL",
  );
});

void test("depth: a fall since the last review counts as much as a rise", () => {
  const prices = [70, 72, 95, 96, 98, 100];
  const history = prices.map((price, i) => ({
    date: `2026-11-0${9 - i}`,
    price,
  }));
  const data = fmp({
    quote: {
      changePercentage: 1,
      timestamp: Date.parse("2026-11-09T21:00:00Z") / 1000,
    },
    history,
  });
  // The review saw the 5th's close at 98; the latest close is 70.
  assert.equal(
    reviewDepth(data, [], new Date(2026, 10, 5, 12).toISOString()).depth,
    "FULL",
  );
});

void test("depth: the price on the review's own day is the one it saw", () => {
  const prices = [100, 98, 80, 80, 80, 80];
  const history = prices.map((price, i) => ({
    date: `2026-11-0${9 - i}`,
    price,
  }));
  const data = fmp({
    quote: {
      changePercentage: 1,
      timestamp: Date.parse("2026-11-09T21:00:00Z") / 1000,
    },
    history,
  });
  // Up 25% in five days, but only 2% since the review on the 8th at 98.
  assert.equal(
    reviewDepth(data, [], new Date(2026, 10, 8, 12).toISOString()).depth,
    "LIGHT",
  );
});

void test("verification: any light call or status other than quiet hold is checked, even repeated", () => {
  const check = (status: string, action: string, previous: string) =>
    needsVerification("LIGHT", { status, action } as never, previous);
  assert.equal(check("no_change", "sell", "sell"), true);
  assert.equal(check("thesis_weakened", "hold", "hold"), true);
  assert.equal(check("no_change", "hold", "hold"), false);
});

void test("a review saved with 0 and no check reads as no score", async () => {
  await client.execute({
    sql: "INSERT INTO ticker_updates (run_id,ticker,review_depth,result_json,verification_json,verified_score,analyst_provider,analyst_model,created_at) VALUES (1,'AAA','LIGHT',?,NULL,0,'chatgpt','m','2026-11-04T00:00:00Z')",
    args: [
      JSON.stringify({ action: "hold", status: "no_change", evidence: [] }),
    ],
  });
  const [view] = await tickerHistory("AAA");
  assert.equal(view?.verifiedScore, null);
});

void test("the count of open items leaves out what I have decided", async () => {
  await client.execute(
    "INSERT INTO research_runs (id,started_at,finished_at,status,provider_mode) VALUES (2,'2026-11-04T12:00:00.000Z','2026-11-04T15:00:00.000Z','finished','chatgpt')",
  );
  await client.execute({
    sql: "INSERT INTO briefs VALUES (1,2,'2026-11-04','chatgpt','m',?,'b')",
    args: [
      JSON.stringify({
        date: "2026-11-04",
        needs_attention: [],
        suggested_actions: [
          {
            ticker: "AAA",
            action: "add",
            urgency: "today",
            size_hint: "",
            reasoning: "r",
          },
          {
            ticker: "BBB",
            action: "trim",
            urgency: "today",
            size_hint: "",
            reasoning: "r",
          },
        ],
      }),
    ],
  });
  await client.execute(
    "INSERT INTO decisions VALUES (1,'AAA','2026-11-04','Added','', '2026-11-04T16:00:00.000Z')",
  );
  assert.equal((await loadBrief()).openCount, 1);
});

// run.ts: depth -----------------------------------------------------------------------------------

const history = (...prices: number[]) =>
  prices.map((price, i) => ({ date: `2026-11-0${9 - i}`, price }));
const asSeen = (n: number) => new Date(NOW - n * 86400000).toISOString();

void test("depth: a big fall buys a full review as a big rise does", () => {
  for (const changePercentage of [-6, 6]) {
    const moved = fmp({ quote: { changePercentage } });
    assert.equal(reviewDepth(moved, [], asSeen(1)).depth, "FULL");
  }
  const week = fmp({
    quote: { changePercentage: 0 },
    history: history(80, 90, 90, 90, 90, 100),
  });
  assert.equal(
    reviewDepth(week, [], asSeen(30 / (24 * 60))).depth,
    "LIGHT",
    "seen at this price",
  );
  const fell = fmp({
    quote: { changePercentage: 0 },
    history: history(80, 99, 99, 99, 99, 100),
  });
  assert.equal(reviewDepth(fell, [], asSeen(1)).depth, "FULL");
});

void test("depth: a week without a full review buys one, and six days do not", () => {
  const quiet = fmp({ quote: { changePercentage: 0 } });
  assert.equal(reviewDepth(quiet, [], asSeen(6)).depth, "LIGHT");
  const due = reviewDepth(quiet, [], asSeen(8));
  assert.equal(due.depth, "FULL");
  assert.match(due.why, /8 days ago/);
  assert.match(reviewDepth(quiet, [], null).why, /no full review/);
});

void test("depth: a quote with no real time cannot prove it was seen", () => {
  const zero = fmp({ quote: { changePercentage: 6, timestamp: 0 } });
  assert.equal(reviewDepth(zero, [], asSeen(1)).depth, "FULL");
});

void test("depth: a review from before the price history still sees a 5-day move", () => {
  const data = fmp({
    quote: { changePercentage: 0 },
    history: history(100, 99, 98, 97, 96, 85),
  });
  assert.equal(reviewDepth(data, [], asSeen(6)).depth, "FULL");
});

// run.ts: unusable passes -------------------------------------------------------------------------

void test("a pass with no evidence fails on a full review whatever it says, and a light one that speaks", () => {
  const pass = (status: string, action: string) =>
    ({ evidence: [], status, action }) as never;
  assert.match(
    unusablePass("FULL", pass("no_change", "hold")) ?? "",
    /no evidence/,
  );
  assert.match(
    unusablePass("LIGHT", pass("thesis_weakened", "hold")) ?? "",
    /no evidence/,
  );
  assert.match(
    unusablePass("LIGHT", pass("no_change", "add")) ?? "",
    /no evidence/,
  );
  assert.equal(unusablePass("LIGHT", pass("no_change", "hold")), null);
});

// run.ts: the brief -------------------------------------------------------------------------------

const outcome = (
  ticker: string,
  action: string,
  extra: Record<string, unknown> = {},
) =>
  ({
    ticker,
    verifiedScore: 0.9,
    result: {
      action,
      reasoning: `${ticker} reason`,
      status: "watch",
      headline: `${ticker} headline`,
      evidence: [],
      would_change_my_mind: [],
      next_proof_point: "",
    },
    verification: { independent_action: action, checks: [] },
    analyst: { provider: "chatgpt", model: "m" },
    verifier: { provider: "claude", model: "c" },
    usedFallback: false,
    ...extra,
  }) as never;
const row = (
  ticker: string,
  action: string,
  extra: Record<string, unknown> = {},
) => ({
  ticker,
  action: action as "hold",
  size_hint: "small",
  reasoning: "brief words",
  urgency: "today" as const,
  verified_score: 0.5,
  models_agree: true as boolean | null,
  ...extra,
});
const briefWith = (actions: ReturnType<typeof row>[]) => ({
  date: "2026-11-04",
  summary: "s",
  needs_attention: [],
  portfolio_observations: [],
  nothing_to_do: false,
  suggested_actions: actions,
});
const markdown = (
  actions: ReturnType<typeof row>[],
  outcomes: unknown[] = [outcome("AAA", "add")],
  failed: { ticker: string; reason: string }[] = [],
) =>
  renderBriefMarkdown({
    brief: briefWith(actions),
    outcomes: outcomes as never,
    failed,
    briefLabel: "stub",
  });
const webChecks = (web: number, filing: number, vendor = 0) => ({
  independent_action: "add",
  checks: [
    ...Array.from({ length: web }, () => ({
      verdict: "verified",
      source: "news:https://x.example",
    })),
    ...Array.from({ length: filing }, () => ({
      verdict: "verified",
      source: "edgar:1",
    })),
    ...Array.from({ length: vendor }, () => ({
      verdict: "verified",
      source: "fmp:quote",
    })),
  ],
});

void test("brief: supported action disagreement is not failed factual verification", () => {
  const result = withCodeScores(
    briefWith([
      row("SSNC", "review", {
        reasoning:
          "The second pass favors adding, while some claims could not be confirmed from what the second pass was given. That financing condition could not be confirmed.",
      }),
    ]),
    [
      outcome("SSNC", "hold", {
        verifiedScore: 1,
        verification: {
          conclusion_supported: true,
          independent_action: "add",
          independent_reason: "Priced notes reduce financing risk.",
          concerns: ["The passes weigh the pending settlement differently."],
          checks: [
            {
              claim: "Notes are priced",
              verdict: "verified",
              note: "Release",
              source: "file:release",
            },
          ],
        },
      }),
    ],
    "2026-11-05",
    new Set(["SSNC"]),
  );
  const action = result.suggested_actions[0]!;
  assert.equal(action.action, "review");
  assert.equal(action.models_agree, false);
  assert.equal(action.verified_score, 1);
  assert.doesNotMatch(action.reasoning, /could not be confirmed/);
  assert.match(action.reasoning, /hold/);
  assert.match(action.reasoning, /add/);
  assert.match(action.reasoning, /Priced notes reduce financing risk/);
});

void test("brief: an actual evidence gap retains its factual caveat during disagreement", () => {
  const result = withCodeScores(
    briefWith([
      row("AAA", "review", {
        reasoning: "Some claims could not be confirmed.",
      }),
    ]),
    [
      outcome("AAA", "hold", {
        verification: {
          conclusion_supported: true,
          independent_action: "add",
          independent_reason: "An alternative.",
          concerns: [],
          checks: [
            {
              claim: "Missing number",
              verdict: "unverified",
              source: "file:pack",
              note: "Missing",
            },
          ],
        },
      }),
    ],
    "2026-11-05",
    new Set(["AAA"]),
  );
  assert.match(
    result.suggested_actions[0]!.reasoning,
    /could not be confirmed/,
  );
});

void test("brief Markdown identifies local corrections separately from original model checks", () => {
  const text = renderBriefMarkdown({
    brief: {
      ...briefWith([]),
      local_correction: {
        at: "2026-11-06T04:00:00Z",
        notes: ["The explanation was corrected locally."],
      },
    },
    outcomes: [],
    failed: [],
    briefLabel: "original model",
  });
  assert.match(text, /Local correction/);
  assert.match(text, /original model checks/i);
  assert.match(text, /explanation was corrected locally/);
});

void test("fund conditions: a rounded-current weight is not a usable future crossing", () => {
  const result = {
    next_proof_point: "",
    would_change_my_mind: [
      "SCHR's portfolio weight rises above 3.5%, reopening the sizing decision.",
    ],
    dossier_current_view: null,
  };
  assert.equal(fundWeightConditionIssues(result, 3.5).length, 1);
  assert.equal(fundWeightConditionIssues(result, 3.504).length, 1);
  assert.equal(fundWeightConditionIssues(result, 3.4999).length, 1);
  assert.equal(fundWeightConditionIssues(result, 3.4).length, 0);
  assert.equal(
    fundWeightConditionIssues(
      {
        ...result,
        would_change_my_mind: ["The annual fee rises above 0.03%."],
      },
      3.5,
    ).length,
    0,
  );
  assert.equal(
    fundWeightConditionIssues(
      {
        ...result,
        would_change_my_mind: [
          "An explicit owner target below the current 3.5% allocation would prompt a review.",
        ],
      },
      3.5,
    ).length,
    0,
  );
  assert.equal(fundWeightConditionIssues(result, null).length, 0);
  assert.equal(
    fundWeightConditionIssues(
      {
        ...result,
        would_change_my_mind: [
          "If portfolio weight remains above 3.5% at the next quarterly review, revisit sizing.",
        ],
      },
      3.504,
    ).length,
    0,
  );
  assert.equal(
    fundWeightConditionIssues(
      {
        ...result,
        would_change_my_mind: [
          "The portfolio weight does not rise above 3.5%.",
        ],
      },
      3.504,
    ).length,
    0,
  );
  assert.equal(
    fundWeightConditionIssues(
      {
        ...result,
        would_change_my_mind: [],
        dossier_current_view: "The portfolio weight is above 3.5% today.",
      },
      3.504,
    ).length,
    0,
  );
  assert.equal(
    fundWeightConditionIssues(
      {
        ...result,
        would_change_my_mind: [],
        dossier_current_view:
          "The portfolio weight is 3.5%. The annual fee rises above 0.03%.",
      },
      3.5,
    ).length,
    0,
  );
});

for (const [name, condition] of [
  [
    "future persistence is not a crossing",
    "If portfolio weight remains above 3.5% at the next quarterly review, revisit sizing.",
  ],
  [
    "a held allocation at a future review is not a crossing",
    "If portfolio weight holds above 3.5% at the next review, reconsider sizing.",
  ],
  [
    "a negated crossing is not an action trigger",
    "The portfolio weight does not rise above 3.5%.",
  ],
])
  void test("fund conditions: " + name, () => {
    assert.equal(
      fundWeightConditionIssues(
        {
          next_proof_point: "",
          would_change_my_mind: [condition!],
          dossier_current_view: null,
        },
        3.504,
      ).length,
      0,
    );
  });

void test("brief: a hold or a call also resting on primary sources has no web caveat", () => {
  const caveat = /rests mainly on web summaries/;
  const with_ = (checks: unknown) => [
    outcome("AAA", "add", { verification: checks }),
  ];
  assert.doesNotMatch(
    markdown(
      [row("AAA", "hold")],
      [outcome("AAA", "hold", { verification: webChecks(3, 0) })],
    ),
    caveat,
  );
  assert.match(
    markdown([row("AAA", "add")], with_(webChecks(3, 1, 1))),
    caveat,
  );
  assert.doesNotMatch(
    markdown([row("AAA", "add")], with_(webChecks(3, 1, 2))),
    caveat,
  );
  assert.doesNotMatch(
    markdown([row("AAA", "add")], with_(webChecks(3, 0, 3))),
    caveat,
  );
});

void test("brief: reasoning cannot break its table row", () => {
  const md = markdown([row("AAA", "add", { reasoning: "A | B\nC  D" })]);
  const line = md.split("\n").find((l) => l.startsWith("| AAA"));
  assert.ok(line?.includes("A \\| B C D"), line);
});

void test("brief: scores and agreement read as words", () => {
  const md = markdown([
    row("AAA", "add", { models_agree: null, verified_score: null }),
  ]);
  assert.match(md, /\| AAA \| add \| small \| today \| n\/a \| n\/a \|/);
  const scored = markdown([
    row("AAA", "add", { models_agree: false, verified_score: 0.5 }),
  ]);
  assert.match(scored, /\| AAA \| add \| small \| today \| 50% \| no \|/);
});

void test("brief: failed holdings are listed, and absent when there are none", () => {
  const md = markdown([], undefined, [
    { ticker: "BBB", reason: "No market data" },
  ]);
  assert.match(md, /## Failed or skipped\n\n- \*\*BBB\*\*: No market data/);
  assert.doesNotMatch(markdown([]), /Failed or skipped/);
});

void test("brief: only an omitted non-hold is added back, and a listed one once", () => {
  const brief = withCodeScores(
    briefWith([row("AAA", "add")]),
    [
      outcome("AAA", "add"),
      outcome("BBB", "hold"),
      outcome("CCC", "trim"),
    ] as never,
    "2026-11-04",
    new Set(["AAA", "BBB", "CCC"]),
  );
  assert.deepEqual(brief.suggested_actions.map((a) => a.ticker).sort(), [
    "AAA",
    "CCC",
  ]);
});

// updates.ts --------------------------------------------------------------------------------------

const view = (over: Record<string, unknown>) =>
  ({
    id: 1,
    depth: "LIGHT",
    createdAt: "day-1",
    result: { status: "no_change", action: "hold" },
    verification: null,
    recheckedAt: null,
    ...over,
  }) as never;

void test("a quiet day needs all four: light, unchecked, no change and hold", () => {
  const real = view({
    id: 1,
    depth: "FULL",
    result: { status: "thesis_weakened", action: "hold" },
  });
  const later = (over: Record<string, unknown>) =>
    currentReview([view({ id: 9, ...over }), real])?.id;
  assert.equal(later({}), 1, "quiet: the real one stays");
  assert.equal(later({ depth: "FULL" }), 9, "a full review is real");
  assert.equal(
    later({ result: { status: "thesis_weakened", action: "hold" } }),
    9,
  );
  assert.equal(later({ result: { status: "no_change", action: "trim" } }), 9);
  assert.equal(later({ verification: { checks: [] } }), 9);
});

void test("a check with no verifier recorded is one model's", () => {
  assert.equal(
    secondOpinion({
      result: { action: "trim" },
      verification: { independent_action: "hold" },
      analystProvider: "chatgpt",
      verifierProvider: null,
    } as never),
    "second_pass_disagrees",
  );
});

const pairs = (claim: string, check: string) =>
  evidenceEntries({
    result: { evidence: [{ claim, source: "s", date: "d" }] },
    verification: {
      checks: [{ claim: check, verdict: "verified", note: "", source: "s" }],
    },
  } as never)[0]?.check !== null;

void test("verified ticks: a not on either side, in either order, is another claim", () => {
  const yes = "The company has been charged in the matter so far";
  const no = "The company has not been charged in the matter so far";
  assert.equal(pairs(no, yes), false);
  assert.equal(pairs(yes, no), false);
  const without =
    "The company closed the merger without regulatory approval this year";
  const withIt = "The company closed the merger regulatory approval this year";
  assert.equal(pairs(without, withIt), false);
});

void test("verified ticks: too few shared words or a two-word claim is not the same claim", () => {
  assert.equal(
    pairs(
      "Revenue rose sharply in Europe on strong pricing",
      "Revenue rose modestly across Asia despite strong demand",
    ),
    false,
  );
  assert.equal(
    pairs(
      "Revenue rose",
      "Revenue rose sharply in the quarter on strong demand",
    ),
    false,
  );
});

void test("verified ticks: whole-word overlap does not confirm a shortened claim", () => {
  assert.equal(
    pairs("sales rose in the", "pre-sales rose in the quarter"),
    false,
  );
  assert.equal(
    pairs("sales rose in the", "sales rose in thereafter years"),
    false,
  );
  assert.equal(pairs("sales rose in the", "sales rose in the quarter"), false);
  assert.equal(
    pairs("sales rose in the quarter", "sales rose in the quarter."),
    true,
  );
});

void test("results day needs a results 8-K, or a reported quarter on or before today", () => {
  const filed = (form: string, items: string) =>
    ({ form, items, filedAt: "2026-11-04" }) as never;
  assert.equal(
    resultsDateFor([filed("8-K/A", "2.02")], [], "2026-11-04"),
    "2026-11-04",
  );
  assert.equal(resultsDateFor([filed("10-Q", "2.02")], [], "2026-11-04"), null);
  assert.equal(
    resultsDateFor([], [{ date: "2026-11-03", epsActual: null }], "2026-11-04"),
    null,
  );
  assert.equal(
    resultsDateFor([], [{ date: "2026-11-05", epsActual: 2 }], "2026-11-04"),
    null,
  );
});

void test("a quiet light review with no checks is fine, since it claims nothing", () => {
  const quiet = { evidence: [], status: "no_change", action: "hold" } as never;
  assert.equal(unusablePass("LIGHT", quiet, { checks: [] }), null);
});

void test("a check citing the dossier beside a vendor counts in both", () => {
  assert.deepEqual(
    verificationSources({
      checks: [
        {
          claim: "x",
          verdict: "verified",
          note: "",
          source: "file:dossier.md; fmp:quote",
        },
      ],
    } as never),
    { filing: 0, vendor: 1, web: 0, other: 1 },
  );
});

void test("only claims that could not be confirmed sit beside the view", async () => {
  const { viewWithUnconfirmed } = await import("./dossier.ts");
  const checks = [
    { claim: "Margin fell", verdict: "contradicted" },
    { claim: "Revenue rose", verdict: "verified" },
  ];
  assert.equal(viewWithUnconfirmed("The view", checks), "The view");
  assert.match(
    viewWithUnconfirmed("The view", [
      { claim: "Backlog grew", verdict: "unverified" },
    ]),
    /Backlog grew/,
  );
});

void test("the same-provider warning needs the same provider, a fallback and Both mode", async () => {
  const { sameProviderFallback } = await import("./updates.ts");
  const update = {
    providerMode: "both",
    usedFallback: true,
    analystProvider: "claude",
    verifierProvider: "claude",
  };
  assert.equal(sameProviderFallback(update), true);
  assert.equal(
    sameProviderFallback({ ...update, verifierProvider: "chatgpt" }),
    false,
  );
  assert.equal(sameProviderFallback({ ...update, usedFallback: false }), false);
  assert.equal(
    sameProviderFallback({ ...update, providerMode: "claude" }),
    false,
  );
  assert.equal(
    sameProviderFallback({ ...update, verifierProvider: null }),
    false,
  );
});
