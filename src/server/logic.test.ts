import "./test-env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { parsePositionsCsv, screenshotPositionsToCsv } from "./csv.ts";
import { dossierSection, replaceCurrentView, thesisText } from "./dossier.ts";
import {
  compactDiff,
  extractSections,
  filingsToList,
  filingSummary,
} from "./edgar.ts";
import {
  fourConsecutiveQuarters,
  validFmpPayload,
  fundamentalContext,
  priceSummary,
  relativeToMarket,
  type FmpData,
} from "./fmp.ts";
import { stallTimer } from "./model.ts";
import { computePortfolioFacts } from "./portfolio.ts";
import { buildQueue, holdingChanges, runProgress } from "./queue.ts";
import { dataWarnings, keyNumbers } from "./research/pack.ts";
import {
  analystPrompt,
  BRIEF_PROMPT,
  dossierTemplate,
  PACK_DATA_NOTES,
  TEMPLATE_HINTS,
  thesisDraftPrompt,
} from "./research/prompts.ts";
import {
  renderBriefMarkdown,
  renderWebResearch,
  unusablePass,
  verifiedScore,
} from "./research/run.ts";
import {
  verificationSources,
  sameProviderFallback,
  currentReview,
  evidenceEntries,
  listedActions,
  secondOpinion,
  type UpdateView,
} from "./updates.ts";

const SINGLE_ACCOUNT = `"Positions for account Individual ...123 as of 10:45 AM ET, 2026/11/04","","","","","","","","","","","","","","","",""
"","","","","","","","","","","","","","","","",""
"Symbol","Description","Qty (Quantity)","Price","Price Chng % (Price Change %)","Price Chng $ (Price Change $)","Mkt Val (Market Value)","Day Chng % (Day Change %)","Day Chng $ (Day Change $)","Cost Basis","Gain % (Gain/Loss %)","Gain $ (Gain/Loss $)","Ratings","Reinvest?","Reinvest Capital Gains?","% of Acct (% of Account)","Security Type",
"AAPL","APPLE INC","1,000","$354.37","6.77%","$22.47","$354,370.00","6.77%","$22,470.00","$100,000.00","254%","$254,370.00","A","No","N/A","60%","Equity",
"BRK/B","BERKSHIRE HATHAWAY INC CLASS B","10","$500.00","0.1%","$0.50","$5,000.00","0.1%","$5.00","--","--","--","B","No","N/A","1%","Equity",
"AAPL 01/15/2027 400.00 C","CALL APPLE INC","1","$5.00","0%","$0","$500.00","0%","$0","$400.00","25%","$100.00","--","--","--","0%","Option",
"Cash & Cash Investments","--","--","--","--","--","$12,345.67","0%","$0.00","--","--","--","--","--","--","20%","Cash and Money Market",
"Account Total","--","--","--","--","--","$372,215.67","6.0%","$22,475.00","$100,400.00","--","--","--","--","--","100%","--",`;

const ALL_ACCOUNTS = `"Positions for All-Accounts as of 10:45 AM ET, 2026/11/04"

"Individual ...123"
"Symbol","Description","Quantity","Price","Market Value","Cost Basis"
"MSFT","MICROSOFT CORP","5","$400.00","$2,000.00","$1,000.00"
"Cash & Cash Investments","--","--","--","$10.00","--"
"Account Total","--","--","--","$2,010.00","--"

"Roth IRA ...456"
"Symbol","Description","Quantity","Price","Market Value","Cost Basis"
"MSFT","MICROSOFT CORP","2","$400.00","$800.00","$500.00"
"Account Total","--","--","--","$800.00","--"`;

void test("parses a single-account Schwab export, including cash", () => {
  const { rows, skipped, error } = parsePositionsCsv(SINGLE_ACCOUNT);
  assert.equal(error, null);
  assert.deepEqual(
    rows.map((r) => r.ticker),
    ["AAPL", "BRK-B", "CASH"],
  );
  const [aapl, brk, cash] = rows;
  assert.equal(aapl?.quantity, 1000);
  assert.equal(aapl?.costBasis, 100000);
  assert.equal(aapl?.accountLabel, "Individual ...123");
  assert.equal(brk?.costBasis, null);
  assert.equal(cash?.quantity, 12345.67);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]?.reason, "not a stock ticker");
});

void test("keeps accounts separate in an all-accounts export", () => {
  const { rows } = parsePositionsCsv(ALL_ACCOUNTS);
  assert.deepEqual(
    rows.map((r) => `${r.ticker}|${r.accountLabel}|${r.quantity}`),
    [
      "MSFT|Individual ...123|5",
      "CASH|Individual ...123|10",
      "MSFT|Roth IRA ...456|2",
    ],
  );
});

void test("counts a money market fund as cash", () => {
  const { rows, notes } = parsePositionsCsv(
    `"Symbol","Description","Qty (Quantity)","Price","Mkt Val (Market Value)","Cost Basis","Security Type"
"SWVXX","SCHWAB VALUE ADVANTAGE MONEY INV","5000.25","$1.00","$5,000.25","$5,000.25","Money Market Fund"
"Cash & Cash Investments","--","--","--","$250.50","--","Cash and Money Market"`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.ticker, "CASH");
  assert.equal(rows[0]?.quantity, 5250.75);
  assert.equal(notes.length, 1);
});

void test("reports a file with no positions", () => {
  assert.notEqual(parsePositionsCsv("hello,world\n1,2").error, null);
});

void test("section extraction skips the table of contents and takes the real section", () => {
  const body = "Our supply chain could be disrupted. ".repeat(40);
  const text = `Item 1A. Risk Factors 5\nItem 1B. Unresolved Staff Comments 20\nItem 1. Business\nSee Item 1A. Risk Factors for more.\nItem 1A. Risk Factors\n${body}\nItem 1B. Unresolved Staff Comments\nNone.`;
  const { risk_factors, mda } = extractSections("10-K", text);
  assert.ok(
    risk_factors?.startsWith("Item 1A. Risk Factors\nOur supply chain"),
  );
  assert.ok(risk_factors?.endsWith("disrupted."));
  assert.equal(mda, null);
});

void test("10-Q MD&A stops at Item 3 and ignores Part II Item 2", () => {
  const body = "Revenue grew this quarter. ".repeat(40);
  const text = `Item 2. Management's Discussion and Analysis\n${body}\nItem 3. Quantitative and Qualitative Disclosures\nItem 2. Unregistered Sales of Equity`;
  const { mda } = extractSections("10-Q", text);
  assert.ok(mda?.includes("Revenue grew"));
  assert.ok(!mda?.includes("Unregistered"));
});

void test("filing diff ignores page footers and moved sentences", () => {
  const before = {
    risk_factors:
      "We face competition.\nApple Inc. | 2025 Form 10-K | 5\n----------\nTariffs may hurt us. Supply is tight.",
    mda: null,
  };
  const after = {
    risk_factors:
      "Supply is tight. We face competition.\nApple Inc. | 2026 Form 10-K | 5\n----------\nA new export ban may hurt us.",
    mda: null,
  };
  const diff = compactDiff(before, after);
  assert.ok(diff.includes("+ A new export ban may hurt us."));
  assert.ok(diff.includes("- Tariffs may hurt us."));
  assert.ok(!diff.includes("Form 10-K"));
  assert.ok(!diff.includes("+ Supply is tight."));
  assert.ok(diff.includes("Not compared"));
});

