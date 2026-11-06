import "./test-env.ts";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { client } from "./db/index.ts";
import {
  fundamentalContext,
  priceSummary,
  relativeToMarket,
  type FmpData,
  type Row,
} from "./fmp.ts";
import {
  dataWarnings,
  keyNumbers,
  vendorFilingGaps,
  writePack,
} from "./research/pack.ts";
import { PACK_DATA_NOTES } from "./research/prompts.ts";

before(() =>
  client.executeMultiple(
    "CREATE TABLE filings(accession_no TEXT,ticker TEXT,form TEXT,filed_at TEXT,primary_doc_url TEXT,items TEXT,sections_json TEXT,processed_at TEXT,PRIMARY KEY(accession_no,ticker));",
  ),
);
after(() => client.close());

const AS_OF = "2026-11-05";
const QUARTERS: [string, string, string][] = [
  ["2026-09-30", "Q3", "2026"],
  ["2026-06-30", "Q2", "2026"],
  ["2026-03-31", "Q1", "2026"],
  ["2025-12-31", "Q4", "2025"],
  ["2025-09-30", "Q3", "2025"],
  ["2025-06-30", "Q2", "2025"],
  ["2025-03-31", "Q1", "2025"],
  ["2024-12-31", "Q4", "2024"],
];

/** Eight quarters that add up in every way the checks look at. */
const incomeRows = (extra: (i: number) => Row = () => ({})) =>
  QUARTERS.map(([date, period, fiscalYear], i) => ({
    date,
    period,
    fiscalYear,
    reportedCurrency: "USD",
    revenue: 1_000,
    operatingIncome: 200,
    incomeBeforeTax: 200,
    interestExpense: 10,
    depreciationAndAmortization: 40,
    ebitda: 250,
    incomeTaxExpense: 40,
    netIncomeFromContinuingOperations: 160,
    netIncome: 160,
    epsDiluted: 2,
    ...extra(i),
  }));
const cashRows = (extra: (i: number) => Row = () => ({})) =>
  QUARTERS.map(([date, period, fiscalYear], i) => ({
    date,
    period,
    fiscalYear,
    reportedCurrency: "USD",
    netIncome: 160,
    operatingCashFlow: 100,
    capitalExpenditure: -10,
    freeCashFlow: 90,
    ...extra(i),
  }));

