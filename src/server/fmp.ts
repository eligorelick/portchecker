import { and, desc, eq, lt, ne } from "drizzle-orm";

import { env } from "../env.js";
import { db } from "./db/index.ts";
import { fmpCache, tickers } from "./db/schema.ts";

const BASE = "https://financialmodelingprep.com/stable/";

// Counts real HTTP requests so `pnpm pack:ticker` can show that a second run makes none.
export const fmpStats = { httpCalls: 0 };

const MIN_REQUEST_GAP_MS = 220; // the Starter plan allows 300 calls per minute
let lastRequestAt = 0;
let requestStart = Promise.resolve();

export class FmpRateLimitError extends Error {}

export function today() {
  return new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local time
}

function daysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toLocaleDateString("en-CA");
}

/**
 * Fetches one endpoint once per ticker per day. An endpoint the plan does not cover (402, 403,
 * 404) is cached as null so the job does not keep asking. A quote or profile is never cached as
 * missing, so it can recover the same day. A 429, a 5xx, a failed connection or malformed JSON gets
 * one retry after a short wait; a second 429 raises FmpRateLimitError so the caller can skip it.
 */
async function fmpGet(
  ticker: string,
  endpoint: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  const fetchedOn = today();
  const [cached] = await db
    .select()
    .from(fmpCache)
    .where(
      and(
        eq(fmpCache.ticker, ticker),
        eq(fmpCache.endpoint, endpoint),
        eq(fmpCache.fetchedOn, fetchedOn),
      ),
    );
  if (cached) {
    const payload: unknown = JSON.parse(cached.payloadJson);
    // An error or a missing quote stored earlier counts as a miss, and the fetch below replaces it.
    if (!isFmpErrorPayload(payload) && validFmpPayload(endpoint, payload)) {
      return payload;
    }
  }

  if (!env.FMP_API_KEY) throw new Error("FMP_API_KEY is not set in .env");
  const url = new URL(endpoint, BASE);
  for (const [k, v] of Object.entries({ symbol: ticker, ...params })) {
    url.searchParams.set(k, v);
  }
  url.searchParams.set("apikey", env.FMP_API_KEY);

  let result = await fetchCounted(url).catch(() => null);
  if (!result || result.res.status === 429 || result.res.status >= 500) {
    await new Promise((r) => setTimeout(r, 3000));
    result = await fetchCounted(url);
    if (result.res.status === 429) {
      throw new FmpRateLimitError(
        `FMP rate limit on ${endpoint} for ${ticker}`,
      );
    }
  }

  const { res, payload } = result;
  if (
    !res.ok &&
    // A refused quote is an account problem, and must not read as a wrong symbol.
    !(endpoint === "quote" ? [404] : [402, 403, 404]).includes(res.status)
  ) {
    // The URL holds the API key, so errors name only the endpoint.
    throw new Error(`FMP ${endpoint} for ${ticker} returned ${res.status}`);
  }

  if (!validFmpPayload(endpoint, payload)) return payload;

  await db
    .insert(fmpCache)
    .values({
      ticker,
      endpoint,
      fetchedOn,
      payloadJson: JSON.stringify(payload),
    })
    .onConflictDoUpdate({
      target: [fmpCache.ticker, fmpCache.endpoint, fmpCache.fetchedOn],
      set: { payloadJson: JSON.stringify(payload) },
    });
  return payload;
}

/** Only a whole-response object counts: a data row may carry a field with one of these names. */
function isFmpErrorPayload(payload: unknown) {
  return (
    !!payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.keys(payload).some((k) => /^(error|message)/i.test(k))
  );
}

/** Error bodies must never become day-long data; empty identity/quote responses can retry. */
export function validFmpPayload(endpoint: string, payload: unknown) {
  if (isFmpErrorPayload(payload)) {
    throw new Error("FMP returned an error payload");
  }
  if (endpoint === "quote") return usableQuote(rows(payload)[0]);
  return endpoint !== "profile" || rows(payload).length > 0;
}

function usableQuote(quote: Row | null | undefined) {
  return (num(quote?.price) ?? 0) > 0;
}

async function fetchCounted(url: URL) {
  // Reserve starts, not whole responses: concurrent holdings and retries share the same pacing.
  const turn = requestStart.then(async () => {
    const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
  });
  requestStart = turn.catch(() => undefined);
  await turn;
  fmpStats.httpCalls += 1;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const payload: unknown = res.ok ? await res.json() : null;
  return { res, payload };
}

export type Row = Record<string, unknown>;

function rows(payload: unknown): Row[] {
  return Array.isArray(payload)
    ? payload.filter(
        (row): row is Row =>
          row !== null && typeof row === "object" && !Array.isArray(row),
      )
    : [];
}

export type FmpData = {
  profile: Row | null;
  quote: Row | null;
  income: Row[];
  balance: Row[];
  cashFlow: Row[];
  keyMetrics: Row[];
  keyMetricsTtm: Row | null;
  ratios: Row[];
  ratiosTtm: Row | null;
  history: Row[];
  news: Row[];
  isFund: boolean;
  earnings: Row[];
  estimates: Row[];
  priceTargetConsensus: Row | null;
  priceTargetSummary: Row | null;
  priceTargetNews: Row[];
  gradesConsensus: Row | null;
  grades: Row[];
  rating: Row | null;
  scores: Row | null;
  insiderTrades: Row[];
  dividends: Row[];
  dividendsCoverageConfirmed?: boolean;
  fundInfo: Row | null;
  fundSectors: Row[];
  fundCountries: Row[];
};

export async function fetchProfile(ticker: string) {
  return rows(await fmpGet(ticker, "profile"))[0] ?? null;
}

/** A saved position should not wait for research to get its first price. Saving always wins. */
export async function cacheMissingHoldingQuotes(tickers: string[]) {
  if (!env.FMP_API_KEY) return;
  try {
    const cached = await latestCachedQuotes();
    for (const ticker of new Set(tickers)) {
      if (ticker === "CASH" || usableQuote(cached.get(ticker))) continue;
      try {
        await fmpGet(ticker, "quote");
      } catch {
        // The existing missing-price notice is the fallback when the vendor is unavailable. Each
        // further ticker would wait out the same failure while the save that called this hangs.
        return;
      }
    }
  } catch {
    // A cache read failure must not turn an already-saved holding into a failed save.
  }
}

// A year of daily prices, the same window for a holding and for the S&P 500 it is compared with.
async function oneYearHistory(ticker: string) {
  return rows(
    await fmpGet(ticker, "historical-price-eod/light", {
      from: daysAgo(365),
      to: today(),
    }),
  );
}