void test("replacing the current view leaves my thesis alone", () => {
  const md = dossierTemplate("AAPL", "Apple Inc.").replace(
    "Why I own it, 3–6 bullets. The model never edits this section.",
    "- Services growth",
  );
  const out = replaceCurrentView(
    md,
    "## 2026-11-04\nStill fine.\n## Thesis (owner: me)\nbad",
  );
  assert.equal(dossierSection(out, "Thesis"), "- Services growth");
  const view = dossierSection(out, "Current view");
  assert.ok(view?.includes("Still fine."));
  assert.ok(view?.includes("### Thesis (owner: me)"));
  assert.equal(
    dossierSection(out, "Watch items"),
    "Next earnings date, pending filings, open questions.",
  );
  assert.equal(out.match(/^## Thesis/gm)?.length, 1);
});

void test("portfolio facts combine accounts and compute weights in code", () => {
  const facts = computePortfolioFacts(
    [
      { ticker: "AAA", name: "A", quantity: 10, costBasis: 500 },
      { ticker: "AAA", name: "A", quantity: 10, costBasis: 500 },
      { ticker: "BBB", name: "B", quantity: 5, costBasis: null },
      { ticker: "ZZZ", name: "No quote", quantity: 1, costBasis: 1 },
      { ticker: "CASH", name: "Cash", quantity: 1000, costBasis: null },
    ],
    new Map([
      ["AAA", { price: 100, change: 5, changePercentage: 5 }],
      ["BBB", { price: 200, change: -2, changePercentage: -1 }],
    ]),
    new Map([
      ["AAA", "Technology"],
      ["BBB", "Energy"],
    ]),
    "2026-11-04",
  );
  assert.equal(facts.total_value, 4000);
  assert.equal(facts.cash_pct, 25);
  assert.equal(facts.top5_concentration_pct, 75);
  const aaa = facts.positions.find((p) => p.ticker === "AAA");
  assert.equal(aaa?.quantity, 20);
  assert.equal(aaa?.weight_pct, 50);
  assert.equal(aaa?.unrealized_gain, 1000);
  assert.equal(
    facts.positions.find((p) => p.ticker === "BBB")?.unrealized_gain,
    null,
  );
  assert.equal(facts.day_change_value, 90);
  assert.deepEqual(facts.missing_prices, ["ZZZ"]);
  assert.deepEqual(facts.sector_weights[0], {
    sector: "Technology",
    weight_pct: 50,
  });
});

void test("price summary reads history newest first", () => {
  const history = [110, 109, 108, 107, 106, 100, 90].map((price, i) => ({
    date: `2026-11-0${7 - i}`,
    price,
  }));
  const summary = priceSummary(history);
  assert.equal(summary?.latest_price, 110);
  assert.equal(summary?.return_5d_pct, 10);
  assert.equal(summary?.high_1y, 110);
  assert.equal(summary?.low_1y, 90);
});

void test("fund sector weights look through to what the fund holds", () => {
  const facts = computePortfolioFacts(
    [
      { ticker: "VOO", name: "S&P 500", quantity: 1, costBasis: null },
      { ticker: "VCSH", name: "Bonds", quantity: 1, costBasis: null },
      { ticker: "MSFT", name: "Microsoft", quantity: 1, costBasis: null },
    ],
    new Map([
      ["VOO", { price: 100, change: 0, changePercentage: 0 }],
      ["VCSH", { price: 100, change: 0, changePercentage: 0 }],
      ["MSFT", { price: 200, change: 0, changePercentage: 0 }],
    ]),
    new Map([
      ["VOO", "Financial Services"],
      ["VCSH", "Financial Services"],
      ["MSFT", "Technology"],
    ]),
    "2026-11-04",
    new Map([
      [
        "VOO",
        [
          { sector: "Technology", weightPercentage: 40 },
          { sector: "Financial Services", weightPercentage: 60 },
        ],
      ],
      ["VCSH", []],
    ]),
  );
  const weight = (sector: string) =>
    facts.sector_weights.find((s) => s.sector === sector)?.weight_pct;
  assert.equal(weight("Technology"), 60); // 200 + 40 of 400
  assert.equal(weight("Financial Services"), 15);
  assert.equal(weight("Funds, no breakdown"), 25);
  const partial = computePortfolioFacts(
    [{ ticker: "F", name: "F", quantity: 1, costBasis: null }],
    new Map([["F", { price: 100, change: 0, changePercentage: 0 }]]),
    new Map(),
    "2026-11-04",
    new Map([["F", [{ sector: "Energy", weightPercentage: "80.00%" }]]]),
  );
  assert.deepEqual(partial.sector_weights, [
    { sector: "Energy", weight_pct: 80 },
    { sector: "Funds, no breakdown", weight_pct: 20 },
  ]);
});

void test("fund sector labels merge with company sectors, and fund cash is not my cash", () => {
  const facts = computePortfolioFacts(
    [
      { ticker: "FUND", name: "F", quantity: 1, costBasis: null },
      { ticker: "COIN", name: "Trust", quantity: 1, costBasis: null },
      { ticker: "SHOP", name: "S", quantity: 1, costBasis: null },
    ],
    new Map([
      ["FUND", { price: 100, change: 0, changePercentage: 0 }],
      ["COIN", { price: 100, change: 0, changePercentage: 0 }],
      ["SHOP", { price: 200, change: 0, changePercentage: 0 }],
    ]),
    new Map([["SHOP", "Consumer Cyclical"]]),
    "2026-11-04",
    new Map([
      [
        "FUND",
        [
          { sector: "Consumer Discretionary", weightPercentage: 90 },
          { sector: "Cash & Others", weightPercentage: 10 },
        ],
      ],
      ["COIN", [{ sector: "Cash & Others", weightPercentage: 100 }]],
    ]),
  );
  assert.deepEqual(facts.sector_weights, [
    { sector: "Consumer Cyclical", weight_pct: 72.5 },
    { sector: "Funds, no breakdown", weight_pct: 27.5 },
  ]);
  assert.equal(facts.cash_pct, 0);
});

void test("upcoming earnings lists the next unreported date per holding", () => {
  const facts = computePortfolioFacts(
    [{ ticker: "AAA", name: "A", quantity: 1, costBasis: null }],
    new Map([["AAA", { price: 1, change: 0, changePercentage: 0 }]]),
    new Map(),
    "2026-11-04",
    new Map(),
    new Map([
      [
        "AAA",
        [
          { date: "2027-05-01", epsActual: null, epsEstimated: 2 },
          { date: "2027-02-01", epsActual: null, epsEstimated: 1 },
          { date: "2026-10-01", epsActual: 1, epsEstimated: 1 },
        ],
      ],
      ["NOT_HELD", [{ date: "2026-12-01", epsActual: null }]],
    ]),
  );
  assert.deepEqual(facts.upcoming_earnings, [
    {
      ticker: "AAA",
      date: "2027-02-01",
      eps_estimated: 1,
      revenue_estimated: null,
    },
  ]);
});

void test("a template thesis counts as blank", () => {
  assert.equal(thesisText(dossierTemplate("AAA", "A")), null);
  const written = dossierTemplate("AAA", "A").replace(
    "Why I own it, 3–6 bullets. The model never edits this section.",
    "- Pricing power",
  );
  assert.equal(thesisText(written), "- Pricing power");
  const kept = dossierTemplate("AAA", "A").replace(
    "\n\n## What would",
    "\n- Pricing power\n\n## What would",
  );
  assert.equal(thesisText(kept), "- Pricing power");
});

void test("web research drops old, undated and non-web sources", () => {
  const finding = (url: string, date: string) => ({
    claim: url,
    url,
    publisher: "P",
    date,
    why_it_matters: "w",
  });
  const { markdown, kept } = renderWebResearch(
    {
      findings: [
        finding("https://fresh.example/a", "2026-11-01"),
        finding("https://old.example/b", "2026-01-01"),
        finding("javascript:alert(1)", "2026-11-01"),
        finding("https://undated.example/c", "last week"),
      ],
    },
    "2026-11-04",
  );
  assert.equal(kept, 1);
  assert.ok(markdown.includes("fresh.example"));
  assert.ok(!markdown.includes("javascript"));
});

void test("verified score is the share of passing checks", () => {
  const check = (verdict: "verified" | "unverified" | "contradicted") => ({
    claim: "c",
    verdict,
    note: "n",
    source: "s",
  });
  const base = {
    ticker: "A",
    conclusion_supported: true,
    concerns: [],
    independent_action: "hold" as const,
    independent_reason: "r",
  };
  assert.equal(verifiedScore(null), null);
  assert.equal(verifiedScore({ ...base, checks: [] }), null);
  assert.equal(
    verifiedScore({
      ...base,
      checks: [
        check("verified"),
        check("verified"),
        check("unverified"),
        check("contradicted"),
      ],
    }),
    0.5,
  );
});

void test("screenshot positions become a CSV the parser accepts", () => {
  const { csv, notes } = screenshotPositionsToCsv({
    positions: [
      {
        symbol: "msft",
        description: "Microsoft",
        quantity: null,
        price: 500,
        cost_basis: 1000,
        gain_value: 650,
      },
      {
        symbol: "MSFT",
        description: null,
        quantity: null,
        price: null,
        cost_basis: null,
        gain_value: null,
      },
      {
        symbol: "SWVXX",
        description: "Money fund",
        quantity: 100,
        price: 1,
        cost_basis: 100,
        gain_value: 0,
      },
    ],
    cash_value: 50,
    account_value: 1800,
    account_name: "Brokerage",
  });
  const { rows } = parsePositionsCsv(csv);
  assert.equal(rows.find((r) => r.ticker === "MSFT")?.quantity, 3.3);
  assert.equal(
    rows.find((r) => r.ticker === "MSFT")?.accountLabel,
    "Brokerage",
  );
  assert.equal(rows.find((r) => r.ticker === "CASH")?.quantity, 150);
  assert.ok(notes.some((n) => n.includes("worked out")));
  assert.ok(notes.some((n) => n.includes("$1800.00") && n.includes("$0.00")));
});

void test("an inline reference does not end a section early", () => {
  const body = "Revenue grew this quarter. ".repeat(10);
  const text = `Item 2. Management's Discussion and Analysis\n${body} See Item 3. Quantitative disclosures for more.\n${body}\nItem 3. Quantitative and Qualitative Disclosures\nMarket risk text`;
  const { mda } = extractSections("10-Q", text);
  assert.ok(mda?.includes("for more."));
  assert.ok(mda?.endsWith("quarter."));
});

void test("a report with no Item headings falls back to its plain headings", () => {
  const contents = "x".repeat(5000);
  const body = "Credit losses rose. ".repeat(50);
  const text = `RISK FACTORS\nMANAGEMENT'S DISCUSSION AND ANALYSIS\n${contents}\nMANAGEMENT'S DISCUSSION AND ANALYSIS OF FINANCIAL CONDITION\n${body}\nRISK FACTORS\n${body}`;
  const { risk_factors, mda } = extractSections("10-K", text);
  assert.ok(
    mda?.startsWith(
      "MANAGEMENT'S DISCUSSION AND ANALYSIS OF FINANCIAL CONDITION",
    ),
  );
  assert.ok(risk_factors?.includes("Credit losses"));
});

void test("a short real section such as no material changes is kept", () => {
  const text =
    "Item 1A. Risk Factors\nThere have been no material changes from the risk factors in our annual report.\nItem 2. Unregistered Sales of Equity";
  assert.ok(
    extractSections("10-Q", text).risk_factors?.includes("no material changes"),
  );
});

const fmpFixture = (overrides: Partial<FmpData>): FmpData => ({
  profile: null,
  quote: null,
  income: [],
  balance: [],
  cashFlow: [],
  keyMetrics: [],
  keyMetricsTtm: null,
  ratios: [],
  ratiosTtm: null,
  history: [],
  news: [],
  isFund: false,
  earnings: [],
  estimates: [],
  priceTargetConsensus: null,
  priceTargetSummary: null,
  priceTargetNews: [],
  gradesConsensus: null,
  grades: [],
  rating: null,
  scores: null,
  insiderTrades: [],
  dividends: [],
  fundInfo: null,
  fundSectors: [],
  fundCountries: [],
  ...overrides,
});

void test("valuation and growth context is computed from vendor data", () => {
  const quarter = (revenue: number, operatingIncome: number) => ({
    revenue,
    operatingIncome,
    netIncome: 10,
    epsDiluted: 1,
    period: "Q3",
    fiscalYear: "2026",
    reportedCurrency: "USD",
  });
  const context = fundamentalContext(
    fmpFixture({
      quote: { price: 100, yearHigh: 120, yearLow: 80 },
      ratios: [
        { priceToEarningsRatio: 20 },
        { priceToEarningsRatio: 30 },
        { priceToEarningsRatio: -5 },
      ],
      estimates: [
        { date: "2028-12-31", epsAvg: 6, revenueAvg: 1200 },
        { date: "2027-12-31", epsAvg: 5, revenueAvg: 1000 },
        { date: "2025-12-31", epsAvg: 1, revenueAvg: 1 },
      ],
      priceTargetConsensus: { targetConsensus: 110 },
      income: [
        { ...quarter(120, 30), date: "2026-09-30" },
        quarter(1, 1),
        quarter(1, 1),
        quarter(1, 1),
        { ...quarter(100, 20), date: "2025-09-30" },
      ],
      cashFlow: Array.from({ length: 8 }, (_, i) => ({
        freeCashFlow: i < 4 ? 10 : 5,
        date: new Date(Date.UTC(2026, 8 - i * 3, 30))
          .toISOString()
          .slice(0, 10),
      })),
      earnings: [
        { date: "2027-01-01", epsActual: null, epsEstimated: 2 },
        {
          date: "2026-10-01",
          epsActual: 2.2,
          epsEstimated: 2,
          revenueActual: 110,
          revenueEstimated: 100,
        },
      ],
    }),
    "2026-11-04",
  );
  assert.equal(context?.valuation.pe_median_last_5_fiscal_years, 25);
  assert.equal(context?.valuation.forward_pe, 20);
  assert.equal(
    context?.valuation.forward_estimate_fiscal_year_end,
    "2027-12-31",
  );
  assert.equal(context?.valuation.estimated_revenue_growth_next_year_pct, 20);
  assert.equal(context?.valuation.position_in_1_year_range_pct, 50);
  assert.equal(context?.growth.revenue_yoy_pct, 20);
  assert.equal(context?.growth.operating_margin_pct, 25);
  assert.equal(context?.growth.free_cash_flow_ttm, 40);
  assert.equal(context?.growth.free_cash_flow_prior_ttm, 20);
  assert.ok(Math.abs((context?.growth.last_eps_surprise_pct ?? 0) - 10) < 1e-9);
  assert.equal(fundamentalContext(fmpFixture({ isFund: true })), null);
});

void test("relative returns subtract the market", () => {
  const relative = relativeToMarket(
    fmpFixture({
      quote: { changePercentage: 12 },
      history: [110, 109, 108, 107, 106, 100].map((price, i) => ({
        date: `2026-11-0${9 - i}`,
        price,
      })),
    }),
    {
      return_1d_pct: 2,
      return_5d_pct: 4,
      start_5d_date: "2026-11-04",
      latest_date: "2026-11-09",
    },
  );
  assert.equal(relative?.today_points, 10);
  assert.equal(relative?.["5_day_points"], 6);
  assert.equal(relativeToMarket(fmpFixture({}), { return_1d_pct: 1 }), null);
});

void test("a quiet day keeps the last real review on screen", () => {
  const view = (id: number, depth: string, status: string, checked: boolean) =>
    ({
      id,
      depth,
      createdAt: `day-${id}`,
      result: { status, action: "hold" },
      verification: checked ? { checks: [] } : null,
      recheckedAt: null,
    }) as unknown as UpdateView;
  const full = view(1, "FULL", "weakened", true);
  const quiet = view(2, "LIGHT", "no_change", false);
  const newer = view(3, "LIGHT", "no_change", false);

  const shown = currentReview([newer, quiet, full]);
  assert.equal(shown?.id, 1);
  assert.equal(shown?.recheckedAt, "day-3");

  // A light review that found something is a real review.
  const found = view(4, "LIGHT", "weakened", true);
  assert.equal(currentReview([found, full])?.id, 4);
  assert.equal(currentReview([found, full])?.recheckedAt, null);

  // With only quiet days on record there is nothing better to show.
  assert.equal(currentReview([newer, quiet])?.id, 3);
  assert.equal(currentReview([]), undefined);
});

void test("forward P/E is left out when estimates are in another currency", () => {
  const estimates = [{ date: "2099-12-31", epsAvg: 20, revenueAvg: 1000 }];
  const quote = { price: 40, yearHigh: 50, yearLow: 30 };
  const inKroner = fundamentalContext(
    fmpFixture({
      quote,
      estimates,
      income: [{ reportedCurrency: "DKK", period: "Q3", fiscalYear: "2026" }],
    }),
    "2026-11-04",
  );
  assert.equal(inKroner?.valuation.forward_pe, null);
  assert.equal(inKroner?.growth.reporting_currency, "DKK");

  const inDollars = fundamentalContext(
    fmpFixture({
      quote,
      estimates,
      income: [{ reportedCurrency: "USD", period: "Q3", fiscalYear: "2026" }],
    }),
    "2026-11-04",
  );
  assert.equal(inDollars?.valuation.forward_pe, 2);
});

void test("a cash flow quarter with no data does not count as zero", () => {
  const quarter = { operatingCashFlow: 100, freeCashFlow: 50 };
  const missing = { operatingCashFlow: 0, freeCashFlow: -900 };
  const keyMetricsTtm = { freeCashFlowYieldTTM: -0.1 };
  const dated = (rows: (typeof quarter)[]) =>
    rows.map((q, i) => ({
      ...q,
      date: new Date(Date.UTC(2026, 8 - i * 3, 30)).toISOString().slice(0, 10),
    }));

  const gap = fundamentalContext(
    fmpFixture({
      keyMetricsTtm,
      cashFlow: dated([missing, quarter, quarter, quarter]),
    }),
    "2026-11-04",
  );
  assert.equal(gap?.growth.free_cash_flow_ttm, null);
  assert.equal(gap?.valuation.fcf_yield_ttm_pct, null);

  const full = fundamentalContext(
    fmpFixture({
      keyMetricsTtm,
      cashFlow: dated([quarter, quarter, quarter, quarter]),
    }),
    "2026-11-04",
  );
  assert.equal(full?.growth.free_cash_flow_ttm, 200);
  assert.equal(full?.valuation.fcf_yield_ttm_pct, -10);
});

const QUEUE_BRIEF = {
  date: "2026-11-04",
  needs_attention: [
    { ticker: "BBB", why: "Models disagree." },
    { ticker: "ZZZ", why: "A filing needs reading." },
  ],
  suggested_actions: [
    {
      ticker: "AAA",
      action: "add" as const,
      size_hint: "Small",
      reasoning: "Cheap.",
      urgency: "no_rush" as const,
      verified_score: 1,
      models_agree: true,
    },
    {
      ticker: "BBB",
      action: "trim" as const,
      size_hint: "A third",
      reasoning: "Margins fell.",
      urgency: "today" as const,
      verified_score: 0.9,
      models_agree: false,
    },
    {
      ticker: "CCC",
      action: "review" as const,
      size_hint: "",
      reasoning: "Unclear.",
      urgency: "this_week" as const,
      verified_score: 1,
      models_agree: null,
    },
  ],
};

void test("the queue lists each ticker once and keeps both the why and the reasoning", () => {
  const queue = buildQueue(QUEUE_BRIEF, []);
  assert.equal(queue.filter((q) => q.ticker === "BBB").length, 1);
  const bbb = queue.find((q) => q.ticker === "BBB");
  assert.equal(bbb?.why, "Models disagree.");
  assert.equal(bbb?.reasoning, "Margins fell.");
  assert.equal(bbb?.action, "trim");
});

void test("the queue never drops a ticker that only appears under needs attention", () => {
  const zzz = buildQueue(QUEUE_BRIEF, []).find((q) => q.ticker === "ZZZ");
  assert.equal(zzz?.why, "A filing needs reading.");
  assert.equal(zzz?.action, null);
});

void test("the queue puts the most urgent first and items with no urgency last", () => {
  assert.deepEqual(
    buildQueue(QUEUE_BRIEF, []).map((q) => q.ticker),
    ["BBB", "CCC", "AAA", "ZZZ"],
  );
});

void test("a decision logged since the brief marks the item and keeps its place", () => {
  const queue = buildQueue(QUEUE_BRIEF, [
    { ticker: "BBB", date: "2026-11-05", actionTaken: "Trimmed", note: "" },
    { ticker: "BBB", date: "2026-11-04", actionTaken: "Older", note: "" },
    {
      ticker: "CCC",
      date: "2026-11-03",
      actionTaken: "Before brief",
      note: "",
    },
  ]);
  assert.deepEqual(
    queue.map((q) => q.ticker),
    ["BBB", "CCC", "AAA", "ZZZ"],
  );
  assert.equal(queue[0]?.decision?.actionTaken, "Trimmed");
  assert.equal(queue.find((q) => q.ticker === "CCC")?.decision, null);
});

void test("run progress counts finished, failed and skipped tickers", () => {
  const log = [
    "10:00:00 Run 1 started in ChatGPT mode.",
    "10:00:01 4 tickers to review.",
    "10:00:02 BAD: No market data for this symbol. Check it under Holdings.",
    "10:00:03 AAPL: FULL review (10-Q filed).",
    "10:00:04 AAPL: watch, hold, verified 96%.",
    "10:00:05 BRK-B: no_change, hold, verified n/a.",
    "10:00:06 MSFT: analyzing.",
  ].join("\n");
  assert.deepEqual(runProgress(log), { done: 3, total: 4 });
  assert.deepEqual(runProgress(`${log}\n10:00:07 MSFT: FAILED. Timed out.`), {
    done: 4,
    total: 4,
  });
});

void test("run progress uses the short list when only some tickers run", () => {
  const log = [
    "10:00:01 19 tickers to review.",
    "10:00:02 Reviewing only: AAPL, MSFT.",
    "10:00:03 AAPL: watch, hold, verified 96%.",
  ].join("\n");
  assert.deepEqual(runProgress(log), { done: 1, total: 2 });
});

void test("run progress is empty before the job has counted its tickers", () => {
  assert.equal(runProgress("10:00:00 Run 1 started in ChatGPT mode."), null);
});

void test("the template's hints stay byte-identical, since dossiers on disk contain them", () => {
  const template = dossierTemplate("AAA", "A");
  for (const hint of [
    "Specific, checkable conditions.",
    "No review yet.",
    "Next earnings date, pending filings, open questions.",
  ]) {
    assert.ok(TEMPLATE_HINTS.has(hint));
    assert.ok(template.includes(`\n\n${hint}\n`));
  }
});

const checked = (claim: string, verdict: "verified" | "contradicted") => ({
  claim,
  verdict,
  note: "n",
  source: "s",
});

void test("evidence pairs exact matches first, so a loose match cannot take a later row's verdict", () => {
  const entries = evidenceEntries({
    result: {
      evidence: [
        { claim: "Sales rose", source: "a", date: "d" },
        { claim: "Sales   ROSE 5%", source: "b", date: "d" },
        { claim: "No match here", source: "c", date: "d" },
      ],
    },
    verification: {
      checks: [
        checked("sales rose 5%", "contradicted"),
        checked("Sales rose", "verified"),
        checked("A leftover claim", "verified"),
      ],
    },
  } as unknown as Parameters<typeof evidenceEntries>[0]);
  assert.deepEqual(
    entries.map((e) => [e.claim, e.check?.verdict ?? null]),
    [
      ["Sales rose", "verified"],
      ["Sales   ROSE 5%", "contradicted"],
      ["No match here", null],
      ["A leftover claim", "verified"],
    ],
  );
  assert.equal(entries[3]?.source, "s");
  assert.equal(
    evidenceEntries({
      result: { evidence: [{ claim: "c", source: "s", date: "d" }] },
      verification: null,
    } as unknown as Parameters<typeof evidenceEntries>[0])[0]?.check,
    null,
  );
});

void test("a second opinion speaks up only when it says something", () => {
  const opinion = (
    independent: string | null,
    verifierProvider: string | null,
  ) =>
    secondOpinion({
      result: { action: "trim" },
      verification: independent && { independent_action: independent },
      analystProvider: "chatgpt",
      verifierProvider,
    } as unknown as Parameters<typeof secondOpinion>[0]);
  assert.equal(opinion(null, null), null);
  assert.equal(opinion("trim", "claude"), "agree");
  assert.equal(opinion("hold", "claude"), "disagree");
  // One model agreeing with itself says little, but a disagreement still shows.
  assert.equal(opinion("trim", "chatgpt"), null);
  assert.equal(opinion("hold", "chatgpt"), "second_pass_disagrees");
});

void test("lists show the brief's action over the analyst's", () => {
  const updates = new Map(
    ["AAA", "BBB"].map((ticker) => [
      ticker,
      { result: { action: "hold" } } as unknown as UpdateView,
    ]),
  );
  const actions = listedActions(
    [
      { ticker: "AAA", action: "review" },
      { ticker: "BBB", action: null },
      { ticker: "CCC", action: "add" },
    ],
    updates,
  );
  assert.equal(actions.get("AAA"), "review");
  assert.equal(actions.get("BBB"), "hold");
  assert.equal(actions.get("CCC"), "add");
  assert.equal(actions.get("DDD"), undefined);
});

void test("key numbers show a foreign filer's currency and hide cash flow with no data", () => {
  const quarter = {
    revenue: 1_200_000_000,
    freeCashFlow: -900,
    operatingCashFlow: 0,
    period: "Q3",
    fiscalYear: "2026",
    reportedCurrency: "DKK",
  };
  const groups = keyNumbers({
    quote: { price: 41.2, marketCap: 8_200_000_000 },
    ratios_ttm: { netProfitMarginTTM: 0.1234 },
    income_statement_quarterly: [quarter],
    cash_flow_quarterly: [quarter],
  });
  const value = (label: string) =>
    groups.flatMap((g) => g.rows).find(([name]) => name === label)?.[1];
  assert.equal(value("Price"), "$41.20");
  assert.equal(value("Market cap"), "$8.2B");
  assert.equal(value("Net margin"), "12.3%");
  assert.equal(value("Revenue"), "DKK 1.2B");
  assert.equal(value("Free cash flow"), undefined);
  assert.equal(groups[2]?.title, "Latest quarter, Q3 2026");
  assert.deepEqual(keyNumbers({}), []);
});

void test("a filing summary names 8-K items and leaves out exhibits", () => {
  assert.equal(filingSummary("10-K", null), "Annual report");
  assert.equal(
    filingSummary("8-K", "2.02, 5.02,9.01, 7.77"),
    "Results, Officer or director change, Item 7.77",
  );
  assert.equal(filingSummary("8-K", null), "");
  assert.equal(filingSummary("4", ""), "");
});

void test("holding changes compare whole tickers across accounts", () => {
  const changes = holdingChanges(
    [
      { ticker: "AAA", quantity: 5 },
      { ticker: "AAA", quantity: 5 },
      { ticker: "BBB", quantity: 1 },
      { ticker: "GONE", quantity: 1 },
    ],
    [
      { ticker: "AAA", quantity: 10 },
      { ticker: "BBB", quantity: 2 },
      { ticker: "NEW", quantity: 3 },
    ],
  );
  assert.equal(changes.added, 1);
  assert.equal(changes.changed, 1);
  assert.deepEqual(changes.removed, ["GONE"]);
  assert.equal(changes.unchanged, 1);
  assert.equal(changes.before.get("AAA"), 10);
});

void test("audit: missing currency fails closed and short TTM windows stay null", () => {
  const f = fmpFixture({
    quote: { price: 40 },
    estimates: [{ date: "2099-01-01", epsAvg: 20 }],
    cashFlow: [{ date: "2026-09-30", freeCashFlow: 10, operatingCashFlow: 20 }],
  });
  assert.equal(fundamentalContext(f)?.valuation.forward_pe, null);
  assert.equal(fundamentalContext(f)?.growth.free_cash_flow_ttm, null);
});

void test("audit: invalid quotes are missing, unknown changes stay null", () => {
  const rows = ["A", "B", "C"].map((ticker) => ({
    ticker,
    name: ticker,
    quantity: 2,
    costBasis: null,
  }));
  const facts = computePortfolioFacts(
    rows,
    new Map([
      ["A", { price: null }],
      ["B", { price: Infinity }],
      ["C", { price: 10, change: null }],
    ]),
    new Map(),
  );
  assert.deepEqual(facts.missing_prices.sort(), ["A", "B"]);
  assert.equal(
    facts.positions.find((p) => p.ticker === "C")?.day_change_value,
    null,
  );
  assert.equal(facts.total_value, 20);
});

void test("audit: a duplicate with unknown basis keeps the merged basis unknown", () => {
  for (const basis of [
    ["--", "10"],
    ["10", "--"],
  ]) {
    const csv = `Symbol,Quantity,Cost Basis\nAAA,1,${basis[0]}\nAAA,2,${basis[1]}`;
    assert.equal(parsePositionsCsv(csv).rows[0]?.costBasis, null);
  }
});

const auditQuarters = [
  "2026-09-26",
  "2026-06-27",
  "2026-03-28",
  "2025-12-27",
].map((date) => ({
  date,
  reportedCurrency: "USD",
  operatingCashFlow: 20,
  freeCashFlow: 10,
  epsDiluted: 2,
}));

void test("audit: fiscal windows reject duplicate and missing quarters", () => {
  assert.equal(fourConsecutiveQuarters(auditQuarters), true);
  assert.equal(fourConsecutiveQuarters(auditQuarters.slice(0, 3)), false);
  assert.equal(
    fourConsecutiveQuarters([
      auditQuarters[0]!,
      auditQuarters[0]!,
      ...auditQuarters.slice(2),
    ]),
    false,
  );
  assert.equal(
    fourConsecutiveQuarters([
      ...auditQuarters.slice(0, 3),
      { date: "2025-09-27" },
    ]),
    false,
  );
});

void test("audit: valuation conflicts retain vendor PE and explain both alternatives", () => {
  const c = fundamentalContext(
    fmpFixture({
      quote: { price: 80, marketCap: 1000 },
      income: auditQuarters,
      cashFlow: auditQuarters,
      keyMetricsTtm: { freeCashFlowYieldTTM: 0.08 },
      ratiosTtm: { priceToEarningsRatioTTM: 20 },
    }),
    "2026-11-04",
  );
  assert.equal(c?.valuation.fcf_yield_ttm_pct, 4);
  assert.equal(c?.valuation.pe_ttm, 20);
  assert.equal(c?.valuation.pe_ttm_from_quarterly_eps, 10);
  assert.equal(c?.data_notes.length, 2);
  assert.ok(c?.data_notes[1]?.includes("tax benefit"));
  const foreign = fundamentalContext(
    fmpFixture({
      quote: { price: 80, marketCap: 1000 },
      cashFlow: auditQuarters.map((q) => ({ ...q, reportedCurrency: "DKK" })),
      keyMetricsTtm: { freeCashFlowYieldTTM: 0.08 },
    }),
    "2026-11-04",
  );
  assert.equal(foreign?.valuation.fcf_yield_ttm_pct, 8);
});

void test("audit: empty quote retries, empty news caches, errors reveal no vendor text", () => {
  assert.equal(validFmpPayload("quote", []), false);
  assert.equal(validFmpPayload("profile", null), false);
  assert.equal(validFmpPayload("news/stock", []), true);
  assert.throws(
    () => validFmpPayload("quote", { "Error Message": "secret-url" }),
    /^Error: FMP returned an error payload$/,
  );
});

void test("audit: quote dates tolerate weekends and report mixed or old dates", () => {
  const rows = ["A", "B", "C"].map((ticker) => ({
    ticker,
    name: ticker,
    quantity: 1,
    costBasis: null,
  }));
  const quotes = new Map([
    ["A", { price: 1, quote_date: "2026-10-30" }],
    ["B", { price: 1, quote_date: "2026-10-29" }],
    ["C", { price: 1 }],
  ]);
  const facts = computePortfolioFacts(rows, quotes, new Map(), "2026-11-02");
  assert.deepEqual(facts.quote_dates, {
    newest: "2026-10-30",
    oldest: "2026-10-29",
    stale: ["B"],
  });
  assert.deepEqual(
    computePortfolioFacts(rows, quotes, new Map(), "2026-11-04").quote_dates
      .stale,
    ["A", "B"],
  );
});

void test("audit: total return requires covered dividends and uses ex-dates without reinvestment", () => {
  const history = [
    { date: "2026-11-04", price: 110 },
    { date: "2025-11-04", price: 100 },
  ];
  assert.equal(priceSummary(history)?.total_return_1y_pct, null);
  assert.equal(priceSummary(history, [])?.total_return_1y_pct, 10);
  assert.equal(
    priceSummary(history, [{ date: "2026-10-01", dividend: 2 }])
      ?.total_return_1y_pct,
    null,
  );
  assert.equal(
    priceSummary(history, [
      { date: "2026-10-01", dividend: 2 },
      { date: "2025-11-04", dividend: 3 },
    ])?.total_return_1y_pct,
    12,
  );
});

void test("audit: foreign annual sections, amendments and whitespace truncation", () => {
  const body = "Operating risks and performance. ".repeat(20);
  const sections = extractSections(
    "20-F/A",
    `Item 3.D. Risk Factors\n${body}\nItem 4. Company\nItem 5. Operating and Financial Review\n${body}\nItem 6. Directors`,
  );
  assert.ok(sections.risk_factors?.includes("Operating risks"));
  assert.ok(sections.mda?.includes("Operating risks"));
  assert.deepEqual(extractSections("40-F", body), {
    risk_factors: null,
    mda: null,
  });
  assert.equal(filingSummary("10-Q/A", null), "Quarterly report amendment");
  const long = extractSections(
    "10-K",
    `preface ${"x".repeat(5000)}\n    RISK FACTORS\n${body.repeat(300)}`,
  );
  assert.ok(long.risk_factors?.includes("Cut off here"));
});

void test("audit: all pending reports and events reach the pack or remain unread", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "portchecker-pack-test-"));
  const packUrl = new URL("./research/pack.ts", import.meta.url).href;
  const dbUrl = new URL("./db/index.ts", import.meta.url).href;
  const schemaUrl = new URL("./db/schema.ts", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    process.chdir(${JSON.stringify(temp)});
    const {client,db}=await import(${JSON.stringify(dbUrl)});
    const {filings}=await import(${JSON.stringify(schemaUrl)});
    await client.executeMultiple('CREATE TABLE filings(accession_no TEXT,ticker TEXT,form TEXT,filed_at TEXT,primary_doc_url TEXT,items TEXT,sections_json TEXT,processed_at TEXT,PRIMARY KEY(accession_no,ticker));');
    fs.mkdirSync('data/dossiers',{recursive:true});fs.writeFileSync('data/dossiers/TEST.md','test dossier');
    const pending=Array.from({length:34},(_,i)=>({accessionNo:'acc-'+i,ticker:'TEST',form:i===0?'10-Q':i===1?'10-Q/A':i===2?'10-Q':i===33?'4':'8-K',filedAt:'2026-11-04',primaryDocUrl:'https://www.sec.gov/test/'+i,items:'',sectionsJson:null,processedAt:null}));
    pending.push({...pending[0],accessionNo:'failed',primaryDocUrl:'https://www.sec.gov/fail'});
    await db.insert(filings).values(pending);
    globalThis.fetch=async(url)=>{if(String(url).endsWith('fail'))throw Error('unavailable');return new Response('Item 1A. Risk Factors\\n'+'Risk text. '.repeat(40)+'\\nItem 2. Unregistered Sales of Equity\\nItem 2. Management?s Discussion and Analysis\\n'+'Revenue grew. '.repeat(40)+'\\nItem 3. Quantitative disclosures');};
    const {writePack}=await import(${JSON.stringify(packUrl)});
    const options={ticker:'TEST',date:'2026-11-04',fmp:${JSON.stringify(fmpFixture({}))},newFilings:pending};
    const light=await writePack({...options,includeFilings:false});
    assert.equal(light.unread.size,34);
    assert.ok(!JSON.parse(fs.readFileSync(light.dir+'/pack.json','utf8')).data_notes.some(n=>n.includes('No SEC filing text')));
    const full=await writePack({...options,includeFilings:true});
    assert.deepEqual([...full.unread],['failed']);
    assert.equal(full.written.filter(n=>n.startsWith('new_8k_')).length,30);
    assert.equal(full.written.filter(n=>n.startsWith('filing_sections_')).length,3);
    assert.ok(full.written.some(n=>n.includes('10-Q-A')));
    const {syncFilings,fetchEventText}=await import(${JSON.stringify(new URL("./edgar.ts", import.meta.url).href)});
    const dateAgo=d=>new Date(Date.now()-d*86400000).toISOString().slice(0,10);
    const submission={filings:{recent:{accessionNumber:['old-6k','new-6k'],filingDate:[dateAgo(20),dateAgo(1)],form:['6-K','6-K'],primaryDocument:['a.htm','b.htm'],items:['','']}}};
    globalThis.fetch=async()=>Response.json(submission);
    const first=await syncFilings('FIRST','1'); assert.deepEqual(first.map(f=>f.accessionNo),['new-6k']);
    await db.insert(filings).values({...pending[0],ticker:'UPGRADE',processedAt:'done'});
    const upgraded=await syncFilings('UPGRADE','1'); assert.deepEqual(upgraded.map(f=>f.accessionNo),['new-6k','old-6k']);
    const urls=[];
    globalThis.fetch=async(url)=>{urls.push(String(url));return new Response(String(url).endsWith('-index.html')?'<table><tr><td>1</td><td>Small</td><td><a href="small.htm">small</a></td><td>EX-99.1</td><td>10</td></tr><tr><td>2</td><td>Results</td><td><a href="large.htm">large</a></td><td>EX-99.2</td><td>1000</td></tr></table>':String(url).endsWith('large.htm')?'RESULTS IN LARGE EXHIBIT':'COVER PAGE');};
    const event=await fetchEventText({...pending[0],form:'6-K',primaryDocUrl:'https://www.sec.gov/Archives/test/cover.htm'});
    assert.ok(event.startsWith('Exhibit source:'));assert.ok(event.includes('RESULTS IN LARGE EXHIBIT'));assert.ok(!urls.some(u=>u.endsWith('small.htm')));
    await client.executeMultiple('CREATE TABLE tickers(ticker TEXT PRIMARY KEY,cik TEXT,sector TEXT,industry TEXT,fmp_profile_json TEXT,last_full_review_at TEXT);CREATE TABLE fmp_cache(ticker TEXT,endpoint TEXT,fetched_on TEXT,payload_json TEXT,PRIMARY KEY(ticker,endpoint,fetched_on));');
    const {tickers}=await import(${JSON.stringify(schemaUrl)});
    await db.insert(tickers).values({ticker:'META',cik:'123',sector:'Technology',industry:'Software',fmpProfileJson:JSON.stringify({companyName:'Prior',description:'Keep'})});
    globalThis.fetch=async()=>{throw Error('no network');};
    const {ensureTicker}=await import(${JSON.stringify(packUrl)});
    const metadata=await ensureTicker('META','Metadata');assert.equal(metadata.cik,'123');assert.equal(metadata.sector,'Technology');assert.equal(JSON.parse(metadata.fmpProfileJson).description,'Keep');
    client.close();
  `;
  try {
    const run = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        env: {
          ...process.env,
          DATABASE_PATH: path.join(temp, "test.db"),
          SEC_USER_AGENT: "Portchecker test audit contact",
        },
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    assert.equal(run.status, 0, run.stderr);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

void test("audit: coverage counts unmatched evidence", () => {
  const verification = {
    checks: [
      { claim: "one", verdict: "verified", source: "pack.json", note: "found" },
    ],
  } as Parameters<typeof verifiedScore>[0];
  const evidence = ["one", "two"].map((claim) => ({
    claim,
    source: "pack.json",
    date: "2026-11-04",
  }));
  assert.equal(verifiedScore(verification, evidence), 0.5);
  assert.equal(verifiedScore(null, evidence), null);
  assert.equal(verifiedScore(null, []), null);
});

void test("audit: source classes preserve mixed support and ignore failed checks", () => {
  const checks = [
    [
      "file:filing_sections_20-F-A_date_accession.md; file:pack.json; news:https://example.org",
      "verified",
    ],
    ["new_8k_date_accession.md", "verified"],
    ["edgar:accession; fmp:ratios", "verified"],
    ["file:web_research.md", "verified"],
    ["dossier.md", "verified"],
    ["unknown", "contradicted"],
  ].map(([source, verdict]) => ({ source, verdict }));
  assert.deepEqual(
    verificationSources({ checks } as Parameters<
      typeof verificationSources
    >[0]),
    { filing: 3, vendor: 2, web: 2, other: 1 },
  );
  assert.equal(verificationSources(null), null);
  assert.equal(
    sameProviderFallback({
      usedFallback: true,
      analystProvider: "claude",
      verifierProvider: "claude",
      providerMode: "both",
    }),
    true,
  );
  assert.equal(
    sameProviderFallback({
      usedFallback: false,
      analystProvider: "claude",
      verifierProvider: "claude",
      providerMode: "both",
    }),
    false,
  );
});

void test("audit: brief distinguishes a second pass and adds the web caveat in code", () => {
  const outcome = {
    ticker: "TEST",
    analyst: { provider: "claude", model: "stub" },
    verifier: { provider: "claude", model: "stub" },
    usedFallback: true,
    result: { status: "watch", headline: "Watch" },
    verification: {
      checks: [{ verdict: "verified", source: "news:https://example.org" }],
    },
  };
  const markdown = renderBriefMarkdown({
    providerMode: "both",
    briefLabel: "stub",
    failed: [],
    outcomes: [outcome],
    brief: {
      date: "2026-11-04",
      summary: "test",
      needs_attention: [],
      portfolio_observations: [],
      suggested_actions: [
        {
          ticker: "TEST",
          action: "add",
          size_hint: "small",
          urgency: "no_rush",
          verified_score: 1,
          models_agree: true,
          reasoning: "test",
        },
      ],
    },
  } as unknown as Parameters<typeof renderBriefMarkdown>[0]);
  assert.match(markdown, /Second pass agrees/);
  assert.match(
    markdown,
    /rests mainly on web summaries, not primary documents/,
  );
  assert.match(markdown, /fallback made one provider check its own work/);
});

void test("audit: concurrent processes atomically claim one run", async () => {
  const temp = mkdtempSync(path.join(tmpdir(), "portchecker-claim-"));
  const runUrl = new URL("./research/run.ts", import.meta.url).href;
  const dbUrl = new URL("./db/index.ts", import.meta.url).href;
  const child = (script: string) =>
    new Promise<string>((resolve, reject) => {
      const process_ = spawn(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
          cwd: temp,
          env: { ...process.env, DATABASE_PATH: path.join(temp, "test.db") },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120_000,
        },
      );
      let stdout = "";
      let stderr = "";
      process_.stdout.on("data", (s: Buffer) => {
        stdout += s.toString();
      });
      process_.stderr.on("data", (s: Buffer) => {
        stderr += s.toString();
      });
      process_.on("error", reject);
      process_.on("close", (code) =>
        code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)),
      );
    });
  try {
    await child(
      `const {client}=await import(${JSON.stringify(dbUrl)});await client.executeMultiple("CREATE TABLE research_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,heartbeat_at TEXT,started_at TEXT,finished_at TEXT,status TEXT,provider_mode TEXT,usage_json TEXT,log_text TEXT DEFAULT '',brief_id INTEGER);");client.close();`,
    );
    const script = `const {claimRun}=await import(${JSON.stringify(runUrl)});const {client}=await import(${JSON.stringify(dbUrl)});console.log((await claimRun('both'))?'won':'lost');client.close();`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => child(script)),
    );
    assert.equal(results.filter((r) => r === "won").length, 1);
    assert.equal(results.filter((r) => r === "lost").length, 5);
    const pack = spawnSync(
      process.execPath,
      [
        new URL(
          "../../scripts/pack-ticker.ts",
          import.meta.url,
        ).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
        "TEST",
      ],
      {
        cwd: temp,
        env: { ...process.env, DATABASE_PATH: path.join(temp, "test.db") },
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    assert.equal(pack.status, 1);
    assert.match(pack.stderr, /research run is active/);
  } finally {
    // Seven child processes have just closed this database. Windows can still hold the folder.
    rmSync(temp, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

void test("audit: billable responses count before schema validation, refusal and continuation exhaustion", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "portchecker-usage-"));
  const modelUrl = new URL("./model.ts", import.meta.url).href;
  const settingsUrl = new URL("./settings.ts", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import {mock} from 'node:test';
    import fs from 'node:fs';
    import {z} from ${JSON.stringify(import.meta.resolve("zod"))};
    process.chdir(${JSON.stringify(temp)});
    let responses=[];let sent='';let sentMax=0;let mode='claude';const requests=[];let codexOptions;
    const settings={provider_mode:'claude',analyst_provider:'claude',fallback_enabled:true,claude_model:'stub',codex_model:'stub',anthropic_api_key:'fake'};
    mock.module(${JSON.stringify(settingsUrl)},{namedExports:{getSettings:async()=>({...settings,provider_mode:mode}),claudeApiKey:()=> 'fake',otherProvider:p=>p==='claude'?'chatgpt':'claude',providerLabel:p=>p}});
    mock.module('node:child_process',{namedExports:{exec:(command,options,callback)=>callback(null,'ready',''),spawn:()=>{throw new Error('Unexpected provider process');}}});
    mock.module(${JSON.stringify(import.meta.resolve("@anthropic-ai/sdk"))},{defaultExport:class {static AnthropicError=class extends Error{};static APIError=class extends this.AnthropicError{constructor(status,error,retryAfter){super('api error');this.status=status;this.error=error;this.headers=new Headers(retryAfter?{'retry-after':retryAfter}:{});}};models={retrieve:async(id)=>modelFacts[id]??({max_tokens:128000})};messages={stream:(request)=>{requests.push(request);sent=request.messages[0].content.at(-1).text;sentMax=request.max_tokens;const reply=responses.shift();return {on(){return this;},abort(){},currentMessage:undefined,finalMessage:async()=>{if(reply instanceof Error)throw reply;return reply;}};}}}});
    mock.module(${JSON.stringify(import.meta.resolve("@openai/codex-sdk"))},{namedExports:{Codex:class {constructor(options){codexOptions=options;}startThread(){return {runStreamed:async()=>({events:(async function*(){yield {type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}};yield {type:'turn.completed',usage:{}};})()})};}}}});
    const modelFacts={new:{max_tokens:64000,capabilities:{thinking:{types:{adaptive:{supported:true}}},code_execution:{supported:true}}},old:{max_tokens:64000,capabilities:{thinking:{types:{adaptive:{supported:false}}},code_execution:{supported:false}}}};
    const {runModel}=await import(${JSON.stringify(modelUrl)});
    const response=(text,stop_reason='end_turn')=>({usage:{input_tokens:10,output_tokens:2},content:[{type:'text',text}],model:'stub',stop_reason});
    let usage=[];
    const options={role:'test',workingDirectory:'.',prompt:'test',schema:z.object({ok:z.boolean()}),onUsage:u=>usage.push(u)};
    responses=[response('{"wrong":true}'),response('{"ok":true}')];
    const retried=await runModel(options);assert.equal(usage.length,2);assert.equal(retried.usage.inputTokens,20);
    usage=[];responses=[response('{}'),response('{}')];await assert.rejects(runModel(options));assert.equal(usage.length,2);
    usage=[];responses=[response('', 'refusal')];const fallback=await runModel(options);assert.equal(fallback.usedFallback,true);assert.equal(usage.length,1);assert.equal(usage[0].inputTokens,10);
    usage=[];responses=Array.from({length:25},()=>response('', 'pause_turn'));await runModel({...options,webSearch:true});assert.equal(usage.length,25);
    usage=[];responses=[response('{"ok":', 'max_tokens')];const cutOff=await runModel(options);assert.equal(cutOff.provider,'chatgpt');assert.equal(cutOff.usedFallback,true);assert.match(cutOff.fallbackReason,/ran out of room/);assert.equal(sentMax,128000);assert.equal(usage.length,1);
    assert.equal(codexOptions.config.tool_output_token_limit,100000);assert.match(codexOptions.config.developer_instructions,/@exec: \{\\"max_output_tokens\\": 100000\}/);
    await runModel({...options,provider:'chatgpt',webSearch:true});assert.match(codexOptions.config.developer_instructions,/@exec/);assert.doesNotMatch(codexOptions.config.developer_instructions,/exec_command|rg /);
    const claudeOnly={...options,provider:'claude'};
    settings.claude_model='new';requests.length=0;responses=[{...response('', 'pause_turn'),container:{id:'box1'}},response('{"ok":true}')];
    await runModel({...claudeOnly,webSearch:true});
    assert.deepEqual(requests[0].thinking,{type:'adaptive'});assert.equal(requests[0].container,undefined);assert.equal(requests[1].container,'box1');assert.equal(requests[0].max_tokens,64000);assert.equal(requests[0].tools[0].allowed_callers,undefined);
    settings.claude_model='old';requests.length=0;responses=[response('{"ok":true}')];
    await runModel({...claudeOnly,webSearch:true});
    assert.equal(requests[0].thinking,undefined);assert.deepEqual(requests[0].tools[0].allowed_callers,['direct']);
    settings.claude_model='stub';
    const {default:Sdk}=await import(${JSON.stringify(import.meta.resolve("@anthropic-ai/sdk"))});
    requests.length=0;responses=[new Sdk.APIError(429,{error:{details:{error_code:'enforced_spend_limit_reached'}}})];
    await assert.rejects(runModel(claudeOnly));assert.equal(requests.length,1);
    requests.length=0;responses=[new Sdk.APIError(429,{error:{type:'rate_limit_error'}},'3600')];
    await assert.rejects(runModel(claudeOnly));assert.equal(requests.length,1);
    fs.writeFileSync('filing_sections_20-F-A_2026-11-04_accession.md','AMENDMENT_SENTINEL');
    fs.writeFileSync('new_8k_2026-11-04_accession.md','SIX_K_SENTINEL');
    fs.writeFileSync('filing_20-F-A_2026-11-04_accession.txt','FULL_TEXT_SENTINEL');
    responses=[response('{"ok":true}')];await runModel(options);assert.ok(sent.includes('AMENDMENT_SENTINEL'));assert.ok(sent.includes('SIX_K_SENTINEL'));assert.ok(!sent.includes('FULL_TEXT_SENTINEL'));assert.ok(sent.includes('filing_20-F-A_2026-11-04_accession.txt'));
  `;
  try {
    const run = spawnSync(
      process.execPath,
      ["--experimental-test-module-mocks", "--input-type=module", "-e", script],
      {
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, DATABASE_PATH: path.join(temp, "test.db") },
      },
    );
    assert.equal(run.status, 0, run.stderr);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

void test("a pass with nothing to show fails the ticker instead of replacing a real review", () => {
  type Pass = Parameters<typeof unusablePass>[1];
  const empty: Pass = { evidence: [], status: "watch", action: "hold" };
  const found: Pass = {
    evidence: [{ claim: "Revenue rose", source: "pack.json", date: "2026" }],
    status: "watch",
    action: "hold",
  };
  assert.match(unusablePass("FULL", empty) ?? "", /no evidence/);
  assert.match(
    unusablePass("LIGHT", { ...empty, status: "no_change", action: "add" }) ??
      "",
    /no evidence/,
  );
  assert.equal(
    unusablePass("LIGHT", { ...empty, status: "no_change", action: "hold" }),
    null,
  );
  assert.match(unusablePass("FULL", found, { checks: [] }) ?? "", /no checks/);
  assert.equal(unusablePass("FULL", found), null);
});

void test("a stored FMP error or empty quote is fetched again and replaced", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "portchecker-fmp-test-"));
  const script = `
    import assert from 'node:assert/strict';
    const {client}=await import(${JSON.stringify(new URL("./db/index.ts", import.meta.url).href)});
    await client.executeMultiple('CREATE TABLE fmp_cache(ticker TEXT,endpoint TEXT,fetched_on TEXT,payload_json TEXT,PRIMARY KEY(ticker,endpoint,fetched_on));');
    const {fetchProfile,today}=await import(${JSON.stringify(new URL("./fmp.ts", import.meta.url).href)});
    await client.execute({sql:'INSERT INTO fmp_cache VALUES (?,?,?,?)',args:['AAA','profile',today(),JSON.stringify({'Error Message':'temporary'})]});
    await client.execute({sql:'INSERT INTO fmp_cache VALUES (?,?,?,?)',args:['BBB','profile',today(),'[]']});
    let calls=0;
    globalThis.fetch=async()=>{calls+=1;return Response.json([{companyName:'Recovered'}]);};
    assert.equal((await fetchProfile('AAA')).companyName,'Recovered');
    assert.equal(calls,1);
    assert.equal((await fetchProfile('AAA')).companyName,'Recovered');
    assert.equal(calls,1);
    assert.equal((await fetchProfile('BBB')).companyName,'Recovered');
    assert.equal(calls,2);
    client.close();
  `;
  try {
    const run = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          DATABASE_PATH: path.join(temp, "test.db"),
          FMP_API_KEY: "test-key",
        },
      },
    );
    assert.equal(run.status, 0, run.stderr);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

