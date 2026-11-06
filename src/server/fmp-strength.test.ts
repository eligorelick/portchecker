import "./test-env.ts";

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import type { FmpData, Row } from "./fmp.ts";

process.env.FMP_API_KEY = "test-key";
const { client } = await import("./db/index.ts");
const {
  fourConsecutiveQuarters,
  fundamentalContext,
  yearAgoRow,
  quoteDate,
  fetchFmpData,
  fetchMarketContext,
  fetchProfile,
  cacheMissingHoldingQuotes,
  FmpRateLimitError,
  latestCached,
  latestCachedQuotes,
  pruneFmpCache,
  today,
  priceSummary,
  relativeToMarket,
  upcomingEstimates,
} = await import("./fmp.ts");

const realSetTimeout = globalThis.setTimeout;
before(() =>
  client.executeMultiple(
    "CREATE TABLE IF NOT EXISTS fmp_cache(ticker TEXT,endpoint TEXT,fetched_on TEXT,payload_json TEXT,PRIMARY KEY(ticker,endpoint,fetched_on));",
  ),
);
beforeEach(async () => {
  // Local noon gives the same calendar day in every machine time zone.
  mock.timers.enable({
    apis: ["Date"],
    now: new Date(2026, 10, 5, 12).getTime(),
  });
  mock.method(globalThis, "setTimeout", ((fn: () => void) =>
    realSetTimeout(fn, 0)) as typeof setTimeout);
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network call");
  });
  await client.execute("DELETE FROM fmp_cache");
});
afterEach(() => mock.reset());
after(() => client.close());

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