const fmp = (overrides: Partial<FmpData> = {}): FmpData => ({
  isFund: false,
  profile: { industry: "Semiconductors" },
  quote: { price: 100, marketCap: 10_000 },
  income: incomeRows(),
  balance: [],
  cashFlow: cashRows(),
  keyMetrics: [],
  keyMetricsTtm: { freeCashFlowYieldTTM: 0.036, evToEBITDATTM: 12 },
  ratios: [],
  ratiosTtm: { priceToEarningsRatioTTM: 15 },
  history: [],
  news: [],
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
const context = (overrides: Partial<FmpData> = {}) =>
  fundamentalContext(fmp(overrides), AS_OF);
const noteWith = (
  c: ReturnType<typeof context>,
  text: string | RegExp,
): string | undefined =>
  c?.data_notes.find((n) =>
    typeof text === "string" ? n.includes(text) : text.test(n),
  );

// The vendor's revenue for C against what it reported, with its net income, in millions.
const C_QUARTERS = [
  { vendor: 45_628, reported: 23_845, net: 5_245 },
  { vendor: 45_302, reported: 24_766, net: 5_831 },
  { vendor: 44_435, reported: 24_633, net: 5_785 },
  { vendor: 40_654, reported: 19_871, net: 2_471 },
];
const reportedAfter = (i: number, revenueActual: number) => ({
  date: new Date(Date.parse(QUARTERS[i]![0]) + 14 * 86400000)
    .toISOString()
    .slice(0, 10),
  epsActual: 1,
  revenueActual,
});
const grossFiler = (overrides: Partial<FmpData> = {}) => ({
  income: incomeRows((i) =>
    C_QUARTERS[i]
      ? { revenue: C_QUARTERS[i].vendor, netIncome: C_QUARTERS[i].net }
      : {},
  ),
  earnings: C_QUARTERS.map((q, i) => reportedAfter(i, q.reported)),
  ...overrides,
});
const numberOf = (groups: ReturnType<typeof keyNumbers>, label: string) =>
  groups.flatMap((g) => g.rows).find(([name]) => name === label)?.[1];

void test("net margin rests on reported revenue where the vendor's is gross, as C's did not", () => {
  const c = context(grossFiler());
  assert.equal(c?.growth.revenue_basis, "reported");
  const margin = c?.growth.net_margin_ttm_on_reported_revenue ?? 0;
  assert.ok(Math.abs(margin - 19_332 / 93_115) < 1e-9);
  const groups = keyNumbers({
    ratios_ttm: { netProfitMarginTTM: 0.1098 },
    valuation_and_growth: { growth: c?.growth },
  });
  assert.equal(numberOf(groups, "Net margin"), "20.8%");
  const note = noteWith(c, "Vendor revenue for");
  assert.match(
    note ?? "",
    /vendor's own margins, price-to-sales and EV-to-sales/,
  );
});

void test("the vendor's net margin stays where revenue is not gross, and in older packs", () => {
  const vendorBasis = keyNumbers({
    ratios_ttm: { netProfitMarginTTM: 0.1234 },
    valuation_and_growth: { growth: { revenue_basis: "vendor_statement" } },
  });
  assert.equal(numberOf(vendorBasis, "Net margin"), "12.3%");
  const olderPack = keyNumbers({ ratios_ttm: { netProfitMarginTTM: 0.1234 } });
  assert.equal(numberOf(olderPack, "Net margin"), "12.3%");
  assert.equal(
    context()?.growth.net_margin_ttm_on_reported_revenue,
    null,
    "a holding whose revenue is not gross keeps the vendor's margin",
  );
});

void test("no net margin is shown when four reported quarters cannot be proved", () => {
  const groups = keyNumbers({
    ratios_ttm: { netProfitMarginTTM: 0.1098 },
    valuation_and_growth: {
      growth: {
        revenue_basis: "reported",
        net_margin_ttm_on_reported_revenue: null,
      },
    },
  });
  assert.equal(numberOf(groups, "Net margin"), undefined);

  // The vendor's older reported figure can still be gross, as CBOE's was.
  const offBasis = grossFiler();
  offBasis.earnings[2] = reportedAfter(2, C_QUARTERS[2]!.vendor);
  assert.equal(
    context(offBasis)?.growth.net_margin_ttm_on_reported_revenue,
    null,
  );

  // A missing quarter would make the last four span more than a year.
  const notConsecutive = grossFiler();
  notConsecutive.income.splice(2, 1);
  notConsecutive.earnings.push(reportedAfter(4, 500));
  assert.equal(
    context(notConsecutive)?.growth.net_margin_ttm_on_reported_revenue,
    null,
  );

  const mixed = grossFiler();
  mixed.income[1] = { ...mixed.income[1]!, reportedCurrency: "EUR" };
  assert.equal(context(mixed)?.growth.net_margin_ttm_on_reported_revenue, null);
});

// A pack is a light one here, so nothing but the database's empty filings table is read.
async function savedPack(overrides: Partial<FmpData>) {
  const temp = mkdtempSync(path.join(tmpdir(), "portchecker-fmp-context-"));
  const start = process.cwd();
  process.chdir(temp);
  try {
    mkdirSync(path.join("data", "dossiers"), { recursive: true });
    writeFileSync(path.join("data", "dossiers", "TEST.md"), "# TEST");
    const { dir } = await writePack({
      ticker: "TEST",
      date: AS_OF,
      fmp: fmp(overrides),
      includeFilings: false,
    });
    return JSON.parse(readFileSync(path.join(dir, "pack.json"), "utf8")) as {
      data_notes: string[];
      key_metrics_ttm: Row | null;
      ratios_ttm: Row | null;
      key_metrics_annual: Row[];
      ratios_annual: Row[];
      dividends: Row[];
      price_summary: Row | null;
    };
  } finally {
    process.chdir(start);
    rmSync(temp, { recursive: true, force: true });
  }
}

const VENDOR_TTM = {
  keyMetricsTtm: {
    marketCap: 10_000,
    enterpriseValueTTM: 11_000,
    evToEBITDATTM: 12,
    netDebtToEBITDATTM: 1,
    freeCashFlowYieldTTM: 0.036,
    evToFreeCashFlowTTM: 30,
    evToOperatingCashFlowTTM: 27,
    incomeQualityTTM: 0.6,
    returnOnEquityTTM: 0.2,
  },
  ratiosTtm: {
    priceToEarningsRatioTTM: 15,
    enterpriseValueMultipleTTM: 12,
    ebitdaMarginTTM: 0.25,
    netProfitMarginTTM: 0.16,
    priceToFreeCashFlowRatioTTM: 28,
    priceToOperatingCashFlowRatioTTM: 25,
    freeCashFlowPerShareTTM: 3.6,
    operatingCashFlowPerShareTTM: 4,
  },
};
const EBITDA_FIELDS = [
  "evToEBITDATTM",
  "netDebtToEBITDATTM",
  "enterpriseValueMultipleTTM",
  "ebitdaMarginTTM",
];
const CASH_FIELDS = [
  "freeCashFlowYieldTTM",
  "evToFreeCashFlowTTM",
  "evToOperatingCashFlowTTM",
  "incomeQualityTTM",
  "priceToFreeCashFlowRatioTTM",
  "priceToOperatingCashFlowRatioTTM",
  "freeCashFlowPerShareTTM",
  "operatingCashFlowPerShareTTM",
];
const ttmFields = (pack: Awaited<ReturnType<typeof savedPack>>) => [
  ...Object.keys(pack.key_metrics_ttm ?? {}),
  ...Object.keys(pack.ratios_ttm ?? {}),
];
// QCOM's Q4 2026: EBITDA of -1,303 on pretax income of 1,173.
const badEbitda = () =>
  incomeRows((i) =>
    i === 0
      ? {
          period: "Q4",
          ebitda: -1_303,
          incomeBeforeTax: 1_173,
          interestExpense: 849,
          depreciationAndAmortization: 806,
        }
      : {},
  );

void test("EBITDA that is left out does not stay in the pack under another name, as QCOM's 22.57 did", async () => {
  const pack = await savedPack({ ...VENDOR_TTM, income: badEbitda() });
  const fields = ttmFields(pack);
  for (const field of EBITDA_FIELDS)
    assert.ok(!fields.includes(field), `${field} is still in the pack`);
  // Everything that does not rest on the bad figure stays.
  for (const field of [
    "enterpriseValueTTM",
    "priceToEarningsRatioTTM",
    "netProfitMarginTTM",
    "returnOnEquityTTM",
    ...CASH_FIELDS,
  ])
    assert.ok(fields.includes(field), `${field} was lost`);
});

void test("cash flow measures that are left out go under every name, as CBOE's 179.81 and 121.59 did not", async () => {
  const pack = await savedPack({
    ...VENDOR_TTM,
    cashFlow: cashRows((i) => (i === 0 ? { netIncome: 2_026 } : {})),
  });
  const fields = ttmFields(pack);
  for (const field of CASH_FIELDS)
    assert.ok(!fields.includes(field), `${field} is still in the pack`);
  for (const field of [...EBITDA_FIELDS, "priceToEarningsRatioTTM"])
    assert.ok(fields.includes(field), `${field} was lost`);
});

void test("a holding with nothing in doubt keeps every vendor field, and so does a fund", async () => {
  const clean = await savedPack(VENDOR_TTM);
  for (const field of [...EBITDA_FIELDS, ...CASH_FIELDS])
    assert.ok(ttmFields(clean).includes(field), `${field} was lost`);

  const fund = await savedPack({
    ...VENDOR_TTM,
    isFund: true,
    income: [],
    cashFlow: [],
  });
  for (const field of [...EBITDA_FIELDS, ...CASH_FIELDS])
    assert.ok(ttmFields(fund).includes(field), `${field} was lost from a fund`);
});

const ANNUAL = {
  keyMetrics: [
    { date: "2026-09-27", fiscalYear: "2026", evToEBITDA: 24.25 },
    { date: "2025-09-28", fiscalYear: "2025", evToEBITDA: 12.71 },
    { date: "2024-09-29", fiscalYear: "2024", evToEBITDA: 15.49 },
    { date: "2023-09-24", fiscalYear: "2023", evToEBITDA: 13.24 },
    { date: "2022-09-25", fiscalYear: "2022", evToEBITDA: 8.13 },
  ].map((r) => ({
    ...r,
    netDebtToEBITDA: 1,
    freeCashFlowYield: 0.05,
    evToFreeCashFlow: 20,
    marketCap: 10_000,
  })),
  ratios: [
    "2026-09-27",
    "2025-09-28",
    "2024-09-29",
    "2023-09-24",
    "2022-09-25",
  ].map((date, i) => ({
    date,
    fiscalYear: String(2026 - i),
    priceToEarningsRatio: 20,
    enterpriseValueMultiple: 13,
    ebitdaMargin: 0.3,
    priceToFreeCashFlowRatio: 20,
    netProfitMargin: 0.2,
  })),
};

void test("annual EBITDA measures stay excluded when the ratios history is absent", async () => {
  const pack = await savedPack({
    ...ANNUAL,
    ratios: [],
    income: badEbitda(),
  });
  assert.equal(pack.key_metrics_annual[0]?.evToEBITDA, undefined);
  assert.equal(pack.key_metrics_annual[0]?.netDebtToEBITDA, undefined);
  assert.equal(pack.key_metrics_annual[0]?.marketCap, 10_000);
  assert.equal(pack.key_metrics_annual[1]?.evToEBITDA, 12.71);
});

void test("filing amounts must agree with the vendor's financial sign", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "portchecker-filing-sign-"));
  try {
    for (const [line, value, warns] of [
      ["Operating income 650 600", -650e6, true],
      ["Operating income (650) 600", 650e6, true],
      ["Operating income (650) 600", -650e6, false],
      ["Operating income -650 600", -650e6, false],
      ["Operating income −650 600", -650e6, false],
      ["Operating income ( $650 ) 600", -650e6, false],
      ["Operating loss 650 600", -650e6, false],
      ["Operating loss 650 600", 650e6, true],
      ["Operating losses 650 600", -650e6, false],
      ["Operating losses 650 600", 650e6, true],
      ["Operating income (losses) 650 600", 650e6, false],
      ["Operating income (loss) 650 600", 650e6, false],
    ] as const) {
      writeFileSync(
        path.join(dir, "filing_10-Q_2026-10-30_test.txt"),
        `Revenue 1,000 950\n${line}\nNet income 100 90`,
      );
      const notes = vendorFilingGaps(
        dir,
        fmp({
          cashFlow: [],
          income: [
            {
              date: "2026-09-30",
              revenue: 1e9,
              operatingIncome: value,
              netIncome: 100e6,
            },
          ],
        }),
      );
      assert.equal(
        notes.some((n) => n.includes("latest quarter operating income")),
        warns,
        line,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a bare net losses amount is an outflow while mixed income and losses follows the amount's sign", () => {
  for (const [line, value, warns] of [
    ["Net losses 650 600", 650e6, true],
    ["Net losses 650 600", -650e6, false],
    ["Net income (losses) 650 600", 650e6, false],
    ["Net income (losses) (650) 600", -650e6, false],
  ] as const) {
    assert.equal(
      gapsWith(
        { [TEN_Q]: line },
        { cashFlow: [], income: [{ date: "2026-09-30", netIncome: value }] },
      ).some((n) => n.includes("latest quarter net income")),
      warns,
      line,
    );
  }
});

void test("filing comparisons require the requested quarter's column", () => {
  for (const [line, latestWarns, priorWarns] of [
    ["Operating income 650 600", false, true],
    ["Operating income 732 650", true, false],
    ["Operating income 732 600 650 650", true, true],
    ["Operating income 650 650", false, false],
    ["Operating income — 650", true, false],
    ["Operating income - 650", true, false],
  ] as const) {
    const notes = gapsWith(
      { [TEN_Q]: line },
      {
        cashFlow: [],
        income: incomeRows((i) => ({
          revenue: 0,
          netIncome: 0,
          operatingIncome: i === 0 || i === 4 ? 650e6 : 0,
        })),
      },
    );
    assert.equal(
      notes.some((n) => n.includes("latest quarter operating income")),
      latestWarns,
      line,
    );
    assert.equal(
      notes.some((n) => n.includes("year-ago quarter operating income")),
      priorWarns,
      line,
    );
  }
});

void test("current-period filing columns tolerate currency, signs, scales and clear note references", () => {
  for (const [line, value] of [
    ["Operating income $650 600", 650e6],
    ["Operating income (loss) $(650) 600", -650e6],
    ["Operating income - $650 600", -650e6],
    ["Operating income −€650 600", -650e6],
    ["Operating income (Note 3) USD 650,000 600,000", 650e6],
    ["Operating income [1] £650,000,000 600,000,000", 650e6],
    ["Operating income (a) 650.5 600.0", 650.5e6],
    ["Operating income¹ 650 600", 650e6],
  ] as const) {
    assert.equal(
      gapsWith(
        { [TEN_Q]: line },
        {
          cashFlow: [],
          income: [{ date: "2026-09-30", operatingIncome: value }],
        },
      ).some((n) => n.includes("latest quarter operating income")),
      false,
      line,
    );
  }
});

void test("year-to-date totals and reversed year columns do not confirm the latest quarter", () => {
  for (const text of [
    "Nine Months Ended September 30\n2026 2025\nOperating income 650 600",
    "Three Months Ended September 30\n2025 2026\nOperating income 650 732",
    "Operating income increased from 600 to 650 million.",
  ]) {
    assert.equal(
      gapsWith(
        { [TEN_Q]: text },
        {
          cashFlow: [],
          income: [{ date: "2026-09-30", operatingIncome: 650e6 }],
        },
      ).some((n) => n.includes("latest quarter operating income")),
      true,
      text,
    );
  }
});

void test("dated headers identify current and year-ago quarters across a different fiscal year", () => {
  assert.deepEqual(
    gapsWith(
      {
        "filing_10-Q_2026-08-26_test.txt":
          "For the Quarter Ended July 26, 2026\n\n\n\n\n\nThree Months Ended Six Months Ended\nJul 26, 2026 Jul 27, 2025 Jul 26, 2026 Jul 27, 2025\nRevenue $96,221 $46,743 $177,837 $90,805",
      },
      {
        cashFlow: [],
        income: [
          {
            date: "2026-07-26",
            period: "Q2",
            fiscalYear: "2027",
            revenue: 96_221e6,
          },
          {
            date: "2025-07-27",
            period: "Q2",
            fiscalYear: "2026",
            revenue: 46_743e6,
          },
        ],
      },
    ),
    [],
  );
});

void test("quarter columns can follow year-to-date totals and reverse the year order", () => {
  const notes = gapsWith(
    {
      [TEN_Q]:
        "Nine Months Ended Three Months Ended\n2025 2026 2025 2026\nOperating income 650 650 650 732",
    },
    {
      cashFlow: [],
      income: incomeRows((i) => ({
        revenue: 0,
        netIncome: 0,
        operatingIncome: i === 0 || i === 4 ? 650e6 : 0,
      })),
    },
  );
  assert.equal(
    notes.some((n) => n.includes("latest quarter operating income")),
    true,
  );
  assert.equal(
    notes.some((n) => n.includes("year-ago quarter operating income")),
    false,
  );
});

void test("a fiscal year holding a quarter with bad EBITDA is left out of the EV/EBITDA history and median, as QCOM's 24.25 was not", async () => {
  const c = context({ ...ANNUAL, income: badEbitda() });
  const history = c?.valuation.history_by_fiscal_year ?? [];
  assert.equal(history.length, 5);
  assert.equal(history[0]?.ev_to_ebitda, null);
  assert.equal(history[0]?.pe, 20);
  assert.equal(history[1]?.ev_to_ebitda, 12.71);
  // Median of 12.71, 15.49, 13.24 and 8.13. With 24.25 in, it was 13.24.
  assert.ok(
    Math.abs(
      (c?.valuation.ev_to_ebitda_median_last_5_fiscal_years ?? 0) - 12.975,
    ) < 1e-9,
  );
  assert.match(noteWith(c, "fiscal year history") ?? "", /fiscal 2026/);

  const pack = await savedPack({ ...ANNUAL, income: badEbitda() });
  const [newestMetrics, olderMetrics] = pack.key_metrics_annual;
  const [newestRatios, olderRatios] = pack.ratios_annual;
  assert.equal(newestMetrics?.evToEBITDA, undefined);
  assert.equal(newestMetrics?.netDebtToEBITDA, undefined);
  assert.equal(newestRatios?.enterpriseValueMultiple, undefined);
  assert.equal(newestRatios?.ebitdaMargin, undefined);
  assert.equal(newestMetrics?.marketCap, 10_000);
  assert.equal(newestMetrics?.freeCashFlowYield, 0.05);
  assert.equal(newestRatios?.netProfitMargin, 0.2);
  // The year before has no bad quarter, so it keeps its figures.
  assert.equal(olderMetrics?.evToEBITDA, 12.71);
  assert.equal(olderRatios?.enterpriseValueMultiple, 13);
});

void test("a bad quarter from the year before still blanks its year after it leaves the trailing window", () => {
  const c = context({
    ...ANNUAL,
    income: incomeRows((i) =>
      i === 5 ? { ebitda: -1_303, fiscalYear: "2025" } : {},
    ),
  });
  assert.equal(c?.valuation.ev_to_ebitda_ttm, 12);
  const history = c?.valuation.history_by_fiscal_year ?? [];
  assert.equal(history[0]?.ev_to_ebitda, 24.25);
  assert.equal(history[1]?.ev_to_ebitda, null);
  // Median of 24.25, 15.49, 13.24 and 8.13.
  const median = c?.valuation.ev_to_ebitda_median_last_5_fiscal_years ?? 0;
  assert.ok(Math.abs(median - 14.365) < 1e-9);
  assert.match(noteWith(c, "fiscal year history") ?? "", /fiscal 2025/);
});

void test("a bad quarter changes no history when its year has no annual row, as CME's and EXPE's did not", () => {
  const annual = {
    keyMetrics: ANNUAL.keyMetrics.slice(1),
    ratios: ANNUAL.ratios.slice(1),
  };
  const income = badEbitda();
  const c = context({ ...annual, income });
  assert.deepEqual(
    c?.valuation.history_by_fiscal_year.map((y) => y.ev_to_ebitda),
    [12.71, 15.49, 13.24, 8.13],
  );
  assert.ok(
    Math.abs(
      (c?.valuation.ev_to_ebitda_median_last_5_fiscal_years ?? 0) - 12.975,
    ) < 1e-9,
  );
  assert.equal(c?.valuation.ev_to_ebitda_ttm, null);
  assert.equal(noteWith(c, "fiscal year history"), undefined);

  // Rows with no fiscal year cannot be matched to a year, so they change nothing.
  const unlabelled = context({
    keyMetrics: [{ date: "2025-12-31", evToEBITDA: 9 }],
    ratios: [{ date: "2025-12-31", priceToEarningsRatio: 20 }],
    income: income.map((r) => ({ ...r, fiscalYear: undefined })),
  });
  assert.equal(
    unlabelled?.valuation.history_by_fiscal_year[0]?.ev_to_ebitda,
    9,
  );
});

const AMZN_ESTIMATES = [
  { date: "2027-12-31", epsAvg: 10.8, revenueAvg: 900 },
  { date: "2026-12-31", epsAvg: 12.84, revenueAvg: 800 },
];
// Over 40% of pretax income from outside operations, as at AMZN.
const outsideOperations = () => incomeRows(() => ({ operatingIncome: 120 }));

void test("the multiple on next year is given, and gains in this year's estimate are named, as AMZN's were not", () => {
  const c = context({
    quote: { price: 266.03, marketCap: 10_000 },
    estimates: AMZN_ESTIMATES,
    income: outsideOperations(),
  });
  assert.ok(Math.abs((c?.valuation.next_year_pe ?? 0) - 266.03 / 10.8) < 1e-9);
  const note = noteWith(c, "next-year P/E");
  assert.match(note ?? "", /12\.84/);
  assert.match(note ?? "", /10\.80/);
  assert.match(note ?? "", /forward P\/E/);
  assert.ok(
    PACK_DATA_NOTES.some((n) => n.includes("next_year_pe")),
    "the field is explained in the standing notes",
  );
});

void test("gains are not named when estimates rise, as CME's and NVDA's do", () => {
  const c = context({
    quote: { price: 100, marketCap: 10_000 },
    estimates: [
      { date: "2027-12-31", epsAvg: 14 },
      { date: "2026-12-31", epsAvg: 12 },
    ],
    income: outsideOperations(),
  });
  assert.ok(Math.abs((c?.valuation.next_year_pe ?? 0) - 100 / 14) < 1e-9);
  assert.equal(noteWith(c, "next-year P/E"), undefined);

  // Falling estimates with no such income say nothing about gains either.
  const operating = context({
    quote: { price: 100, marketCap: 10_000 },
    estimates: AMZN_ESTIMATES,
  });
  assert.equal(noteWith(operating, "next-year P/E"), undefined);
});

void test("no multiple on next year without a positive estimate", () => {
  const loss = context({
    estimates: [
      { date: "2027-12-31", epsAvg: -1 },
      { date: "2026-12-31", epsAvg: 12 },
    ],
  });
  assert.equal(loss?.valuation.next_year_pe, null);
  assert.equal(loss?.valuation.forward_pe, 100 / 12);
  assert.equal(
    context({ estimates: [{ date: "2026-12-31", epsAvg: 12 }] })?.valuation
      .next_year_pe,
    null,
  );
});

// NVO on 2026-11-05: a dollar quote and kroner statements, where the two market caps give the rate.
const NVO_EPS = [4.74, 10.91, 6.04, 4.5];
const nvo = (overrides: Partial<FmpData> = {}) => ({
  quote: { price: 42.18, marketCap: 185_981_960_174 },
  keyMetricsTtm: { marketCap: 1_257_516_826_582 },
  ratiosTtm: { priceToEarningsRatioTTM: 10.8772 },
  income: QUARTERS.slice(1).map(([date, period, fiscalYear], i) => ({
    date,
    period,
    fiscalYear,
    reportedCurrency: "DKK",
    epsDiluted: NVO_EPS[i] ?? 5,
  })),
  cashFlow: [],
  estimates: [
    { date: "2026-12-31", epsAvg: 22.25 },
    { date: "2027-12-31", epsAvg: 22.1 },
  ],
  ...overrides,
});

void test("a filer in another currency gets a forward P/E from the rate the vendor's own caps imply", () => {
  const c = context(nvo());
  assert.ok(Math.abs((c?.valuation.forward_pe ?? 0) - 12.82) < 0.01);
  assert.ok(Math.abs((c?.valuation.next_year_pe ?? 0) - 12.9) < 0.01);
  const note = noteWith(c, "imply");
  assert.match(note ?? "", /6\.7615/);
  assert.match(note ?? "", /DKK/);
});

void test("no forward P/E comes from a rate that does not reconcile", () => {
  const forward = (o: Partial<FmpData>) => context(nvo(o))?.valuation;
  // Nothing to take the rate from.
  assert.equal(forward({ keyMetricsTtm: null })?.forward_pe, null);
  assert.equal(forward({ keyMetricsTtm: null })?.next_year_pe, null);
  assert.equal(
    forward({ quote: { price: 42.18, marketCap: null } })?.forward_pe,
    null,
  );
  assert.equal(forward({ ratiosTtm: null })?.forward_pe, null);
  // An ADR that holds two shares: the price no longer fits the vendor's trailing P/E.
  assert.equal(
    forward({ quote: { price: 84.36, marketCap: 185_981_960_174 } })
      ?.forward_pe,
    null,
  );
  // Estimates already in dollars would otherwise be 6.76 times too cheap.
  const inDollars = [
    { date: "2026-12-31", epsAvg: 22.25 / 6.76 },
    { date: "2027-12-31", epsAvg: 22.1 / 6.76 },
  ];
  const usdEstimates = forward({ estimates: inDollars });
  assert.equal(usdEstimates?.forward_pe, null);
  assert.equal(usdEstimates?.next_year_pe, null);
  // Quarters in two currencies cannot prove the trailing P/E.
  const mixed = nvo();
  mixed.income[1] = { ...mixed.income[1]!, reportedCurrency: "USD" };
  assert.equal(context(mixed)?.valuation.forward_pe, null);
});

void test("a filer in dollars gets the same forward P/E and no rate note", () => {
  const c = context({
    quote: { price: 100, marketCap: 10_000 },
    keyMetricsTtm: { marketCap: 10_000 },
    estimates: [{ date: "2026-12-31", epsAvg: 5 }],
  });
  assert.equal(c?.valuation.forward_pe, 20);
  assert.equal(noteWith(c, "imply"), undefined);
});

void test("a foreign filer's notes say which figures are in dollars, as NVO's did not", () => {
  const notes = (o: Partial<FmpData> = {}) =>
    (context(nvo(o))?.data_notes ?? []).filter((n) =>
      n.includes("earnings history"),
    );
  assert.equal(notes().length, 1);
  assert.match(notes()[0] ?? "", /DKK/);
  assert.match(notes()[0] ?? "", /US dollars/);
  assert.equal(noteWith(context(), "earnings history"), undefined);
  // With no stated currency nothing can be said about it.
  const noCurrency = context({
    income: incomeRows(() => ({ reportedCurrency: undefined })),
  });
  assert.equal(noteWith(noCurrency, "earnings history"), undefined);
});

const debtRows = (balance: Row, growth?: Row) =>
  keyNumbers({
    income_statement_quarterly: [incomeRows()[0]],
    balance_sheet_quarterly: [
      {
        date: "2026-09-30",
        period: "Q3",
        fiscalYear: "2026",
        reportedCurrency: "USD",
        cashAndCashEquivalents: 5_000_000_000,
        ...balance,
      },
    ],
    valuation_and_growth: growth ? { growth } : null,
  });

void test("the debt row says when it holds leases, as MSFT's and AMZN's did not", () => {
  const leases = debtRows({
    totalDebt: 133_931_000_000,
    capitalLeaseObligations: 98_450_000_000,
  });
  assert.equal(numberOf(leases, "Debt and leases"), "$133.93B");
  assert.equal(numberOf(leases, "Total debt"), undefined);

  const noLeases = debtRows({
    totalDebt: 15_112_000_000,
    capitalLeaseObligations: 0,
  });
  assert.equal(numberOf(noLeases, "Total debt"), "$15.11B");
  assert.equal(numberOf(noLeases, "Debt and leases"), undefined);
});

void test("a bank has no debt row, since C's holds repos and customer funds, and an older pack keeps its row", () => {
  const debt = { totalDebt: 817_477_000_000, capitalLeaseObligations: 0 };
  const bank = debtRows(debt, { bank_like: true });
  assert.equal(numberOf(bank, "Total debt"), undefined);
  assert.equal(numberOf(bank, "Cash and equivalents"), "$5B");
  assert.equal(numberOf(debtRows(debt), "Total debt"), "$817.48B");
  assert.equal(
    numberOf(debtRows(debt, { bank_like: false }), "Total debt"),
    "$817.48B",
  );
  assert.equal(
    context({ profile: { industry: "Banks - Diversified" } })?.growth.bank_like,
    true,
  );
  assert.equal(context()?.growth.bank_like, false);
});

void test("a debt row from a lagging balance sheet still names its quarter", () => {
  const lagging = debtRows({
    date: "2026-06-30",
    period: "Q2",
    totalDebt: 133_931_000_000,
    capitalLeaseObligations: 98_450_000_000,
  });
  assert.equal(numberOf(lagging, "Debt and leases, Q2 2026"), "$133.93B");
});

// CBOE: 2025's three quarters sum to 844.9M against the 1,400.5M its 10-Q prints.
const CBOE_CASH = [340.1, -503.2, 82, 377.8, 153.9, 437.2, 253.8, 377].map(
  (millions) => ({ operatingCashFlow: millions * 1e6 }),
);
const TEN_Q = "filing_10-Q_2026-10-30_0001.txt";
function gapsWith(
  files: Record<string, string>,
  overrides: Partial<FmpData> = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), "portchecker-fmp-gaps-"));
  try {
    for (const [name, text] of Object.entries(files))
      writeFileSync(path.join(dir, name), text);
    return vendorFilingGaps(
      dir,
      fmp({ cashFlow: cashRows((i) => CBOE_CASH[i] ?? {}), ...overrides }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const cashNote = (notes: string[]) =>
  notes.find((n) => n.includes("operating cash flow"));

void test("cash used in operations keeps the outflow sign when the amount has no minus sign", () => {
  const overrides = {
    income: [{ date: "2026-09-30", period: "Q1", fiscalYear: "2026" }],
    cashFlow: [
      {
        date: "2026-09-30",
        period: "Q1",
        fiscalYear: "2026",
        operatingCashFlow: -81.1e6,
      },
    ],
  };
  for (const [text, warns] of [
    ["Net cash used in operating activities 81.1", false],
    ["Net cash used in operations $81.1", false],
    ["Net cash provided by operating activities 81.1", true],
    ["Net cash provided by (used in) operating activities (81.1)", false],
    ["Net cash provided by (used in) operating activities 81.1", true],
  ] as const) {
    assert.equal(
      Boolean(cashNote(gapsWith({ [TEN_Q]: text }, overrides))),
      warns,
      text,
    );
  }
});

void test("vendor cash flow that does not sum to the 10-Q's year-to-date figure is flagged, as CBOE's 2025 was not", () => {
  // The current year's negative sum matches, while the prior year's 844.9M does not.
  const note = cashNote(
    gapsWith({
      [TEN_Q]:
        "Net cash provided by (used in) operating activities (81.1) 1,400.5.",
    }),
  );
  assert.match(note ?? "", /fiscal 2025 Q1 to Q3/);
  assert.match(note ?? "", /844900000/);
  assert.match(note ?? "", /10-Q filed 2026-10-30/);
  assert.match(note ?? "", /year-earlier free cash flow/);
});

void test("vendor cash flow that sums to what the 10-Q prints raises nothing", () => {
  const note = cashNote(
    gapsWith({
      [TEN_Q]:
        "Net cash provided by (used in) operating activities (81.1) 844.9.",
    }),
  );
  assert.equal(note, undefined);
});

void test("cash flow sums must match their own year-to-date columns", () => {
  assert.match(
    cashNote(
      gapsWith({
        [TEN_Q]:
          "Net cash provided by (used in) operating activities 844.9 (81.1)",
      }),
    ) ?? "",
    /fiscal 2026 Q1 to Q3/,
  );
  assert.equal(
    cashNote(
      gapsWith({
        [TEN_Q]:
          "Three Months Ended Nine Months Ended Twelve Months Ended\n2025 2026 2025 2026 2025 2026\nNet cash provided by (used in) operating activities 10 20 844.9 (81.1) 30 40",
      }),
    ),
    undefined,
  );
});

void test("a missing quarter, a bank, or no filing for the period raises no cash flow alarm", () => {
  const text = {
    [TEN_Q]:
      "Net cash provided by (used in) operating activities 2,273.9 1,400.5.",
  };
  // The vendor's zero means it has no data yet, as with SCHW's latest quarter.
  const zeroInBothYears = cashRows((i) => ({
    ...CBOE_CASH[i],
    ...(i === 0 || i === 4 ? { operatingCashFlow: 0 } : {}),
  }));
  assert.equal(
    cashNote(gapsWith(text, { cashFlow: zeroInBothYears })),
    undefined,
  );
  assert.equal(
    cashNote(
      gapsWith(text, { profile: { industry: "Financial - Capital Markets" } }),
    ),
    undefined,
  );
  // Filed before the quarter ended, so it says nothing about this period.
  assert.equal(
    cashNote(gapsWith({ "filing_10-Q_2026-07-29_0001.txt": "Nothing." })),
    undefined,
  );
  assert.equal(cashNote(gapsWith({})), undefined);
  assert.equal(cashNote(gapsWith(text, { cashFlow: [] })), undefined);
});

void test("an annual report is compared only with a whole year, and a lagging cash statement with nothing", () => {
  const fourth = (rows: Row[]) =>
    rows.map((r, i) => {
      const [date, period, fiscalYear] = QUARTERS[i + 3] ?? [];
      return { ...r, date, period, fiscalYear };
    });
  const income = fourth(incomeRows().slice(0, 5));
  const cashFlow = fourth(
    cashRows((i) => ({ operatingCashFlow: 100e6 + i * 1e6 })).slice(0, 5),
  );
  // 2025's four quarters total 406M. A 10-K that prints it raises nothing, and one that does not does.
  const TEN_K = "filing_10-K_2026-02-20_0001.txt";
  assert.equal(
    cashNote(
      gapsWith(
        { [TEN_K]: "Net cash from operating activities 406." },
        { income, cashFlow },
      ),
    ),
    undefined,
  );
  assert.match(
    cashNote(
      gapsWith(
        { [TEN_K]: "Net cash from operating activities 999." },
        { income, cashFlow },
      ),
    ) ?? "",
    /fiscal 2025 Q1 to Q4.*10-K filed 2026-02-20/,
  );
  // The cash statement is a quarter behind the 10-Q, so its sum is for another period.
  assert.equal(
    cashNote(
      gapsWith(
        { [TEN_Q]: "Net cash from operating activities 999." },
        { cashFlow: cashRows((i) => CBOE_CASH[i] ?? {}).slice(1) },
      ),
    ),
    undefined,
  );
});

void test("free cash flow that is not its own parts gives no total or yield", () => {
  const bad = context({
    cashFlow: cashRows(() => ({ freeCashFlow: 900 })),
    keyMetricsTtm: { freeCashFlowYieldTTM: 0.36 },
  });
  assert.equal(bad?.growth.free_cash_flow_ttm, null);
  assert.equal(bad?.growth.free_cash_flow_prior_ttm, null);
  assert.equal(bad?.valuation.fcf_yield_ttm_pct, null);
  assert.equal(bad?.growth.latest_quarter_free_cash_flow_usable, false);
  assert.match(
    noteWith(bad, "cash flow rows are unreliable") ?? "",
    /free cash flow of 900 against operating cash flow of 100 and capital spending of -10/,
  );
});

void test("free cash flow within rounding of its parts stands, and a quarter with no data is not a conflict", () => {
  const rounded = context({
    cashFlow: cashRows(() => ({ freeCashFlow: 90.5 })),
  });
  assert.equal(rounded?.growth.free_cash_flow_ttm, 362);
  // A row that omits capital spending cannot be checked this way.
  const noCapex = context({
    cashFlow: cashRows(() => ({ capitalExpenditure: undefined })),
  });
  assert.equal(noCapex?.growth.free_cash_flow_ttm, 360);
  const missing = context({
    cashFlow: cashRows((i) =>
      i === 0
        ? { operatingCashFlow: 0, capitalExpenditure: 0, freeCashFlow: -900 }
        : {},
    ),
  });
  assert.equal(missing?.growth.free_cash_flow_ttm, null);
  assert.equal(noteWith(missing, "free cash flow of -900"), undefined);
});

void test("trailing cash flow is not added across currencies", () => {
  const mixed = context({
    cashFlow: cashRows((i) => (i === 2 ? { reportedCurrency: "EUR" } : {})),
    keyMetricsTtm: { freeCashFlowYieldTTM: 0.036 },
  });
  assert.equal(mixed?.growth.free_cash_flow_ttm, null);
  assert.equal(mixed?.valuation.fcf_yield_ttm_pct, null);
  // The year before is one currency, so it stands.
  assert.equal(mixed?.growth.free_cash_flow_prior_ttm, 360);
  const note = noteWith(mixed, "more than one currency");
  assert.match(note ?? "", /EUR/);
  assert.match(note ?? "", /USD/);

  const before = context({
    cashFlow: cashRows((i) => (i === 6 ? { reportedCurrency: "EUR" } : {})),
  });
  assert.equal(before?.growth.free_cash_flow_ttm, 360);
  assert.equal(before?.growth.free_cash_flow_prior_ttm, null);
  assert.match(noteWith(before, "year-earlier") ?? "", /EUR/);

  const unstated = context({
    cashFlow: cashRows((i) => (i === 1 ? { reportedCurrency: null } : {})),
  });
  assert.equal(unstated?.growth.free_cash_flow_ttm, null);
});

void test("cash flow in one currency against statements in another gives no total", () => {
  const c = context({
    cashFlow: cashRows(() => ({ reportedCurrency: "EUR" })),
    keyMetricsTtm: {},
  });
  assert.equal(c?.growth.reporting_currency, "USD");
  assert.equal(c?.growth.free_cash_flow_ttm, null);
  assert.equal(c?.growth.free_cash_flow_prior_ttm, null);
  assert.match(noteWith(c, "more than one currency") ?? "", /EUR/);
});

void test("a filer wholly in its own currency keeps its cash flow totals", () => {
  const kroner = () => ({ reportedCurrency: "DKK" });
  const c = context({
    income: incomeRows(kroner),
    cashFlow: cashRows(kroner),
    keyMetricsTtm: { freeCashFlowYieldTTM: 0.05 },
  });
  assert.equal(c?.growth.free_cash_flow_ttm, 360);
  assert.equal(c?.growth.free_cash_flow_prior_ttm, 360);
  assert.equal(c?.valuation.fcf_yield_ttm_pct, 5);
  assert.equal(noteWith(c, "more than one currency"), undefined);
});

void test("old cash flow quarters give no year-earlier trailing total", () => {
  const old = cashRows((i) => ({
    date: QUARTERS[i]![0].replace(/^202[456]/, (year) =>
      String(Number(year) - 3),
    ),
  }));
  const stale = context({ cashFlow: old });
  assert.equal(stale?.growth.free_cash_flow_ttm, null);
  assert.equal(stale?.growth.free_cash_flow_prior_ttm, null);
});

void test("a recent cash flow total is not compared with four quarters from years earlier", () => {
  const cashFlow = cashRows((i) =>
    i < 4
      ? {}
      : {
          date: QUARTERS[i]![0].replace(/^202[45]/, (year) =>
            String(Number(year) - 3),
          ),
        },
  );
  const c = context({ cashFlow });
  assert.equal(c?.growth.free_cash_flow_ttm, 360);
  assert.equal(c?.growth.free_cash_flow_prior_ttm, null);
  assert.equal(context()?.growth.free_cash_flow_prior_ttm, 360);
});

void test("earnings in two currencies give no reading of income from outside operations", () => {
  const mixed = context({
    income: incomeRows((i) => ({
      operatingIncome: 120,
      ...(i === 1 ? { reportedCurrency: "EUR" } : {}),
    })),
  });
  assert.equal(noteWith(mixed, "outside operations"), undefined);
  assert.equal(mixed?.valuation.pe_ttm_without_other_income, null);
  assert.ok(
    noteWith(
      context({ income: incomeRows(() => ({ operatingIncome: 120 })) }),
      "outside operations",
    ),
  );
});

// AMZN's last four quarters, in millions: 40% of pretax income came from outside operations.
const AMZN_QUARTERS = [
  {
    operatingIncome: 28_076,
    depreciationAndAmortization: 20_949,
    pretax: 26_865,
  },
  {
    operatingIncome: 27_461,
    depreciationAndAmortization: 19_988,
    pretax: 80_857,
  },
  {
    operatingIncome: 23_852,
    depreciationAndAmortization: 18_945,
    pretax: 39_834,
  },
  {
    operatingIncome: 24_977,
    depreciationAndAmortization: 19_471,
    pretax: 26_138,
  },
];
const amznIncome = (extra: (i: number) => Row = () => ({})) =>
  incomeRows((i) => {
    const q = AMZN_QUARTERS[i];
    return q
      ? {
          operatingIncome: q.operatingIncome,
          depreciationAndAmortization: q.depreciationAndAmortization,
          incomeBeforeTax: q.pretax,
          ebitda: q.pretax + 10 + q.depreciationAndAmortization,
          ...extra(i),
        }
      : {};
  });
const AMZN_EV = {
  keyMetricsTtm: { enterpriseValueTTM: 3_092_775, evToEBITDATTM: 11.99 },
};

void test("EV/EBITDA is also given without outside gains, as AMZN's 11.99 against its 16.83 was not", () => {
  const c = context({ ...AMZN_EV, income: amznIncome() });
  const multiple = c?.valuation.ev_to_ebitda_ttm_without_other_income ?? 0;
  assert.ok(Math.abs(multiple - 3_092_775 / (104_366 + 79_353)) < 1e-9);
  assert.equal(c?.valuation.ev_to_ebitda_ttm, 11.99);
  assert.match(
    noteWith(c, "outside operations") ?? "",
    /EV\/EBITDA near 16\.8/,
  );
});

void test("no EV/EBITDA without outside gains from small gains, doubtful EBITDA, a bank or a missing figure", () => {
  const without = (o: Partial<FmpData>) =>
    context({ ...AMZN_EV, income: amznIncome(), ...o });
  const value = (o: Partial<FmpData>) =>
    without(o)?.valuation.ev_to_ebitda_ttm_without_other_income;
  // 8% from outside operations is under the point where the note speaks.
  const small = without({
    income: amznIncome((i) => {
      const op = AMZN_QUARTERS[i]?.operatingIncome ?? 0;
      return {
        incomeBeforeTax: op * 1.087,
        ebitda:
          op * 1.087 +
          10 +
          (AMZN_QUARTERS[i]?.depreciationAndAmortization ?? 0),
      };
    }),
  });
  assert.equal(small?.valuation.ev_to_ebitda_ttm_without_other_income, null);
  assert.doesNotMatch(small?.data_notes.join(" ") ?? "", /EV\/EBITDA near/);
  // CME's flagged EBITDA is left out, and must not come back as a precise replacement.
  assert.equal(
    value({ income: amznIncome((i) => (i === 1 ? { ebitda: -1_303 } : {})) }),
    null,
  );
  assert.equal(value({ profile: { industry: "Banks - Regional" } }), null);
  assert.equal(
    value({
      income: amznIncome((i) =>
        i === 2 ? { depreciationAndAmortization: undefined } : {},
      ),
    }),
    null,
  );
  assert.equal(value({ keyMetricsTtm: { evToEBITDATTM: 11.99 } }), null);
  // Enterprise value is in the filer's own currency, and this has only been proved in dollars.
  assert.equal(
    value({
      income: amznIncome().map((r) => ({ ...r, reportedCurrency: "DKK" })),
    }),
    null,
  );
});

// EXPE on 2026-11-05: the vendor's cap counts 114.5M common shares and not its 5.5M Class B.
const shareCounts = (price: number, marketCap: number, income: Row[]) =>
  context({ quote: { price, marketCap }, income });

void test("a market cap well below the share count says so, as EXPE's did not", () => {
  const note = noteWith(
    shareCounts(
      315.88,
      36_167_825_665,
      incomeRows(() => ({ weightedAverageShsOut: 119_900_000 })),
    ),
    "basic shares",
  );
  assert.match(note ?? "", /114\.5M shares/);
  assert.match(note ?? "", /119\.9M basic shares/);
  assert.match(note ?? "", /share class/);
  assert.match(note ?? "", /fallen/);
});

void test("a market cap near the share count, or with no count, raises nothing", () => {
  // SSNC: dilution is far above the cap's count, which basic shares do not confuse with a missing class.
  const ssnc = shareCounts(
    100,
    23_470_000_000,
    incomeRows(() => ({
      weightedAverageShsOut: 234_600_000,
      weightedAverageShsOutDil: 240_600_000,
    })),
  );
  assert.equal(noteWith(ssnc, "basic shares"), undefined);
  const noCount = shareCounts(315.88, 36_167_825_665, incomeRows());
  assert.equal(noteWith(noCount, "basic shares"), undefined);
  // An ADR that holds two shares is not 1:1 with the filer's count, and that is no missing class.
  const adr = shareCounts(
    100,
    10_000_000_000,
    incomeRows(() => ({
      reportedCurrency: "DKK",
      weightedAverageShsOut: 200_000_000,
    })),
  );
  assert.equal(noteWith(adr, "basic shares"), undefined);
});

const daysBefore = (end: string, days: number) =>
  new Date(Date.parse(end) - days * 86400000).toISOString().slice(0, 10);
const LATEST = "2026-11-04";
/** Newest first, `stepDays` apart, ending on LATEST. A real year is about 251 rows, 1.45 days apart. */
const prices = (rows: number, stepDays = 1) =>
  Array.from({ length: rows }, (_, i) => ({
    date: daysBefore(LATEST, Math.round(i * stepDays)),
    price: 100 + i,
  }));
const fullYear = () => prices(251, 1.45);

void test("a dividend is counted at its split-adjusted amount, on the basis prices are in", () => {
  const flat = [
    { date: LATEST, price: 50 },
    { date: "2025-11-04", price: 50 },
  ];
  const split = priceSummary(flat, [
    { date: "2026-06-01", dividend: 2, adjDividend: 1 },
    { date: "2025-11-04", dividend: 2, adjDividend: 1 },
  ]);
  assert.equal(split?.total_return_1y_pct, 2);
  assert.equal(split?.distribution_yield_1y_pct, 2);
  assert.equal(split?.distributions_1y, 1);
  // A row with no adjusted amount keeps the plain one.
  const plain = priceSummary(flat, [
    { date: "2026-06-01", dividend: 2 },
    { date: "2025-11-04", dividend: 2 },
  ]);
  assert.equal(plain?.total_return_1y_pct, 4);
});

void test("a short price history gives no one-year return, yield or comparison, as a new listing's did", () => {
  const spy = priceSummary(prices(365));
  const short = prices(60);
  const summary = priceSummary(short, []);
  assert.equal(summary?.price_return_1y_pct, null);
  assert.equal(summary?.return_1y_pct, null);
  assert.equal(summary?.total_return_1y_pct, null);
  assert.equal(summary?.distributions_1y, null);
  assert.equal(summary?.distribution_yield_1y_pct, null);
  // Shorter windows the history does cover stay, and the range states its own coverage.
  assert.notEqual(summary?.return_1m_pct, null);
  assert.equal(summary?.trading_days, 60);
  assert.equal(summary?.start_date, short[59]?.date);
  assert.equal(summary?.high_1y, 159);

  const relative = relativeToMarket(fmp({ history: short }), spy);
  assert.equal(relative?.["1_year_points"], null);
  assert.notEqual(relative?.["1_month_points"], null);

  assert.equal(priceSummary(prices(1), [])?.return_1y_pct, null);
  const rows = keyNumbers({ price_summary: summary });
  assert.equal(numberOf(rows, "1-year return"), undefined);
  // The range is still there, and does not call itself a year's.
  assert.equal(numberOf(rows, "1-year high"), undefined);
  assert.equal(numberOf(rows, `High since ${summary?.start_date}`), "$159.00");
  assert.equal(numberOf(rows, `Low since ${summary?.start_date}`), "$100.00");
});

void test("a month of history is not compared with SPY's year", () => {
  const spy = {
    latest_date: LATEST,
    start_date: "2025-11-05",
    return_1y_pct: 10,
  };
  const month = [
    { date: LATEST, price: 100 },
    { date: "2026-10-04", price: 50 },
  ];
  const relative = relativeToMarket(fmp({ history: month }), spy);
  assert.equal(relative?.["1_year_points"], null);
});

void test("a full year keeps its one-year figures and its comparison with SPY", () => {
  const spy = priceSummary(fullYear());
  const history = fullYear();
  const summary = priceSummary(history, [
    { date: "2026-06-01", dividend: 2 },
    { date: String(history[250]?.date), dividend: 2 },
  ]);
  assert.equal(summary?.price_return_1y_pct, -71.43);
  assert.equal(summary?.return_1y_pct, -71.43);
  assert.equal(summary?.distributions_1y, 2);
  assert.equal(summary?.total_return_1y_pct, -70.86);
  assert.equal(summary?.distribution_yield_1y_pct, 2);
  const groups = keyNumbers({ price_summary: summary });
  assert.equal(numberOf(groups, "1-year return"), "−71.43%");
  assert.equal(numberOf(groups, "1-year high"), "$350.00");
  assert.equal(numberOf(groups, "1-year low"), "$100.00");
  // A pack from before this field could be null reads as it always did.
  const older = keyNumbers({ price_summary: { high_1y: 120, low_1y: 80 } });
  assert.equal(numberOf(older, "1-year high"), "$120.00");
  const relative = relativeToMarket(fmp({ history }), spy);
  assert.equal(relative?.["1_year_points"], 0);
});

void test("a year that starts weeks apart from SPY's is no comparison, and a few days apart is", () => {
  const spy = {
    latest_date: LATEST,
    start_date: daysBefore(LATEST, 380),
    return_1y_pct: 10,
  };
  const year = prices(250, 355 / 249);
  assert.equal(
    relativeToMarket(fmp({ history: year }), spy)?.["1_year_points"],
    null,
  );
  const closeBy = { ...spy, start_date: daysBefore(LATEST, 360) };
  assert.notEqual(
    relativeToMarket(fmp({ history: year }), closeBy)?.["1_year_points"],
    null,
  );
  // With no start date for SPY, nothing proves the two windows match.
  assert.equal(
    relativeToMarket(fmp({ history: year }), {
      latest_date: LATEST,
      return_1y_pct: 10,
    })?.["1_year_points"],
    null,
  );
});

const DIVIDEND_YEAR = [
  { date: "2026-06-01", dividend: 3 },
  { date: "2025-11-04", dividend: 3 },
];
const flatYear = () => [
  { date: LATEST, price: 110 },
  { date: "2025-11-04", price: 100 },
];

void test("the total return gap against SPY includes dividends on both sides, as VOO's and VCSH's lacked", () => {
  const spy = priceSummary(flatYear(), [
    { date: "2026-06-01", dividend: 1 },
    { date: "2025-11-04", dividend: 1 },
  ]);
  const relative = relativeToMarket(
    fmp({ history: flatYear(), dividends: DIVIDEND_YEAR }),
    spy,
  );
  assert.equal(spy?.total_return_1y_pct, 11);
  assert.ok(
    Math.abs((relative?.["1_year_total_return_points"] ?? 0) - 2) < 1e-9,
  );
  // The price gap beside it is still the price gap.
  assert.equal(relative?.["1_year_points"], 0);
  assert.ok(
    PACK_DATA_NOTES.some((n) => n.includes("1_year_total_return_points")),
    "the field is explained in the standing notes",
  );
  // Old packs compare against this sentence, so it must not be reworded.
  assert.ok(
    PACK_DATA_NOTES.includes(
      "relative_to_sp500 compares price returns only, without dividends on either side, so it understates a high-yield holding.",
    ),
  );
});

void test("no total return gap when either side's dividends are unproved, or the windows differ", () => {
  const spy = priceSummary(flatYear(), DIVIDEND_YEAR);
  const gap = (holding: Partial<FmpData>, market: Row | null | undefined) =>
    relativeToMarket(fmp({ history: flatYear(), ...holding }), market)?.[
      "1_year_total_return_points"
    ];
  assert.equal(
    gap({ dividends: [], dividendsCoverageConfirmed: false }, spy),
    null,
  );
  assert.equal(
    gap({ dividends: DIVIDEND_YEAR }, priceSummary(flatYear())),
    null,
  );
  assert.equal(
    gap({ history: prices(60), dividends: DIVIDEND_YEAR }, spy),
    null,
  );
  assert.equal(
    gap({ dividends: DIVIDEND_YEAR }, { ...spy, start_date: "2025-09-01" }),
    null,
  );
});

const monthlyPayer = (extra: Row[] = []) => [
  ...extra,
  ...Array.from({ length: 16 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 9 - i, 15)).toISOString().slice(0, 10),
    dividend: 0.3,
  })),
];
const dividendRows = async (o: Partial<FmpData>) => {
  const pack = await savedPack({ history: flatYear(), ...o });
  const sum = pack.dividends
    .filter((d) => String(d.date) <= LATEST)
    .reduce((total, d) => total + Number(d.dividend), 0);
  return { pack, sum: Number(sum.toFixed(4)) };
};