void test("a 6-K's PDF exhibit is named, a failed exhibit list retries, and a plain cover passes", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "portchecker-6k-test-"));
  const script = `
    import assert from 'node:assert/strict';
    const {client}=await import(${JSON.stringify(new URL("./db/index.ts", import.meta.url).href)});
    const {fetchEventText}=await import(${JSON.stringify(new URL("./edgar.ts", import.meta.url).href)});
    const row={accessionNo:'acc',ticker:'TEST',form:'6-K',filedAt:'2026-11-04',primaryDocUrl:'https://www.sec.gov/Archives/test/cover.htm'};
    const isIndex=url=>String(url).endsWith('-index.html');
    globalThis.fetch=async url=>new Response(isIndex(url)?'<table><tr><td>1</td><td>Results</td><td><a href="results.pdf">results.pdf</a></td><td>EX-99.1</td><td>9000</td></tr></table>':'COVER');
    const pdf=await fetchEventText(row);
    assert.ok(pdf.includes('https://www.sec.gov/Archives/test/results.pdf'));
    assert.ok(pdf.includes('was not read'));
    assert.ok(pdf.includes('COVER'));
    globalThis.fetch=async url=>{if(isIndex(url))throw new Error('down');return new Response('COVER');};
    await assert.rejects(fetchEventText(row),/Could not resolve/);
    globalThis.fetch=async url=>new Response(isIndex(url)?'<table></table>':'COVER');
    assert.equal(await fetchEventText(row),'COVER');
    client.close();
  `;
  try {
    const run = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          DATABASE_PATH: path.join(temp, "test.db"),
          SEC_USER_AGENT: "Portchecker test contact",
        },
      },
    );
    assert.equal(run.status, 0, run.stderr);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