const quarterRow = (date: string, extra: Row = {}) => ({
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
const incomeRows = (extra: (i: number) => Row = () => ({})) =>
  QUARTER_ENDS.map((d, i) => quarterRow(d, extra(i)));
const cashRows = (extra: (i: number) => Row = () => ({})) =>
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
const contextOf = (overrides: Partial<FmpData>, asOf = "2026-11-05") =>
  fundamentalContext(
    fmpFixture({
      quote: { price: 100, marketCap: 10_000 },
      income: incomeRows(),
      cashFlow: cashRows(),
      keyMetricsTtm: { freeCashFlowYieldTTM: 0.036, evToEBITDATTM: 12 },
      ...overrides,
    }),
    asOf,
  );
const notesOf = (c: ReturnType<typeof contextOf>) =>
  c?.data_notes.join(" | ") ?? "";

void test("quarters: gaps outside 70 to 110 days are not consecutive", () => {
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const rows = (gaps: number[]) => {
    let t = Date.parse("2026-09-30");
    return [
      { date: iso(t) },
      ...gaps.map((g) => ({ date: iso((t -= g * 86400000)) })),
    ];
  };
  assert.equal(fourConsecutiveQuarters(rows([91, 91, 91])), true);
  assert.equal(fourConsecutiveQuarters(rows([65, 91, 91])), false);
  assert.equal(fourConsecutiveQuarters(rows([115, 91, 91])), false);
});

void test("year-ago row: more than 20 days off is another quarter", () => {
  assert.equal(
    yearAgoRow([{ date: "2026-09-30" }, { date: "2025-08-15" }]),
    undefined,
  );
  assert.equal(
    yearAgoRow([{ date: "2026-09-30" }, { date: "2025-10-10" }])?.date,
    "2025-10-10",
  );
});

void test("a row off by more than its tolerance is flagged, and one within it is not", () => {
  const add = (continuing: number, net: number, revenue = 1000) =>
    notesOf(
      contextOf({
        income: incomeRows((i) =>
          i === 0
            ? {
                incomeBeforeTax: 1000,
                incomeTaxExpense: 200,
                netIncomeFromContinuingOperations: continuing,
                netIncome: net,
                revenue,
              }
            : {},
        ),
      }),
    );
  // 800 is exact, the allowance is 10% of 1000.
  assert.doesNotMatch(add(850, 850), /does not add up/);
  assert.match(add(650, 650), /does not add up/);
  // Tax fits, but continuing income is not net income.
  assert.match(add(800, 400), /does not add up/);
});

void test("cash flow net income off by more than 5% of net or 1% of revenue is doubted", () => {
  // Net 160, revenue 1000: 10 is allowed.
  const free = (own: number) =>
    contextOf({
      cashFlow: cashRows((i) => (i === 0 ? { netIncome: own } : {})),
    })?.growth.free_cash_flow_ttm;
  assert.equal(free(169), 360);
  assert.equal(free(180), null);
});

void test("EBITDA: the allowance is a quarter of what the row implies, and each part counts", () => {
  const ev = (row: Row) =>
    contextOf({
      income: incomeRows((i) =>
        i === 0
          ? row
          : {
              ebitda: 240,
              interestExpense: 10,
              depreciationAndAmortization: 30,
            },
      ),
    })?.valuation.ev_to_ebitda_ttm;
  // 200 + 10 + 30 = 240, so up to 60 away is allowed.
  assert.equal(
    ev({ ebitda: 290, interestExpense: 10, depreciationAndAmortization: 30 }),
    12,
  );
  assert.equal(
    ev({ ebitda: 340, interestExpense: 10, depreciationAndAmortization: 30 }),
    null,
  );
  // Interest stored as a negative still adds, and D&A is part of it.
  assert.equal(
    ev({ ebitda: 330, interestExpense: -100, depreciationAndAmortization: 30 }),
    12,
  );
  assert.equal(
    ev({ ebitda: 410, interestExpense: 10, depreciationAndAmortization: 200 }),
    12,
  );
});

void test("trailing earnings mix: no pretax income gives no notes", () => {
  const zero = contextOf({
    income: incomeRows((i) => ({
      incomeBeforeTax: i % 2 ? -100 : 100,
      netIncome: 160,
      operatingIncome: 50,
    })),
  });
  assert.doesNotMatch(notesOf(zero), /tax benefit|outside operations/);
  assert.equal(zero?.valuation.pe_ttm_without_other_income, null);
});

void test("trailing earnings mix: another currency gives no price-based figure", () => {
  const dkk = (extra: Row) =>
    contextOf({
      income: incomeRows(() => ({ reportedCurrency: "DKK", ...extra })),
    });
  const other = dkk({ operatingIncome: 120 });
  assert.match(notesOf(other), /outside operations/);
  assert.doesNotMatch(notesOf(other), /trailing P\/E near/);
  assert.equal(other?.valuation.pe_ttm_without_other_income, null);
  const taxed = dkk({ netIncome: 340 });
  assert.match(notesOf(taxed), /tax benefit/);
  assert.doesNotMatch(notesOf(taxed), /times pretax income/);
});

void test("trailing earnings mix: net just under pretax still says a tax benefit, and a loss from operations gives no P/E", () => {
  assert.match(
    notesOf(contextOf({ income: incomeRows(() => ({ netIncome: 194 })) })),
    /nearly all of/,
  );
  assert.doesNotMatch(
    notesOf(contextOf({ income: incomeRows(() => ({ netIncome: 180 })) })),
    /tax benefit/,
  );
  const loss = contextOf({
    income: incomeRows(() => ({ operatingIncome: -50 })),
  });
  assert.equal(loss?.valuation.pe_ttm_without_other_income, null);
});

void test("revenue 30% from the reported figure is a different basis", () => {
  const context = contextOf({
    income: incomeRows((i) => ({ revenue: i === 0 ? 1_300 : 1_000 })),
    earnings: [{ date: "2026-10-13", epsActual: 2, revenueActual: 1_000 }],
  });
  assert.equal(context?.growth.revenue_basis, "reported");
});

void test("the reported figure must be the first report of that quarter", () => {
  const basis = (earnings: Row[], income = incomeRows()) =>
    contextOf({ income, earnings })?.growth.revenue_basis;
  // The next quarter's report, 106 days on, must not be read as this one's.
  assert.equal(
    basis([
      { date: "2026-10-13", epsActual: 2, revenueActual: 1_000 },
      { date: "2027-01-14", epsActual: 2, revenueActual: 2_000 },
    ]),
    "vendor_statement",
  );
  // A report long after the quarter belongs to a later one.
  assert.equal(
    basis(
      [{ date: "2026-11-01", epsActual: 2, revenueActual: 2_000 }],
      incomeRows((i) => (i === 0 ? { date: "2026-03-31" } : {})),
    ),
    "vendor_statement",
  );
  // A row with no actual has reported nothing, so the next one is the report.
  assert.equal(
    basis([
      { date: "2026-10-10", epsActual: null, revenueActual: null },
      { date: "2026-10-13", epsActual: 2, revenueActual: 500 },
    ]),
    "reported",
  );
});

void test("cash flow: a statement 300 days old gives no current yield", () => {
  const context = contextOf({ cashFlow: cashRows().slice(3) }, "2026-10-28");
  assert.equal(context?.growth.free_cash_flow_ttm, null);
  assert.match(notesOf(context), /too old/);
});

void test("cash flow: a dated quarter with no data is not summed as zero", () => {
  const context = contextOf({
    cashFlow: cashRows((i) =>
      i === 1 ? { operatingCashFlow: 0, freeCashFlow: -900 } : {},
    ),
  });
  assert.equal(context?.growth.free_cash_flow_ttm, null);
  assert.equal(context?.valuation.fcf_yield_ttm_pct, null);
});

void test("cash flow: a quarter missing its figure gives no total", () => {
  const context = contextOf({
    cashFlow: cashRows((i) => (i === 1 ? { freeCashFlow: undefined } : {})),
  });
  assert.equal(context?.growth.free_cash_flow_ttm, null);
});

void test("operating margin on zero revenue is no margin", () => {
  const context = contextOf({
    income: incomeRows((i) => (i === 0 ? { revenue: 0 } : {})),
  });
  assert.equal(context?.growth.operating_margin_pct, null);
});

void test("a bank's fiscal year rows carry no EV multiple or cash yield either", () => {
  const context = contextOf({
    profile: { industry: "Banks - Diversified" },
    ratios: [{ date: "2025-12-31", priceToEarningsRatio: 12 }],
    keyMetrics: [
      { date: "2025-12-31", evToEBITDA: 14, freeCashFlowYield: -0.2 },
    ],
  });
  assert.deepEqual(context?.valuation.history_by_fiscal_year, [
    {
      fiscal_year_end: "2025-12-31",
      pe: 12,
      ev_to_ebitda: null,
      fcf_yield_pct: null,
      price_to_book: null,
    },
  ]);
});

void test("a bad cash flow row on a bank says nothing of cash flow, since none is given", () => {
  const context = contextOf({
    profile: { industry: "Banks - Diversified" },
    cashFlow: cashRows((i) => ({
      capitalExpenditure: i === 0 || i === 5 ? 383 : -10,
    })),
    income: incomeRows(() => ({ ebitda: -1303 })),
  });
  assert.doesNotMatch(
    notesOf(context),
    /cash flow rows are unreliable|year-earlier free cash flow|does not fit its own/,
  );
  assert.equal(context?.growth.latest_quarter_free_cash_flow_usable, false);
});

void test("yield: old cash flow gives no yield, the vendor's included", () => {
  const context = contextOf(
    {
      cashFlow: cashRows().slice(3),
      keyMetricsTtm: { freeCashFlowYieldTTM: 0.1 },
    },
    "2026-10-28",
  );
  assert.equal(context?.valuation.fcf_yield_ttm_pct, null);
});

void test("trailing P/E from quarterly EPS: a loss or another currency gives none", () => {
  const pe = (extra: Row) =>
    contextOf({ income: incomeRows(() => extra) })?.valuation
      .pe_ttm_from_quarterly_eps;
  assert.equal(pe({}), 25);
  assert.equal(pe({ epsDiluted: -1 }), null);
  assert.equal(pe({ reportedCurrency: "DKK" }), null);
});

void test("data notes: a vendor figure 20% or more off speaks up, and a close one does not", () => {
  const notes = (overrides: Partial<FmpData>) => notesOf(contextOf(overrides));
  // 360 of cash flow on 10,000 of market value is 3.6%.
  assert.match(
    notes({ keyMetricsTtm: { freeCashFlowYieldTTM: 0.045 } }),
    /Vendor FCF yield/,
  );
  assert.doesNotMatch(
    notes({ keyMetricsTtm: { freeCashFlowYieldTTM: 0.037 } }),
    /Vendor FCF yield/,
  );
  // Price 100 over 4 of EPS is 25.
  assert.match(
    notes({ ratiosTtm: { priceToEarningsRatioTTM: 32 } }),
    /Vendor trailing P\/E/,
  );
  assert.doesNotMatch(
    notes({ ratiosTtm: { priceToEarningsRatioTTM: 26 } }),
    /Vendor trailing P\/E/,
  );
});

void test("forward P/E: a forecast loss gives none", () => {
  const context = contextOf({
    estimates: [{ date: "2099-12-31", epsAvg: -2, revenueAvg: 1 }],
  });
  assert.equal(context?.valuation.forward_pe, null);
});

void test("analyst target and year range say where the price sits", () => {
  const context = contextOf({
    quote: { price: 100, marketCap: 10_000, yearHigh: 100, yearLow: 100 },
    priceTargetConsensus: { targetConsensus: 110 },
  });
  assert.equal(context?.valuation.analyst_target_upside_pct, 10);
  assert.equal(context?.valuation.position_in_1_year_range_pct, null);
});

void test("reported revenue is only offered when it replaced the vendor's", () => {
  const close = contextOf({
    earnings: [{ date: "2026-10-13", epsActual: 2, revenueActual: 1_050 }],
  });
  assert.equal(close?.growth.latest_quarter_reported_revenue, null);
  const foreign = contextOf({
    income: incomeRows(() => ({ reportedCurrency: "DKK", revenue: 78_488 })),
    earnings: [{ date: "2026-10-05", epsActual: 2, revenueActual: 12_130 }],
  });
  assert.equal(foreign?.growth.latest_quarter_reported_revenue, null);
});

void test("a bank's free cash flow is unusable and absent for both years", () => {
  const context = contextOf({ profile: { industry: "Banks - Regional" } });
  assert.equal(context?.growth.latest_quarter_free_cash_flow_usable, false);
  assert.equal(context?.growth.free_cash_flow_ttm, null);
  assert.equal(context?.growth.free_cash_flow_prior_ttm, null);
});

void test("a quote with no real time falls back on its stored date", () => {
  assert.equal(
    quoteDate({ timestamp: 0, quote_date: "2026-11-03" }),
    "2026-11-03",
  );
  assert.equal(quoteDate({ timestamp: -5 }, "2026-11-02"), "2026-11-02");
  assert.equal(quoteDate({ quote_date: "last week" }), null);
});

function stubFmp(answer: (endpoint: string, call: number) => Response) {
  const calls: string[] = [];
  mock.method(globalThis, "fetch", async (input: URL) => {
    assert.equal(
      new URL(String(input)).origin,
      "https://financialmodelingprep.com",
    );
    const endpoint = new URL(String(input)).pathname.replace("/stable/", "");
    calls.push(endpoint);
    return answer(endpoint, calls.length);
  });
  return calls;
}
const cachedRows = async (ticker: string) =>
  (
    await client.execute({
      sql: "SELECT * FROM fmp_cache WHERE ticker = ?",
      args: [ticker],
    })
  ).rows.length;
const daysBack = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toLocaleDateString("en-CA");
};

void test("fmp: concurrent requests and retries reserve separate request starts", async () => {
  let now = Date.now() + 1000;
  const timers: { at: number; run: () => void }[] = [];
  mock.method(Date, "now", () => now);
  mock.method(globalThis, "setTimeout", ((run: () => void, delay: number) => {
    timers.push({ at: now + delay, run });
    return 1;
  }) as unknown as typeof setTimeout);
  const starts: number[] = [];
  let attempts = 0;
  stubFmp(() => {
    starts.push(now);
    return ++attempts === 2
      ? new Response("", { status: 500 })
      : Response.json([{ companyName: "Ready" }]);
  });
  const drive = async (work: Promise<unknown>) => {
    let done = false;
    const settled = work.finally(() => {
      done = true;
    });
    // SQLite promises run on the real event loop; only application timers advance virtually.
    for (let turn = 0; !done && turn < 1000; turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (timers.length) {
        now = Math.min(...timers.map((timer) => timer.at));
        const due = timers.filter((timer) => timer.at === now);
        timers.splice(
          0,
          timers.length,
          ...timers.filter((timer) => timer.at !== now),
        );
        due.forEach((timer) => timer.run());
      }
    }
    assert.ok(done, "requests settled without a real timer or network");
    await settled;
  };
  await drive(fetchProfile("WARM"));
  await drive(Promise.all(["AAA", "BBB", "CCC"].map(fetchProfile)));
  assert.equal(starts.length, 5, "warm-up, three requests and one retry");
  for (let i = 1; i < starts.length; i++)
    assert.ok(starts[i]! - starts[i - 1]! >= 220, JSON.stringify(starts));
});

void test("fmp: a 429 is retried once and the second answer is used", async () => {
  const calls = stubFmp((_, call) =>
    call === 1
      ? new Response("", { status: 429 })
      : Response.json([{ companyName: "Recovered" }]),
  );
  assert.equal((await fetchProfile("R429"))?.companyName, "Recovered");
  assert.equal(calls.length, 2);
});

void test("fmp: a second 429 raises FmpRateLimitError, so the run says Skipped", async () => {
  stubFmp(() => new Response("", { status: 429 }));
  await assert.rejects(fetchProfile("S429"), FmpRateLimitError);
  assert.equal(await cachedRows("S429"), 0);
});

void test("fmp: refused optional endpoints are remembered for the day", async () => {
  for (const status of [402, 403, 404]) {
    const calls = stubFmp((endpoint) =>
      endpoint === "dividends"
        ? new Response("", { status })
        : Response.json(
            endpoint === "profile" ? [{ companyName: "Company" }] : [],
          ),
    );
    const ticker = "REFUSED" + status;
    assert.equal(
      (await fetchFmpData(ticker)).dividendsCoverageConfirmed,
      false,
    );
    assert.equal(
      (await fetchFmpData(ticker)).dividendsCoverageConfirmed,
      false,
    );
    assert.equal(calls.filter((e) => e === "dividends").length, 1);
  }
});

void test("fmp: a 500 fails without storing anything or naming the key", async () => {
  stubFmp(() => new Response("", { status: 500 }));
  await assert.rejects(
    fetchProfile("E500"),
    (e: Error) =>
      e.message.includes("returned 500") && !e.message.includes("test-key"),
  );
  assert.equal(await cachedRows("E500"), 0);
});

void test("fmp: an empty profile or quote is not stored, so the next run asks again", async () => {
  const calls = stubFmp(() => Response.json([]));
  assert.equal(await fetchProfile("EMPTY"), null);
  assert.equal(await cachedRows("EMPTY"), 0);
  await fetchProfile("EMPTY");
  assert.equal(calls.length, 2);
});

void test("fmp: unusable quotes and malformed profiles recover on the same day", async () => {
  for (const payload of [
    [{ price: null }],
    [{ price: 0 }],
    [{ price: -1 }],
    [{ price: "100" }],
    [null],
    [42],
    [[]],
  ]) {
    await client.execute("DELETE FROM fmp_cache");
    let quoteCalls = 0;
    stubFmp((endpoint) =>
      Response.json(
        endpoint === "profile"
          ? [{ companyName: "Valid" }]
          : endpoint === "quote"
            ? ++quoteCalls === 1
              ? payload
              : [{ price: 100, change: 0 }]
            : [],
      ),
    );
    assert.equal(
      (await fetchFmpData("RECOVER")).quote,
      null,
      JSON.stringify(payload),
    );
    assert.equal((await latestCachedQuotes()).has("RECOVER"), false);
    await cacheMissingHoldingQuotes(["RECOVER"]);
    assert.equal((await fetchFmpData("RECOVER")).quote?.price, 100);
    assert.equal((await latestCachedQuotes()).get("RECOVER")?.change, 0);
    assert.equal(quoteCalls, 2);
  }
  for (const payload of [[null], [42], [[]]]) {
    await client.execute("DELETE FROM fmp_cache");
    const calls = stubFmp((_, call) =>
      Response.json(
        call === 1
          ? payload
          : [
              {
                companyName: "Recovered",
                message: "Ordinary row field",
                errorRatio: 0,
              },
            ],
      ),
    );
    assert.equal(await fetchProfile("PROFILE"), null);
    assert.equal(await cachedRows("PROFILE"), 0);
    assert.equal((await fetchProfile("PROFILE"))?.companyName, "Recovered");
    assert.equal(calls.length, 2);
  }
});

void test("fmp: invalid stored quotes cannot hide an older usable quote or prevent refresh", async () => {
  for (const price of [null, 0, -1, "100"]) {
    await client.execute("DELETE FROM fmp_cache");
    for (const [on, value] of [
      [daysBack(1), 90],
      [today(), price],
    ]) {
      await client.execute({
        sql: "INSERT INTO fmp_cache VALUES ('RECOVER','quote',?,?)",
        args: [String(on), JSON.stringify([{ price: value }])],
      });
    }
    assert.equal((await latestCachedQuotes()).get("RECOVER")?.price, 90);
    const calls = stubFmp((endpoint) =>
      Response.json(
        endpoint === "profile"
          ? [{ companyName: "Valid" }]
          : endpoint === "quote"
            ? [{ price: 100 }]
            : [],
      ),
    );
    assert.equal((await fetchFmpData("RECOVER")).quote?.price, 100);
    assert.equal(calls.filter((endpoint) => endpoint === "quote").length, 1);
  }
});

void test("fmp: an error body under message or error is refused and not stored", async () => {
  for (const key of ["message", "Error Message", "error"]) {
    stubFmp(() => Response.json({ [key]: "Limit reached" }));
    await assert.rejects(fetchProfile("BADBODY"), /error payload/);
    assert.equal(await cachedRows("BADBODY"), 0, key);
  }
});

const fundProfile = (flag: string) =>
  stubFmp((endpoint) =>
    endpoint === "profile"
      ? Response.json([{ companyName: "F", [flag]: true }])
      : Response.json([]),
  );

void test("fmp: both fund flags select fund metadata and skip earnings", async () => {
  for (const flag of ["isEtf", "isFund"]) {
    await client.execute("DELETE FROM fmp_cache");
    const calls = fundProfile(flag);
    const data = await fetchFmpData("FUNDY");
    assert.equal(data.isFund, true, flag);
    assert.ok(calls.includes("etf/info"), flag);
    assert.ok(!calls.includes("earnings"), flag);
  }
});

void test("fmp: grades older than 90 days are left out", async () => {
  stubFmp((endpoint) => {
    if (endpoint === "grades")
      return Response.json([
        { date: daysBack(10), newGrade: "Buy", previousGrade: "Hold" },
        { date: daysBack(100), newGrade: "Sell", previousGrade: "Hold" },
      ]);
    return Response.json(endpoint === "profile" ? [{ companyName: "C" }] : []);
  });
  const data = await fetchFmpData("GRADES");
  assert.deepEqual(
    data.grades.map((g) => g.newGrade),
    ["Buy"],
  );
});

void test("fmp: dividends the plan refuses do not read as a non-payer", async () => {
  const answer = (status: number) =>
    stubFmp((endpoint) =>
      endpoint === "dividends"
        ? status === 200
          ? Response.json([])
          : new Response("", { status })
        : Response.json(endpoint === "profile" ? [{ companyName: "C" }] : []),
    );
  answer(402);
  const refused = await fetchFmpData("DIVNO");
  assert.equal(refused.dividendsCoverageConfirmed, false);
  await client.execute("DELETE FROM fmp_cache");
  answer(200);
  const none = await fetchFmpData("DIVNO");
  assert.equal(none.dividendsCoverageConfirmed, true);
});

void test("fmp: the market calendar keeps only high-impact US events", async () => {
  stubFmp((endpoint) =>
    endpoint === "economic-calendar"
      ? Response.json([
          {
            country: "US",
            impact: "High",
            date: "d",
            event: "CPI",
            estimate: 1,
          },
          { country: "US", impact: "Low", date: "d", event: "Auction" },
          { country: "DE", impact: "High", date: "d", event: "ZEW" },
        ])
      : Response.json([]),
  );
  const context = await fetchMarketContext();
  assert.deepEqual(
    context.us_high_impact_events_next_7_days.map((e) => e.event),
    ["CPI"],
  );
});

void test("fmp: pruning removes old days but keeps SEC's list and retry markers", async () => {
  const old = daysBack(30);
  const put = (ticker: string, endpoint: string, on: string) =>
    client.execute({
      sql: "INSERT INTO fmp_cache VALUES (?,?,?,?)",
      args: [ticker, endpoint, on, "[]"],
    });
  await put("_SEC", "company_tickers", old);
  await put("_SEC", "retrying:acc", old);
  await put("AAA", "quote", old);
  await put("AAA", "profile", today());
  await pruneFmpCache();
  const left = (
    await client.execute("SELECT ticker, endpoint FROM fmp_cache")
  ).rows
    .map((r) => {
      assert.ok(typeof r.ticker === "string" && typeof r.endpoint === "string");
      return `${r.ticker}/${r.endpoint}`;
    })
    .sort();
  assert.deepEqual(left, [
    "AAA/profile",
    "_SEC/company_tickers",
    "_SEC/retrying:acc",
  ]);
});

void test("fmp: pages read the newest cached quote, and an empty one does not hide a real one", async () => {
  const put = (ticker: string, on: string, payload: unknown) =>
    client.execute({
      sql: "INSERT INTO fmp_cache VALUES (?,'quote',?,?)",
      args: [ticker, on, JSON.stringify(payload)],
    });
  await put("AAA", "2026-11-01", [{ price: 1 }]);
  await put("AAA", "2026-11-03", [{ price: 3 }]);
  await put("AAA", "2026-11-02", [{ price: 2 }]);
  await put("BBB", "2026-11-03", []);
  await put("BBB", "2026-11-02", [{ price: 9 }]);
  const quotes = await latestCachedQuotes();
  assert.equal(quotes.get("AAA")?.price, 3);
  assert.equal(quotes.get("AAA")?.quote_date, "2026-11-03");
  assert.equal(quotes.get("BBB")?.price, 9);
  assert.equal(quotes.get("BBB")?.quote_date, "2026-11-02");
  assert.equal((await latestCached("quote")).size, 2);
});

const days = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2026, 10, 4) - i * 86400000)
      .toISOString()
      .slice(0, 10),
    price: 100 + i,
  }));

