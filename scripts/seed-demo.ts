// `pnpm demo:seed` fills an empty install with fictional data, so the app can be explored with no
// API keys. Every company, number and link here is made up. It refuses to touch a database that
// already has records or research files.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { env } from "../src/env.js";
import { db } from "../src/server/db/index.ts";
import {
  briefs,
  decisions,
  filings,
  fmpCache,
  holdings,
  researchRuns,
  settings,
  tickers,
  tickerUpdates,
} from "../src/server/db/schema.ts";
import {
  readThesis,
  replaceCurrentView,
  saveDossier,
} from "../src/server/dossier.ts";
import { today } from "../src/server/fmp.ts";
import {
  dossierTemplate,
  THESIS_PLACEHOLDER,
  type AnalystResult,
  type BriefResult,
  type VerifierResult,
} from "../src/server/research/prompts.ts";
import {
  renderBriefMarkdown,
  verifiedScore,
  writeBriefFile,
} from "../src/server/research/run.ts";
import { saveSettings } from "../src/server/settings.ts";

// Selecting a constant checks for prior use without loading settings or private content.
const existingRecords = await Promise.all(
  [
    holdings,
    tickers,
    filings,
    fmpCache,
    researchRuns,
    tickerUpdates,
    briefs,
    decisions,
    settings,
  ].map((table) =>
    db
      .select({ present: sql<number>`1` })
      .from(table)
      .limit(1),
  ),
);
const databaseFiles = new Set(
  ["", "-wal", "-shm", "-journal"].map((suffix) =>
    path.resolve(env.DATABASE_PATH + suffix),
  ),
);
function hasDataFiles(dir: string): boolean {
  return (
    existsSync(dir) &&
    readdirSync(dir, { withFileTypes: true }).some((entry) => {
      const file = path.resolve(dir, entry.name);
      return entry.isDirectory()
        ? hasDataFiles(file)
        : !databaseFiles.has(file);
    })
  );
}
if (existingRecords.some((rows) => rows.length > 0) || hasDataFiles("data")) {
  console.error(
    "This installation already has records or data files, so the demo was not loaded. Use a separate, empty installation to explore the demo.",
  );
  process.exit(1);
}

const date = today();
const now = new Date().toISOString();
const model = { provider: "chatgpt", model: "demo-analyst" };
const checker = { provider: "claude", model: "demo-verifier" };

type Demo = {
  ticker: string;
  name: string;
  sector: string;
  quantity: number;
  costBasis: number;
  price: number;
  changePct: number;
  thesis?: string;
  result: AnalystResult;
  checks?: VerifierResult["checks"];
  independent?: VerifierResult["independent_action"];
  concerns?: string[];
};

const ok = (claim: string, source: string, note: string) => ({
  claim,
  source,
  note,
  verdict: "verified" as const,
});