void test("the page shows a pack's warnings but not the guidance written for models", () => {
  const warning = "The newest quarterly statement is more than 120 days old.";
  assert.deepEqual(dataWarnings([...PACK_DATA_NOTES, warning]), [warning]);
  assert.deepEqual(dataWarnings(undefined), []);
});

void test("only silence stops a call: activity keeps pushing the limit back", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fired = 0;
  const stall = stallTimer(60, () => (fired += 1));
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(30);
    stall.touch();
  }
  assert.equal(fired, 0);
  t.mock.timers.tick(59);
  assert.equal(fired, 0);
  t.mock.timers.tick(1);
  assert.equal(fired, 1);
  stall.stop();
});

void test("routine filings cannot push the latest annual report off the list", () => {
  const rows = [
    ...Array.from({ length: 30 }, () => ({ form: "6-K" })),
    { form: "20-F" },
    { form: "20-F" },
  ];
  const listed = filingsToList(rows);
  assert.equal(listed.length, 21);
  assert.equal(listed.filter((f) => f.form === "20-F").length, 1);
  assert.equal(filingsToList(rows.slice(0, 5)).length, 5);
});

// Vendor rows must be reconciled before entering the valuation block ------------------------------

const quarterRow = (date: string, extra: Record<string, unknown> = {}) => ({
  date,
  period: "Q3",
  fiscalYear: date.slice(0, 4),
  reportedCurrency: "USD",
  revenue: 1_000,
  operatingIncome: 200,
  incomeBeforeTax: 200,
  incomeTaxExpense: 40,
  netIncomeFromContinuingOperations: 160,
  netIncome: 160,
  epsDiluted: 1,
  ...extra,
});
const QUARTER_ENDS = [
  "2026-09-30",
  "2026-06-30",
  "2026-03-31",
  "2025-12-31",
  "2025-09-30",
  "2025-06-30",
  "2025-03-31",
  "2024-12-31",
];
const incomeRows = (
  extra: (i: number) => Record<string, unknown> = () => ({}),
) => QUARTER_ENDS.map((d, i) => quarterRow(d, extra(i)));
const cashRows = (extra: (i: number) => Record<string, unknown> = () => ({})) =>
  QUARTER_ENDS.map((date, i) => ({
    date,
    period: "Q3",
    fiscalYear: date.slice(0, 4),
    reportedCurrency: "USD",
    netIncome: 160,
    operatingCashFlow: 100,
    capitalExpenditure: -10,
    freeCashFlow: 90,
    ...extra(i),
  }));
