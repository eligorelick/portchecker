import { db } from "./db/index.ts";
import { holdings, tickers } from "./db/schema.ts";
import {
  latestCached,
  latestCachedQuotes,
  nextEarnings,
  num,
  quoteDate,
  today,
  type Row,
} from "./fmp.ts";

type HoldingInput = {
  ticker: string;
  name: string;
  quantity: number;
  costBasis: number | null;
};

// Funds and company profiles name sectors differently. These map fund labels onto the profile names.
const SECTOR_NAMES: Record<string, string> = {
  "basic materials": "Basic Materials",
  materials: "Basic Materials",
  communication: "Communication Services",
  "communication services": "Communication Services",
  "consumer cyclical": "Consumer Cyclical",
  "consumer discretionary": "Consumer Cyclical",
  "consumer defensive": "Consumer Defensive",
  "consumer staples": "Consumer Defensive",
  energy: "Energy",
  financials: "Financial Services",
  "financial services": "Financial Services",
  "health care": "Healthcare",
  healthcare: "Healthcare",
  industrials: "Industrials",
  "information technology": "Technology",
  technology: "Technology",
  "real estate": "Real Estate",
  utilities: "Utilities",
};

const round = (n: number, digits = 2) => Number(n.toFixed(digits));

/**
 * All portfolio math lives here. Accounts holding the same ticker are combined. Positions with
 * no quote are listed in missing_prices and left out of the totals, since they have no value.
 */
export function computePortfolioFacts(
  rows: HoldingInput[],
  quotes: Map<string, Row>,
  sectors: Map<string, string | null>,
  asOf = today(),
  // A fund's own sector label is "Financial Services" whatever it holds, so sector weights look
  // through to what each fund owns. A fund with no breakdown stays one "Funds, no breakdown" line.
  fundSectors = new Map<string, Row[]>(),
  earnings = new Map<string, Row[]>(),
) {
  // Brokers store a short's basis with either sign. Each lot is signed before lots are added, a
  // long's cost positive and a short's proceeds negative, so a gain is always value less basis.
  const signedBasis = (row: HoldingInput) =>
    row.costBasis === null || row.quantity >= 0
      ? row.costBasis
      : -Math.abs(row.costBasis);
  const add = (a: number | null, b: number | null) =>
    a === null || b === null ? null : a + b;
  const combined = new Map<
    string,
    HoldingInput & { signedBasis: number | null }
  >();
  for (const row of rows) {
    const existing = combined.get(row.ticker);
    if (existing) {
      existing.quantity += row.quantity;
      existing.costBasis = add(existing.costBasis, row.costBasis);
      existing.signedBasis = add(existing.signedBasis, signedBasis(row));
    } else {
      combined.set(row.ticker, { ...row, signedBasis: signedBasis(row) });
    }
  }

  const positions = [...combined.values()].map((h) => {
    const isCash = h.ticker === "CASH";
    const quote = isCash
      ? { price: 1, change: 0, changePercentage: 0 }
      : quotes.get(h.ticker);
    const rawPrice = num(quote?.price);
    const price = rawPrice !== null && rawPrice > 0 ? rawPrice : null;
    const change = price === null ? null : num(quote?.change);
    const changePct = price === null ? null : num(quote?.changePercentage);
    const value = price === null ? null : h.quantity * price;
    const gain =
      !isCash && value !== null && h.signedBasis !== null
        ? value - h.signedBasis
        : null;
    return {
      ticker: h.ticker,
      name: h.name,
      quantity: h.quantity,
      quote_date: isCash ? null : quoteDate(quote),
      price,
      value: value === null ? null : round(value),
      day_change_pct: changePct === null ? null : round(changePct),
      day_change_value: change === null ? null : round(change * h.quantity),
      cost_basis: h.costBasis,
      unrealized_gain: gain === null ? null : round(gain),
      // A percent needs a base on the position's own side: a cost under a long, proceeds under a short.
      unrealized_gain_pct:
        gain === null ||
        !h.signedBasis ||
        Math.sign(h.signedBasis) !== Math.sign(h.quantity)
          ? null
          : round((gain / Math.abs(h.signedBasis)) * 100),
      sector: isCash ? "Cash" : (sectors.get(h.ticker) ?? "Unknown"),
    };
  });

  const total = positions.reduce((sum, p) => sum + (p.value ?? 0), 0);
  const weight = (value: number) =>
    total > 0 ? round((value / total) * 100) : 0;
  const withWeights = positions
    .map((p) => ({
      ...p,
      weight_pct: p.value === null ? null : weight(p.value),
    }))
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1));

  const invested = withWeights.filter((p) => p.ticker !== "CASH");
  // A short sorts last, so it must not be netted in merely because fewer than five longs fill the list.
  const top5 = invested
    .slice(0, 5)
    .reduce((sum, p) => sum + Math.max(p.value ?? 0, 0), 0);

  const bySector = new Map<string, number>();
  const addToSector = (sector: string, value: number) =>
    bySector.set(sector, (bySector.get(sector) ?? 0) + value);
  const NO_BREAKDOWN = "Funds, no breakdown";
  const noBreakdownFunds = new Map<string, number>();
  for (const p of withWeights) {
    const value = p.value ?? 0;
    const breakdown = fundSectors.get(p.ticker);
    if (!breakdown) {
      addToSector(p.sector, value);
      continue;
    }
    const slices = breakdown
      .map((slice) => ({
        label: String(slice.sector),
        key: String(slice.sector).trim().toLowerCase(),
        share: (parseFloat(String(slice.weightPercentage)) || 0) / 100,
      }))
      // "Cash & Others" is not my cash: a bitcoin trust reports all of its holdings this way.
      .filter((s) => !s.key.startsWith("cash"));
    const listed = slices.reduce((sum, s) => sum + s.share, 0);
    // A list over 100% or with a negative slice cannot be a split of the fund, so none of it is used.
    const usable = listed <= 1.005 && slices.every((s) => s.share >= 0);
    if (usable) {
      for (const s of slices) {
        addToSector(SECTOR_NAMES[s.key] ?? s.label, value * s.share);
      }
    }
    // Whatever the fund's list leaves out still has to land somewhere.
    if (!usable || listed < 0.995) {
      const unlisted = usable ? value * (1 - listed) : value;
      addToSector(NO_BREAKDOWN, unlisted);
      noBreakdownFunds.set(p.ticker, unlisted);
    }
  }

  const cash = positions.find((p) => p.ticker === "CASH")?.value ?? 0;
  const gains = invested.filter((p) => p.unrealized_gain !== null);

  const dates = invested
    .flatMap((p) => (p.quote_date ? [p.quote_date] : []))
    .sort();
  const newest = dates.at(-1) ?? null;

  // The day's total holds only moves from the date its label names. The rest are named, not summed.
  const inDayTotal = (p: (typeof invested)[number]) =>
    p.day_change_value !== null && p.quote_date === newest;
  const dayChange = invested
    .filter(inDayTotal)
    .reduce((sum, p) => sum + (p.day_change_value ?? 0), 0);
  const previousTotal = total - dayChange;
  const dayLeftOut = invested
    .filter((p) => p.price !== null && !inDayTotal(p))
    .map((p) => p.ticker);
  // With no move known, a total of 0 would read as a flat day.
  const noDayTotal = invested.length > 0 && !invested.some(inDayTotal);
  return {
    quote_dates: {
      newest,
      oldest: dates[0] ?? null,
      stale: invested
        .filter(
          (p) =>
            p.quote_date !== null &&
            ((newest !== null && p.quote_date < newest) ||
              Date.parse(asOf) - Date.parse(p.quote_date) > 4 * 86400000),
        )
        .map((p) => p.ticker),
    },
    as_of: asOf,
    total_value: round(total),
    cash_value: round(cash),
    cash_pct: weight(cash),
    top5_concentration_pct: weight(top5),
    day_change_value: noDayTotal ? null : round(dayChange),
    day_change_pct: noDayTotal
      ? null
      : previousTotal > 0
        ? round((dayChange / previousTotal) * 100)
        : 0,
    day_change_left_out: dayLeftOut,
    unrealized_gain_where_known: round(
      gains.reduce((sum, p) => sum + (p.unrealized_gain ?? 0), 0),
    ),
    positions_with_cost_basis: gains.length,
    sector_weights: [...bySector.entries()]
      .map(([sector, value]) => ({ sector, weight_pct: weight(value) }))
      .sort((a, b) => b.weight_pct - a.weight_pct),
    funds_no_breakdown: [...noBreakdownFunds.entries()]
      .map(([ticker, value]) => ({ ticker, weight_pct: weight(value) }))
      .filter((f) => f.weight_pct >= 0.1)
      .sort((a, b) => b.weight_pct - a.weight_pct),
    positions: withWeights,
    upcoming_earnings: [...earnings.entries()]
      .filter(([ticker]) => combined.has(ticker))
      .flatMap(([ticker, list]) => {
        const next = nextEarnings(list, asOf);
        return next
          ? [
              {
                ticker,
                date: String(next.date),
                eps_estimated: next.epsEstimated ?? null,
                revenue_estimated: next.revenueEstimated ?? null,
              },
            ]
          : [];
      })
      .sort((a, b) => a.date.localeCompare(b.date)),
    missing_prices: invested
      .filter((p) => p.price === null)
      .map((p) => p.ticker),
  };
}