void test("the pack lists every payment behind a monthly payer's total, as VCSH's 8 of 12 did not", async () => {
  const { pack, sum } = await dividendRows({ dividends: monthlyPayer() });
  assert.equal(pack.dividends.length, 12);
  assert.equal(pack.price_summary?.distributions_1y_count, 12);
  assert.equal(sum, pack.price_summary?.distributions_1y);
  // A declared payment still to come is ahead of the list, and must not push one out of it.
  const declared = await dividendRows({
    dividends: monthlyPayer([{ date: "2026-11-30", dividend: 0.3 }]),
  });
  assert.equal(declared.pack.dividends.length, 13);
  assert.equal(declared.sum, declared.pack.price_summary?.distributions_1y);
});

void test("the pack lists 8 payments for a quarterly payer, or when the total is unproved", async () => {
  const quarterly = Array.from({ length: 16 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 9 - i * 3, 15)).toISOString().slice(0, 10),
    dividend: 1,
  }));
  const { pack } = await dividendRows({ dividends: quarterly });
  assert.equal(pack.dividends.length, 8);
  const unproved = await dividendRows({
    dividends: monthlyPayer(),
    dividendsCoverageConfirmed: false,
  });
  assert.equal(unproved.pack.dividends.length, 8);
  assert.equal(unproved.pack.price_summary?.distributions_1y, null);
});