const contextOf = (overrides: Partial<Parameters<typeof fmpFixture>[0]>) =>
  fundamentalContext(
    fmpFixture({
      quote: { price: 100, marketCap: 10_000 },
      income: incomeRows(),
      cashFlow: cashRows(),
      keyMetricsTtm: { freeCashFlowYieldTTM: 0.036, evToEBITDATTM: 12 },
      ...overrides,
    }),
    "2026-11-05",
  );

void test("cash flow rows that contradict the income statement give no free cash flow, as CBOE's did", () => {
  const clean = contextOf({});
  assert.equal(clean?.growth.free_cash_flow_ttm, 360);
  assert.ok(clean?.data_notes.every((n) => !n.includes("cash flow rows")));

  const context = contextOf({
    cashFlow: cashRows((i) => (i === 0 ? { netIncome: 2_026 } : {})),
  });
  assert.equal(context?.growth.free_cash_flow_ttm, null);
  assert.equal(context?.valuation.fcf_yield_ttm_pct, null);
  // The year before is untouched by a bad row in this one.
  assert.equal(context?.growth.free_cash_flow_prior_ttm, 360);
  const note = context?.data_notes.find((n) => n.includes("cash flow rows"));
  assert.match(note ?? "", /net income of 2026 against 160/);
  assert.match(note ?? "", /freeCashFlowYieldTTM/);
});