export type PortfolioFacts = ReturnType<typeof computePortfolioFacts>;

/** What a pack tells the models about one position. */
export function packPosition(facts: PortfolioFacts, ticker: string) {
  const position = facts.positions.find((p) => p.ticker === ticker);
  return (
    position && {
      quantity: position.quantity,
      value: position.value,
      weight_pct: position.weight_pct,
      cost_basis: position.cost_basis,
      unrealized_gain: position.unrealized_gain,
      unrealized_gain_pct: position.unrealized_gain_pct,
      portfolio_total_value: facts.total_value,
      portfolio_cash_pct: facts.cash_pct,
      portfolio_top5_concentration_pct: facts.top5_concentration_pct,
      portfolio_sector_weights: facts.sector_weights,
    }
  );
}

/** Facts from the database and the latest cached quotes. Makes no network calls. */
export async function loadPortfolioFacts() {
  const [rows, tickerRows, quotes, fundSectors, earnings] = await Promise.all([
    db.select().from(holdings),
    db.select().from(tickers),
    latestCachedQuotes(),
    latestCached("etf/sector-weightings"),
    latestCached("earnings"),
  ]);
  const holdingsDates = rows.map((row) => row.updatedAt).sort();
  return {
    ...computePortfolioFacts(
      rows,
      quotes,
      new Map(tickerRows.map((t) => [t.ticker, t.sector])),
      today(),
      fundSectors,
      earnings,
    ),
    holdings_updated_at: holdingsDates[0] ?? null,
    holdings_latest_updated_at: holdingsDates.at(-1) ?? null,
  };
}