const demos: Demo[] = [
  {
    ticker: "MRDN",
    name: "Meridian Freight Systems",
    sector: "Industrials",
    quantity: 40,
    costBasis: 3200,
    price: 118.4,
    changePct: -6.2,
    thesis:
      "- Network density lowers cost per mile as volume grows.\n- Contract freight keeps revenue steadier than spot rates.\n- Debt is falling, which leaves room for buybacks.",
    result: {
      ticker: "MRDN",
      status: "thesis_weakened",
      headline:
        "A lost anchor contract and lower margin guidance cut against the contract-freight part of the thesis.",
      what_changed: [
        "An 8-K disclosed the loss of its largest contract, about 11% of revenue, from next quarter.",
        "Full-year operating margin guidance fell to 9% from 11%.",
        "The stock fell 6.2% today while the S&P 500 rose 0.4%.",
      ],
      evidence: [
        {
          claim:
            "The largest contract, about 11% of revenue, ends next quarter.",
          source: "file:new_8k.md",
          date,
        },
        {
          claim: "Full-year operating margin guidance fell to 9% from 11%.",
          source: "file:new_8k.md",
          date,
        },
        {
          claim: "Debt to EBITDA fell to 1.8 from 2.3 over the past year.",
          source: "fmp:key-metrics-ttm",
          date,
        },
      ],
      action: "trim",
      confidence: 0.72,
      business_view:
        "Worse: steadier contract revenue is the core of the case, and it just shrank.",
      valuation_view:
        "Fair: 15 times forward earnings sits at its 5-year median, so the price does not yet discount lower margins.",
      evidence_against: [
        "Debt keeps falling, so there is no balance sheet stress.",
        "Management expects to replace part of the contract within a year.",
      ],
      next_proof_point:
        "At next quarter's results, check whether contract revenue is above 62% of the total and margin is at least 9%.",
      reasoning:
        "Steadier contract revenue is the second point of the thesis, and losing an 11% customer weakens it directly. At a fair rather than cheap price and a position near 19% of the portfolio, trimming lowers the risk while the replacement business is unproven.",
      would_change_my_mind: [
        "Contract revenue back above 65% of the total within two quarters.",
        "Operating margin guidance raised back to 10% or more.",
      ],
      dossier_current_view: `${date}: Trim. The lost anchor contract weakens the contract-freight case and margin guidance fell to 9%. The balance sheet is still improving. Next check: contract revenue share and margin at next quarter's results.`,
    },
    checks: [
      ok(
        "The largest contract, about 11% of revenue, ends next quarter.",
        "file:new_8k.md",
        "Found in the 8-K, Item 1.02.",
      ),
      ok(
        "Full-year operating margin guidance fell to 9% from 11%.",
        "file:new_8k.md",
        "Found in the 8-K, Exhibit 99.1.",
      ),
      ok(
        "Debt to EBITDA fell to 1.8 from 2.3 over the past year.",
        "fmp:key-metrics-ttm",
        "Matches pack.json.",
      ),
      ok(
        "The stock fell 6.2% today while the S&P 500 rose 0.4%.",
        "fmp:quote",
        "Matches relative_to_sp500.",
      ),
      {
        claim:
          "Management expects to replace part of the contract within a year.",
        source: "file:new_8k.md",
        verdict: "unverified",
        note: "The 8-K says it is pursuing replacement business but gives no time frame.",
      },
    ],
    independent: "hold",
    concerns: [
      "The size of the trim rests on position weight rather than on the contract loss itself.",
    ],
  },
  {
    ticker: "HLDN",
    name: "Halden Semiconductors",
    sector: "Technology",
    quantity: 25,
    costBasis: 2500,
    price: 204.1,
    changePct: 3.1,
    thesis:
      "- Design wins in power chips last for a decade.\n- Automotive demand grows faster than the wider chip market.",
    result: {
      ticker: "HLDN",
      status: "thesis_strengthened",
      headline:
        "Two new automotive design wins and rising margins support the thesis.",
      what_changed: [
        "Revenue grew 21% from a year earlier, led by automotive.",
        "Gross margin rose to 54% from 51%.",
      ],
      evidence: [
        {
          claim: "Revenue grew 21% from a year earlier.",
          source: "fmp:income-statement",
          date,
        },
        {
          claim: "Gross margin rose to 54% from 51%.",
          source: "fmp:income-statement",
          date,
        },
      ],
      action: "hold",
      confidence: 0.81,
      business_view: "Better: growth and margins both improved.",
      valuation_view:
        "Expensive: 31 times forward earnings against a 5-year median of 24, so strong results are already in the price.",
      evidence_against: [
        "A 3.1% gain today follows a 28% run over three months.",
      ],
      next_proof_point:
        "At next quarter's results, check that automotive revenue growth stays above 20%.",
      reasoning:
        "The results strengthen the design-win thesis, but the price already reflects them, so holding beats adding at 31 times forward earnings.",
      would_change_my_mind: [
        "A fall to about 24 times forward earnings would make adding attractive.",
      ],
      dossier_current_view: `${date}: Hold. Automotive design wins and a 54% gross margin support the thesis, but the stock is expensive at 31 times forward earnings.`,
    },
    checks: [
      ok(
        "Revenue grew 21% from a year earlier.",
        "fmp:income-statement",
        "Matches pack.json.",
      ),
      ok(
        "Gross margin rose to 54% from 51%.",
        "fmp:income-statement",
        "Matches pack.json.",
      ),
      ok(
        "A 3.1% gain today follows a 28% run over three months.",
        "fmp:quote",
        "Matches price_summary.",
      ),
    ],
    independent: "hold",
    concerns: [],
  },
  {
    ticker: "NWFD",
    name: "Northwind Foods",
    sector: "Consumer Defensive",
    quantity: 60,
    costBasis: 2900,
    price: 52.75,
    changePct: 0.3,
    result: {
      ticker: "NWFD",
      status: "no_change",
      headline: "Nothing new today: no filing, and the price barely moved.",
      what_changed: [],
      evidence: [
        { claim: "Price rose 0.3% today.", source: "fmp:quote", date },
      ],
      action: "hold",
      confidence: 0.6,
      business_view: "Unchanged since the last full review.",
      valuation_view:
        "Fair: 17 times forward earnings, close to its 5-year median of 18.",
      evidence_against: [],
      next_proof_point: "Next full review, or sooner if a filing lands.",
      reasoning: "No new evidence, so the case for holding stands.",
      would_change_my_mind: ["A cut to the dividend."],
      dossier_current_view: `${date}: Hold. Nothing new today: no filing, and the price barely moved. Next check: the Q3 results.`,
    },
  },
  {
    ticker: "SMPL",
    name: "Sample Total Market ETF",
    sector: "Technology",
    quantity: 30,
    costBasis: 6100,
    price: 251.3,
    changePct: 0.4,
    thesis: "- Low-cost core holding for broad US market exposure.",
    result: {
      ticker: "SMPL",
      status: "no_change",
      headline: "The fund is doing its job: low cost and tracking the market.",
      what_changed: [],
      evidence: [
        { claim: "Expense ratio is 0.03%.", source: "fmp:etf/info", date },
      ],
      action: "hold",
      confidence: 0.85,
      business_view: "Unchanged: holdings and cost are stable.",
      valuation_view: "Fair: it holds the whole market at market prices.",
      evidence_against: [],
      next_proof_point:
        "Check the expense ratio and tracking at the next annual report.",
      reasoning: "It remains a cheap core holding, which is its only job.",
      would_change_my_mind: ["A fee increase above 0.10%."],
      dossier_current_view: `${date}: Hold. The fund is doing its job at low cost. Next check: its weight, now the largest in the portfolio, if it passes 35%.`,
    },
  },
];