void test("a positive capital spending figure is not trusted, as EXPE's was not", () => {
  const context = contextOf({
    cashFlow: cashRows((i) => (i === 0 ? { capitalExpenditure: 383 } : {})),
  });
  assert.equal(context?.valuation.fcf_yield_ttm_pct, null);
  assert.ok(
    context?.data_notes.some((n) => n.includes("capital spending of +383")),
  );
});

void test("a small gap in cash flow net income is minority interest, not a bad row", () => {
  const context = contextOf({
    cashFlow: cashRows((i) => (i === 0 ? { netIncome: 161.5 } : {})),
  });
  assert.equal(context?.growth.free_cash_flow_ttm, 360);
});

void test("a provision stored as a negative still adds up, and a row that truly does not is flagged", () => {
  const signFlipped = contextOf({
    income: incomeRows((i) =>
      i === 0
        ? {
            incomeBeforeTax: 1303,
            incomeTaxExpense: -264,
            netIncomeFromContinuingOperations: 1039,
            netIncome: 1030,
          }
        : {},
    ),
  });
  assert.ok(
    signFlipped?.data_notes.every((n) => !n.includes("does not add up")),
  );

  const benefit = contextOf({
    income: incomeRows((i) =>
      i === 0
        ? {
            incomeBeforeTax: 2232,
            incomeTaxExpense: -5138,
            netIncomeFromContinuingOperations: 7370,
            netIncome: 7370,
          }
        : {},
    ),
  });
  assert.ok(benefit?.data_notes.every((n) => !n.includes("does not add up")));

  const broken = contextOf({
    income: incomeRows((i) =>
      i === 0
        ? {
            incomeBeforeTax: 1173,
            incomeTaxExpense: -8027,
            netIncomeFromContinuingOperations: 13378,
            netIncome: 1252,
          }
        : {},
    ),
  });
  assert.ok(broken?.data_notes.some((n) => n.includes("does not add up")));
});