void test("relative returns require matching start dates as well as end dates", () => {
  const history = days(80);
  const spy = priceSummary(history);
  const sparse = history.filter((_, index) => index === 0 || index > 4);
  const compared = relativeToMarket(fmpFixture({ history: sparse }), spy);
  for (const field of [
    "today_points",
    "5_day_points",
    "1_month_points",
    "3_month_points",
  ] as const) {
    assert.equal(compared?.[field], null, field);
    assert.equal(
      relativeToMarket(fmpFixture({ history }), spy)?.[field],
      0,
      field,
    );
  }
  const missingOne = history.filter((_, index) => index !== 2);
  assert.equal(
    relativeToMarket(fmpFixture({ history: missingOne }), spy)?.[
      "5_day_points"
    ],
    null,
  );
  assert.equal(
    relativeToMarket(fmpFixture({ history }), {
      latest_date: spy!.latest_date,
      return_5d_pct: 1,
    })?.["5_day_points"],
    null,
  );
});

void test("price summary: each window reads its own row", () => {
  const s = priceSummary(days(70));
  assert.equal(
    s?.return_1d_pct,
    Number((((100 - 101) / 101) * 100).toFixed(2)),
  );
  assert.equal(
    s?.return_5d_pct,
    Number((((100 - 105) / 105) * 100).toFixed(2)),
  );
  assert.equal(
    s?.return_1m_pct,
    Number((((100 - 121) / 121) * 100).toFixed(2)),
  );
  assert.equal(
    s?.return_3m_pct,
    Number((((100 - 163) / 163) * 100).toFixed(2)),
  );
  assert.equal(s?.return_1y_pct, null);
  assert.equal(priceSummary(days(21))?.return_1m_pct, null);
  assert.equal(priceSummary(days(63))?.return_3m_pct, null);
});