// C on 2026-11-05, with preferred stock the vendor counts as book.
const C_BOOK = {
  profile: { industry: "Banks - Diversified" },
  quote: { price: 124.75, marketCap: 209_260_640_000 },
  balance: [
    {
      reportedCurrency: "USD",
      totalStockholdersEquity: 209_409_000_000,
      preferredStock: 18_050_000_000,
    },
  ],
  ratiosTtm: { priceToEarningsRatioTTM: 15, priceToBookRatioTTM: 0.9957 },
  ratios: [1.0006, 0.6416, 0.4832, 0.4376, 0.6079].map((book, i) => ({
    date: `${2025 - i}-12-31`,
    fiscalYear: String(2025 - i),
    priceToBookRatio: book,
  })),
};

void test("a bank gets book value on common equity and the vendor's, as C's 0.996 needed", () => {
  const c = context(C_BOOK);
  const valuation = c?.valuation;
  assert.ok(
    Math.abs((valuation?.price_to_common_book_ttm ?? 0) - 1.0936) < 1e-3,
  );
  assert.equal(valuation?.price_to_book_ttm, 0.9957);
  assert.equal(valuation?.price_to_book_median_last_5_fiscal_years, 0.6079);
  assert.deepEqual(
    valuation?.history_by_fiscal_year.map((y) => y.price_to_book),
    [1.0006, 0.6416, 0.4832, 0.4376, 0.6079],
  );
  const note = noteWith(c, "bank or broker");
  assert.match(note ?? "", /count preferred stock as book/);
  assert.match(note ?? "", /common book/);
  // Text a person reads names no internal field.
  assert.doesNotMatch(note ?? "", /price_to_/);
  const groups = keyNumbers({ valuation_and_growth: c });
  assert.equal(numberOf(groups, "Price to common book"), "1.09");
});