void test("EBITDA that does not fit its own row leaves out the EV multiple, as QCOM's did", () => {
  const fits = contextOf({
    income: incomeRows(() => ({
      ebitda: 240,
      interestExpense: 10,
      depreciationAndAmortization: 30,
    })),
  });
  assert.equal(fits?.valuation.ev_to_ebitda_ttm, 12);

  const context = contextOf({
    income: incomeRows((i) => ({
      ebitda: i === 0 ? -1303 : 240,
      interestExpense: 10,
      depreciationAndAmortization: 30,
    })),
  });
  assert.equal(context?.valuation.ev_to_ebitda_ttm, null);
  assert.ok(
    context?.data_notes.some(
      (n) => n.includes("EBITDA") && n.includes("Q3 2026"),
    ),
  );
});

void test("a bank or broker gets no EV multiple or cash yield, and an exchange keeps them", () => {
  const profile = (industry: string) => ({ industry });
  for (const industry of [
    "Banks - Diversified",
    "Financial - Capital Markets",
  ]) {
    const context = contextOf({
      profile: profile(industry),
      keyMetrics: [
        { date: "2025-12-31", evToEBITDA: 14, freeCashFlowYield: -0.2 },
      ],
    });
    assert.equal(context?.valuation.ev_to_ebitda_ttm, null, industry);
    assert.equal(
      context?.valuation.ev_to_ebitda_median_last_5_fiscal_years,
      null,
    );
    assert.equal(context?.valuation.fcf_yield_ttm_pct, null);
    assert.equal(
      context?.valuation.fcf_yield_median_last_5_fiscal_years_pct,
      null,
    );
    assert.equal(context?.growth.free_cash_flow_ttm, null);
    assert.ok(context?.data_notes.some((n) => n.includes("bank or broker")));
  }
  const exchange = contextOf({
    profile: profile("Financial - Data & Stock Exchanges"),
  });
  assert.equal(exchange?.valuation.ev_to_ebitda_ttm, 12);
  assert.ok(exchange?.data_notes.every((n) => !n.includes("bank or broker")));
});

void test("gross vendor revenue gives way to reported revenue, as C's and CBOE's did", () => {
  const context = contextOf({
    income: incomeRows((i) => ({
      revenue: i === 0 ? 45_628 : 43_845,
      operatingIncome: i === 0 ? 7_307 : 7_000,
    })),
    earnings: [
      { date: "2027-01-14", epsActual: null, epsEstimated: 2 },
      {
        date: "2026-10-13",
        epsActual: 2,
        epsEstimated: 2,
        revenueActual: 23_845,
      },
      {
        date: "2026-07-14",
        epsActual: 2,
        epsEstimated: 2,
        revenueActual: 24_766,
      },
      {
        date: "2025-10-14",
        epsActual: 2,
        epsEstimated: 2,
        revenueActual: 22_079,
      },
    ],
  });
  assert.equal(context?.growth.revenue_basis, "reported");
  assert.equal(Math.round(context?.growth.revenue_yoy_pct ?? 0), 8);
  assert.equal(
    Math.round((context?.growth.operating_margin_pct ?? 0) * 10) / 10,
    30.6,
  );
  assert.ok(
    context?.data_notes.some((n) => n.includes("45628") && n.includes("23845")),
  );
});

