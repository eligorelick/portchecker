import Papa from "papaparse";

type ParsedHolding = {
  ticker: string;
  name: string;
  quantity: number;
  costBasis: number | null;
  accountLabel: string;
  marketValue: number | null;
};

type ParsedCsv = {
  rows: ParsedHolding[];
  skipped: { row: string; reason: string }[];
  notes: string[];
  error: string | null;
};

function clean(cell: string | undefined) {
  return (cell ?? "").replace(/[$%,"]/g, "").trim();
}

function toNumber(cell: string | undefined): number | null {
  // Quantity, value and cost are never percents, so a percent means the row is out of line.
  if (cell?.includes("%")) return null;
  const c = (cell ?? "").replace(/[$"]/g, "").trim();
  // Parentheses and a minus both mean negative. Commas may only group thousands, so a decimal
  // comma or a hex literal is unknown and never a different number.
  const sign = /^[(+-]*/.exec(c)![0];
  const digits = c.slice(sign.length).replace(/\)$/, "");
  if (
    !/\d/.test(digits) ||
    !/^(\d{1,3}(,\d{3})+|\d*)(\.\d*)?(e[-+]?\d+)?$/i.test(digits)
  )
    return null;
  const n = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return /[(-]/.test(sign) ? -n : n;
}

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

type Columns = {
  symbol: number;
  description: number;
  quantity: number;
  price: number;
  marketValue: number;
  costBasis: number;
  securityType: number;
  width: number;
};

/** How many cells a row uses. Exports may or may not end their lines with a comma. */
function usedWidth(row: string[]) {
  let width = row.length;
  while (width > 0 && (row[width - 1] ?? "").trim() === "") width--;
  return width;
}

// Money market funds hold $1 per share and have no thesis to review, so they count as cash.
// Their tickers are five letters ending in XX, such as SWVXX.
export const isMoneyMarketTicker = (symbol: string) =>
  /^[A-Z]{3}XX$/.test(symbol.trim().toUpperCase());

function isCashLike(symbol: string, securityType: string) {
  return (
    /\bcash\b/i.test(symbol) ||
    /money market/i.test(securityType) ||
    isMoneyMarketTicker(symbol)
  );
}

function findColumns(row: string[]): Columns | null {
  const headers = row.map((h) => clean(h).toLowerCase());
  const find = (test: (h: string) => boolean) => headers.findIndex(test);
  const symbol = find((h) => h === "symbol" || h.startsWith("symbol "));
  const quantity = find((h) => /\b(qty|quantity)\b/.test(h));
  const marketValue = find((h) => /market value|mkt val/.test(h));
  if (symbol < 0 || (quantity < 0 && marketValue < 0)) return null;
  return {
    symbol,
    quantity,
    price: find((h) => h === "price" || h === "last price"),
    marketValue,
    description: find((h) => h.startsWith("description") || h === "name"),
    // A per-share figure stored as the position's total would invent a gain.
    costBasis: find(
      (h) =>
        h.includes("cost basis") &&
        !/avg|average|share|\bunit\b|\bper\b/.test(h),
    ),
    securityType: find((h) => h.includes("security type")),
    width: usedWidth(row),
  };
}

/** The shape every stored ticker has. Tickers name folders on disk, so nothing else gets in. */
export const TICKER_PATTERN = /^[A-Z][A-Z0-9-]{0,9}$/;

export const normalizeTicker = (ticker: string) =>
  ticker.trim().toUpperCase().replace(/[/.]/g, "-");

/**
 * Parses a Schwab Positions export. Handles single-account and all-accounts files: a row with
 * one filled cell can be an account title, and each account repeats its own header row.
 */
export function parsePositionsCsv(csv: string): ParsedCsv {
  const parsed = Papa.parse<string[]>(csv.replace(/^﻿/, ""), {
    skipEmptyLines: true,
  });
  const badQuotes = parsed.errors.some((e) => e.type === "Quotes");
  // A quote that never closes, or closes on a later line, runs rows together. Importing replaces
  // everything, so the rows it swallowed would read as sold and their numbers land on another row.
  if (
    parsed.errors.some((e) => e.code === "MissingQuotes") ||
    (badQuotes && parsed.data.some((row) => row.some((c) => /[\r\n]/.test(c))))
  ) {
    return {
      rows: [],
      skipped: [],
      notes: [],
      error:
        "A quote mark in this file is out of place, so rows ran together and could not be read. Nothing was changed. Export the file again, or fix the quote marks and retry.",
    };
  }
  const merged = new Map<string, ParsedHolding>();
  const skipped: ParsedCsv["skipped"] = [];
  const notes: string[] = [];
  let columns: Columns | null = null;
  let account = "";
  let accountValue = 0; // Market value of the rows read since the last header or Account Total.

  for (const [rowIndex, row] of parsed.data.entries()) {
    const filled = row.filter((c) => c.trim() !== "");
    const headerColumns = findColumns(row);
    if (headerColumns) {
      columns = headerColumns;
      accountValue = 0;
      continue;
    }
    if (filled.length === 1) {
      const title = (filled[0] ?? "").trim();
      const positionsFor =
        /^positions for\s+(?:account\s+)?(.+?)\s+as of\b/i.exec(title);
      if (positionsFor) {
        const label = positionsFor[1] ?? "";
        account = /^all[- ]accounts$/i.test(label) ? "" : label;
        continue;
      }
      if (/^(date|downloaded|generated)/i.test(title)) continue;
      // Ordinary account headings introduce a header. Otherwise this can be an incomplete
      // position (including cash), which must reach the normal validation below.
      const next = parsed.data
        .slice(rowIndex + 1)
        .find((r) => r.some((c) => c.trim() !== ""));
      if (!columns || findColumns(next ?? [])) {
        account = title;
        continue;
      }
    }
    if (!columns) continue;

    const symbol = (row[columns.symbol] ?? "").trim();
    if (!symbol) continue;
    if (/\btotal\b/i.test(symbol)) {
      // Only Account Total covers cash too. Positions Total, if a file has one, is left alone.
      if (/^account total$/i.test(symbol)) {
        const stated = toNumber(row[columns.marketValue]);
        if (stated !== null && Math.abs(stated - accountValue) > 1) {
          notes.push(
            `${account || "This file"}: rows add up to ${usd(accountValue)}, but its Account Total says ${usd(stated)}, a difference of ${usd(Math.abs(stated - accountValue))}.${skipped.length ? " Rows left out below can explain it." : ""}`,
          );
        }
        accountValue = 0;
      }
      continue;
    }

    // An unquoted comma pushes later cells right, past the header. A stray quote can swallow a
    // comma, which pulls them left. Either way the numbers sit under the wrong columns.
    const width = usedWidth(row);
    const strayQuote = badQuotes && row.some((c) => c.includes('"'));
    if (width > columns.width || (strayQuote && width < columns.width)) {
      skipped.push({
        row: symbol,
        reason: "its cells do not line up with the header",
      });
      continue;
    }
    const securityType = (row[columns.securityType] ?? "").trim();
    if (/^(fixed income|bonds?)$/i.test(securityType)) {
      skipped.push({ row: symbol, reason: "a bond, not a stock" });
      continue;
    }
    if (/^cash$/i.test(symbol) && /^equity$/i.test(securityType)) {
      skipped.push({
        row: symbol,
        reason: "a stock with the ticker CASH, which this app keeps for cash",
      });
      continue;
    }

    const marketValue = toNumber(row[columns.marketValue]);
    const name = (row[columns.description] ?? "").trim();
    let holding: ParsedHolding;

    if (isCashLike(symbol, securityType)) {
      const dollars = marketValue ?? toNumber(row[columns.quantity]);
      if (dollars === null) {
        skipped.push({ row: symbol, reason: "cash row has no amount" });
        continue;
      }
      if (!/\bcash\b/i.test(symbol)) {
        const note = `${symbol} is a money market fund, so it counts as cash.`;
        if (!notes.includes(note)) notes.push(note);
      }
      holding = {
        ticker: "CASH",
        name: "Cash",
        quantity: dollars,
        costBasis: null,
        accountLabel: account,
        marketValue: dollars,
      };
    } else {
      const ticker = normalizeTicker(symbol);
      if (!TICKER_PATTERN.test(ticker)) {
        skipped.push({ row: symbol, reason: "not a stock ticker" });
        continue;
      }
      const quantity = toNumber(row[columns.quantity]);
      if (quantity === null) {
        skipped.push({ row: symbol, reason: "no quantity" });
        continue;
      }
      if (quantity === 0) {
        skipped.push({ row: symbol, reason: "zero shares" });
        continue;
      }
      // A row can be out of line with no cell to spare, and this also tests the column matching
      // on a real export. It only warns, since a bond's price or a broker's rounding can differ.
      const price = toNumber(row[columns.price]);
      if (
        price !== null &&
        marketValue !== null &&
        Math.abs(quantity * price - marketValue) >
          Math.max(1, Math.abs(marketValue) * 0.01)
      ) {
        notes.push(
          `${symbol}: quantity ${quantity} at ${usd(price)} comes to ${usd(quantity * price)}, but the file gives its market value as ${usd(marketValue)}. Check this row.`,
        );
      }
      holding = {
        ticker,
        name: name === "--" ? "" : name,
        quantity,
        costBasis: toNumber(row[columns.costBasis]),
        accountLabel: account,
        marketValue,
      };
    }

    accountValue += holding.marketValue ?? 0;
    const key = `${holding.ticker}|${holding.accountLabel}`;
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += holding.quantity;
      existing.marketValue =
        existing.marketValue === null || holding.marketValue === null
          ? null
          : existing.marketValue + holding.marketValue;
      existing.costBasis =
        existing.costBasis === null || holding.costBasis === null
          ? null
          : existing.costBasis + holding.costBasis;
    } else {
      merged.set(key, holding);
    }
  }

  const rows = [...merged.values()].filter((holding) => {
    if (holding.ticker === "CASH" || holding.quantity !== 0) return true;
    skipped.push({ row: holding.ticker, reason: "zero shares" });
    return false;
  });
  return {
    rows,
    skipped,
    notes,
    error:
      rows.length > 0
        ? null
        : skipped[0]
          ? `No positions could be read, because every row was left out. The first was ${skipped[0].row}: ${skipped[0].reason}.`
          : "No positions found. Expected a header row with Symbol and Quantity or Market Value.",
  };
}

type ScreenPosition = {
  symbol: string;
  description: string | null;
  quantity: number | null;
  price: number | null;
  cost_basis: number | null;
  gain_value: number | null;
};

/**
 * Turns positions read from screenshots into a Schwab-shaped CSV. A quantity cut off on screen
 * comes from (cost basis + gain) / price. Reports how the total compares with the screen.
 */
export function screenshotPositionsToCsv(screen: {
  positions: ScreenPosition[];
  cash_value: number | null;
  account_value: number | null;
  account_name: string | null;
}) {
  const notes: string[] = [];
  const quote = (v: string | number | null) =>
    `"${String(v ?? "--").replace(/"/g, '""')}"`;
  const bySymbol = new Map<string, ScreenPosition>();
  for (const p of screen.positions) {
    const key = p.symbol.trim().toUpperCase();
    const seen = bySymbol.get(key);
    if (!seen) {
      bySymbol.set(key, { ...p, symbol: key });
      continue;
    }
    seen.description ??= p.description;
    seen.quantity ??= p.quantity;
    seen.price ??= p.price;
    seen.cost_basis ??= p.cost_basis;
    seen.gain_value ??= p.gain_value;
  }

  let total = screen.cash_value ?? 0;
  const lines = [...bySymbol.values()].map((p) => {
    let quantity = p.quantity;
    if (
      quantity === null &&
      p.price &&
      p.cost_basis !== null &&
      p.gain_value !== null
    ) {
      quantity = Number(((p.cost_basis + p.gain_value) / p.price).toFixed(4));
      notes.push(
        `${p.symbol}: quantity ${quantity} was worked out from cost basis, gain and price. Check it.`,
      );
    }
    const value =
      quantity !== null && p.price !== null ? quantity * p.price : null;
    total += value ?? 0;
    return [p.symbol, p.description, quantity, p.price, value, p.cost_basis]
      .map(quote)
      .join(",");
  });

  if (screen.account_value !== null) {
    const gap = Math.abs(total - screen.account_value);
    notes.push(
      `Positions and cash add up to $${total.toFixed(2)}. The screen shows $${screen.account_value.toFixed(2)}, a difference of $${gap.toFixed(2)}.`,
    );
  }
  const title = screen.account_name
    ? [
        `"Positions for account ${screen.account_name.replace(/"/g, "")} as of screenshot"`,
      ]
    : [];
  const csv = [
    ...title,
    '"Symbol","Description","Quantity","Price","Market Value","Cost Basis"',
    ...lines,
    ...(screen.cash_value !== null
      ? [
          `"Cash & Cash Investments","--","--","--",${quote(screen.cash_value)},"--"`,
        ]
      : []),
  ].join("\n");
  return { csv, notes };
}