void test("preferred stock missing from the newest row comes from the one before, as SCHW's did", () => {
  const c = context({
    ...C_BOOK,
    profile: { industry: "Financial - Capital Markets" },
    quote: { price: 93.37, marketCap: 161_468_475_800 },
    balance: [
      {
        reportedCurrency: "USD",
        totalStockholdersEquity: 51_400_000_000,
        preferredStock: 0,
      },
      {
        reportedCurrency: "USD",
        totalStockholdersEquity: 49_884_000_000,
        preferredStock: 6_763_000_000,
      },
    ],
  });
  assert.ok(
    Math.abs((c?.valuation.price_to_common_book_ttm ?? 0) - 3.6173) < 1e-3,
  );
});

void test("no price to common book when equity does not cover the preferred, or is in another currency", () => {
  const common = (balance: Row) =>
    context({ ...C_BOOK, balance: [{ ...C_BOOK.balance[0], ...balance }] })
      ?.valuation.price_to_common_book_ttm;
  assert.equal(common({ totalStockholdersEquity: 18_050_000_000 }), null);
  assert.equal(common({ totalStockholdersEquity: 1_000_000_000 }), null);
  assert.equal(common({ totalStockholdersEquity: null }), null);
  assert.equal(common({ reportedCurrency: "EUR" }), null);
  const noCap = context({ ...C_BOOK, quote: { price: 124.75 } });
  assert.equal(noCap?.valuation.price_to_common_book_ttm, null);
  assert.equal(
    context({ ...C_BOOK, balance: [] })?.valuation.price_to_common_book_ttm,
    null,
  );
});

void test("a company that is not a bank gets none of the book fields, and its history row is unchanged", () => {
  const c = context({ ...C_BOOK, profile: { industry: "Semiconductors" } });
  assert.equal("price_to_common_book_ttm" in (c?.valuation ?? {}), false);
  assert.equal("price_to_book_ttm" in (c?.valuation ?? {}), false);
  assert.deepEqual(Object.keys(c?.valuation.history_by_fiscal_year[0] ?? {}), [
    "fiscal_year_end",
    "pe",
    "ev_to_ebitda",
    "fcf_yield_pct",
  ]);
  assert.equal(
    numberOf(keyNumbers({ valuation_and_growth: c }), "Price to common book"),
    undefined,
  );
  assert.equal(noteWith(c, "common book"), undefined);
});

void test("insurers and mortgage lenders lose EV/EBITDA and cash yield as banks do, with a note in their own words", () => {
  for (const [industry, opening] of [
    ["Insurance - Property & Casualty", "This is an insurer, whose cash flow"],
    ["Insurance - Life", "This is an insurer, whose cash flow"],
    ["Insurance - Reinsurance", "This is an insurer, whose cash flow"],
    ["Insurance - Specialty", "This is an insurer, whose cash flow"],
    ["Insurance - Diversified", "This is an insurer, whose cash flow"],
    ["Financial - Mortgages", "This is a mortgage lender, whose debt"],
    ["REIT - Mortgage", "This is a mortgage lender, whose debt"],
    ["Banks - Regional", "This is a bank or broker, whose debt"],
  ] as const) {
    const c = context({ profile: { industry } });
    assert.equal(c?.valuation.ev_to_ebitda_ttm, null, industry);
    assert.equal(c?.valuation.fcf_yield_ttm_pct, null, industry);
    assert.equal(c?.growth.bank_like, true, industry);
    assert.match(noteWith(c, opening) ?? "", /left out here/, industry);
  }
});

void test("insurance brokers, credit services and exchanges keep EV/EBITDA and cash yield", () => {
  for (const industry of [
    "Insurance - Brokers",
    "Insurance Brokers",
    "Financial - Credit Services",
    "Financial - Data & Stock Exchanges",
    "Asset Management",
    "Software - Application",
  ]) {
    const c = context({ profile: { industry } });
    assert.equal(c?.valuation.ev_to_ebitda_ttm, 12, industry);
    assert.notEqual(c?.valuation.fcf_yield_ttm_pct, null, industry);
    assert.equal(c?.growth.bank_like, false, industry);
    assert.equal(noteWith(c, "left out here"), undefined, industry);
  }
});

void test("an insurer's debt row stays, since it is plain borrowing, while a bank's and a mortgage lender's go", () => {
  const debt = (industry: string) =>
    keyNumbers({
      company: { industry },
      income_statement_quarterly: [incomeRows()[0]],
      balance_sheet_quarterly: [
        {
          date: "2026-09-30",
          reportedCurrency: "USD",
          totalDebt: 5_000_000_000,
        },
      ],
      valuation_and_growth: { growth: { bank_like: true } },
    });
  assert.equal(numberOf(debt("Insurance - Life"), "Total debt"), "$5B");
  assert.equal(numberOf(debt("Banks - Regional"), "Total debt"), undefined);
  assert.equal(
    numberOf(debt("Financial - Mortgages"), "Total debt"),
    undefined,
  );
});

const LOSS_MAKER = {
  ratiosTtm: { priceToEarningsRatioTTM: -14.2, ebitdaMarginTTM: -0.3 },
  keyMetricsTtm: {
    evToEBITDATTM: -9.7,
    netDebtToEBITDATTM: -2,
    returnOnEquityTTM: -0.2,
  },
  keyMetrics: [
    {
      date: "2025-12-31",
      fiscalYear: "2025",
      evToEBITDA: -8,
      netDebtToEBITDA: -1,
    },
    { date: "2024-12-31", fiscalYear: "2024", evToEBITDA: 11 },
  ],
  ratios: [
    {
      date: "2025-12-31",
      fiscalYear: "2025",
      priceToEarningsRatio: -3,
      enterpriseValueMultiple: -8,
      ebitdaMargin: -0.25,
    },
    {
      date: "2024-12-31",
      fiscalYear: "2024",
      priceToEarningsRatio: 20,
      enterpriseValueMultiple: 11,
      ebitdaMargin: 0.2,
    },
  ],
};