// Quarterly key-metrics and ratios return 402 on the Starter plan, so these use annual and TTM.
export async function fetchFmpData(ticker: string): Promise<FmpData> {
  const quarterly = { period: "quarter", limit: "8" };
  let profile = await fetchProfile(ticker);
  // No answer today must not turn a fund into a stock, or give a bank back its EV multiple.
  if (!profile) {
    const [stored] = await db
      .select({ json: tickers.fmpProfileJson })
      .from(tickers)
      .where(eq(tickers.ticker, ticker));
    profile = stored?.json ? (JSON.parse(stored.json) as Row) : null;
  }
  const isFund = profile?.isEtf === true || profile?.isFund === true;
  const first = async (endpoint: string, params = {}) => {
    const row = rows(await fmpGet(ticker, endpoint, params))[0] ?? null;
    if (endpoint === "quote" && !usableQuote(row)) return null;
    return row && endpoint === "quote"
      ? {
          ...row,
          quote_date: quoteDate(row, today()),
          as_of_et: quoteTimeEt(row),
        }
      : row;
  };
  const list = async (endpoint: string, params = {}) =>
    rows(await fmpGet(ticker, endpoint, params));
  // A monthly payer needs 13 rows to reach back past a one-year price window.
  const dividendPayload = await fmpGet(ticker, "dividends", { limit: "16" });
  // Funds have no statements, estimates or insiders; companies have no fund data.
  return {
    isFund,
    earnings: isFund ? [] : await list("earnings", { limit: "8" }),
    // FMP returns the furthest years first, so ask for enough to reach the near ones.
    estimates: isFund
      ? []
      : await list("analyst-estimates", { period: "annual", limit: "10" }),
    priceTargetConsensus: isFund ? null : await first("price-target-consensus"),
    priceTargetSummary: isFund ? null : await first("price-target-summary"),
    priceTargetNews: isFund
      ? []
      : await list("price-target-news", { limit: "10" }),
    gradesConsensus: isFund ? null : await first("grades-consensus"),
    // FMP ignores limit here and returns years of rows, so keep the last 90 days.
    grades: isFund
      ? []
      : (await list("grades")).filter((g) => String(g.date) >= daysAgo(90)),
    rating: isFund ? null : await first("ratings-snapshot"),
    scores: isFund ? null : await first("financial-scores"),
    insiderTrades: isFund
      ? []
      : await list("insider-trading/search", { limit: "20" }),
    dividends: rows(dividendPayload),
    dividendsCoverageConfirmed: Array.isArray(dividendPayload),
    fundInfo: isFund ? await first("etf/info") : null,
    fundSectors: isFund ? await list("etf/sector-weightings") : [],
    fundCountries: isFund ? await list("etf/country-weightings") : [],
    profile,
    quote: await first("quote"),
    income: await list("income-statement", quarterly),
    balance: await list("balance-sheet-statement", quarterly),
    cashFlow: await list("cash-flow-statement", quarterly),
    keyMetrics: await list("key-metrics", { limit: "5" }),
    keyMetricsTtm: await first("key-metrics-ttm"),
    ratios: await list("ratios", { limit: "5" }),
    ratiosTtm: await first("ratios-ttm"),
    history: await oneYearHistory(ticker),
    news: await list("news/stock", {
      symbols: ticker,
      from: daysAgo(7),
      to: today(),
      limit: "20",
    }),
  };
}

function pctChange(from: number | undefined, to: number) {
  return from ? Number((((to - from) / from) * 100).toFixed(2)) : null;
}

/** The S&P 500's recent moves and the coming week's major US data releases. */
export async function fetchMarketContext() {
  // SPY always pays, so a refused or empty list is no proof of what it paid, and costs only the total.
  const dividends = await fmpGet("SPY", "dividends", { limit: "16" }).catch(
    () => null,
  );
  const spy = priceSummary(
    await oneYearHistory("SPY"),
    Array.isArray(dividends) && dividends.length ? rows(dividends) : undefined,
  );
  const calendar = rows(
    await fmpGet("_MARKET", "economic-calendar", {
      from: today(),
      to: daysAgo(-7),
    }),
  );
  return {
    sp500_proxy_spy: spy,
    us_high_impact_events_next_7_days: calendar
      .filter((e) => e.country === "US" && e.impact === "High")
      // The vendor lists the furthest dates first, and the soonest matter most.
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map((e) => ({ date: e.date, event: e.event, estimate: e.estimate }))
      .slice(0, 20),
  };
}

/** Removes cached days older than a week, keeping SEC's ticker list. */
export async function pruneFmpCache() {
  await db
    .delete(fmpCache)
    .where(
      and(lt(fmpCache.fetchedOn, daysAgo(7)), ne(fmpCache.ticker, "_SEC")),
    );
}