void test("price summary: the first row for a date stands", () => {
  const s = priceSummary([
    { date: "2026-11-04", price: 110 },
    { date: "2026-11-04", price: 999 },
    { date: "2026-11-03", price: 100 },
  ]);
  assert.equal(s?.latest_price, 110);
});

void test("dividends: a declared payment after the last price is not counted", () => {
  const history = [
    { date: "2026-11-04", price: 110 },
    { date: "2025-11-04", price: 100 },
  ];
  const s = priceSummary(history, [
    { date: "2026-12-15", dividend: 50 },
    { date: "2026-10-01", dividend: 2 },
    { date: "2025-11-04", dividend: 3 },
  ]);
  assert.equal(s?.distributions_1y, 2);
  assert.equal(s?.total_return_1y_pct, 12);
});

void test("dividends: a row with no amount leaves the total unknown", () => {
  const history = [
    { date: "2026-11-04", price: 110 },
    { date: "2025-11-04", price: 100 },
  ];
  const s = priceSummary(history, [
    { date: "2026-10-01", dividend: null },
    { date: "2025-11-04", dividend: 3 },
  ]);
  assert.equal(s?.distributions_1y, null);
  assert.equal(s?.total_return_1y_pct, null);
  assert.equal(s?.distribution_yield_1y_pct, null);
});