void test("a loss-maker has no trailing or fiscal year multiple, since a negative one means nothing", () => {
  const c = context(LOSS_MAKER);
  assert.equal(c?.valuation.pe_ttm, null);
  assert.equal(c?.valuation.ev_to_ebitda_ttm, null);
  const history = c?.valuation.history_by_fiscal_year ?? [];
  assert.equal(history[0]?.pe, null);
  assert.equal(history[0]?.ev_to_ebitda, null);
  assert.equal(history[1]?.ev_to_ebitda, 11);
  const profitable = context();
  assert.equal(profitable?.valuation.pe_ttm, 15);
  assert.equal(profitable?.valuation.ev_to_ebitda_ttm, 12);
});

void test("the pack drops a loss-maker's negative multiples and keeps the margin that shows the loss", async () => {
  const pack = await savedPack(LOSS_MAKER);
  assert.equal(pack.key_metrics_ttm?.evToEBITDATTM, undefined);
  assert.equal(pack.key_metrics_ttm?.netDebtToEBITDATTM, undefined);
  assert.equal(pack.key_metrics_ttm?.returnOnEquityTTM, -0.2);
  assert.equal(pack.ratios_ttm?.ebitdaMarginTTM, -0.3);
  const [lossYear, goodYear] = pack.ratios_annual;
  assert.equal(lossYear?.enterpriseValueMultiple, undefined);
  assert.equal(lossYear?.ebitdaMargin, -0.25);
  assert.equal(goodYear?.enterpriseValueMultiple, 11);
  assert.equal(pack.key_metrics_annual[0]?.evToEBITDA, undefined);
  assert.equal(pack.key_metrics_annual[1]?.evToEBITDA, 11);
});

void test("the Numbers tab calls a negative or zero P/E not meaningful, and keeps a real or missing one as it was", () => {
  const pe = (priceToEarningsRatioTTM: unknown) =>
    numberOf(keyNumbers({ ratios_ttm: { priceToEarningsRatioTTM } }), "P/E");
  assert.equal(pe(-14.2), "Not meaningful");
  assert.equal(pe(0), "Not meaningful");
  assert.equal(pe(28.95), "28.95");
  assert.equal(pe(undefined), undefined);
});

const surprise = (epsActual: unknown, epsEstimated: unknown) =>
  context({ earnings: [{ date: "2026-10-20", epsActual, epsEstimated }] })
    ?.growth.last_eps_surprise_pct;

void test("an earnings surprise on an expected loss reads over the size of the estimate", () => {
  assert.equal(surprise(-0.5, -1), 50);
  assert.equal(surprise(-1.5, -1), -50);
  assert.equal(surprise(0.5, -1), 150);
  assert.ok(Math.abs((surprise(1.1, 1) ?? 0) - 10) < 1e-9);
  assert.ok(Math.abs((surprise(0.9, 1) ?? 0) + 10) < 1e-9);
  assert.ok(
    PACK_DATA_NOTES.some((n) => n.includes("last_eps_surprise_pct")),
    "the convention is stated in the standing notes",
  );
});

void test("no earnings surprise on a zero or missing estimate", () => {
  assert.equal(surprise(0.5, 0), null);
  assert.equal(surprise(0.5, null), null);
  assert.equal(surprise(0.5, undefined), null);
});

/**
 * Runs vendor calls in their own process, because the app reads the key when it loads. Every fetch
 * is answered here: `answers` maps an endpoint to what it says in turn, a status, 'throw' or a JSON
 * body, and the last one repeats. An endpoint with no answer gets an empty list.
 */
function withVendor(script: string) {
  const temp = mkdtempSync(path.join(tmpdir(), "portchecker-fmp-vendor-"));
  const app = (file: string) =>
    JSON.stringify(new URL(file, import.meta.url).href);
  try {
    const run = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--input-type=module",
        "--eval",
        `
        import assert from 'node:assert/strict';
        const {client}=await import(${app("./db/index.ts")});
        await client.executeMultiple('CREATE TABLE fmp_cache(ticker TEXT,endpoint TEXT,fetched_on TEXT,payload_json TEXT,PRIMARY KEY(ticker,endpoint,fetched_on));CREATE TABLE tickers(ticker TEXT PRIMARY KEY,cik TEXT,sector TEXT,industry TEXT,fmp_profile_json TEXT,last_full_review_at TEXT);');
        const {FmpRateLimitError,fetchFmpData,fetchMarketContext,fetchProfile,fundamentalContext,today}=await import(${app("./fmp.ts")});
        const realTimeout=globalThis.setTimeout;
        const waits=[];
        globalThis.setTimeout=(run,ms,...rest)=>{waits.push(ms);return realTimeout(run,Math.min(ms,1),...rest);};
        const calls=[];
        let answers={};
        globalThis.fetch=async(input)=>{
          const endpoint=new URL(String(input)).pathname.slice('/stable/'.length);
          calls.push(endpoint);
          const queue=answers[endpoint];
          if(!queue)return Response.json([]);
          const answer=queue.length>1?queue.shift():queue[0];
          if(answer==='throw')throw new TypeError('fetch failed');
          if(answer==='malformed')return new Response('{not json',{status:200});
          return typeof answer==='number'?new Response('',{status:answer}):Response.json(answer);
        };
        const asked=(endpoint)=>calls.filter((c)=>c===endpoint).length;
        const stored=async(endpoint,ticker)=>(await client.execute({sql:'SELECT payload_json FROM fmp_cache WHERE endpoint=? AND ticker=?',args:[endpoint,ticker]})).rows.map((r)=>r.payload_json);
        const quoted=[{symbol:'X',price:100}];
        ${script}
        client.close();
        process.exit(0);
        `,
      ],
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
}

void test("a refused quote is not remembered for the day and does not read as a wrong symbol", () => {
  withVendor(`
    answers={quote:[403,quoted],'key-metrics':[402]};
    await assert.rejects(fetchFmpData('AAA'),/FMP quote for AAA returned 403/);
    assert.deepEqual(await stored('quote','AAA'),[]);
    // The plan is fixed later the same day, and the holding comes back.
    assert.equal((await fetchFmpData('AAA')).quote.price,100);
    assert.equal(asked('quote'),2);
    assert.deepEqual(await stored('key-metrics','AAA'),['null']);
    // What the plan really does not cover is asked once a day.
    await fetchFmpData('AAA');
    assert.equal(asked('key-metrics'),1);
    assert.equal(asked('quote'),2);
  `);
});

void test("a 402 quote is refused the same way, and a 404 still reads as no such symbol", () => {
  withVendor(`
    answers={quote:[402]};
    await assert.rejects(fetchFmpData('AAA'),/FMP quote for AAA returned 402/);
    answers={quote:[404,quoted]};
    assert.equal((await fetchFmpData('BBB')).quote,null);
    assert.deepEqual(await stored('quote','BBB'),[]);
    assert.equal((await fetchFmpData('BBB')).quote.price,100);
  `);
});

void test("a null quote or profile stored by an earlier version is fetched again, and other nulls stay", () => {
  withVendor(`
    for(const endpoint of ['quote','profile','key-metrics'])
      await client.execute({sql:'INSERT INTO fmp_cache VALUES (?,?,?,?)',args:['AAA',endpoint,today(),'null']});
    answers={quote:[quoted],profile:[[{companyName:'Back',isEtf:false}]],'key-metrics':[[{date:'2025-12-31'}]]};
    const data=await fetchFmpData('AAA');
    assert.equal(data.quote.price,100);
    assert.equal(data.profile.companyName,'Back');
    assert.deepEqual(data.keyMetrics,[]);
    assert.equal(asked('key-metrics'),0);
  `);
});

void test("a refused profile is not remembered for the day either", () => {
  withVendor(`
    answers={profile:[403,[{companyName:'Back'}]]};
    assert.equal(await fetchProfile('AAA'),null);
    assert.deepEqual(await stored('profile','AAA'),[]);
    assert.equal((await fetchProfile('AAA')).companyName,'Back');
    assert.equal(asked('profile'),2);
  `);
});

void test("one vendor failure or dropped connection gets one retry, and the holding stays in the run", () => {
  withVendor(`
    answers={profile:[502,[{companyName:'Back'}]]};
    assert.equal((await fetchProfile('AAA')).companyName,'Back');
    assert.equal(asked('profile'),2);
    assert.ok(waits.includes(3000));
    assert.equal((await fetchProfile('AAA')).companyName,'Back');
    assert.equal(asked('profile'),2);

    answers={profile:['throw',[{companyName:'Back'}]]};
    assert.equal((await fetchProfile('BBB')).companyName,'Back');
    assert.equal(asked('profile'),4);

    // A failure on an optional endpoint must not lose the quote behind it.
    answers={'price-target-news':[503,[{newsTitle:'Raised'}]],quote:[quoted]};
    const data=await fetchFmpData('CCC');
    assert.equal(data.quote.price,100);
    assert.equal(data.priceTargetNews[0].newsTitle,'Raised');
  `);
});

void test("a successful HTTP response with malformed JSON gets one retry and caches only valid data", () => {
  withVendor(`
    answers={quote:['malformed',quoted]};
    assert.equal((await fetchFmpData('AAA')).quote.price,100);
    assert.equal(asked('quote'),2);
    assert.deepEqual(await stored('quote','AAA'),[JSON.stringify(quoted)]);
    await fetchFmpData('AAA');
    assert.equal(asked('quote'),2);
  `);
});

void test("malformed JSON that repeats stops after two requests without being cached", () => {
  withVendor(`
    answers={profile:['malformed']};
    await assert.rejects(fetchProfile('AAA'),SyntaxError);
    assert.equal(asked('profile'),2);
    assert.deepEqual(await stored('profile','AAA'),[]);
    answers={profile:[502,'malformed']};
    await assert.rejects(fetchProfile('BBB'),SyntaxError);
    assert.equal(asked('profile'),4);
    assert.deepEqual(await stored('profile','BBB'),[]);
  `);
});

void test("a failure that repeats ends in the same error as before, with no key in it", () => {
  withVendor(`
    answers={profile:[502]};
    await assert.rejects(fetchProfile('AAA'),(error)=>{
      assert.match(error.message,/^FMP profile for AAA returned 502$/);
      assert.doesNotMatch(error.message,/test-key/);
      return true;
    });
    assert.equal(asked('profile'),2);
    answers={profile:['throw']};
    await assert.rejects(fetchProfile('BBB'),/fetch failed/);
    assert.equal(asked('profile'),4);
    assert.deepEqual(await stored('profile','AAA'),[]);
    assert.deepEqual(await stored('profile','BBB'),[]);
  `);
});

void test("a status that will not change gets no retry, and rate limits work as before", () => {
  withVendor(`
    answers={profile:[401]};
    await assert.rejects(fetchProfile('AAA'),/returned 401/);
    assert.equal(asked('profile'),1);
    answers={profile:[429,[{companyName:'Back'}]]};
    assert.equal((await fetchProfile('BBB')).companyName,'Back');
    assert.equal(asked('profile'),3);
    answers={profile:[429]};
    await assert.rejects(fetchProfile('CCC'),FmpRateLimitError);
    assert.equal(asked('profile'),5);
  `);
});

const YEAR_OF_SPY = `
  const back=(days)=>{const d=new Date(today()+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-days);return d.toISOString().slice(0,10);};
  const spyPrices=[{date:back(0),price:110},{date:back(365),price:100}];
  const spyPaid=[{date:back(90),dividend:2,adjDividend:2},{date:back(365),dividend:2,adjDividend:2}];
`;

void test("SPY's total return comes from its own dividends", () => {
  withVendor(`${YEAR_OF_SPY}
    answers={'historical-price-eod/light':[spyPrices],dividends:[spyPaid]};
    const spy=(await fetchMarketContext()).sp500_proxy_spy;
    assert.equal(spy.price_return_1y_pct,10);
    assert.equal(spy.total_return_1y_pct,12);
    assert.equal(spy.distributions_1y,2);
  `);
});

void test("SPY dividends that cannot be had give no total return, keep the prices, and do not read as nothing paid", () => {
  withVendor(`${YEAR_OF_SPY}
    for(const refused of [402,404,500,'throw',[],{'Error Message':'Limit reached'}]){
      await client.execute('DELETE FROM fmp_cache');
      answers={'historical-price-eod/light':[spyPrices],dividends:[refused]};
      const spy=(await fetchMarketContext()).sp500_proxy_spy;
      assert.equal(spy.total_return_1y_pct,null,JSON.stringify(refused));
      assert.equal(spy.distributions_1y,null,JSON.stringify(refused));
      assert.equal(spy.price_return_1y_pct,10,JSON.stringify(refused));
    }
  `);
});