const cash = 4200;

for (const d of demos) {
  await db.insert(holdings).values({
    ticker: d.ticker,
    name: d.name,
    quantity: d.quantity,
    costBasis: d.costBasis,
    accountLabel: "Demo account",
    updatedAt: now,
  });
  await db.insert(tickers).values({
    ticker: d.ticker,
    sector: d.sector,
    industry: d.sector,
    lastFullReviewAt: now,
  });
  await db.insert(fmpCache).values({
    ticker: d.ticker,
    endpoint: "quote",
    fetchedOn: date,
    payloadJson: JSON.stringify([
      {
        price: d.price,
        changePercentage: d.changePct,
        change: (d.price * d.changePct) / 100,
      },
    ]),
  });
  const template = dossierTemplate(d.ticker, d.name);
  const withThesis = d.thesis
    ? template.replace(THESIS_PLACEHOLDER, d.thesis)
    : template;
  saveDossier(
    d.ticker,
    d.result.dossier_current_view
      ? replaceCurrentView(withThesis, d.result.dossier_current_view)
      : withThesis,
  );
}
await db.insert(holdings).values({
  ticker: "CASH",
  name: "Cash",
  quantity: cash,
  costBasis: null,
  accountLabel: "Demo account",
  updatedAt: now,
});
await db.insert(fmpCache).values({
  ticker: "HLDN",
  endpoint: "earnings",
  fetchedOn: date,
  payloadJson: JSON.stringify([
    {
      date: new Date(Date.now() + 6 * 86_400_000).toLocaleDateString("en-CA"),
      epsActual: null,
      epsEstimated: 1.95,
      revenueEstimated: 910000000,
    },
  ]),
});