void test("reported revenue close to the statement leaves the vendor's figures alone", () => {
  const context = contextOf({
    earnings: [
      {
        date: "2026-10-13",
        epsActual: 2,
        epsEstimated: 2,
        revenueActual: 1_050,
      },
    ],
  });
  assert.equal(context?.growth.revenue_basis, "vendor_statement");
  assert.equal(context?.growth.revenue_yoy_pct, 0);
});

void test("revenue in another currency is not mistaken for a gross basis, as NVO's was not", () => {
  const context = contextOf({
    income: incomeRows(() => ({ reportedCurrency: "DKK", revenue: 78_488 })),
    earnings: [
      {
        date: "2026-10-05",
        epsActual: 2,
        epsEstimated: 2,
        revenueActual: 12_130,
      },
    ],
  });
  assert.equal(context?.growth.revenue_basis, "vendor_statement");
});

void test("trailing earnings that lean on gains outside operations are named, as AMZN's were not", () => {
  const context = contextOf({
    income: incomeRows(() => ({
      operatingIncome: 120,
      incomeBeforeTax: 200,
      netIncome: 160,
    })),
  });
  const note = context?.data_notes.find((n) =>
    n.includes("outside operations"),
  );
  assert.match(note ?? "", /40% of pretax income/);
  // Market value 10,000 over net income scaled to operations: 640 x 480 / 800 = 384.
  assert.match(note ?? "", /near 26\.0/);
  assert.equal(
    Math.round((context?.valuation.pe_ttm_without_other_income ?? 0) * 10) / 10,
    26,
  );
  const plain = contextOf({});
  assert.equal(plain?.valuation.pe_ttm_without_other_income, null);
  assert.ok(plain?.data_notes.every((n) => !n.includes("outside operations")));
});

void test("net income above pretax income says a tax benefit is in it, as QCOM's was", () => {
  const context = contextOf({
    income: incomeRows(() => ({ incomeBeforeTax: 200, netIncome: 340 })),
  });
  const note = context?.data_notes.find((n) => n.includes("tax benefit"));
  assert.match(note ?? "", /above pretax income/);
  assert.match(note ?? "", /12\.5 times pretax income/);
  assert.ok(contextOf({})?.data_notes.every((n) => !n.includes("tax benefit")));
});

void test("results filed after the quote was priced are stated, as EXPE's were", () => {
  // 2026-11-04 16:00:00 ET.
  const quote = { price: 100, marketCap: 10_000, timestamp: 1793826000 };
  const after = contextOf({
    quote,
    income: incomeRows((i) =>
      i === 0 ? { acceptedDate: "2026-11-04 16:00:23" } : {},
    ),
  });
  assert.ok(
    after?.data_notes.some(
      (n) => n.includes("16:00:23") && n.includes("does not reflect"),
    ),
  );
  const before = contextOf({
    quote,
    income: incomeRows((i) =>
      i === 0 ? { acceptedDate: "2026-10-30 08:16:33" } : {},
    ),
  });
  assert.ok(before?.data_notes.every((n) => !n.includes("does not reflect")));
});

void test("the five years behind the medians are all given", () => {
  const years = ["2025", "2024", "2023", "2022", "2021"];
  const context = contextOf({
    ratios: years.map((y, i) => ({
      date: `${y}-12-31`,
      priceToEarningsRatio: i === 4 ? -3 : 20 + i,
    })),
    keyMetrics: years.map((y, i) => ({
      date: `${y}-12-31`,
      evToEBITDA: 10 + i,
      freeCashFlowYield: 0.01 * (i + 1),
    })),
  });
  const history = context?.valuation.history_by_fiscal_year ?? [];
  assert.equal(history.length, 5);
  assert.deepEqual(history[1], {
    fiscal_year_end: "2024-12-31",
    pe: 21,
    ev_to_ebitda: 11,
    fcf_yield_pct: 2,
  });
  // A loss year has no P/E, as in the range and median.
  assert.equal(history[4]?.pe, null);
});

void test("a fund's yield is worked out at today's price from the whole year, as SCHD's was not", () => {
  const history = Array.from({ length: 251 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 10, 4) - i * 86400000 * 1.45)
      .toISOString()
      .slice(0, 10),
    price: i === 0 ? 36.21 : 26.57,
  }));
  const start = String(history[history.length - 1]?.date);
  const summary = priceSummary(history, [
    { date: "2026-09-23", dividend: 0.2665 },
    { date: "2026-06-24", dividend: 0.2525 },
    { date: "2026-03-25", dividend: 0.2569 },
    { date: "2025-12-10", dividend: 0.2782 },
    { date: start, dividend: 0.26 },
  ]);
  assert.equal(summary?.start_date, start);
  assert.equal(summary?.start_price, 26.57);
  assert.equal(summary?.distributions_1y, 1.0541);
  assert.equal(summary?.distributions_1y_count, 4);
  assert.equal(summary?.distribution_yield_1y_pct, 2.91);
  // With no proof the list reaches the start, nothing is claimed.
  const unsure = priceSummary(history);
  assert.equal(unsure?.distributions_1y, null);
  assert.equal(unsure?.distribution_yield_1y_pct, null);
});

void test("standing notes and prompts explain concentration, cash flow and one-off items", () => {
  assert.ok(
    PACK_DATA_NOTES.some((n) => n.includes("portfolio_sector_weights")),
  );
  assert.ok(PACK_DATA_NOTES.some((n) => n.includes("capitalized software")));
  assert.ok(
    PACK_DATA_NOTES.some((n) => n.includes("distribution_yield_1y_pct")),
  );
  assert.match(BRIEF_PROMPT, /would stop or reverse the action/);
  assert.match(
    analystPrompt({
      depth: "FULL",
      date: "2026-11-05",
      quantity: 1,
      weightPct: 1,
      hasThesis: false,
    }),
    /gains, reversals, write-downs or tax items/,
  );
});

void test("a year-ago reported figure on the old gross basis gives no growth rate, as CBOE's did not", () => {
  const context = contextOf({
    income: incomeRows((i) => ({
      revenue: i === 0 ? 1_359 : 1_142,
      operatingIncome: i === 0 ? 534 : 370,
    })),
    earnings: [
      { date: "2026-10-30", epsActual: 2, epsEstimated: 2, revenueActual: 712 },
      {
        date: "2025-10-31",
        epsActual: 2,
        epsEstimated: 2,
        revenueActual: 1_142,
      },
    ],
  });
  assert.equal(context?.growth.revenue_basis, "reported");
  assert.equal(context?.growth.revenue_yoy_pct, null);
  assert.equal(Math.round(context?.growth.operating_margin_pct ?? 0), 75);
  assert.equal(context?.growth.operating_margin_year_ago_pct, null);
  assert.ok(
    context?.data_notes.some((n) => n.includes("not on the same basis")),
  );
});

void test("a bad row a year back only costs the year-earlier total", () => {
  const context = contextOf({
    cashFlow: cashRows((i) => (i === 7 ? { capitalExpenditure: 130 } : {})),
  });
  assert.equal(context?.growth.free_cash_flow_ttm, 360);
  assert.ok(Math.abs((context?.valuation.fcf_yield_ttm_pct ?? 0) - 3.6) < 1e-9);
  assert.equal(context?.growth.free_cash_flow_prior_ttm, null);
  assert.ok(
    context?.data_notes.every((n) => !n.includes("freeCashFlowYieldTTM")),
  );
  assert.ok(context?.data_notes.some((n) => n.includes("year-earlier")));
});

void test("a small quarter's few dollars of difference are not a bad row, as BMY's was not", () => {
  const context = contextOf({
    income: incomeRows((i) =>
      i === 0 ? { revenue: 12_300, netIncome: 72 } : {},
    ),
    cashFlow: cashRows((i) => (i === 0 ? { netIncome: 76 } : {})),
  });
  assert.equal(context?.growth.free_cash_flow_ttm, 360);
});

void test("the page's key numbers follow the same checks as the review", () => {
  const income = [
    {
      date: "2026-09-30",
      period: "Q3",
      fiscalYear: "2026",
      reportedCurrency: "USD",
      revenue: 45_628_000_000,
      netIncome: 5_245_000_000,
    },
  ];
  const cash = [
    {
      date: "2026-09-30",
      period: "Q3",
      fiscalYear: "2026",
      reportedCurrency: "USD",
      operatingCashFlow: -1_157_000_000,
      freeCashFlow: -774_000_000,
    },
  ];
  const quarter = (growth?: Record<string, unknown>) =>
    keyNumbers({
      income_statement_quarterly: income,
      cash_flow_quarterly: cash,
      valuation_and_growth: growth ? { growth } : null,
    }).find((g) => g.title.startsWith("Latest quarter"))?.rows ?? [];
  const value = (rows: [string, string][], label: string) =>
    rows.find(([name]) => name === label)?.[1];
  // A pack written before these checks reads as it always did.
  assert.equal(value(quarter(), "Revenue"), "$45.63B");
  assert.equal(value(quarter(), "Free cash flow"), "−$774M");
  const checked = quarter({
    latest_quarter_reported_revenue: 23_845_000_000,
    latest_quarter_free_cash_flow_usable: false,
  });
  assert.equal(value(checked, "Revenue"), "$23.85B");
  assert.equal(value(checked, "Free cash flow"), undefined);
});

void test("the thesis prompt requires concentration, dated valuation and measurable break conditions", () => {
  const prompt = thesisDraftPrompt("NVDA");
  assert.match(prompt, /gains, reversals, write-downs or tax items/);
  assert.match(prompt, /a few customers or a related party/);
  assert.match(prompt, /the date of that value/);
  assert.match(prompt, /Each break condition needs one of them/);
  assert.match(prompt, /3 to 6 bullets of at most 35 words/);
});