void test("in a busy week the economic event list keeps the soonest events, in date order", () => {
  withVendor(`
    const event=(date,i)=>({country:'US',impact:'High',date:date+' 13:30:00',event:'Report '+i,estimate:null});
    // The vendor lists the furthest first. Five events are on the soonest day.
    const later=Array.from({length:21},(_,i)=>event('2026-11-'+String(12-Math.floor(i/4)).padStart(2,'0'),i));
    const soonest=Array.from({length:5},(_,i)=>event('2026-11-05','soon '+i));
    answers={'economic-calendar':[[...later,...soonest,{country:'US',impact:'Low',date:'2026-11-05 13:30:00',event:'Quiet'},{country:'JP',impact:'High',date:'2026-11-05 13:30:00',event:'Abroad'}]]};
    const events=(await fetchMarketContext()).us_high_impact_events_next_7_days;
    assert.equal(events.length,20);
    assert.equal(events.filter((e)=>e.date.startsWith('2026-11-05')).length,5);
    assert.deepEqual(events.map((e)=>e.date),events.map((e)=>e.date).sort());
    assert.ok(events.every((e)=>e.event.startsWith('Report')));
  `);
});

void test("an empty or refused profile keeps what the ticker's stored profile says, and today's wins when there is one", () => {
  withVendor(`
    const keep=(ticker,profile)=>client.execute({sql:'INSERT INTO tickers(ticker,fmp_profile_json) VALUES (?,?)',args:[ticker,JSON.stringify(profile)]});
    await keep('FUND',{companyName:'A Fund',isEtf:true,industry:'Asset Management'});
    await keep('BANK',{companyName:'A Bank',isEtf:false,industry:'Banks - Regional'});
    const sectors=[{sector:'Technology',weightPercentage:'100%'}];
    for(const empty of [[],403,404]){
      await client.execute('DELETE FROM fmp_cache');
      answers={profile:[empty],quote:[quoted],'etf/sector-weightings':[sectors]};
      const fund=await fetchFmpData('FUND');
      assert.equal(fund.isFund,true,String(empty));
      assert.equal(fund.profile.companyName,'A Fund');
      assert.deepEqual(fund.fundSectors,sectors);
      const bank=await fetchFmpData('BANK');
      assert.equal(bank.isFund,false);
      assert.equal(fundamentalContext(bank,'2026-11-05').growth.bank_like,true);
    }
    // With nothing stored, it is what it was: no company, and not a fund.
    answers={profile:[[]],quote:[quoted]};
    const fresh=await fetchFmpData('NEWT');
    assert.equal(fresh.isFund,false);
    assert.equal(fresh.profile,null);
    // Today's answer is newer than the stored one.
    await client.execute('DELETE FROM fmp_cache');
    answers={profile:[[{companyName:'Now a stock',isEtf:false}]],quote:[quoted]};
    const changed=await fetchFmpData('FUND');
    assert.equal(changed.isFund,false);
    assert.equal(changed.profile.companyName,'Now a stock');
  `);
});

// Recorded company-level vendor discrepancies shown by the Numbers tab.
const NOTE_WORDS: [string, string][] = [
  [
    "Over the last four quarters, 40% of pretax income came from outside operations (pretax 173694000000, operating income 104366000000). The trailing P/E and EV/EBITDA lean on it, so check the filings for what it is before calling them cheap. Scaling net income down to operating income alone gives a trailing P/E near 35.5.",
    "Over the last four quarters, 40% of pretax income came from outside operations (pretax $173.69B, operating income $104.37B). The trailing P/E and EV/EBITDA lean on it, so check the filings for what it is before calling them cheap. Scaling net income down to operating income alone gives a trailing P/E near 35.5.",
  ],
  [
    "This is a bank or broker, whose debt and cash flow include customer funds, so EV/EBITDA and free cash flow yield are left out here. Disregard those measures in key_metrics_ttm and key_metrics_annual, and use earnings and book value. Price to common book here is market cap over equity less preferred stock. The vendor's price to book, its median and the fiscal year history count preferred stock as book, so compare the vendor's figure with those and quote price to common book for the level.",
    "This is a bank or broker, whose debt and cash flow include customer funds, so EV/EBITDA and free cash flow yield are left out here. Price to common book here is market cap over equity less preferred stock.",
  ],
  [
    "Vendor revenue for Q3 2026 is 45628000000, but the company reported 23845000000. The vendor's figure is gross, so revenue_yoy_pct and the operating margins here use the reported revenue in earnings_history instead. Do not compare revenue in income_statement_quarterly with the company's reported revenue, and disregard the vendor's own margins, price-to-sales and EV-to-sales ratios, which rest on the gross figure.",
    "Vendor revenue for Q3 2026 is $45.63B, but the company reported $23.85B. The vendor's figure is gross, so revenue growth and the operating margins here use the reported revenue instead.",
  ],
  // A pack from before the vendor's other ratios were named ends that sentence sooner.
  [
    "Vendor revenue for Q3 2026 is 1358800000, but the company reported 712200000. The vendor's figure is gross, so revenue_yoy_pct and the operating margins here use the reported revenue in earnings_history instead. The year-ago reported figure is not on the same basis, so that growth rate and margin are left out; take them from the filing. Do not compare revenue in income_statement_quarterly with the company's reported revenue.",
    "Vendor revenue for Q3 2026 is $1.36B, but the company reported $712.2M. The vendor's figure is gross, so revenue growth and the operating margins here use the reported revenue instead. The year-ago reported figure is not on the same basis, so that growth rate and margin are left out; take them from the filing.",
  ],
  [
    "The vendor's cash flow rows are unreliable: Q3 2026 shows net income of 2026000000 against 428200000 in the income statement. The trailing free cash flow and its yield are left out, so take cash flow from the filing, and disregard freeCashFlowYieldTTM in key_metrics_ttm.",
    "The vendor's cash flow rows are unreliable: Q3 2026 shows net income of $2.03B against $428.2M in the income statement. The trailing free cash flow and its yield are left out, so take cash flow from the filing.",
  ],
  [
    "The vendor's cash flow rows are unreliable: Q3 2026 shows capital spending of +383000000, when spending is an outflow. The trailing free cash flow and its yield are left out, so take cash flow from the filing, and disregard freeCashFlowYieldTTM in key_metrics_ttm.",
    "The vendor's cash flow rows are unreliable: Q3 2026 shows capital spending of +$383M, when spending is an outflow. The trailing free cash flow and its yield are left out, so take cash flow from the filing.",
  ],
  [
    "The vendor's EBITDA does not fit its own pretax income, interest and depreciation in Q3 2026, Q2 2026, so the trailing EV/EBITDA is left out. Disregard evToEBITDATTM in key_metrics_ttm.",
    "The vendor's EBITDA does not fit its own pretax income, interest and depreciation in Q3 2026, Q2 2026, so the trailing EV/EBITDA is left out.",
  ],
  [
    "The vendor's Q3 2026 row does not add up: pretax income 1303000000, tax -264000000, income from continuing operations 1030000000, net income 1030000000. Treat these lines as unreliable and prefer the filing.",
    "The vendor's Q3 2026 row does not add up: pretax income $1.3B, tax −$264M, income from continuing operations $1.03B, net income $1.03B. Treat these lines as unreliable and prefer the filing.",
  ],
  [
    "These vendor figures do not appear in the 10-Q filed 2026-10-29: latest quarter operating income 2843000000; year-ago quarter operating income 3639000000. The filing may group them differently or not report that line, but valuation_and_growth is computed from them, so use the filing's own figures where it has them.",
    "These vendor figures do not appear in the 10-Q filed 2026-10-29: latest quarter operating income $2.84B; year-ago quarter operating income $3.64B. The filing may group them differently or not report that line, but the growth and valuation figures are computed from them, so use the filing's own figures where it has them.",
  ],
  [
    "Results were reported on 2026-11-04, but the newest vendor statements end 2026-06-30. The growth, margin, free cash flow and trailing figures in valuation_and_growth describe that earlier quarter, so take the current quarter from the results in the filings or news.",
    "Results were reported on 2026-11-04, but the newest vendor statements end 2026-06-30. The growth, margin, free cash flow and trailing figures here describe that earlier quarter, so take the current quarter from the results in the filings or news.",
  ],
  [
    "Net income over the last four quarters (13628000000) is above pretax income (9414000000), so a tax benefit is in it and the trailing P/E understates the multiple on normally taxed earnings. Market value is 19.6 times pretax income.",
    "Net income over the last four quarters ($13.63B) is above pretax income ($9.41B), so a tax benefit is in it and the trailing P/E understates the multiple on normally taxed earnings. Market value is 19.6 times pretax income.",
  ],
  [
    "Analysts expect EPS to fall from 12.84 in the fiscal year ending 2026-12-31 to 10.80 in the next. With this much income from outside operations, the nearer year can include those gains, so the forward P/E and the next-year EPS decline may reflect them and not the business. The next-year P/E is the multiple on the later year.",
    "Analysts expect EPS to fall from 12.84 in the fiscal year ending 2026-12-31 to 10.80 in the next. With this much income from outside operations, the nearer year can include those gains, so the forward P/E and the next-year EPS decline may reflect them and not the business.",
  ],
  [
    "The vendor's operating cash flow for fiscal 2025 Q1 to Q3 adds up to 844900000, which the 10-Q filed 2026-10-30 does not print. Its cash flow rows do not match the filing, so take cash flow from the filing and disregard the trailing and year-earlier free cash flow totals.",
    "The vendor's operating cash flow for fiscal 2025 Q1 to Q3 adds up to $844.9M, which the 10-Q filed 2026-10-30 does not print. Its cash flow rows do not match the filing, so take cash flow from the filing and disregard the trailing and year-earlier free cash flow totals.",
  ],
  [
    "The 20-F filed 2026-02-04 (edgar:0001171843-26-000123) has almost no risk or results text and no readable annual report exhibit, perhaps because it is a PDF, so those sections are incomplete.",
    "The 20-F filed 2026-02-04 has almost no risk or results text and no readable annual report exhibit, perhaps because it is a PDF, so those sections are incomplete.",
  ],
];

const INTERNAL_WORDS = /\b[a-z]+_[a-z_]+\b|\b[a-z]+[A-Z]\w*\b|\b\d{7,}\b/;

void test("a warning on the page reads in plain words and compact amounts", () => {
  for (const [note, words] of NOTE_WORDS)
    assert.deepEqual(dataWarnings([note]), [words]);
});

void test("a warning's dates, clock times, ratios and share counts are not amounts", () => {
  const unchanged = [
    "The Q3 2026 results were filed at 2026-11-04 16:00:23 ET, after this quote was priced, so the price does not reflect them yet.",
    "Vendor trailing P/E is 12.34; price over the four newest quarterly diluted EPS gives 13.22. The vendor figure can lag a just-reported quarter, and one-off items such as a tax benefit can also cause this; neither should be treated as authoritative without checking.",
    "The vendor's market cap implies 114.5M shares at this price, but the latest quarter averaged 119.9M basic shares.",
    "The forward P/E and next-year P/E convert the dollar price to DKK at 6.7615, the rate the vendor's two market caps imply, because the estimates are in DKK.",
    "The newest cash flow statement is dated 2024-12-31, too old for a current free cash flow yield, so none is given.",
    "The source is edgar:0001171843-26-000123, also written 0001171843-26-000123, at a rate of 6.76155.",
  ];
  assert.deepEqual(dataWarnings(unchanged), unchanged);
});

void test("a foreign filer's warnings read in its own currency, as NVO's kroner would not", () => {
  const home = noteWith(context(nvo()), "earnings history") ?? "";
  const row =
    "The vendor's Q2 2026 row does not add up: pretax income 1300000000, tax -264000000, income from continuing operations 1030000000, net income 1030000000. Treat these lines as unreliable and prefer the filing.";
  assert.deepEqual(dataWarnings([home, row]), [
    home,
    "The vendor's Q2 2026 row does not add up: pretax income DKK 1.3B, tax −DKK 264M, income from continuing operations DKK 1.03B, net income DKK 1.03B. Treat these lines as unreliable and prefer the filing.",
  ]);
  assert.match(dataWarnings([row])[0] ?? "", /pretax income \$1\.3B/);
});