const [run] = await db
  .insert(researchRuns)
  .values({
    startedAt: now,
    finishedAt: now,
    status: "finished",
    providerMode: "both",
    logText: "Demo data. No research job ran.",
    usageJson: JSON.stringify({
      inputTokens: 0,
      outputTokens: 0,
      webSearches: 0,
    }),
  })
  .returning();
const runId = run?.id ?? 1;

const outcomes = [];
for (const d of demos) {
  const verification: VerifierResult | null = d.checks
    ? {
        ticker: d.ticker,
        checks: d.checks,
        conclusion_supported: true,
        concerns: d.concerns ?? [],
        independent_action: d.independent ?? d.result.action,
        independent_reason:
          d.independent && d.independent !== d.result.action
            ? "One lost contract does not justify selling at a fair price while the balance sheet improves."
            : "The verified evidence supports the same call.",
      }
    : null;
  const score = verifiedScore(verification);
  await db.insert(tickerUpdates).values({
    runId,
    ticker: d.ticker,
    reviewDepth: verification ? "FULL" : "LIGHT",
    // As a real review does, so the page does not say the thesis changed since.
    resultJson: JSON.stringify({
      ...d.result,
      thesis_at_review: readThesis(d.ticker),
    }),
    verificationJson: verification ? JSON.stringify(verification) : null,
    verifiedScore: score,
    analystProvider: model.provider,
    analystModel: model.model,
    verifierProvider: verification ? checker.provider : null,
    verifierModel: verification ? checker.model : null,
    createdAt: now,
  });
  outcomes.push({
    ticker: d.ticker,
    depth: verification ? ("FULL" as const) : ("LIGHT" as const),
    result: d.result,
    verification,
    verifiedScore: score,
    analyst: model,
    verifier: verification ? checker : null,
    usedFallback: false,
    revisedAfterReview: false,
  });
}

const brief: BriefResult = {
  date,
  summary:
    "This is demo data with made-up companies. Meridian Freight needs a decision: it lost its largest contract and cut margin guidance, and at about 19% of the portfolio it is the largest risk. The two models disagree on it, so read the second opinion first. Everything else is a hold, and Halden reports in six days.",
  needs_attention: [
    {
      ticker: "MRDN",
      why: "Lost its largest contract and cut margin guidance. The thesis is weakened.",
    },
  ],
  portfolio_observations: [
    "Meridian Freight and the total market fund together are about half of the portfolio.",
    "Cash is about 17% of the portfolio, which leaves room to act without selling anything.",
  ],
  suggested_actions: [
    {
      ticker: "MRDN",
      action: "trim",
      size_hint: "About a quarter of the position",
      reasoning:
        "Trimming lowers the risk while the replacement business is unproven. The verifier would hold, so treat this as a close call.",
      urgency: "this_week",
      verified_score: outcomes[0]?.verifiedScore ?? null,
      models_agree: false,
    },
  ],
  nothing_to_do: false,
};
const markdown = renderBriefMarkdown({
  brief,
  outcomes,
  failed: [],
  briefLabel: "ChatGPT (demo-analyst)",
});
await db.insert(briefs).values({
  runId,
  date,
  provider: model.provider,
  model: model.model,
  resultJson: JSON.stringify(brief),
  markdown,
});
writeBriefFile(date, markdown);

await saveSettings({ provider_mode: "both", analyst_provider: "chatgpt" });

console.log("Loaded the demo. Run `pnpm dev` and open http://localhost:3000");
console.log(
  "Keep this demo installation separate from your real portfolio. See README.md before importing real holdings.",
);
process.exit(0);