/** Newest first, one row a day, and a missing price is no price, not zero. */
export function pricePoints(history: Row[]) {
  const byDate = new Map<string, number>();
  for (const h of history) {
    const price =
      typeof h.price === "number" || (typeof h.price === "string" && h.price)
        ? Number(h.price)
        : NaN;
    // "undefined" would sort after every real date and become the latest price.
    if (typeof h.date !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(h.date))
      continue;
    if (price > 0 && Number.isFinite(price) && !byDate.has(h.date))
      byDate.set(h.date, price);
  }
  return [...byDate]
    .map(([date, price]) => ({ date, price }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

const FULL_YEAR_MIN_DAYS = 350;
const SAME_START_MAX_DAYS = 7;

/** One-year price facts. */
export function priceSummary(history: Row[], dividends?: Row[]) {
  const points = pricePoints(history);
  const latest = points[0];
  if (!latest) return null;
  const prices = points.map((p) => p.price);
  const start = points[points.length - 1]!;
  // A new listing's few weeks are not a year, whatever the field is called.
  const fullYear =
    (Date.parse(latest.date) - Date.parse(start.date)) / 86400000 >=
    FULL_YEAR_MIN_DAYS;
  // A boundary dividend proves this capped list reaches the beginning of the price window.
  // An explicit empty successful list confirms a non-payer; omitted data does not.
  const covered =
    dividends !== undefined &&
    (dividends.length === 0 ||
      dividends.some((d) => String(d.date) <= start.date));
  const inWindow =
    dividends?.filter(
      (d) => String(d.date) > start.date && String(d.date) <= latest.date,
    ) ?? [];
  // Adjusted for any split since, on the basis the vendor's price history is taken to be on.
  const cash = inWindow.map((d) => num(d.adjDividend) ?? num(d.dividend));
  const paid =
    fullYear && covered && cash.every((d) => d !== null)
      ? Number(cash.reduce<number>((sum, d) => sum + (d ?? 0), 0).toFixed(4))
      : null;
  const totalReturn =
    paid !== null && start.price > 0
      ? ((latest.price - start.price + paid) / start.price) * 100
      : null;
  return {
    price_return_1y_pct: fullYear ? pctChange(start.price, latest.price) : null,
    total_return_1y_pct:
      totalReturn === null ? null : Number(totalReturn.toFixed(2)),
    total_return_method:
      "Price change plus cash dividends by ex-date, without reinvestment; null when dividend coverage is unconfirmed or the price history is under a year.",
    // Commentary quotes yields at other prices, so this is the one at today's.
    start_date: start.date,
    start_price: start.price,
    distributions_1y: paid,
    distributions_1y_count: paid === null ? null : cash.length,
    distribution_yield_1y_pct:
      paid === null || latest.price <= 0
        ? null
        : Number(((paid / latest.price) * 100).toFixed(2)),
    latest_date: latest.date,
    latest_price: latest.price,
    start_1d_date: points[1]?.date ?? null,
    start_5d_date: points[5]?.date ?? null,
    start_1m_date: points[21]?.date ?? null,
    start_3m_date: points[63]?.date ?? null,
    return_1d_pct: pctChange(points[1]?.price, latest.price),
    return_5d_pct: pctChange(points[5]?.price, latest.price),
    return_1m_pct: pctChange(points[21]?.price, latest.price),
    return_3m_pct: pctChange(points[63]?.price, latest.price),
    return_1y_pct: fullYear ? pctChange(start.price, latest.price) : null,
    high_1y: Math.max(...prices),
    low_1y: Math.min(...prices),
    trading_days: points.length,
  };
}

export const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** A row with no actual, whether null or left out, has not been reported. Zero has. */
export const hasReported = (e: Row) => num(e.epsActual) !== null;

/** A statement's currency. Foreign filers can report in their home currency; quotes are in dollars. */
export function reportingCurrency(row: Row | null | undefined) {
  const reported = row?.reportedCurrency;
  return typeof reported === "string" ? reported : null;
}

/** A total across currencies is a total in none. */
export const oneCurrency = (rows: Row[]) =>
  new Set(rows.map(reportingCurrency)).size <= 1;

/** Zero operating cash flow means FMP has no data for that quarter yet, which is common for banks. */
export const cashFlowMissing = (row: Row | null | undefined) =>
  num(row?.operatingCashFlow) === 0;

/** Estimates after a date, nearest first. FMP returns the furthest years first. */
export function upcomingEstimates(estimates: Row[], asOf: string) {
  return estimates
    .filter((e) => String(e.date) > asOf)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (!sorted.length) return null;
  return sorted.length % 2
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function values(rows: Row[], field: string) {
  return rows.flatMap((r) => {
    const n = num(r[field]);
    return n === null ? [] : [n];
  });
}

// A negative multiple means nothing, so a typical multiple leaves those years out.
const positives = (rows: Row[], field: string) =>
  values(rows, field).filter((n) => n > 0);
const positiveOrNull = (n: number | null) => (n !== null && n > 0 ? n : null);

function growthPct(now: unknown, before: unknown) {
  const a = num(now);
  const b = num(before);
  return a === null || b === null || b <= 0 ? null : ((a - b) / b) * 100;
}

/** Fiscal quarter ends can move by a week (52/53-week years). Reject gaps and duplicates. */
export function fourConsecutiveQuarters(rows: Row[]) {
  if (rows.length !== 4) return false;
  const dates = rows.map((r) =>
    typeof r.date === "string" ? Date.parse(r.date) : NaN,
  );
  return dates.every(
    (d, i) =>
      Number.isFinite(d) &&
      (i === 0 ||
        ((dates[i - 1]! - d) / 86400000 >= 70 &&
          (dates[i - 1]! - d) / 86400000 <= 110)),
  );
}

/**
 * The same quarter a year earlier, in the same currency. Counting four rows back compares the wrong
 * quarters when one is missing or restated, and a period the vendor has none for gives no growth.
 */
export function yearAgoRow(rows: Row[]) {
  const latest = rows[0];
  if (typeof latest?.date !== "string") return undefined;
  const target = Date.parse(latest.date) - 365 * 86400000;
  return rows
    .slice(1)
    .find(
      (r) =>
        typeof r.date === "string" &&
        Math.abs(Date.parse(r.date) - target) <= 20 * 86400000 &&
        reportingCurrency(r) === reportingCurrency(latest),
    );
}

/** Tax and continuing income must fit the row's own pretax and net income. QCOM's Q4 did not. */
function rowsThatDoNotAddUp(rows: Row[]) {
  return rows.flatMap((r) => {
    const pretax = num(r.incomeBeforeTax);
    const tax = num(r.incomeTaxExpense);
    const continuing = num(r.netIncomeFromContinuingOperations);
    const net = num(r.netIncome);
    if (pretax === null || tax === null || continuing === null || net === null)
      return [];
    const allowed = Math.max(
      Math.abs(pretax) * 0.1,
      Math.abs(net) * 0.1,
      Math.abs(num(r.revenue) ?? 0) * 0.01,
    );
    // Some rows carry the filing's bracketed provision as a negative, and the row still adds up.
    const taxFits = (t: number) => Math.abs(pretax - t - continuing) <= allowed;
    return !(taxFits(tax) || taxFits(-tax)) ||
      Math.abs(continuing - net) > allowed
      ? [
          `The vendor's ${String(r.period)} ${String(r.fiscalYear)} row does not add up: pretax income ${pretax}, tax ${tax}, income from continuing operations ${continuing}, net income ${net}. Treat these lines as unreliable and prefer the filing.`,
        ]
      : [];
  });
}

const quarterLabel = (r: Row | undefined) =>
  `${String(r?.period)} ${String(r?.fiscalYear)}`;
const CASH_FLOW_NET_INCOME_GAP = 0.05;
const CASH_FLOW_REVENUE_GAP = 0.01;
const FREE_CASH_FLOW_GAP = 0.01;

/**
 * Vendor cash flow quarters that contradict themselves. CBOE's Q3 showed $2,026M of net income against
 * $428M in its income statement, and EXPE's capital spending was a positive six-month total. Summing
 * rows like these gives a free cash flow yield that looks exact and means nothing.
 */
function cashFlowRowsInDoubt(cash: Row[], income: Row[]) {
  return cash.flatMap((row) => {
    const capex = num(row.capitalExpenditure);
    if (capex !== null && capex > 0)
      return [
        {
          row,
          why: `${quarterLabel(row)} shows capital spending of +${capex}, when spending is an outflow`,
        },
      ];
    const operating = num(row.operatingCashFlow);
    const free = num(row.freeCashFlow);
    // Free cash flow is defined as these two. Zero operating cash flow means no data, not a conflict.
    if (
      capex !== null &&
      operating &&
      free !== null &&
      Math.abs(free - (operating + capex)) >
        Math.max(Math.abs(operating), Math.abs(capex)) * FREE_CASH_FLOW_GAP
    )
      return [
        {
          row,
          why: `${quarterLabel(row)} shows free cash flow of ${free} against operating cash flow of ${operating} and capital spending of ${capex}`,
        },
      ];
    const own = num(row.netIncome);
    const match = income.find((r) => r.date === row.date);
    const net = num(match?.netIncome);
    // Minority interest and rounding move a small quarter by a few percent of its own net income.
    const allowed = Math.max(
      Math.abs(net ?? 0) * CASH_FLOW_NET_INCOME_GAP,
      Math.abs(num(match?.revenue) ?? 0) * CASH_FLOW_REVENUE_GAP,
    );
    return own !== null && net !== null && Math.abs(own - net) > allowed
      ? [
          {
            row,
            why: `${quarterLabel(row)} shows net income of ${own} against ${net} in the income statement`,
          },
        ]
      : [];
  });
}

const EBITDA_GAP = 0.25;

/** Quarters whose EBITDA is not their own pretax income, interest and D&A. QCOM's Q4 was negative. */
function ebitdaRowsInDoubt(rows: Row[]) {
  return rows.filter((r) => {
    const ebitda = num(r.ebitda);
    const pretax = num(r.incomeBeforeTax);
    if (ebitda === null || pretax === null) return false;
    const expected =
      pretax +
      Math.abs(num(r.interestExpense) ?? 0) +
      (num(r.depreciationAndAmortization) ?? 0);
    return Math.abs(ebitda - expected) > Math.abs(expected) * EBITDA_GAP;
  });
}

const OTHER_INCOME_SHARE = 0.1;
const SHARE_COUNT_GAP = 0.97;
const BIG_NET_SHARE = 0.95;
const HOME_RATE_GAP = 0.05;
const ESTIMATE_CURRENCY_GAP = 3;

/** Earnings the trailing P/E leans on that operations did not produce. Null with too little data. */
function trailingEarningsMix(rows: Row[], marketCap: number | null) {
  if (!fourConsecutiveQuarters(rows) || !oneCurrency(rows)) return null;
  const pretax = sumField(rows, "incomeBeforeTax");
  const operating = sumField(rows, "operatingIncome");
  const net = sumField(rows, "netIncome");
  if (pretax === null || operating === null || net === null || pretax <= 0)
    return null;
  const usable =
    marketCap !== null &&
    marketCap > 0 &&
    rows.every((r) => reportingCurrency(r) === "USD");
  const otherShare = (pretax - operating) / pretax;
  const taxFavored = net / pretax >= BIG_NET_SHARE;
  return {
    otherShare,
    taxFavored,
    pretax,
    operating,
    net,
    peWithoutOther:
      usable && otherShare >= OTHER_INCOME_SHARE && operating > 0
        ? marketCap / ((net * operating) / pretax)
        : null,
    pricePretax: usable ? marketCap / pretax : null,
  };
}

const REVENUE_BASIS_GAP = 0.1;
const REPORTED_WITHIN_DAYS = 120;
// An insurance broker holds no premiums and is valued on its cash flow, so it stays out.
export const BANK_LIKE =
  /\bbanks?\b|capital markets|\bmortgages?\b|\binsurance\b(?!\s*-?\s*brokers?)/i;

const STATEMENT_LAG_DAYS = 100;
const CASH_FLOW_MAX_AGE_DAYS = 200;

function sumField(rows: Row[], field: string) {
  const values = rows.flatMap((r) => {
    const n = num(r[field]);
    return n === null ? [] : [n];
  });
  return values.length === rows.length && rows.length
    ? values.reduce((a, b) => a + b, 0)
    : null;
}

/** One row per fiscal year, so the medians can be checked. A loss year has no P/E. */
function fiscalYearHistory(
  fmp: FmpData,
  bankLike: boolean,
  ebitdaYearInDoubt: (row: Row | undefined) => boolean,
) {
  return fmp.ratios.map((r) => {
    const metrics = fmp.keyMetrics.find((m) => m.date === r.date);
    const pe = num(r.priceToEarningsRatio);
    const fcfYield = num(metrics?.freeCashFlowYield);
    return {
      fiscal_year_end: r.date,
      pe: positiveOrNull(pe),
      ev_to_ebitda:
        bankLike || ebitdaYearInDoubt(metrics)
          ? null
          : positiveOrNull(num(metrics?.evToEBITDA)),
      fcf_yield_pct: bankLike || fcfYield === null ? null : fcfYield * 100,
      ...(bankLike ? { price_to_book: num(r.priceToBookRatio) } : {}),
    };
  });
}

/**
 * Valuation and growth worked out in code from FMP's own numbers, so a review has real benchmarks
 * (the stock's history, forward earnings, analyst targets) and no model does the arithmetic.
 */
export function fundamentalContext(fmp: FmpData, asOf = today()) {
  if (fmp.isFund) return null;
  const price = num(fmp.quote?.price);
  const upcoming = upcomingEstimates(fmp.estimates, asOf);
  const nearest = upcoming[0];
  const after = upcoming[1];
  const forwardEps = num(nearest?.epsAvg);
  const nextEps = num(after?.epsAvg);
  const target = num(fmp.priceTargetConsensus?.targetConsensus);
  const yearHigh = num(fmp.quote?.yearHigh);
  const yearLow = num(fmp.quote?.yearLow);
  const pe = positives(fmp.ratios, "priceToEarningsRatio");
  const yearAgo = yearAgoRow(fmp.income);
  const fcfYieldTtm = num(fmp.keyMetricsTtm?.freeCashFlowYieldTTM);
  // A negative yield is a real year of burning cash, so it stays in the median.
  const fcfYieldMedian = median(values(fmp.keyMetrics, "freeCashFlowYield"));
  const income = fmp.income;
  const currency = reportingCurrency(income[0]);
  const inDollars = currency === "USD";
  // A bank's vendor revenue is gross of interest and an exchange's is gross of rebates, so it is about
  // twice what the company reports. Growth and margins on that basis match nothing the company says.
  const reportedRevenue = (row: Row | undefined) => {
    const end = typeof row?.date === "string" ? Date.parse(row.date) : NaN;
    const after = fmp.earnings
      .filter((e) => {
        const days = (Date.parse(String(e.date)) - end) / 86400000;
        return hasReported(e) && days >= 0 && days <= REPORTED_WITHIN_DAYS;
      })
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
    return num(after?.revenueActual);
  };
  const latestReported = reportedRevenue(income[0]);
  const latestRevenue = num(income[0]?.revenue);
  const grossRevenue =
    inDollars &&
    latestReported !== null &&
    latestReported > 0 &&
    latestRevenue !== null &&
    Math.abs(latestRevenue / latestReported - 1) > REVENUE_BASIS_GAP;
  // The vendor's older reported figures can still be gross, which made CBOE's 18% growth read -38%.
  const onLatestBasis = (row: Row | undefined) => {
    const reported = reportedRevenue(row);
    const statement = num(row?.revenue);
    if (!reported || !statement || !latestReported || !latestRevenue)
      return false;
    return (
      Math.abs(reported / statement / (latestReported / latestRevenue) - 1) <=
      REVENUE_BASIS_GAP
    );
  };
  const revenueOf = (row: Row | undefined) => {
    if (!grossRevenue) return num(row?.revenue);
    return onLatestBasis(row) ? reportedRevenue(row) : null;
  };
  const margin = (row: Row | undefined) => {
    const op = num(row?.operatingIncome);
    const rev = revenueOf(row);
    return op === null || !rev ? null : (op / rev) * 100;
  };
  const lastFour = income.slice(0, 4);
  const lastFourRevenue = lastFour.map(revenueOf);
  const lastFourNet = sumField(lastFour, "netIncome");
  const netMarginOnReported =
    grossRevenue &&
    fourConsecutiveQuarters(lastFour) &&
    oneCurrency(lastFour) &&
    lastFourNet !== null &&
    lastFourRevenue.every((r) => r)
      ? lastFourNet /
        lastFourRevenue.reduce<number>((sum, r) => sum + (r ?? 0), 0)
      : null;
  const cashInDoubt = cashFlowRowsInDoubt(fmp.cashFlow.slice(0, 8), income);
  // Totals here read as reporting_currency, and quarters in two currencies add up to nothing.
  const cashInOneCurrency = (rows: Row[]) => {
    const rowCurrency = reportingCurrency(rows[0]);
    return (
      oneCurrency(rows) &&
      (rowCurrency === null || currency === null || rowCurrency === currency)
    );
  };
  const currenciesIn = (rows: Row[]) =>
    [
      ...new Set([
        ...(currency ? [currency] : []),
        ...rows.map((r) => reportingCurrency(r) ?? "none stated"),
      ]),
    ].join(", ");
  // Counting a quarter with no data as zero would make the trailing total and the yield wrong.
  const complete = (rows: Row[]) =>
    fourConsecutiveQuarters(rows) &&
    cashInOneCurrency(rows) &&
    !rows.some(cashFlowMissing) &&
    !rows.some((r) => cashInDoubt.some((d) => d.row === r));
  const cashNow = fmp.cashFlow.slice(0, 4);
  const cashBefore = fmp.cashFlow.slice(4, 8);
  // Four old quarters would add up perfectly and read as today's yield.
  const cashCurrent =
    typeof cashNow[0]?.date === "string" &&
    Date.parse(asOf) - Date.parse(cashNow[0].date) <=
      CASH_FLOW_MAX_AGE_DAYS * 86400000;
  const fcfNow =
    complete(cashNow) && cashCurrent ? sumField(cashNow, "freeCashFlow") : null;
  const fcfBefore =
    complete(cashBefore) &&
    cashCurrent &&
    yearAgoRow(fmp.cashFlow) === cashBefore[0]
      ? sumField(cashBefore, "freeCashFlow")
      : null;
  // Foreign filers can report in their home currency while the ADR trades in dollars, so dividing
  // the price by those estimates gives a meaningless P/E. Growth rates are still comparable.
  const marketCap = num(fmp.quote?.marketCap);
  const computedYield =
    fcfNow !== null &&
    cashNow.every((r) => reportingCurrency(r) === "USD") &&
    marketCap !== null &&
    marketCap > 0
      ? (fcfNow / marketCap) * 100
      : null;
  const vendorYield =
    fcfYieldTtm === null || !complete(cashNow) || !cashCurrent
      ? null
      : fcfYieldTtm * 100;
  const eps =
    fourConsecutiveQuarters(lastFour) &&
    lastFour.every((r) => reportingCurrency(r) === "USD")
      ? sumField(lastFour, "epsDiluted")
      : null;
  const quarterlyPe =
    price !== null && price > 0 && eps !== null && eps > 0 ? price / eps : null;
  const vendorPe = num(fmp.ratiosTtm?.priceToEarningsRatioTTM);
  // A foreign filer's key metrics cap is in its home currency, so the two caps give the vendor's own
  // rate. It counts only if it reproduces the vendor's trailing P/E, which an ADR that is not 1:1
  // fails, and if the estimates sit near trailing EPS, which estimates in dollars do not.
  const homeCap = num(fmp.keyMetricsTtm?.marketCap);
  const homeEps =
    fourConsecutiveQuarters(lastFour) && oneCurrency(lastFour)
      ? sumField(lastFour, "epsDiluted")
      : null;
  const homeRate =
    !inDollars &&
    currency !== null &&
    price !== null &&
    price > 0 &&
    homeCap !== null &&
    homeCap > 0 &&
    marketCap !== null &&
    marketCap > 0 &&
    homeEps !== null &&
    homeEps > 0 &&
    vendorPe !== null &&
    vendorPe > 0 &&
    forwardEps !== null &&
    forwardEps > homeEps / ESTIMATE_CURRENCY_GAP &&
    forwardEps < homeEps * ESTIMATE_CURRENCY_GAP &&
    Math.abs((price * homeCap) / marketCap / homeEps / vendorPe - 1) <=
      HOME_RATE_GAP
      ? homeCap / marketCap
      : null;
  const toEstimateCurrency = inDollars ? 1 : homeRate;
  const estimatePrice =
    price !== null && toEstimateCurrency !== null
      ? price * toEstimateCurrency
      : null;
  const differs = (
    vendor: number | null,
    computed: number | null,
    threshold: number,
  ) =>
    vendor !== null &&
    computed !== null &&
    Math.abs(vendor - computed) > Math.abs(computed) * threshold;
  const dataNotes: string[] = [];
  if (currency && !inDollars)
    dataNotes.push(
      `Statements, annual estimates, the market cap in the key metrics and enterprise values are in ${currency}. The quote, price targets, earnings history and next earnings figures are in US dollars, so compare them with those only as percentages or ratios.`,
    );
  if (homeRate !== null)
    dataNotes.push(
      `The forward P/E and next-year P/E convert the dollar price to ${currency} at ${homeRate.toFixed(4)}, the rate the vendor's two market caps imply, because the estimates are in ${currency}.`,
    );
  if (differs(vendorYield, computedYield, 0.1))
    dataNotes.push(
      `Vendor FCF yield is ${vendorYield!.toFixed(2)}%; the four USD cash-flow quarters divided by quote market cap give ${computedYield!.toFixed(2)}%, which is used here.`,
    );
  if (differs(vendorPe, quarterlyPe, 0.15))
    dataNotes.push(
      `Vendor trailing P/E is ${vendorPe!.toFixed(2)}; price over the four newest quarterly diluted EPS gives ${quarterlyPe!.toFixed(2)}. The vendor figure can lag a just-reported quarter, and one-off items such as a tax benefit can also cause this; neither should be treated as authoritative without checking.`,
    );
  if (complete(cashNow) && !cashCurrent)
    dataNotes.push(
      `The newest cash flow statement is dated ${String(cashNow[0]?.date)}, too old for a current free cash flow yield, so none is given.`,
    );
  dataNotes.push(...rowsThatDoNotAddUp(income.slice(0, 8)));
  // An EV multiple and a cash yield mean something else where debt and cash flow include client funds.
  const industry = fmp.profile?.industry;
  const bankLike = typeof industry === "string" && BANK_LIKE.test(industry);
  if (bankLike)
    dataNotes.push(
      `This is ${/insurance/i.test(String(industry)) ? "an insurer, whose cash flow includes premiums held for future claims" : /mortgage/i.test(String(industry)) ? "a mortgage lender, whose debt and cash flow mostly fund loans" : "a bank or broker, whose debt and cash flow include customer funds"}, so EV/EBITDA and free cash flow yield are left out here. Disregard those measures in key_metrics_ttm and key_metrics_annual, and use earnings and book value. Price to common book here is market cap over equity less preferred stock. The vendor's price to book, its median and the fiscal year history count preferred stock as book, so compare the vendor's figure with those and quote price to common book for the level.`,
    );
  // The vendor's newest row can show no preferred stock until the 10-Q arrives, as SCHW's did.
  const commonEquity = bankLike
    ? (num(fmp.balance[0]?.totalStockholdersEquity) ?? 0) -
      (values(fmp.balance, "preferredStock").find((v) => v > 0) ?? 0)
    : 0;
  const bookValue = bankLike
    ? {
        price_to_common_book_ttm:
          marketCap !== null &&
          marketCap > 0 &&
          commonEquity > 0 &&
          reportingCurrency(fmp.balance[0]) === "USD"
            ? marketCap / commonEquity
            : null,
        price_to_book_ttm: num(fmp.ratiosTtm?.priceToBookRatioTTM),
        price_to_book_median_last_5_fiscal_years: median(
          positives(fmp.ratios, "priceToBookRatio"),
        ),
      }
    : {};
  const doubtIn = (rows: Row[]) =>
    cashInDoubt.filter((d) => rows.includes(d.row)).map((d) => d.why);
  if (!bankLike && doubtIn(cashNow).length)
    dataNotes.push(
      `The vendor's cash flow rows are unreliable: ${doubtIn(cashNow).join("; ")}. The trailing free cash flow and its yield are left out, so take cash flow from the filing, and disregard freeCashFlowYieldTTM in key_metrics_ttm.`,
    );
  if (!bankLike && doubtIn(cashBefore).length)
    dataNotes.push(
      `The year-earlier free cash flow total is left out because the vendor's row is unreliable: ${doubtIn(cashBefore).join("; ")}.`,
    );
  if (
    !bankLike &&
    fourConsecutiveQuarters(cashNow) &&
    !cashInOneCurrency(cashNow)
  )
    dataNotes.push(
      `The vendor's last four cash flow quarters and income statement are in more than one currency (${currenciesIn(cashNow)}), so they do not add up to a total. The trailing free cash flow and its yield are left out, so take cash flow from the filing.`,
    );
  if (
    !bankLike &&
    fourConsecutiveQuarters(cashBefore) &&
    !cashInOneCurrency(cashBefore)
  )
    dataNotes.push(
      `The year-earlier free cash flow total is left out because its quarters and the income statement are in more than one currency (${currenciesIn(cashBefore)}).`,
    );
  const ebitdaInDoubt = ebitdaRowsInDoubt(income.slice(0, 4));
  if (!bankLike && ebitdaInDoubt.length)
    dataNotes.push(
      `The vendor's EBITDA does not fit its own pretax income, interest and depreciation in ${ebitdaInDoubt.map(quarterLabel).join(", ")}, so the trailing EV/EBITDA is left out. Disregard evToEBITDATTM in key_metrics_ttm.`,
    );
  // The vendor's annual EBITDA is usually the sum of its quarters: QCOM's 8,658M for 2026 holds the -1,303M.
  const quartersInDoubt = ebitdaRowsInDoubt(income);
  const ebitdaYearInDoubt = (row: Row | undefined) =>
    typeof row?.fiscalYear === "string" &&
    quartersInDoubt.some((q) => q.fiscalYear === row.fiscalYear);
  const yearsInDoubt = fmp.keyMetrics
    .filter(ebitdaYearInDoubt)
    .map((m) => String(m.fiscalYear));
  if (!bankLike && yearsInDoubt.length)
    dataNotes.push(
      `The vendor's EBITDA for fiscal ${yearsInDoubt.join(", ")} includes a quarter that does not fit, so EV/EBITDA for that period is left out of the fiscal year history and median, and its other EBITDA measures are left out of the annual tables.`,
    );
  if (grossRevenue)
    dataNotes.push(
      `Vendor revenue for ${quarterLabel(income[0])} is ${latestRevenue}, but the company reported ${latestReported}. The vendor's figure is gross, so revenue_yoy_pct and the operating margins here use the reported revenue in earnings_history instead.${revenueOf(yearAgo) === null ? " The year-ago reported figure is not on the same basis, so that growth rate and margin are left out; take them from the filing." : ""} Do not compare revenue in income_statement_quarterly with the company's reported revenue, and disregard the vendor's own margins, price-to-sales and EV-to-sales ratios, which rest on the gross figure.`,
    );
  const mix = trailingEarningsMix(lastFour, marketCap);
  const enterpriseValue = num(fmp.keyMetricsTtm?.enterpriseValueTTM);
  const depreciation = sumField(lastFour, "depreciationAndAmortization");
  const evWithoutOther =
    mix &&
    mix.otherShare >= OTHER_INCOME_SHARE &&
    !bankLike &&
    !ebitdaInDoubt.length &&
    inDollars &&
    enterpriseValue !== null &&
    enterpriseValue > 0 &&
    depreciation !== null &&
    mix.operating + depreciation > 0
      ? enterpriseValue / (mix.operating + depreciation)
      : null;
  if (mix && mix.otherShare >= OTHER_INCOME_SHARE)
    dataNotes.push(
      `Over the last four quarters, ${Math.round(mix.otherShare * 100)}% of pretax income came from outside operations (pretax ${mix.pretax}, operating income ${mix.operating}). The trailing P/E and EV/EBITDA lean on it, so check the filings for what it is before calling them cheap.${mix.peWithoutOther === null ? "" : ` Scaling net income down to operating income alone gives a trailing P/E near ${mix.peWithoutOther.toFixed(1)}.`}${evWithoutOther === null ? "" : ` Enterprise value over operating income plus depreciation gives an EV/EBITDA near ${evWithoutOther.toFixed(1)}.`}`,
    );
  if (
    mix &&
    mix.otherShare >= OTHER_INCOME_SHARE &&
    forwardEps !== null &&
    nextEps !== null &&
    nextEps < forwardEps
  )
    dataNotes.push(
      `Analysts expect EPS to fall from ${forwardEps.toFixed(2)} in the fiscal year ending ${String(nearest?.date)} to ${nextEps.toFixed(2)} in the next. With this much income from outside operations, the nearer year can include those gains, so the forward P/E and the next-year EPS decline may reflect them and not the business. The next-year P/E is the multiple on the later year.`,
    );
  if (mix?.taxFavored)
    dataNotes.push(
      `Net income over the last four quarters (${mix.net}) is ${mix.net > mix.pretax ? "above" : "nearly all of"} pretax income (${mix.pretax}), so a tax benefit is in it and the trailing P/E understates the multiple on normally taxed earnings.${mix.pricePretax === null ? "" : ` Market value is ${mix.pricePretax.toFixed(1)} times pretax income.`}`,
    );
  // Basic shares, since dilution alone puts a cap's count below the diluted one. EXPE's cap leaves out
  // its 5.5M Class B shares. A filer in another currency may have an ADR that is not one share.
  const basicShares = num(income[0]?.weightedAverageShsOut);
  if (
    inDollars &&
    price !== null &&
    price > 0 &&
    marketCap !== null &&
    marketCap > 0 &&
    basicShares !== null &&
    marketCap / price < basicShares * SHARE_COUNT_GAP
  )
    dataNotes.push(
      `The vendor's market cap implies ${(marketCap / price / 1e6).toFixed(1)}M shares at this price, but the latest quarter averaged ${(basicShares / 1e6).toFixed(1)}M basic shares. It may leave out a share class, or the count may have fallen since, so check the cover page of the latest filing. If a class is left out, the market cap is too low, so yields on it read high and multiples on it read low.`,
    );
  const quotedAt = quoteClockEt(fmp.quote);
  const accepted = income[0]?.acceptedDate;
  if (quotedAt && typeof accepted === "string" && accepted > quotedAt)
    dataNotes.push(
      `The ${quarterLabel(income[0])} results were filed at ${accepted} ET, after this quote was priced, so the price does not reflect them yet.`,
    );
  const lastReported = fmp.earnings
    .filter(hasReported)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  const statementsEnd = income[0]?.date;
  if (
    lastReported &&
    typeof statementsEnd === "string" &&
    Date.parse(String(lastReported.date)) - Date.parse(statementsEnd) >
      STATEMENT_LAG_DAYS * 86400000
  )
    dataNotes.push(
      `Results were reported on ${String(lastReported.date)}, but the newest vendor statements end ${statementsEnd}. The growth, margin, free cash flow and trailing figures in valuation_and_growth describe that earlier quarter, so take the current quarter from the results in the filings or news.`,
    );
  const epsActual = num(lastReported?.epsActual);
  const epsEstimated = num(lastReported?.epsEstimated);
  return {
    data_notes: dataNotes,
    valuation: {
      pe_ttm_from_quarterly_eps: quarterlyPe,
      pe_ttm: positiveOrNull(vendorPe),
      pe_fiscal_years_counted: pe.length,
      pe_median_last_5_fiscal_years: median(pe),
      pe_low_last_5_fiscal_years: pe.length ? Math.min(...pe) : null,
      pe_high_last_5_fiscal_years: pe.length ? Math.max(...pe) : null,
      forward_pe:
        estimatePrice !== null && forwardEps && forwardEps > 0
          ? estimatePrice / forwardEps
          : null,
      forward_estimate_fiscal_year_end: nearest?.date ?? null,
      forward_estimate_analysts: nearest?.numAnalystsEps ?? null,
      next_year_fiscal_year_end: after?.date ?? null,
      next_year_pe:
        estimatePrice !== null && nextEps && nextEps > 0
          ? estimatePrice / nextEps
          : null,
      estimated_eps_growth_next_year_pct: growthPct(
        after?.epsAvg,
        nearest?.epsAvg,
      ),
      estimated_revenue_growth_next_year_pct: growthPct(
        after?.revenueAvg,
        nearest?.revenueAvg,
      ),
      pe_ttm_without_other_income: mix?.peWithoutOther ?? null,
      ev_to_ebitda_ttm_without_other_income: evWithoutOther,
      ...bookValue,
      ev_to_ebitda_ttm:
        bankLike || ebitdaInDoubt.length
          ? null
          : positiveOrNull(num(fmp.keyMetricsTtm?.evToEBITDATTM)),
      ev_to_ebitda_median_last_5_fiscal_years: bankLike
        ? null
        : median(
            positives(
              fmp.keyMetrics.filter((m) => !ebitdaYearInDoubt(m)),
              "evToEBITDA",
            ),
          ),
      fcf_yield_ttm_pct: bankLike ? null : (computedYield ?? vendorYield),
      fcf_yield_median_last_5_fiscal_years_pct:
        bankLike || fcfYieldMedian === null ? null : fcfYieldMedian * 100,
      // The medians above rest on these, and the annual tables below keep only three years.
      history_by_fiscal_year: fiscalYearHistory(
        fmp,
        bankLike,
        ebitdaYearInDoubt,
      ),
      analyst_target_consensus: target,
      analyst_target_upside_pct: growthPct(target, price),
      position_in_1_year_range_pct:
        price !== null &&
        yearHigh !== null &&
        yearLow !== null &&
        yearHigh > yearLow
          ? ((price - yearLow) / (yearHigh - yearLow)) * 100
          : null,
    },
    growth: {
      reporting_currency: currency,
      latest_quarter: income[0]
        ? `${String(income[0].period)} ${String(income[0].fiscalYear)}`
        : null,
      latest_quarter_end: statementsEnd ?? null,
      bank_like: bankLike,
      revenue_basis: grossRevenue ? "reported" : "vendor_statement",
      net_margin_ttm_on_reported_revenue: netMarginOnReported,
      latest_quarter_reported_revenue: grossRevenue ? latestReported : null,
      latest_quarter_free_cash_flow_usable:
        !bankLike && !cashInDoubt.some((d) => d.row === cashNow[0]),
      revenue_yoy_pct: growthPct(revenueOf(income[0]), revenueOf(yearAgo)),
      operating_income_yoy_pct: growthPct(
        income[0]?.operatingIncome,
        yearAgo?.operatingIncome,
      ),
      net_income_yoy_pct: growthPct(income[0]?.netIncome, yearAgo?.netIncome),
      eps_diluted_yoy_pct: growthPct(
        income[0]?.epsDiluted,
        yearAgo?.epsDiluted,
      ),
      operating_margin_pct: margin(income[0]),
      operating_margin_year_ago_pct: margin(yearAgo),
      free_cash_flow_ttm: bankLike ? null : fcfNow,
      free_cash_flow_prior_ttm: bankLike ? null : fcfBefore,
      // Over the estimate's size, so a beat reads as positive when a loss was expected.
      last_eps_surprise_pct:
        epsActual === null || !epsEstimated
          ? null
          : ((epsActual - epsEstimated) / Math.abs(epsEstimated)) * 100,
      last_revenue_surprise_pct: growthPct(
        lastReported?.revenueActual,
        lastReported?.revenueEstimated,
      ),
    },
  };
}

/** How the holding has done against the S&P 500, in percentage points. */
export function relativeToMarket(fmp: FmpData, spy: Row | null | undefined) {
  const own = priceSummary(
    fmp.history,
    fmp.dividendsCoverageConfirmed === false ? undefined : fmp.dividends,
  );
  if (!own || !spy) return null;
  const gap = (a: number | null, b: unknown) => {
    const other = num(b);
    return a === null || other === null ? null : a - other;
  };
  // An intraday quote against SPY's last close would compare two different days.
  const spyDate = typeof spy.latest_date === "string" ? spy.latest_date : null;
  const sameDay = (date: string | null) =>
    date === null || spyDate === null || date === spyDate;
  const quoteMove = num(fmp.quote?.changePercentage);
  const useQuote =
    quoteMove !== null && sameDay(quoteDate(fmp.quote ?? undefined));
  const latestMove = useQuote
    ? quoteMove
    : sameDay(own.latest_date)
      ? own.return_1d_pct
      : null;
  // Longer windows tolerate a late price by a day or two. Beyond that they are different periods.
  const daysApart = spyDate
    ? Math.abs(Date.parse(own.latest_date) - Date.parse(spyDate)) / 86400000
    : 0;
  const window = (a: number | null, b: unknown, toleranceDays: number) =>
    daysApart <= toleranceDays ? gap(a, b) : null;
  const matchingStart = (a: string | null, b: unknown, toleranceDays: number) =>
    a !== null &&
    typeof b === "string" &&
    Math.abs(Date.parse(a) - Date.parse(b)) / 86400000 <= toleranceDays;
  // A year counts only against a year that started about the same day.
  const sameStart =
    typeof spy.start_date === "string" &&
    Math.abs(Date.parse(own.start_date) - Date.parse(spy.start_date)) /
      86400000 <=
      SAME_START_MAX_DAYS;
  return {
    // A same-day vendor quote already supplies its daily change. History-derived changes need
    // both price anchors; a missing trading bar must not turn a multi-day move into today's move.
    today_points:
      useQuote || matchingStart(own.start_1d_date, spy.start_1d_date, 0)
        ? gap(latestMove, spy.return_1d_pct)
        : null,
    "5_day_points": matchingStart(own.start_5d_date, spy.start_5d_date, 0)
      ? window(own.return_5d_pct, spy.return_5d_pct, 0)
      : null,
    "1_month_points": matchingStart(own.start_1m_date, spy.start_1m_date, 3)
      ? window(own.return_1m_pct, spy.return_1m_pct, 3)
      : null,
    "3_month_points": matchingStart(own.start_3m_date, spy.start_3m_date, 3)
      ? window(own.return_3m_pct, spy.return_3m_pct, 3)
      : null,
    "1_year_points": sameStart
      ? window(own.return_1y_pct, spy.return_1y_pct, 3)
      : null,
    "1_year_total_return_points": sameStart
      ? window(own.total_return_1y_pct, spy.total_return_1y_pct, 3)
      : null,
  };
}

/** Newest cached payload per ticker for one endpoint, for pages that must not hit the network. */
export async function latestCached(endpoint: string) {
  const cached = await db
    .select()
    .from(fmpCache)
    .where(eq(fmpCache.endpoint, endpoint))
    .orderBy(desc(fmpCache.fetchedOn));
  const latest = new Map<string, Row[]>();
  for (const row of cached) {
    if (!latest.has(row.ticker)) {
      const payload = rows(JSON.parse(row.payloadJson));
      if (endpoint === "quote" && !usableQuote(payload[0])) continue;
      latest.set(
        row.ticker,
        payload.map((p) =>
          endpoint === "quote"
            ? { ...p, quote_date: quoteDate(p, row.fetchedOn) }
            : p,
        ),
      );
    }
  }
  return latest;
}

export async function latestCachedQuotes() {
  const quotes = new Map<string, Row>();
  for (const [ticker, payload] of await latestCached("quote")) {
    if (payload[0]) quotes.set(ticker, payload[0]);
  }
  return quotes;
}

/** The next unreported earnings date in an FMP earnings list, if any. */
export function nextEarnings(earnings: Row[], from = today()) {
  return (
    earnings
      .filter((e) => !hasReported(e) && String(e.date) >= from)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0] ?? null
  );
}

/** Quote timestamps and cache dates use the same local calendar as today(). */
export function quoteDate(
  quote: Row | undefined,
  fallback: string | null = null,
) {
  const timestamp = num(quote?.timestamp);
  if (timestamp !== null && timestamp > 0) {
    const d = new Date(timestamp * 1000);
    if (Number.isFinite(d.getTime())) return d.toLocaleDateString("en-CA");
  }
  const cached = quote?.quote_date ?? fallback;
  return typeof cached === "string" && /^\d{4}-\d{2}-\d{2}$/.test(cached)
    ? cached
    : null;
}

/** A quote's time in the form statements give theirs: 2026-11-04 16:00:00, market time. */
function quoteClockEt(quote: Row | undefined | null) {
  const timestamp = num(quote?.timestamp);
  if (timestamp === null || timestamp <= 0) return null;
  return new Date(timestamp * 1000)
    .toLocaleString("sv-SE", { timeZone: "America/New_York" })
    .slice(0, 19);
}

/** When a quote was priced, in market time. Null when the vendor gave no timestamp. */
export function quoteTimeEt(quote: Row | undefined | null) {
  const timestamp = num(quote?.timestamp);
  if (timestamp === null || timestamp <= 0) return null;
  const time = new Date(timestamp * 1000).toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `${time} ET`;
}