void test("no warning the code writes today shows a field name or a raw integer on the page", () => {
  const billion = 1e9;
  const troubled = {
    quote: {
      price: 100,
      marketCap: 1_000 * billion,
      timestamp: Date.parse("2026-11-04T15:00:00-05:00") / 1000,
    },
    keyMetrics: [{ date: "2025-12-31", fiscalYear: "2025", evToEBITDA: 10 }],
    income: incomeRows((i) => ({
      revenue: 45.628 * billion,
      operatingIncome: 5 * billion,
      incomeBeforeTax: 8 * billion,
      incomeTaxExpense: -1 * billion,
      netIncomeFromContinuingOperations: 9 * billion,
      netIncome: (i === 0 ? 7 : 9) * billion,
      ebitda: -1.303 * billion,
      weightedAverageShsOut: 20 * billion,
      acceptedDate: "2026-11-04 16:00:23",
    })),
    cashFlow: cashRows((i) =>
      i === 0
        ? { capitalExpenditure: 0.383 * billion }
        : i === 4
          ? { netIncome: 2.026 * billion }
          : {},
    ),
    earnings: [
      ...[0, 1, 2, 3].map((i) => reportedAfter(i, 23.845 * billion)),
      { date: "2027-02-01", epsActual: 1 },
    ],
    estimates: [
      { date: "2026-12-31", epsAvg: 12.84 },
      { date: "2027-12-31", epsAvg: 10.8 },
    ],
  };
  const notes = [
    ...(context(troubled)?.data_notes ?? []),
    ...(context({ profile: { industry: "Banks - Diversified" } })?.data_notes ??
      []),
    ...gapsWith({ [TEN_Q]: "Nothing the vendor says." }, troubled),
  ];
  for (const phrase of [
    "does not add up",
    "Vendor revenue for",
    "cash flow rows are unreliable",
    "The year-earlier free cash flow",
    "EBITDA does not fit",
    "EBITDA for fiscal",
    "came from outside operations",
    "Analysts expect EPS",
    "Net income over the last four quarters",
    "market cap implies",
    "results were filed at",
    "Results were reported on",
    "This is a bank or broker",
    "These vendor figures",
    "operating cash flow for fiscal",
  ])
    assert.ok(
      notes.some((n) => n.includes(phrase)),
      `no note says "${phrase}"`,
    );
  const shown = dataWarnings(notes);
  assert.equal(shown.length, notes.length);
  for (const line of shown) assert.doesNotMatch(line, INTERNAL_WORDS);
});

void test("the models keep each note as it was written, whatever the page shows", async () => {
  const raw =
    "so take cash flow from the filing, and disregard freeCashFlowYieldTTM in key_metrics_ttm.";
  const pack = await savedPack({
    cashFlow: cashRows((i) => (i === 0 ? { capitalExpenditure: 383 } : {})),
  });
  assert.ok(pack.data_notes.some((n) => n.endsWith(raw)));
  for (const standing of PACK_DATA_NOTES)
    assert.ok(pack.data_notes.includes(standing));
  assert.ok(!dataWarnings(pack.data_notes).some((n) => n.endsWith(raw)));
});

void test("old statements read as one warning when the results note already says so, as NVO's did not", () => {
  const lag = "Results were reported on 2026-11-04, but the statements lag.";
  const old =
    "The newest quarterly statement is dated 2026-06-30, more than 120 days old.";
  assert.deepEqual(dataWarnings([lag, old]), [lag]);
  assert.deepEqual(dataWarnings([old, lag]), [lag]);
  // With no results to explain it, the age is the only warning there is.
  assert.deepEqual(dataWarnings([old]), [old]);
});

void test("a negative figure has its minus in front of the currency, and a return its direction", () => {
  const quarter = (reportedCurrency: string) => ({
    ...incomeRows()[0],
    reportedCurrency,
    netIncome: -5_000_000,
  });
  const groups = (reportedCurrency: string) =>
    keyNumbers({
      price_summary: { return_5d_pct: -5.35, return_1y_pct: 6.33 },
      ratios_ttm: { netProfitMarginTTM: -0.123 },
      key_metrics_ttm: { returnOnEquityTTM: -0.05 },
      income_statement_quarterly: [quarter(reportedCurrency)],
      cash_flow_quarterly: [
        {
          ...quarter(reportedCurrency),
          operatingCashFlow: 1,
          freeCashFlow: -34_840_000_000,
        },
      ],
    });
  const usd = groups("USD");
  assert.equal(numberOf(usd, "Free cash flow"), "−$34.84B");
  assert.equal(numberOf(usd, "Net income"), "−$5M");
  assert.equal(numberOf(usd, "5-day return"), "−5.35%");
  assert.equal(numberOf(usd, "1-year return"), "+6.33%");
  assert.equal(numberOf(usd, "Net margin"), "−12.3%");
  assert.equal(numberOf(usd, "Return on equity"), "−5.0%");
  assert.equal(numberOf(groups("DKK"), "Free cash flow"), "−DKK 34.84B");
  assert.equal(numberOf(groups("DKK"), "Net income"), "−DKK 5M");
});

void test("a flat return reads as zero and a missing one stays off the page", () => {
  const groups = keyNumbers({
    price_summary: { return_5d_pct: 0, return_1y_pct: null },
  });
  assert.equal(numberOf(groups, "5-day return"), "0.00%");
  assert.equal(numberOf(groups, "1-year return"), undefined);
});

void test("a fund shows its cost, yield and holdings, and its size is not called a market cap", () => {
  const groups = keyNumbers({
    is_fund: true,
    quote: { marketCap: 1.725e12 },
    price_summary: { distribution_yield_1y_pct: 0 },
    fund_info: {
      expenseRatio: 0.03,
      holdingsCount: 3065,
      assetClass: "Core Investment Grade Bond",
    },
  });
  assert.equal(numberOf(groups, "Fund market value"), "$1.73T");
  assert.equal(numberOf(groups, "Market cap"), undefined);
  assert.deepEqual(groups.find((g) => g.title === "Fund")?.rows, [
    ["Expense ratio", "0.03%"],
    ["Distribution yield, last 12 months", "0.00%"],
    ["Number of holdings", "3,065"],
    ["Asset class", "Core Investment Grade Bond"],
  ]);
  assert.deepEqual(
    groups.map((g) => g.title),
    ["Price", "Fund"],
  );
});

void test("a fund's written pack reaches the Numbers tab with the figures the vendor gave", async () => {
  const pack = await savedPack({
    isFund: true,
    quote: { price: 45.33, marketCap: 64_590_000_000 },
    fundInfo: {
      expenseRatio: 0.25,
      holdingsCount: 1,
      assetClass: "Alternatives",
      assetsUnderManagement: 1_000_000_000_000,
      nav: 43.97,
    },
    history: fullYear(),
    dividends: [],
  });
  const groups = keyNumbers(pack);
  assert.deepEqual(groups.find((g) => g.title === "Fund")?.rows, [
    ["Expense ratio", "0.25%"],
    ["Distribution yield, last 12 months", "0.00%"],
    ["Number of holdings", "1"],
    ["Asset class", "Alternatives"],
  ]);
  // The vendor's round assets and its NAV do not reconcile with the price, so they stay off.
  assert.ok(!JSON.stringify(groups).includes("43.97"));
});

void test("a fund with a figure missing or older than the field loses only that row", () => {
  const titles = (pack: Parameters<typeof keyNumbers>[0]) =>
    keyNumbers(pack).map((g) => g.title);
  assert.deepEqual(titles({ is_fund: true, fund_info: null }), []);
  const noYield = keyNumbers({
    is_fund: true,
    price_summary: { high_1y: 2, low_1y: 1 },
    fund_info: { expenseRatio: 0.59 },
  });
  assert.deepEqual(noYield.find((g) => g.title === "Fund")?.rows, [
    ["Expense ratio", "0.59%"],
  ]);
  // Zero is far likelier a missing vendor figure than a free fund, and an asset class is words.
  assert.deepEqual(
    titles({
      is_fund: true,
      fund_info: { expenseRatio: 0, holdingsCount: 0, assetClass: 7 },
    }),
    [],
  );
});

void test("a stock keeps its market cap label and has no fund group", () => {
  const stock = keyNumbers({
    is_fund: false,
    quote: { marketCap: 8_200_000_000 },
    fund_info: { expenseRatio: 0.03 },
  });
  assert.equal(numberOf(stock, "Market cap"), "$8.2B");
  assert.equal(numberOf(stock, "Fund market value"), undefined);
  assert.deepEqual(
    stock.map((g) => g.title),
    ["Price"],
  );
  // A pack from before is_fund was written reads as a stock.
  assert.equal(
    numberOf(keyNumbers({ quote: { marketCap: 5 } }), "Market cap"),
    "$5",
  );
});

// QCOM's figures on 2026-11-05.
const QCOM_VALUATION = {
  forward_pe: 17.2958,
  forward_estimate_fiscal_year_end: "2027-09-28",
  pe_fiscal_years_counted: 5,
  pe_median_last_5_fiscal_years: 17.1654,
  pe_low_last_5_fiscal_years: 9.8073,
  pe_high_last_5_fiscal_years: 32.668,
  pe_ttm_without_other_income: null,
  fcf_yield_ttm_pct: 4.6778,
  analyst_target_upside_pct: 21.2195,
  pe_ttm_from_quarterly_eps: 13.1,
};
const CHECKED = { revenue_basis: "vendor_statement", revenue_yoy_pct: -8.42 };
const valuationRows = (valuation: Row, growth: Row = CHECKED) =>
  keyNumbers({
    ratios_ttm: { priceToEarningsRatioTTM: 13.52 },
    valuation_and_growth: { growth, valuation },
  });

void test("the Numbers tab shows the valuation figures a review rests on, as QCOM's did not", () => {
  const groups = valuationRows(QCOM_VALUATION);
  assert.deepEqual(
    groups.find((g) => g.title === "Forward and historical valuation")?.rows,
    [
      [
        "Forward P/E on usually adjusted estimates, fiscal year ending 2027-09-28",
        "17.30",
      ],
      ["Median P/E on reported earnings, last 5 fiscal years", "17.17"],
      ["P/E range, last 5 fiscal years", "9.81 to 32.67"],
      ["Free cash flow yield, trailing 12 months, vendor figures", "4.68%"],
      ["Upside to analyst target", "+21.22%"],
    ],
  );
  assert.equal(numberOf(groups, "Revenue growth, year on year"), "−8.42%");
  // The page adds its own P/E row to the first group whose title starts with "Valuation".
  assert.equal(
    groups.find((g) => g.title.startsWith("Valuation"))?.title,
    "Valuation and returns, trailing 12 months",
  );
});

void test("a valuation figure the code left out loses only its own row", () => {
  // NVO has no forward P/E when its rate does not reconcile, and a bank has no yield.
  const rows = valuationRows({
    ...QCOM_VALUATION,
    forward_pe: null,
    fcf_yield_ttm_pct: null,
    pe_low_last_5_fiscal_years: null,
  }).flatMap((g) => g.rows.map(([label]) => label));
  assert.ok(!rows.some((label) => label.startsWith("Forward P/E")));
  assert.ok(!rows.some((label) => label.startsWith("Free cash flow yield")));
  assert.ok(!rows.some((label) => label.startsWith("P/E range")));
  assert.ok(
    rows.includes("Median P/E on reported earnings, last 5 fiscal years"),
  );
  // CBOE's growth is left out when the two years are on different bases.
  assert.equal(
    numberOf(
      valuationRows(QCOM_VALUATION, {
        revenue_basis: "reported",
        revenue_yoy_pct: null,
      }),
      "Revenue growth, year on year",
    ),
    undefined,
  );
});

void test("the median says how many years it rests on, as AMZN's four do", () => {
  const years = (pe_fiscal_years_counted: number) =>
    valuationRows({ ...QCOM_VALUATION, pe_fiscal_years_counted })
      .flatMap((g) => g.rows.map(([label]) => label))
      .filter((label) => /^Median|^P\/E range/.test(label));
  assert.deepEqual(years(4), [
    "Median P/E on reported earnings, last 4 fiscal years",
    "P/E range, last 4 fiscal years",
  ]);
  assert.deepEqual(years(1), [
    "Median P/E on reported earnings, last 1 fiscal year",
    "P/E range, last 1 fiscal year",
  ]);
});

void test("outside income gets its own P/E row, and a stock with none gets no row", () => {
  const label = "Trailing P/E without income from outside operations";
  const amzn = valuationRows({
    ...QCOM_VALUATION,
    pe_ttm_without_other_income: 35.5234,
  });
  assert.equal(numberOf(amzn, label), "35.52");
  assert.equal(numberOf(valuationRows(QCOM_VALUATION), label), undefined);
});

void test("a pack from before the vendor checks shows none of the figures they have since corrected", () => {
  // Compare cached 4.07% growth against 7.94% now, and a 0.56% yield against none now.
  const older = keyNumbers({
    valuation_and_growth: {
      growth: { revenue_yoy_pct: 4.07 },
      valuation: QCOM_VALUATION,
    },
  });
  assert.deepEqual(older, []);
});

void test("a stock's written pack reaches the Numbers tab with its valuation rows and a minus sign", async () => {
  const pack = await savedPack({
    quote: { price: 100, marketCap: 10_000 },
    ratios: [{ date: "2025-12-31", priceToEarningsRatio: 20 }],
    estimates: [{ date: "2026-12-31", epsAvg: 10 }],
    priceTargetConsensus: { targetConsensus: 90 },
    cashFlow: cashRows(() => ({
      operatingCashFlow: -100,
      capitalExpenditure: -10,
      freeCashFlow: -110,
    })),
  });
  assert.deepEqual(
    keyNumbers(pack).find((g) => g.title === "Forward and historical valuation")
      ?.rows,
    [
      [
        "Forward P/E on usually adjusted estimates, fiscal year ending 2026-12-31",
        "10.00",
      ],
      ["Median P/E on reported earnings, last 1 fiscal year", "20.00"],
      ["P/E range, last 1 fiscal year", "20.00 to 20.00"],
      ["Free cash flow yield, trailing 12 months, vendor figures", "−4.40%"],
      ["Upside to analyst target", "−10.00%"],
    ],
  );
});