void test("estimates: a fiscal year ending today is no longer upcoming", () => {
  assert.deepEqual(
    upcomingEstimates(
      [{ date: "2026-11-04" }, { date: "2027-11-04" }],
      "2026-11-04",
    ).map((e) => e.date),
    ["2027-11-04"],
  );
});

void test("growth from a zero or negative base gives no rate", () => {
  const row = (date: string, operatingIncome: number) => ({
    date,
    period: "Q3",
    fiscalYear: date.slice(0, 4),
    reportedCurrency: "USD",
    revenue: 100,
    operatingIncome,
  });
  const context = (before: number) =>
    fundamentalContext(
      fmpFixture({
        isFund: false,
        quote: { price: 1 },
        income: [row("2026-09-30", 50), row("2025-09-30", before)],
        cashFlow: [],
        ratios: [],
        keyMetrics: [],
        estimates: [],
        earnings: [],
      }),
      "2026-11-04",
    );
  assert.equal(context(0)?.growth.operating_income_yoy_pct, null);
  assert.equal(context(-10)?.growth.operating_income_yoy_pct, null);
  assert.equal(context(25)?.growth.operating_income_yoy_pct, 100);
});

void test("cached bank and exchange revenue keep their reported basis", () => {
  // Recorded vendor rows: CBOE's older actual is still gross.
  const reported = (revenue: number, prior: number, earnings: Row[]) =>
    contextOf({
      income: [
        quarterRow("2026-09-30", { revenue }),
        quarterRow("2025-09-30", { revenue: prior }),
      ],
      earnings,
    });
  const c = reported(45_628_000_000, 43_845_000_000, [
    { date: "2026-10-13", epsActual: 2.85, revenueActual: 23_845_000_000 },
    { date: "2025-11-06", epsActual: 1.86, revenueActual: 22_090_000_000 },
  ]);
  assert.equal(c?.growth.latest_quarter_reported_revenue, 23_845_000_000);
  assert.ok(c && c.growth.revenue_yoy_pct !== null);
  assert.ok(Math.abs(c.growth.revenue_yoy_pct - 7.944771389769126) < 1e-10);
  const cboe = reported(1_358_800_000, 1_141_700_000, [
    { date: "2026-10-30", epsActual: 3.63, revenueActual: 712_200_000 },
    { date: "2025-10-31", epsActual: 2.67, revenueActual: 1_141_700_000 },
  ]);
  assert.equal(cboe?.growth.latest_quarter_reported_revenue, 712_200_000);
  assert.equal(cboe?.growth.revenue_yoy_pct, null);
});

void test("cached cash flow conflicts exclude the yield without doubting a valid tax provision", () => {
  // Recorded CBOE and EXPE income and cash flow fields.
  const cboe = contextOf({
    income: incomeRows((i) =>
      i === 0
        ? {
            revenue: 1_358_800_000,
            netIncome: 428_200_000,
            incomeBeforeTax: 554_500_000,
            incomeTaxExpense: 126_300_000,
            netIncomeFromContinuingOperations: 428_200_000,
          }
        : {},
    ),
    cashFlow: cashRows((i) =>
      i === 0
        ? {
            netIncome: 2_026_000_000,
            operatingCashFlow: 340_100_000,
            capitalExpenditure: -24_100_000,
            freeCashFlow: 316_000_000,
          }
        : {},
    ),
  });
  assert.equal(cboe?.growth.free_cash_flow_ttm, null);
  assert.equal(cboe?.valuation.fcf_yield_ttm_pct, null);
  assert.match(notesOf(cboe), /cash flow rows are unreliable/);
  const expe = contextOf({
    income: incomeRows((i) =>
      i === 0
        ? {
            revenue: 4_938_000_000,
            netIncome: 1_030_000_000,
            incomeBeforeTax: 1_303_000_000,
            incomeTaxExpense: -264_000_000,
            netIncomeFromContinuingOperations: 1_030_000_000,
          }
        : {},
    ),
    cashFlow: cashRows((i) =>
      i === 0
        ? {
            netIncome: 1_039_000_000,
            operatingCashFlow: -1_157_000_000,
            capitalExpenditure: 383_000_000,
            freeCashFlow: -774_000_000,
          }
        : {},
    ),
  });
  assert.equal(expe?.valuation.fcf_yield_ttm_pct, null);
  assert.match(notesOf(expe), /capital spending/);
  assert.doesNotMatch(notesOf(expe), /row does not add up/);
});

void test("cached negative EBITDA cannot make QCOM's trailing multiple look authoritative", () => {
  const qcom = contextOf({
    income: incomeRows((i) =>
      i === 0
        ? {
            date: "2026-09-27",
            period: "Q4",
            revenue: 10_322_000_000,
            incomeBeforeTax: 1_173_000_000,
            interestExpense: 849_000_000,
            depreciationAndAmortization: 806_000_000,
            ebitda: -1_303_000_000,
            netIncome: 1_252_000_000,
            incomeTaxExpense: -8_027_000_000,
            netIncomeFromContinuingOperations: 13_378_000_000,
          }
        : {},
    ),
    keyMetricsTtm: { evToEBITDATTM: 22.57046941753292 },
  });
  assert.equal(qcom?.valuation.ev_to_ebitda_ttm, null);
  assert.match(notesOf(qcom), /EBITDA does not fit/);
});
