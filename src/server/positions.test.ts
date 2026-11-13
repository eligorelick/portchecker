import "./test-env.ts";

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import nodeModule from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  normalizeTicker,
  parsePositionsCsv,
  screenshotPositionsToCsv,
} from "./csv.ts";
import {
  dossierSection,
  replaceCurrentView,
  replaceSection,
} from "./dossier.ts";
import {
  computePortfolioFacts,
  loadPortfolioFacts,
  packPosition,
} from "./portfolio.ts";
import {
  addedMessage,
  holdingChanges,
  holdingFormState,
  MAX_SCREENSHOTS,
  parseOptionalNumber,
  previewChanges,
  previewLoader,
  previewSummary,
  rowCount,
  rowTextAfterChange,
  screenshotExtension,
  screenshotFallbackNotes,
  screenshotPickProblem,
} from "./queue.ts";
import { dossierTemplate } from "./research/prompts.ts";
import { reviewBasisNotice } from "./updates.ts";

void test("offsetting duplicate stock rows are left out as zero shares while cash and shorts remain", () => {
  const parsed = parsePositionsCsv(
    "Symbol,Quantity\nAAA,10\nAAA,-10\nBBB,-2\nCASH,0",
  );
  assert.equal(parsed.error, null);
  assert.deepEqual(
    parsed.rows.map((r) => [r.ticker, r.quantity]),
    [
      ["BBB", -2],
      ["CASH", 0],
    ],
  );
  assert.deepEqual(parsed.skipped, [{ row: "AAA", reason: "zero shares" }]);
});

void test("ticker normalization is shared by imports, forms and scripts", () => {
  for (const [typed, stored] of [
    [" brk.b ", "BRK-B"],
    ["brk/b", "BRK-B"],
    [" msft ", "MSFT"],
  ] as const) {
    assert.equal(normalizeTicker(typed), stored);
  }
});

void test("a symbol with no other cells is left out without renaming the account", () => {
  const parsed = parsePositionsCsv(
    [
      "Positions for account Brokerage as of today",
      "Symbol,Description,Quantity",
      "AAA,First,1",
      "BBB,,",
      "CCC,Third,3",
    ].join("\n"),
  );
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.skipped, [{ row: "BBB", reason: "no quantity" }]);
  assert.deepEqual(
    parsed.rows.map((row) => [row.ticker, row.accountLabel]),
    [
      ["AAA", "Brokerage"],
      ["CCC", "Brokerage"],
    ],
  );
});

void test("a cash row with no amounts is reported without renaming following positions", () => {
  const parsed = parsePositionsCsv(
    [
      "Positions for account Brokerage as of today",
      "Symbol,Description,Quantity,Price,Market Value,Cost Basis",
      "AAPL,Apple,10,100,1000,500",
      "Cash & Cash Investments,,,,,",
      "MSFT,Microsoft,5,100,500,200",
    ].join("\n"),
  );
  assert.deepEqual(parsed.skipped, [
    { row: "Cash & Cash Investments", reason: "cash row has no amount" },
  ]);
  assert.deepEqual(
    parsed.rows.map((row) => [row.ticker, row.accountLabel, row.costBasis]),
    [
      ["AAPL", "Brokerage", 500],
      ["MSFT", "Brokerage", 200],
    ],
  );
  const heading = parsePositionsCsv(
    "Symbol,Quantity\nAAA,1\nMy IRA\nSymbol,Quantity\nBBB,2",
  );
  assert.deepEqual(heading.skipped, []);
  assert.equal(heading.rows[1]?.accountLabel, "My IRA");
});

void test("an account title shaped like a ticker still labels its repeated header", () => {
  const parsed = parsePositionsCsv(
    [
      "Symbol,Description,Quantity",
      "AAA,First,1",
      "IRA,,",
      ",,",
      "Symbol,Description,Quantity",
      "BBB,Second,2",
    ].join("\n"),
  );
  assert.deepEqual(parsed.skipped, []);
  assert.equal(parsed.rows[1]?.accountLabel, "IRA");
});

void test("single-cell export metadata after the header stays out of the skipped positions", () => {
  const parsed = parsePositionsCsv(
    "Symbol,Quantity\nAAA,1\nDate\nDownloaded\nGenerated\nBBB,2",
  );
  assert.deepEqual(parsed.skipped, []);
  assert.deepEqual(
    parsed.rows.map((row) => row.accountLabel),
    ["", ""],
  );
});

void test("one money market fund in two accounts gets one explanation", () => {
  const parsed = parsePositionsCsv(
    [
      "Brokerage",
      "Symbol,Quantity",
      "SWVXX,100",
      "IRA",
      "Symbol,Quantity",
      "SWVXX,200",
    ].join("\n"),
  );
  assert.deepEqual(
    parsed.rows.map((row) => [row.ticker, row.quantity]),
    [
      ["CASH", 100],
      ["CASH", 200],
    ],
  );
  assert.deepEqual(parsed.notes, [
    "SWVXX is a money market fund, so it counts as cash.",
  ]);
});

void test("a well-quoted short row with shifted amounts warns in the preview", () => {
  const parsed = parsePositionsCsv(
    [
      "Symbol,Description,Quantity,Price,Market Value,Cost Basis,Security Type",
      '"BBB","Foo Inc,20","$5","$100","$80","Equity"',
      "CCC,Third,3,1,3,2,Equity",
    ].join("\n"),
  );
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.notes, [
    "BBB: quantity 5 at $100.00 comes to $500.00, but the file gives its market value as $80.00. Check this row.",
  ]);
  assert.equal(parsed.rows[1]?.quantity, 3);
});

void test("zero-share stocks are left out while zero cash and shorts still import", () => {
  const parsed = parsePositionsCsv(
    "Symbol,Quantity\nAAA,0\nBBB,-0\nCASH,0\nSHRT,-2",
  );
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.skipped, [
    { row: "AAA", reason: "zero shares" },
    { row: "BBB", reason: "zero shares" },
  ]);
  assert.deepEqual(
    parsed.rows.map((row) => [row.ticker, row.quantity]),
    [
      ["CASH", 0],
      ["SHRT", -2],
    ],
  );
});

const holding = (
  ticker: string,
  quantity = 1,
  costBasis: number | null = null,
) => ({ ticker, name: ticker, quantity, costBasis });

void test("csv: every way a broker writes a total cost keeps its sign or stays unknown", () => {
  for (const [cell, expected] of [
    ["$1,000.50", 1000.5],
    ["-$850", -850],
    ["($850.25)", -850.25],
    ["(10)", -10],
    ["0", 0],
    ["--", null],
    ["N/A", null],
    ["n/a", null],
    ["NA", null],
    ["", null],
    ["pending", null],
  ] as const) {
    const parsed = parsePositionsCsv(
      `Symbol,Quantity,Cost Basis\nAAA,1,"${cell}"`,
    );
    assert.equal(parsed.error, null, cell);
    assert.equal(parsed.rows[0]?.costBasis, expected, cell);
  }
  const short = parsePositionsCsv(
    'Symbol,Quantity,Market Value,Cost Basis\nAAA,(5),"($1,000.50)",($850.25)',
  );
  assert.deepEqual(
    short.rows.map((r) => [r.quantity, r.marketValue, r.costBasis]),
    [[-5, -1000.5, -850.25]],
  );
});

void test("csv: a number in a form no US broker writes is unknown, never a different number", () => {
  const cost = (cell: string) =>
    parsePositionsCsv(`Symbol,Quantity,Cost Basis\nAAA,1,"${cell}"`).rows[0]
      ?.costBasis;
  for (const [cell, expected] of [
    // A minus inside parentheses is still a negative, not a double negative.
    ["(-5)", -5],
    ["-(5)", -5],
    // Commas only group thousands. A decimal comma must not become 125 or 1.23456.
    ["12,5", null],
    ["1.234,56", null],
    ["1,2345", null],
    ["1,234,567.89", 1234567.89],
    ["$-1,234.56", -1234.56],
    // Only plain decimals and scientific notation are numbers.
    ["0x10", null],
    ["0b11", null],
    ["1e3", 1000],
    ["1.5E-2", 0.015],
    ["1e999", null],
    ["+5", 5],
    [".5", 0.5],
    ["5.", 5],
    ["5-", null],
    ["e5", null],
    ["()", null],
  ] as const) {
    assert.equal(cost(cell), expected, cell);
  }
  // A quantity it cannot read is not a position, so the row is left out and listed.
  const european = parsePositionsCsv('Symbol,Quantity\nAAA,"12,5"\nBBB,2');
  assert.deepEqual(
    european.rows.map((r) => [r.ticker, r.quantity]),
    [["BBB", 2]],
  );
  assert.equal(european.skipped[0]?.row, "AAA");
});

void test("csv: a number takes one sign, matched brackets and a dollar sign only in front", () => {
  const cost = (cell: string) =>
    parsePositionsCsv(`Symbol,Quantity,Cost Basis\nAAA,1,"${cell}"`).rows[0]
      ?.costBasis;
  for (const [cell, expected] of [
    // Two signs do not say which one is meant.
    ["--5", null],
    ["+-5", null],
    ["-+5", null],
    ["++5", null],
    ["(--5)", null],
    ["-(-5)", null],
    ["+(5)", null],
    // A bracket with no partner is a damaged cell, not a negative and not a positive.
    ["(5", null],
    ["(1,234.56", null],
    ["5)", null],
    // A dollar sign belongs before the digits.
    ["1$2", null],
    ["5$", null],
    ["$($5)", null],
    // 0,500 is not a thousands group, and could be a decimal comma.
    ["0,500", null],
    ["0,125", null],
    // The forms a US export does use still read, with or without spaces.
    ["( 5 )", -5],
    ["$(5)", -5],
    ["$ 1,234.56", 1234.56],
    ["-$1,234.56", -1234.56],
    ["($1,234.56)", -1234.56],
    ["(-$5)", -5],
    ["+$5", 5],
    ["0.50", 0.5],
    ["0", 0],
    ["1234.5600", 1234.56],
    ["100,000", 100000],
  ] as const) {
    assert.equal(cost(cell), expected, cell);
  }
});

void test("csv: abbreviated and decorated headers still find the right amounts", () => {
  const parsed = parsePositionsCsv(
    '" SYMBOL (Ticker) ",Name,Qty,Last Price,Mkt Val,Cost Basis Total\nAAA,Acme,2,10,20,15',
  );
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.rows, [
    {
      ticker: "AAA",
      name: "Acme",
      quantity: 2,
      marketValue: 20,
      costBasis: 15,
      accountLabel: "",
    },
  ]);
  assert.deepEqual(parsed.notes, []);
  assert.equal(
    parsePositionsCsv("Symbol,Market Value\nCash & Cash Investments,250")
      .rows[0]?.quantity,
    250,
  );
});

void test("csv: all-accounts metadata does not become an account label", () => {
  const parsed = parsePositionsCsv(
    '"Positions for All-Accounts as of 10:45 AM ET, 2026/11/04"\nSymbol,Quantity\nAAA,1\nDownloaded 2026/11/04\nBBB,2',
  );
  assert.deepEqual(
    parsed.rows.map((r) => [r.ticker, r.accountLabel]),
    [
      ["AAA", ""],
      ["BBB", ""],
    ],
  );
});

void test("csv: cash prefers market value, falls back to quantity and needs an amount", () => {
  const header = "Symbol,Quantity,Market Value";
  assert.equal(
    parsePositionsCsv(`${header}\nCash,7,250`).rows[0]?.quantity,
    250,
  );
  assert.equal(parsePositionsCsv(`${header}\nCash,7,--`).rows[0]?.quantity, 7);
  const missing = parsePositionsCsv(`${header}\nCash,--,--\nAAA,1,10`);
  assert.deepEqual(missing.skipped, [
    { row: "Cash", reason: "cash row has no amount" },
  ]);
  const fund = parsePositionsCsv(
    "Symbol,Description,Quantity,Market Value,Security Type\nMMDA1,--,99,500,Money Market Fund",
  );
  assert.deepEqual(
    fund.rows.map((r) => [r.ticker, r.quantity, r.costBasis]),
    [["CASH", 500, null]],
  );
  assert.deepEqual(fund.notes, [
    "MMDA1 is a money market fund, so it counts as cash.",
  ]);
  assert.equal(
    parsePositionsCsv("Symbol,Description,Quantity\nAAA,--,1").rows[0]?.name,
    "",
  );
});

void test("csv: duplicate rows sum known values and never fill an unknown value or basis", () => {
  const header = "Symbol,Quantity,Market Value,Cost Basis";
  const known = parsePositionsCsv(`${header}\nAAA,1,10,5\nAAA,2,20,6`);
  assert.deepEqual(
    known.rows.map((r) => [r.quantity, r.marketValue, r.costBasis]),
    [[3, 30, 11]],
  );
  for (const cells of ["AAA,1,--,--\nAAA,2,20,6", "AAA,1,10,5\nAAA,2,--,--"]) {
    const parsed = parsePositionsCsv(`${header}\n${cells}`);
    assert.deepEqual(
      parsed.rows.map((r) => [r.quantity, r.marketValue, r.costBasis]),
      [[3, null, null]],
    );
  }
});

void test("csv: a long and a short row of one ticker in one account leave the basis unknown", () => {
  // Long 10 bought for $800 and short 4 sold for $480, at $100: up $200 and up $80.
  const gainOf = (csv: string) =>
    computePortfolioFacts(
      parsePositionsCsv(csv).rows,
      new Map([["S", quote(100, 0)]]),
      new Map(),
      "2026-11-05",
    ).positions[0]?.unrealized_gain;
  const header = "Symbol,Quantity,Cost Basis";
  // In two accounts each lot keeps its own basis, and the gain is right.
  assert.equal(
    gainOf(
      `Positions for account One as of today\n${header}\nS,10,800\nPositions for account Two as of today\n${header}\nS,-4,480`,
    ),
    280,
  );
  // In one account the rows become one holding with one basis. $800 + $480 is the basis of
  // neither side, and gave a loss of $680. Unknown is the honest answer, and the preview says why.
  const oneAccount = parsePositionsCsv(`${header}\nS,10,800\nS,-4,480`);
  assert.deepEqual(
    oneAccount.rows.map((r) => [r.quantity, r.costBasis]),
    [[6, null]],
  );
  assert.equal(gainOf(`${header}\nS,10,800\nS,-4,480`), null);
  assert.match(
    oneAccount.notes.join("\n"),
    /S: .*both long and short.*cost basis.*blank/,
  );
  // A later row on either side cannot bring a basis back.
  assert.equal(
    parsePositionsCsv(`${header}\nS,10,800\nS,-4,480\nS,5,450`).rows[0]
      ?.costBasis,
    null,
  );
  // Two rows on the same side still add up.
  assert.equal(
    parsePositionsCsv(`${header}\nS,-5,600\nS,-5,600`).rows[0]?.costBasis,
    1200,
  );
});

const blankScreenPosition = {
  symbol: "AAA",
  description: null,
  quantity: null,
  price: null,
  cost_basis: null,
  gain_value: null,
};
type ScreenPosition = Parameters<
  typeof screenshotPositionsToCsv
>[0]["positions"][number];
const screenCsv = (
  positions: ScreenPosition[],
  extra: Partial<
    Omit<Parameters<typeof screenshotPositionsToCsv>[0], "positions">
  > = {},
) =>
  screenshotPositionsToCsv({
    positions,
    cash_value: null,
    account_value: null,
    account_name: null,
    ...extra,
  });

void test("csv: overlapping screenshots fill each missing fact and keep facts already seen", () => {
  const position = {
    ...blankScreenPosition,
    symbol: " aaa ",
    description: 'Acme "A"',
    quantity: 3,
    price: 10,
    cost_basis: 15,
    gain_value: 5,
  };
  for (const missing of [
    "description",
    "quantity",
    "price",
    "cost_basis",
    "gain_value",
  ] as const) {
    const first = { ...position, [missing]: null };
    const second = { ...position, symbol: "AAA" };
    const converted = screenCsv([first, second]);
    assert.deepEqual(
      parsePositionsCsv(converted.csv).rows.map((r) => [
        r.ticker,
        r.name,
        r.quantity,
        r.marketValue,
        r.costBasis,
      ]),
      [["AAA", 'Acme "A"', 3, 30, 15]],
      missing,
    );
  }
  const derived = screenCsv([
    { ...blankScreenPosition, price: 3 },
    { ...blankScreenPosition, cost_basis: 10, gain_value: 1 },
  ]);
  assert.equal(parsePositionsCsv(derived.csv).rows[0]?.quantity, 3.6667);
  assert.match(derived.notes[0] ?? "", /quantity 3\.6667 was worked out/);
  const kept = screenCsv([
    position,
    {
      ...position,
      quantity: 99,
      price: 99,
      description: "Other",
      cost_basis: 99,
      gain_value: 99,
    },
  ]);
  assert.deepEqual(
    parsePositionsCsv(kept.csv).rows.map((r) => [
      r.name,
      r.quantity,
      r.marketValue,
      r.costBasis,
    ]),
    [['Acme "A"', 3, 30, 15]],
  );
});

void test("csv: screenshot inference requires a nonzero price, basis and gain", () => {
  for (const missing of [
    { price: 0 },
    { price: null },
    { cost_basis: null },
    { gain_value: null },
  ]) {
    const converted = screenCsv([
      {
        ...blankScreenPosition,
        price: 10,
        cost_basis: 15,
        gain_value: 5,
        ...missing,
      },
    ]);
    assert.deepEqual(parsePositionsCsv(converted.csv).skipped, [
      { row: "AAA", reason: "no quantity" },
    ]);
    assert.deepEqual(converted.notes, []);
  }
});

void test("csv: screenshot reconciliation includes cash, gives an unsigned gap and quotes the account", () => {
  for (const account_value of [100, 200]) {
    const converted = screenCsv(
      [{ ...blankScreenPosition, quantity: 1, price: 100 }],
      { cash_value: 50, account_value, account_name: 'My "Main" IRA' },
    );
    assert.deepEqual(converted.notes, [
      `Positions and cash add up to $150.00. The screen shows $${account_value.toFixed(2)}, a difference of $50.00.`,
    ]);
    assert.deepEqual(
      parsePositionsCsv(converted.csv).rows.map((r) => [
        r.ticker,
        r.quantity,
        r.accountLabel,
      ]),
      [
        ["AAA", 1, "My Main IRA"],
        ["CASH", 50, "My Main IRA"],
      ],
    );
  }
  const absent = screenCsv([
    { ...blankScreenPosition, quantity: 1, price: 100 },
  ]);
  assert.deepEqual(
    parsePositionsCsv(absent.csv).rows.map((r) => r.ticker),
    ["AAA"],
  );
  assert.doesNotMatch(absent.csv, /Cash & Cash Investments/);
});

void test("portfolio: combining accounts preserves an unknown basis regardless of order", () => {
  for (const costs of [
    [50, null],
    [null, 50],
  ] as const) {
    const facts = computePortfolioFacts(
      [holding("AAA", 2, costs[0]), holding("AAA", 3, costs[1])],
      new Map([["AAA", { price: 100 }]]),
      new Map(),
      "2026-11-05",
    );
    assert.equal(facts.positions[0]?.quantity, 5);
    assert.equal(facts.positions[0]?.cost_basis, null);
    assert.equal(facts.positions[0]?.unrealized_gain, null);
    assert.equal(facts.positions_with_cost_basis, 0);
    assert.equal(facts.unrealized_gain_where_known, 0);
  }
});

void test("portfolio: zero and negative quotes leave price, moves and gain unknown", () => {
  const facts = computePortfolioFacts(
    [holding("AAA", 2, 10), holding("BBB", 3, 20)],
    new Map([
      ["AAA", { price: 0, change: 1, changePercentage: 1 }],
      ["BBB", { price: -5, change: 1, changePercentage: 1 }],
    ]),
    new Map(),
    "2026-11-05",
  );
  assert.deepEqual(facts.missing_prices.sort(), ["AAA", "BBB"]);
  for (const p of facts.positions) {
    assert.deepEqual(
      [
        p.price,
        p.value,
        p.day_change_value,
        p.day_change_pct,
        p.unrealized_gain,
        p.weight_pct,
      ],
      [null, null, null, null, null, null],
    );
  }
  assert.deepEqual(
    [
      facts.total_value,
      facts.cash_pct,
      facts.top5_concentration_pct,
      facts.day_change_pct,
    ],
    [0, 0, 0, null],
  );
  assert.deepEqual(facts.sector_weights, [
    { sector: "Unknown", weight_pct: 0 },
  ]);
});

void test("portfolio: cash has no quote date or gain even with a supplied quote and basis", () => {
  const facts = computePortfolioFacts(
    [holding("CASH", 1000, 900)],
    new Map([["CASH", { price: 99, quote_date: "2026-11-04" }]]),
    new Map([["CASH", "Technology"]]),
    "2026-11-05",
  );
  const cash = facts.positions[0];
  assert.deepEqual(
    [
      cash?.price,
      cash?.value,
      cash?.quote_date,
      cash?.unrealized_gain,
      cash?.sector,
    ],
    [1, 1000, null, null, "Cash"],
  );
  assert.deepEqual(facts.sector_weights, [{ sector: "Cash", weight_pct: 100 }]);
});

void test("portfolio: a zero basis gives a dollar gain without a percentage", () => {
  const facts = computePortfolioFacts(
    [holding("AAA", 1, 0), holding("BBB")],
    new Map([
      ["AAA", { price: 10 }],
      ["BBB", { price: 20 }],
    ]),
    new Map(),
    "2026-11-05",
  );
  assert.equal(
    facts.positions.find((p) => p.ticker === "AAA")?.unrealized_gain,
    10,
  );
  assert.equal(
    facts.positions.find((p) => p.ticker === "AAA")?.unrealized_gain_pct,
    null,
  );
  assert.equal(facts.positions_with_cost_basis, 1);
  assert.equal(facts.unrealized_gain_where_known, 10);
});

void test("portfolio: top five means the five largest investments and excludes larger cash", () => {
  const values = [100, 600, 300, 500, 200, 400];
  const facts = computePortfolioFacts(
    [...values.map((_, i) => holding(`T${i}`)), holding("CASH", 900)],
    new Map(values.map((price, i) => [`T${i}`, { price }])),
    new Map(),
    "2026-11-05",
  );
  assert.deepEqual(
    facts.positions.map((p) => p.value),
    [900, 600, 500, 400, 300, 200, 100],
  );
  assert.deepEqual(
    [
      facts.total_value,
      facts.cash_value,
      facts.cash_pct,
      facts.top5_concentration_pct,
    ],
    [3000, 900, 30, 66.67],
  );
});

void test("portfolio: a short is never netted into the top five, however few positions there are", () => {
  const top5 = (longs: number[]) =>
    computePortfolioFacts(
      [
        ...longs.map((_, i) => holding(`L${i}`)),
        holding("SHRT", -5),
        holding("CASH", 500),
      ],
      new Map([
        ...longs.map((price, i): [string, { price: number }] => [
          `L${i}`,
          { price },
        ]),
        ["SHRT", { price: 100 }],
      ]),
      new Map(),
      "2026-11-05",
    );
  // Long $1,000, short -$500, cash $500: the long alone is all of the $1,000 net value.
  const one = top5([1000]);
  assert.equal(one.total_value, 1000);
  assert.equal(one.top5_concentration_pct, 100);
  // Four longs leave a free slot, which the short must not fill.
  assert.equal(top5([500, 400, 300, 200]).top5_concentration_pct, 100);
  // A fifth long of $1 fills the slot. The figure must not jump because of it.
  assert.equal(top5([500, 400, 300, 200, 1]).top5_concentration_pct, 100);
  // With six longs the short was already left out: 1,500 of the 1,600 net.
  assert.equal(
    top5([500, 400, 300, 200, 100, 100]).top5_concentration_pct,
    93.75,
  );
});

void test("portfolio: weights, cash share and sectors are shares of net value, with a short or negative cash", () => {
  const sum = (weights: (number | null)[]) =>
    weights.reduce<number>((total, w) => total + (w ?? 0), 0);
  // Long $1,000 of technology, short $500 of energy, cash $500: net value $1,000.
  const short = computePortfolioFacts(
    [holding("LONG", 10), holding("SHRT", -5), holding("CASH", 500)],
    new Map([
      ["LONG", { price: 100 }],
      ["SHRT", { price: 100 }],
    ]),
    new Map([
      ["LONG", "Technology"],
      ["SHRT", "Energy"],
    ]),
    "2026-11-05",
  );
  assert.equal(short.total_value, 1000);
  assert.deepEqual(
    short.positions.map((p) => [p.ticker, p.value, p.weight_pct]),
    [
      ["LONG", 1000, 100],
      ["CASH", 500, 50],
      ["SHRT", -500, -50],
    ],
  );
  assert.equal(sum(short.positions.map((p) => p.weight_pct)), 100);
  assert.equal(short.cash_pct, 50);
  assert.deepEqual(short.sector_weights, [
    { sector: "Technology", weight_pct: 100 },
    { sector: "Cash", weight_pct: 50 },
    { sector: "Energy", weight_pct: -50 },
  ]);
  assert.equal(sum(short.sector_weights.map((s) => s.weight_pct)), 100);
  // Three longs of $400 bought partly on margin: cash is -$200 and net value $1,000.
  const margin = computePortfolioFacts(
    [holding("A"), holding("B"), holding("C"), holding("CASH", -200)],
    new Map(["A", "B", "C"].map((ticker) => [ticker, { price: 400 }])),
    new Map(),
    "2026-11-05",
  );
  assert.equal(margin.total_value, 1000);
  assert.equal(margin.cash_value, -200);
  assert.equal(margin.cash_pct, -20);
  assert.equal(sum(margin.positions.map((p) => p.weight_pct)), 100);
  assert.equal(margin.top5_concentration_pct, 120);
});

void test("portfolio: a short gains on the day when its stock falls, and the percent is on yesterday's net value", () => {
  const facts = computePortfolioFacts(
    [holding("LONG", 10), holding("SHRT", -5), holding("CASH", 500)],
    new Map([
      ["LONG", quote(100, 2, "2026-11-05")],
      ["SHRT", quote(100, -1, "2026-11-05")],
    ]),
    new Map(),
    "2026-11-05",
  );
  const short = facts.positions.find((p) => p.ticker === "SHRT");
  assert.equal(short?.day_change_value, 5);
  assert.equal(short?.day_change_pct, -1);
  // +$20 on the long and +$5 on the short, on $975 the day before.
  assert.equal(facts.day_change_value, 25);
  assert.equal(facts.day_change_pct, 2.56);
});

void test("portfolio: a quote is stale after four days, and a quote that is not a number is no price", () => {
  const dated = (date: string) =>
    computePortfolioFacts(
      [holding("AAA")],
      new Map([["AAA", quote(100, 0, date)]]),
      new Map(),
      "2026-11-05",
    ).quote_dates.stale;
  assert.deepEqual(dated("2026-11-01"), []);
  assert.deepEqual(dated("2026-10-31"), ["AAA"]);
  const facts = computePortfolioFacts(
    [holding("NAN"), holding("INF"), holding("TEXT"), holding("MOVE")],
    new Map<string, Record<string, unknown>>([
      ["NAN", { price: Number.NaN, change: 1 }],
      ["INF", { price: Infinity, change: 1 }],
      ["TEXT", { price: "100", change: 1 }],
      ["MOVE", { price: 50, change: Number.NaN, changePercentage: "2" }],
    ]),
    new Map(),
    "2026-11-05",
  );
  assert.deepEqual(facts.missing_prices.sort(), ["INF", "NAN", "TEXT"]);
  assert.equal(facts.total_value, 50);
  const move = facts.positions.find((p) => p.ticker === "MOVE");
  assert.deepEqual(
    [move?.value, move?.day_change_value, move?.day_change_pct],
    [50, null, null],
  );
  assert.equal(facts.day_change_value, null);
  assert.doesNotMatch(JSON.stringify(facts), /NaN|Infinity/);
});

void test("csv: negative cash, scientific notation, a lower-case symbol and a formula-like symbol", () => {
  const parsed = parsePositionsCsv(
    [
      "Symbol,Description,Quantity,Price,Market Value,Cost Basis,Security Type",
      'hldn,Holden,1e2,$10.00,"$1,000.00","$900.00",Equity',
      "=SUM(A1),Formula,1,$1.00,$1.00,$1.00,Equity",
      "+CMD,Formula,1,$1.00,$1.00,$1.00,Equity",
      "@SUM,Formula,1,$1.00,$1.00,$1.00,Equity",
      'Cash & Cash Investments,--,--,--,"($250.50)",--,Cash and Money Market',
    ].join("\n"),
  );
  assert.equal(parsed.error, null);
  assert.deepEqual(
    parsed.rows.map((r) => [r.ticker, r.quantity, r.costBasis]),
    [
      ["HLDN", 100, 900],
      ["CASH", -250.5, null],
    ],
  );
  assert.deepEqual(
    parsed.skipped.map((s) => s.row),
    ["=SUM(A1)", "+CMD", "@SUM"],
  );
  assert.ok(parsed.skipped.every((s) => s.reason === "not a stock ticker"));
});

void test("portfolio: a complete fund breakdown has no unallocated remainder", () => {
  const facts = computePortfolioFacts(
    [holding("FUND")],
    new Map([["FUND", { price: 100 }]]),
    new Map([["FUND", "Financial Services"]]),
    "2026-11-05",
    new Map([
      [
        "FUND",
        [
          { sector: "Energy", weightPercentage: 40 },
          { sector: "Technology", weightPercentage: 60 },
        ],
      ],
    ]),
  );
  assert.deepEqual(facts.sector_weights, [
    { sector: "Technology", weight_pct: 60 },
    { sector: "Energy", weight_pct: 40 },
  ]);
  assert.deepEqual(facts.funds_no_breakdown, []);
});

void test("portfolio: the day percentage uses yesterday's value and handles a zero denominator", () => {
  const facts = computePortfolioFacts(
    [holding("AAA", 10)],
    new Map([["AAA", { price: 105, change: 5, changePercentage: 5 }]]),
    new Map(),
    "2026-11-05",
  );
  assert.equal(facts.day_change_value, 50);
  assert.equal(facts.day_change_pct, 5);
  const noPrevious = computePortfolioFacts(
    [holding("AAA")],
    new Map([["AAA", { price: 50, change: 50 }]]),
    new Map(),
    "2026-11-05",
  );
  assert.equal(noPrevious.day_change_pct, 0);
});

void test("portfolio: a pack gets the requested position and the whole portfolio context", () => {
  const facts = computePortfolioFacts(
    [holding("AAA", 2, 100), holding("BBB", 3, 90), holding("CASH", 400)],
    new Map([
      ["AAA", { price: 100 }],
      ["BBB", { price: 50 }],
    ]),
    new Map([
      ["AAA", "Technology"],
      ["BBB", "Energy"],
    ]),
    "2026-11-05",
  );
  assert.deepEqual(packPosition(facts, "BBB"), {
    quantity: 3,
    value: 150,
    weight_pct: 20,
    cost_basis: 90,
    unrealized_gain: 60,
    unrealized_gain_pct: 66.67,
    portfolio_total_value: 750,
    portfolio_cash_pct: 53.33,
    portfolio_top5_concentration_pct: 46.67,
    portfolio_sector_weights: [
      { sector: "Cash", weight_pct: 53.33 },
      { sector: "Technology", weight_pct: 26.67 },
      { sector: "Energy", weight_pct: 20 },
    ],
  });
  assert.equal(packPosition(facts, "MISSING"), undefined);
});

const quote = (price: number, change: number | null, date?: string) => ({
  price,
  change,
  changePercentage: change === null ? null : (change / price) * 100,
  ...(date ? { quote_date: date } : {}),
});

void test("the day's total holds only moves from the newest quote date and names the rest", () => {
  const facts = computePortfolioFacts(
    [holding("NEW"), holding("OLD"), holding("CASH", 1000)],
    new Map([
      ["NEW", quote(100, 100, "2026-11-05")],
      ["OLD", quote(100, -2000, "2026-11-04")],
    ]),
    new Map(),
    "2026-11-05",
  );
  assert.equal(facts.day_change_value, 100);
  assert.equal(facts.day_change_pct, 9.09); // 100 on the 1100 before it
  assert.deepEqual(facts.day_change_left_out, ["OLD"]);
  // Every holding keeps its own move and its value. Only the day's total changes.
  assert.equal(facts.total_value, 1200);
  assert.equal(
    facts.positions.find((p) => p.ticker === "OLD")?.day_change_value,
    -2000,
  );
  assert.deepEqual(facts.quote_dates.stale, ["OLD"]);
});

void test("the day's total sums every move when quotes share one date or have none", () => {
  const dated = computePortfolioFacts(
    [holding("A"), holding("B")],
    new Map([
      ["A", quote(100, 5, "2026-11-05")],
      ["B", quote(100, -2, "2026-11-05")],
    ]),
    new Map(),
    "2026-11-05",
  );
  assert.equal(dated.day_change_value, 3);
  assert.equal(dated.day_change_pct, 1.52); // 3 on the 197 before it
  assert.deepEqual(dated.day_change_left_out, []);

  const undated = computePortfolioFacts(
    [holding("A"), holding("B")],
    new Map([
      ["A", quote(100, 5)],
      ["B", quote(100, -2)],
    ]),
    new Map(),
    "2026-11-05",
  );
  assert.equal(undated.day_change_value, 3);
  assert.deepEqual(undated.day_change_left_out, []);
});

void test("a quote with no date is not added to a day's total that names a date", () => {
  const facts = computePortfolioFacts(
    [holding("A"), holding("B")],
    new Map([
      ["A", quote(100, 5, "2026-11-05")],
      ["B", quote(100, -40)],
    ]),
    new Map(),
    "2026-11-05",
  );
  assert.equal(facts.day_change_value, 5);
  assert.deepEqual(facts.day_change_left_out, ["B"]);
});

void test("a missing day change is named, and a missing price stays in the missing list only", () => {
  const facts = computePortfolioFacts(
    [holding("A"), holding("B"), holding("C")],
    new Map([
      ["A", quote(100, 5, "2026-11-05")],
      ["B", quote(100, null, "2026-11-05")],
    ]),
    new Map(),
    "2026-11-05",
  );
  assert.equal(facts.day_change_value, 5);
  assert.deepEqual(facts.day_change_left_out, ["B"]);
  assert.deepEqual(facts.missing_prices, ["C"]);
  assert.equal(
    facts.positions.find((p) => p.ticker === "B")?.day_change_value,
    null,
  );
});

void test("no known move reads as no figure, not a zero return", () => {
  const facts = computePortfolioFacts(
    [holding("A", 10), holding("CASH", 500)],
    new Map([["A", quote(100, null, "2026-11-05")]]),
    new Map(),
    "2026-11-05",
  );
  assert.equal(facts.day_change_value, null);
  assert.equal(facts.day_change_pct, null);
  assert.deepEqual(facts.day_change_left_out, ["A"]);
  assert.equal(facts.total_value, 1500);
});

void test("cash-only days read zero while entirely unpriced invested moves stay unknown", () => {
  const cash = computePortfolioFacts(
    [holding("CASH", 500)],
    new Map(),
    new Map(),
    "2026-11-05",
  );
  assert.equal(cash.day_change_value, 0);
  assert.equal(cash.day_change_pct, 0);
  assert.deepEqual(cash.day_change_left_out, []);

  const unpriced = computePortfolioFacts(
    [holding("A")],
    new Map(),
    new Map(),
    "2026-11-05",
  );
  assert.equal(unpriced.day_change_value, null);
  assert.equal(unpriced.day_change_pct, null);
  assert.deepEqual(unpriced.day_change_left_out, []);
  assert.deepEqual(unpriced.missing_prices, ["A"]);
});

void test("replace comparison detects total basis changes across account labels", () => {
  const changes = holdingChanges(
    [{ ticker: "AAA", quantity: 10, costBasis: 100, accountLabel: "Old" }],
    [{ ticker: "AAA", quantity: 10, costBasis: 1000, accountLabel: "New" }],
  );
  assert.equal(changes.unchanged, 0);
  assert.match(previewSummary(changes, false), /1 with cost basis changes/);
});

void test("a basis gained in another account cannot hide a retained account losing its basis", () => {
  const current = [
    { ticker: "AAA", quantity: 10, costBasis: 1000, accountLabel: "Taxable" },
    { ticker: "AAA", quantity: 5, costBasis: null, accountLabel: "IRA" },
  ];
  const incoming = [
    { ...current[0]!, costBasis: null },
    { ...current[1]!, costBasis: 400 },
  ];
  assert.deepEqual(holdingChanges(current, incoming).losingBasis, ["AAA"]);
  assert.equal(holdingChanges(current, incoming).unchanged, 0);
  assert.deepEqual(holdingChanges(current, current).losingBasis, []);
  assert.deepEqual(holdingChanges(current, [incoming[1]!]).losingBasis, [
    "AAA",
  ]);
  assert.deepEqual(
    holdingChanges(
      current,
      incoming.map((r) => ({ ...r, accountLabel: `New ${r.accountLabel}` })),
    ).losingBasis,
    ["AAA"],
  );
});

void test("a short's gain and percent read the same for either sign of its basis", () => {
  for (const basis of [-1200, 1200]) {
    const profit = computePortfolioFacts(
      [holding("S", -10, basis)],
      new Map([["S", quote(100, 0)]]),
      new Map(),
      "2026-11-05",
    );
    assert.equal(profit.positions[0]?.value, -1000);
    assert.equal(profit.positions[0]?.unrealized_gain, 200);
    assert.equal(profit.positions[0]?.unrealized_gain_pct, 16.67);
    assert.equal(profit.unrealized_gain_where_known, 200);

    const loss = computePortfolioFacts(
      [holding("S", -10, basis)],
      new Map([["S", quote(130, 0)]]),
      new Map(),
      "2026-11-05",
    ).positions[0];
    assert.equal(loss?.unrealized_gain, -100);
    assert.equal(loss?.unrealized_gain_pct, -8.33);
  }
});

void test("a long position's gain and percent stay value less basis", () => {
  const long = computePortfolioFacts(
    [holding("L", 10, 800)],
    new Map([["L", quote(100, 0)]]),
    new Map(),
    "2026-11-05",
  ).positions[0];
  assert.equal(long?.unrealized_gain, 200);
  assert.equal(long?.unrealized_gain_pct, 25);
});

void test("lots of one ticker in several accounts gain the same for either sign of a short's basis", () => {
  const position = (rows: ReturnType<typeof holding>[]) =>
    computePortfolioFacts(
      rows,
      new Map([["S", quote(100, 0)]]),
      new Map(),
      "2026-11-05",
    ).positions[0];
  // Long 10 bought for $800 is up $200. Short 4 sold for $480 is up $80.
  for (const proceeds of [-480, 480]) {
    const both = position([holding("S", 10, 800), holding("S", -4, proceeds)]);
    assert.equal(both?.quantity, 6);
    assert.equal(both?.value, 600);
    assert.equal(both?.unrealized_gain, 280);
    assert.equal(both?.unrealized_gain_pct, 87.5);
  }
  // Two short lots of 5, each sold for $600, cost $1,000 to cover: up $200 on $1,200.
  for (const [first, second] of [
    [-600, -600],
    [600, 600],
    [600, -600],
  ] as const) {
    const shorts = position([
      holding("S", -5, first),
      holding("S", -5, second),
    ]);
    assert.equal(shorts?.unrealized_gain, 200);
    assert.equal(shorts?.unrealized_gain_pct, 16.67);
  }
  // The basis shown is still the sum of what each account reported.
  assert.equal(
    position([holding("S", 10, 800), holding("S", 5, 450)])?.cost_basis,
    1250,
  );
  // That includes two short lots: $600 and $600 reported is $1,200 shown, not the signed -$1,200.
  assert.equal(
    position([holding("S", -5, 600), holding("S", -5, 600)])?.cost_basis,
    1200,
  );
  assert.equal(
    position([holding("S", 10, 800), holding("S", 5, null)])?.unrealized_gain,
    null,
  );
});

void test("a percent gain needs a basis on the position's own side", () => {
  const position = (rows: ReturnType<typeof holding>[]) =>
    computePortfolioFacts(
      rows,
      new Map([["S", quote(100, 0)]]),
      new Map(),
      "2026-11-05",
    ).positions[0];
  // A long whose basis went negative still has a dollar gain, but no base to take a percent of.
  const negative = position([holding("S", 1, -50)]);
  assert.equal(negative?.unrealized_gain, 150);
  assert.equal(negative?.unrealized_gain_pct, null);
  // Long 1 bought for $1,000 and short 4 sold for $480 nets short against a net cost.
  const netShort = position([holding("S", 1, 1000), holding("S", -4, 480)]);
  assert.equal(netShort?.unrealized_gain, -820);
  assert.equal(netShort?.unrealized_gain_pct, null);
  // Offsetting lots leave no position to take a percent of, and never divide zero by zero.
  for (const basis of [500, 0]) {
    const flat = position([holding("S", 5, basis), holding("S", -5, basis)]);
    assert.equal(flat?.unrealized_gain_pct, null);
  }
});

void test("the funds behind the no-breakdown line are named, biggest first", () => {
  const facts = computePortfolioFacts(
    [
      holding("VOO"),
      holding("VCSH"),
      holding("IBIT", 3),
      holding("MCHI"),
      holding("MSFT", 2),
      holding("NOPRICE"),
    ],
    new Map([
      ["VOO", quote(100, 0)],
      ["VCSH", quote(100, 0)],
      ["IBIT", quote(100, 0)],
      ["MCHI", quote(100, 0)],
      ["MSFT", quote(100, 0)],
    ]),
    new Map([["MSFT", "Technology"]]),
    "2026-11-05",
    new Map([
      ["VOO", [{ sector: "Technology", weightPercentage: 100 }]],
      ["VCSH", []],
      ["IBIT", [{ sector: "Cash & Others", weightPercentage: 100 }]],
      // A rounding gap this small still lands on the line, but is too small to name.
      ["MCHI", [{ sector: "Energy", weightPercentage: 99.5 - 0.01 }]],
      ["NOPRICE", []],
    ]),
  );
  assert.deepEqual(facts.funds_no_breakdown, [
    { ticker: "IBIT", weight_pct: 37.5 },
    { ticker: "VCSH", weight_pct: 12.5 },
  ]);
  assert.deepEqual(facts.sector_weights, [
    { sector: "Funds, no breakdown", weight_pct: 50.06 },
    { sector: "Technology", weight_pct: 37.5 },
    { sector: "Energy", weight_pct: 12.44 },
  ]);

  // A big fund's small gap comes after a smaller fund with no list at all.
  const ordered = computePortfolioFacts(
    [holding("BIG", 10), holding("SMALL", 2)],
    new Map([
      ["BIG", quote(100, 0)],
      ["SMALL", quote(100, 0)],
    ]),
    new Map(),
    "2026-11-05",
    new Map([
      ["BIG", [{ sector: "Energy", weightPercentage: 90 }]],
      ["SMALL", []],
    ]),
  );
  assert.deepEqual(ordered.funds_no_breakdown, [
    { ticker: "SMALL", weight_pct: 16.67 },
    { ticker: "BIG", weight_pct: 8.33 },
  ]);
});

void test("a fund list that cannot be a split of the fund goes on the no-breakdown line whole", () => {
  const facts = (breakdown: { sector: string; weightPercentage: number }[]) =>
    computePortfolioFacts(
      [holding("F", 10)],
      new Map([["F", quote(100, 0)]]),
      new Map(),
      "2026-11-05",
      new Map([["F", breakdown]]),
    );
  const whole = [{ sector: "Funds, no breakdown", weight_pct: 100 }];
  for (const breakdown of [
    [
      { sector: "Technology", weightPercentage: 65 },
      { sector: "Financials", weightPercentage: 60 },
    ],
    [
      { sector: "Technology", weightPercentage: 80 },
      { sector: "Energy", weightPercentage: 80 },
    ],
    [
      { sector: "Technology", weightPercentage: -20 },
      { sector: "Energy", weightPercentage: 100 },
    ],
  ]) {
    assert.deepEqual(facts(breakdown).sector_weights, whole);
    assert.deepEqual(facts(breakdown).funds_no_breakdown, [
      { ticker: "F", weight_pct: 100 },
    ]);
    assert.equal(facts(breakdown).total_value, 1000);
  }
});

void test("a fund list a little over 100% from vendor rounding is still used", () => {
  const facts = computePortfolioFacts(
    [holding("F", 10)],
    new Map([["F", quote(100, 0)]]),
    new Map(),
    "2026-11-05",
    new Map([
      [
        "F",
        [
          { sector: "Technology", weightPercentage: 60.2 },
          { sector: "Energy", weightPercentage: 40.2 },
          { sector: "Cash & Others", weightPercentage: 5 },
        ],
      ],
    ]),
  );
  assert.deepEqual(facts.sector_weights, [
    { sector: "Technology", weight_pct: 60.2 },
    { sector: "Energy", weight_pct: 40.2 },
  ]);
  assert.deepEqual(facts.funds_no_breakdown, []);
});

void test("a new view starting with an indented heading stays inside Current view", () => {
  const template = dossierTemplate("AAA", "A");
  const watchItems = dossierSection(template, "Watch items");
  for (const view of [
    "  ## Watch items\nnew",
    "\t## Watch items\nnew",
    "\n  # Watch items\nnew",
  ]) {
    const once = replaceCurrentView(template, view);
    assert.equal(
      dossierSection(once, "Current view"),
      "### Watch items\nnew",
      JSON.stringify(view),
    );
    assert.equal(once.match(/^## Watch items/gm)?.length, 1);
    assert.equal(dossierSection(once, "Watch items"), watchItems);

    const twice = replaceCurrentView(once, "fresh");
    assert.equal(dossierSection(twice, "Current view"), "fresh");
    assert.equal(twice.match(/^## Watch items/gm)?.length, 1);
    assert.equal(dossierSection(twice, "Watch items"), watchItems);
  }
});

void test("a row whose unquoted commas run past the header is left out, and the others stay", () => {
  const { rows, skipped, error } = parsePositionsCsv(
    [
      "Symbol,Description,Quantity,Price,Market Value,Cost Basis",
      "AAPL,Apple Inc,1,000,150.00,150000.00,100000.00",
      "MSFT,Microsoft,5,400,2000,1000",
    ].join("\n"),
  );
  assert.equal(error, null);
  assert.deepEqual(
    rows.map((r) => [r.ticker, r.quantity, r.costBasis]),
    [["MSFT", 5, 1000]],
  );
  assert.deepEqual(skipped, [
    { row: "AAPL", reason: "its cells do not line up with the header" },
  ]);
});

void test("a row that is out of line with no cell to spare is flagged by its own arithmetic", () => {
  const { rows, notes } = parsePositionsCsv(
    [
      "Symbol,Description,Quantity,Price,Market Value,Cost Basis,Security Type",
      "AAPL,Apple Inc,1,000,150.00,150000.00,100000.00",
      "MSFT,Microsoft,5,400,2000,1000,Equity",
    ].join("\n"),
  );
  assert.deepEqual(notes, [
    "AAPL: quantity 1 at $0.00 comes to $0.00, but the file gives its market value as $150.00. Check this row.",
  ]);
  // It only warns: the rows read as they did, for the preview to show.
  assert.deepEqual(
    rows.map((r) => r.ticker),
    ["AAPL", "MSFT"],
  );
});

void test("rows whose quantity and price come to their market value are not flagged", () => {
  const header = "Symbol,Quantity,Price,Market Value";
  for (const row of [
    "SSNC,5.3074,$79.72,$423.11", // Rounded in the file.
    "AMZN,9,$268.8493,$2419.64",
    "AAA,1000,$10.00,$10050.00", // Within 1%.
    "BBB,1,$0.50,$1.40", // Within a dollar.
    "SHRT,-10,$100,-$1000",
    "NOPX,5,--,$100",
    "NOMV,5,$100,--",
  ]) {
    assert.deepEqual(parsePositionsCsv(`${header}\n${row}`).notes, [], row);
  }
  assert.equal(
    parsePositionsCsv(`${header}\nAAA,1000,$10.00,$10200.00`).notes.length,
    1,
  );
  // "Price Chng $" is not the price.
  assert.deepEqual(
    parsePositionsCsv(
      "Symbol,Qty,Price Chng $ (Price Change $),Price,Mkt Val\nAAA,10,$1,$5,$50",
    ).notes,
    [],
  );
});

const QUOTED_HEADER = `"Symbol","Description","Quantity","Price","Market Value","Cost Basis","Security Type",`;

void test("a stray quote that still lines up keeps its row and its numbers", () => {
  const { rows, skipped, error } = parsePositionsCsv(
    [
      QUOTED_HEADER,
      `"BBB","Foo "Bar" Inc","20","$5","$100","$80","Equity",`,
      `"CCC","Plain","3","$1","$3","$2","Equity",`,
    ].join("\n"),
  );
  assert.equal(error, null);
  assert.deepEqual(skipped, []);
  assert.deepEqual(
    rows.map((r) => [r.ticker, r.quantity, r.marketValue, r.costBasis]),
    [
      ["BBB", 20, 100, 80],
      ["CCC", 3, 3, 2],
    ],
  );
});

void test("a stray quote that swallows a comma leaves that row out, with or without a trailing comma", () => {
  for (const end of [",", ""]) {
    const { rows, skipped, error } = parsePositionsCsv(
      [
        QUOTED_HEADER,
        "",
        `"AAA","Fine","1","$1","$1","$1","Equity"${end}`,
        "",
        `"BBB","Foo Inc,"20","$5","$100","$80","Equity"${end}`,
        "",
        `"CCC","Fine","3","$1","$3","$2","Equity"${end}`,
      ].join("\n"),
    );
    assert.equal(error, null, JSON.stringify(end));
    assert.deepEqual(
      rows.map((r) => [r.ticker, r.quantity]),
      [
        ["AAA", 1],
        ["CCC", 3],
      ],
    );
    assert.deepEqual(
      skipped.map((s) => s.row),
      ["BBB"],
    );
  }
});

void test("a short row with no stray quote on it is read as before", () => {
  const { rows, skipped } = parsePositionsCsv(
    [
      QUOTED_HEADER,
      `"BBB","Foo "Bar" Inc","20","$5","$100","$80","Equity",`,
      `"CCC","Short","3","$1","$3"`,
    ].join("\n"),
  );
  assert.deepEqual(skipped, []);
  assert.deepEqual(
    rows.map((r) => [r.ticker, r.quantity, r.costBasis]),
    [
      ["BBB", 20, 80],
      ["CCC", 3, null],
    ],
  );
});

void test("a quote that runs rows together refuses the file, so nothing can be replaced from it", () => {
  const header = "Symbol,Description,Quantity,Market Value,Cost Basis";
  const fine = "AAPL,Apple,5,1000,500";
  for (const [label, lines] of [
    ["never closes", [`MSFT,"Microsoft,10,4000,2000`, "NVDA,Nvidia,3,600,300"]],
    ["never closes on the last line", [`MSFT,"Microsoft,10,4000,2000`]],
    [
      "opens the row",
      [`"MSFT,Microsoft,10,4000,2000`, "NVDA,Nvidia,3,600,300"],
    ],
    // This one read as MSFT holding NVDA's 3 shares, with NVDA gone.
    [
      "closes on a later line",
      [`MSFT,"Microsoft,10,4000,2000`, `NVDA,"Nvidia",3,600,300`],
    ],
  ] as const) {
    const parsed = parsePositionsCsv([header, fine, ...lines].join("\n"));
    assert.match(parsed.error ?? "", /quote mark/, label);
    assert.deepEqual(parsed.rows, [], label);
  }
});

void test("Windows line endings and a byte order mark change nothing about what is read", () => {
  const lines = [
    QUOTED_HEADER,
    `"AAA","Fine","1","$1","$1","$1","Equity",`,
    `"BBB","Foo "Bar" Inc","20","$5","$100","$80","Equity",`,
    `"CCC","Foo Inc,"30","$5","$100","$80","Equity",`,
    `"Account Total","--","--","--","$101.00","--","--",`,
  ];
  const plain = parsePositionsCsv(lines.join("\n"));
  assert.equal(plain.error, null);
  assert.deepEqual(
    plain.rows.map((r) => [r.ticker, r.quantity]),
    [
      ["AAA", 1],
      ["BBB", 20],
    ],
  );
  assert.deepEqual(parsePositionsCsv(`﻿${lines.join("\r\n")}\r\n`), plain);
});

void test("a file whose every row was left out says why, not that it has no header", () => {
  assert.equal(
    parsePositionsCsv("Symbol,Quantity,Market Value\nX,12.5%,50\nY,1%,2").error,
    "No positions could be read, because every row was left out. The first was X: no quantity.",
  );
  assert.match(
    parsePositionsCsv("hello,world\n1,2").error ?? "",
    /Expected a header row/,
  );
});

void test("a cell with a line break and well-formed quotes still reads", () => {
  const { rows, error } = parsePositionsCsv(
    `Symbol,Description,Quantity\nAAA,"Two\nlines",4\nBBB,Plain,5`,
  );
  assert.equal(error, null);
  assert.deepEqual(
    rows.map((r) => [r.ticker, r.quantity]),
    [
      ["AAA", 4],
      ["BBB", 5],
    ],
  );
});

void test("trailing empty cells on a header or a row are not a mismatch", () => {
  for (const csv of [
    "Symbol,Quantity,Cost Basis,,\nAAA,1,2",
    "Symbol,Quantity,Cost Basis\nAAA,1,2,,",
    "Symbol,Quantity,Cost Basis,\nAAA,1,2,",
  ]) {
    const { rows, skipped } = parsePositionsCsv(csv);
    assert.deepEqual(skipped, [], csv);
    assert.equal(rows[0]?.costBasis, 2, csv);
  }
});

const TOTAL_HEADER = `"Symbol","Description","Quantity","Price","Market Value","Cost Basis"`;

void test("a gap between the rows and the Account Total is noted, per account", () => {
  const { notes } = parsePositionsCsv(
    [
      `"Individual ...123"`,
      TOTAL_HEADER,
      `"AAPL","Apple","1000","$371.71567","$371,715.67","$1,000.00"`,
      `"AAPL 01/15/2027 400.00 C","CALL","1","$5.00","$500.00","$400.00"`,
      `"Account Total","--","--","--","$372,215.67","--"`,
      `"Roth ...456"`,
      TOTAL_HEADER,
      `"MSFT","Microsoft","2","$400.00","$800.00","$500.00"`,
      `"Account Total","--","--","--","$800.00","--"`,
    ].join("\n"),
  );
  assert.deepEqual(notes, [
    "Individual ...123: rows add up to $371,715.67, but its Account Total says $372,215.67, a difference of $500.00. Rows left out below can explain it.",
  ]);
});

void test("no note when totals balance, within a dollar, or are not stated", () => {
  for (const csv of [
    // Cash counts, and rows merged in one account are not counted twice.
    [
      TOTAL_HEADER,
      `"AAA","A","100","$1","$100.00","$1"`,
      `"AAA","A","100","$1","$100.00","$1"`,
      `"Cash & Cash Investments","--","--","--","$10.50","--"`,
      `"Account Total","--","--","--","$210.75","--"`,
    ],
    // Two accounts with no titles share a label but not a total.
    [
      TOTAL_HEADER,
      `"AAA","A","100","$1","$100.00","$1"`,
      `"Account Total","--","--","--","$100.00","--"`,
      `"BBB","B","50","$1","$50.00","$1"`,
      `"Account Total","--","--","--","$50.00","--"`,
    ],
    // Positions Total leaves out cash, so it is not the figure to compare.
    [
      TOTAL_HEADER,
      `"AAA","A","100","$1","$100.00","$1"`,
      `"Positions Total","--","--","--","$100.00","--"`,
      `"Cash & Cash Investments","--","--","--","$20.00","--"`,
      `"Account Total","--","--","--","$120.00","--"`,
    ],
    [
      TOTAL_HEADER,
      `"AAA","A","100","$1","$100.00","$1"`,
      `"Positions Total","--","--","--","$999.00","--"`,
    ],
    [TOTAL_HEADER, `"AAA","A","100","$1","$100.00","$1"`],
    [
      TOTAL_HEADER,
      `"AAA","A","100","$1","$100.00","$1"`,
      `"Account Total","--","--","--","--","--"`,
    ],
  ]) {
    assert.deepEqual(parsePositionsCsv(csv.join("\n")).notes, [], csv[1]);
  }
});

void test("a gap with nothing left out does not point at a list that is not there", () => {
  const { notes, skipped } = parsePositionsCsv(
    [
      TOTAL_HEADER,
      `"AAA","A","100","$1","$100.00","$1"`,
      `"Account Total","--","--","--","$150.00","--"`,
    ].join("\n"),
  );
  assert.deepEqual(skipped, []);
  assert.deepEqual(notes, [
    "This file: rows add up to $100.00, but its Account Total says $150.00, a difference of $50.00.",
  ]);
});

void test("a per-share cost column is never read as the position's total cost", () => {
  const basis = (header: string, cells: string) =>
    parsePositionsCsv(
      `Symbol,Quantity,Market Value,${header}\nAAA,10,2000,${cells}`,
    ).rows[0]?.costBasis;
  assert.equal(basis("Cost Basis Per Share,Cost Basis", "150,1500"), 1500);
  assert.equal(basis("Average Cost Basis,Total Cost Basis", "50,500"), 500);
  assert.equal(basis("Average Cost Basis,Cost Basis Total", "50,500"), 500);
  assert.equal(basis("Cost Basis Total,Average Cost Basis", "500,50"), 500);
  assert.equal(basis("Cost Basis", "500"), 500);
  for (const header of [
    "Avg Cost Basis",
    "Average Cost Basis",
    "Cost Basis/Share",
    "Cost Basis Per Share",
    "Cost Basis Per Unit",
    "Unit Cost Basis",
  ]) {
    assert.equal(basis(header, "50"), null, header);
  }
});

void test("a letter-first bond CUSIP is left out, and a fund that holds bonds is not", () => {
  const { rows, skipped } = parsePositionsCsv(
    [
      "Symbol,Description,Quantity,Price,Market Value,Cost Basis,Security Type",
      "G0176J109,ALLEGION BOND,10000,$99,$9900,$10000,Fixed Income",
      "VCSH,VANGUARD SHORT-TERM,26,$77,$2021,$2067,ETFs & Closed End Funds",
      "BND,VANGUARD TOTAL BOND,5,$70,$350,$340,Bond ETF",
      "AAPL 01/15/2027 400.00 C,CALL,1,$5,$500,$400,Option",
    ].join("\n"),
  );
  assert.deepEqual(
    rows.map((r) => r.ticker),
    ["VCSH", "BND"],
  );
  assert.deepEqual(skipped, [
    { row: "G0176J109", reason: "a bond, not a stock" },
    { row: "AAPL 01/15/2027 400.00 C", reason: "not a stock ticker" },
  ]);
});

void test("a stock trading as CASH is left out rather than counted as dollars", () => {
  const { rows, skipped } = parsePositionsCsv(
    [
      "Symbol,Description,Quantity,Price,Market Value,Cost Basis,Security Type",
      "CASH,PATHWARD FINANCIAL INC,700,$80,$56000,$40000,Equity",
      "Cash & Cash Investments,--,--,--,$100,--,Cash and Money Market",
      "CASH,Cash,--,--,$50,--,Cash and Money Market",
    ].join("\n"),
  );
  assert.deepEqual(skipped, [
    {
      row: "CASH",
      reason: "a stock with the ticker CASH, which this app keeps for cash",
    },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.ticker, r.quantity]),
    [["CASH", 150]],
  );
  // With no type column nothing says it is a stock, and screenshot files have none.
  assert.equal(
    parsePositionsCsv("Symbol,Quantity,Market Value\nCASH,--,$75").rows[0]
      ?.quantity,
    75,
  );
});

void test("a percent is never read as a share count or a cost", () => {
  const shares = parsePositionsCsv("Symbol,Quantity,Market Value\nX,12.5%,50");
  assert.deepEqual(shares.rows, []);
  assert.deepEqual(shares.skipped, [{ row: "X", reason: "no quantity" }]);

  const cost = parsePositionsCsv("Symbol,Quantity,Cost Basis\nY,3,20%");
  assert.equal(cost.rows[0]?.quantity, 3);
  assert.equal(cost.rows[0]?.costBasis, null);
});

void test("merging rows keeps an unknown market value unknown, not zero or a part", () => {
  const value = (cells: [string, string]) =>
    parsePositionsCsv(
      `Symbol,Quantity,Market Value\nAAA,1,${cells[0]}\nAAA,2,${cells[1]}`,
    ).rows[0]?.marketValue;
  assert.equal(value(["", ""]), null);
  assert.equal(value(["100", ""]), null);
  assert.equal(value(["", "100"]), null);
  assert.equal(value(["100", "200"]), 300);
});

void test("the replace preview names tickers losing their cost basis, and only those", () => {
  const row = (ticker: string, costBasis: number | null, quantity = 5) => ({
    ticker,
    quantity,
    costBasis,
  });
  const changes = holdingChanges(
    [
      row("AAA", 100),
      row("BBB", 100),
      row("CCC", null),
      row("DDD", 100),
      row("CASH", null),
      // One of two accounts has no basis yet, and the file says the same.
      row("EEE", 100),
      row("EEE", null),
      // The same state, but this file loses the basis it did have.
      row("FFF", 100),
      row("FFF", null),
      // A new account with no basis leaves the combined position with none.
      row("GGG", 100),
    ],
    [
      row("AAA", null),
      row("BBB", 200),
      row("CCC", null),
      row("CASH", null),
      row("NEW", null),
      row("EEE", 100),
      row("EEE", null),
      row("FFF", null),
      row("FFF", null),
      row("GGG", 100),
      row("GGG", null),
    ],
  );
  assert.deepEqual(changes.losingBasis, ["AAA", "FFF", "GGG"]);
  // It is a warning only: the counts read as they did.
  assert.equal(changes.added, 1);
  assert.deepEqual(changes.removed, ["DDD"]);
  assert.equal(changes.before.get("AAA"), 5);
  assert.equal(changes.after.get("AAA"), 5);
});

void test("rows with no cost basis given lose nothing in the replace preview", () => {
  assert.deepEqual(
    holdingChanges(
      [{ ticker: "AAA", quantity: 1 }],
      [{ ticker: "AAA", quantity: 1 }],
    ).losingBasis,
    [],
  );
});

void test("a typo in a number box reads as no number, and real numbers still read", () => {
  for (const typo of [
    "2500 USD",
    "12O0",
    "(100)",
    "1.5k",
    "0x10",
    "Infinity",
    "1e999",
    "1.2.3",
    ".",
    "-",
    "$",
    "",
  ]) {
    assert.equal(parseOptionalNumber(typo), null, typo);
  }
  for (const [text, value] of [
    ["$1,200.50", 1200.5],
    [".5", 0.5],
    ["5.", 5],
    ["-1200", -1200],
    ["+3", 3],
    ["0", 0],
    [" 12 ", 12],
    // The form fills itself from the stored value, so it must read its own text back.
    [String(1e21), 1e21],
    [String(1e-7), 1e-7],
  ] as const) {
    assert.equal(parseOptionalNumber(text), value, text);
  }
});

void test("a typo in the cost basis blocks the save, while a blank still clears it on purpose", () => {
  const msft = { name: "Microsoft", quantity: 10, costBasis: 2000 };
  const text = (costBasis: string, quantity = "10") => ({
    ticker: "MSFT",
    name: "Microsoft",
    quantity,
    costBasis,
  });

  const typo = holdingFormState(text("2500 USD"), msft);
  assert.equal(typo.canSave, false);
  assert.equal(typo.dirty, true);
  assert.equal(typo.problem, "Enter the total cost basis as a plain number.");

  const blank = holdingFormState(text(""), msft);
  assert.equal(blank.canSave, true);
  assert.equal(blank.dirty, true);
  assert.equal(blank.costBasis, null);
  assert.equal(blank.problem, null);

  const money = holdingFormState(text("$1,200.50"), msft);
  assert.equal(money.canSave, true);
  assert.equal(money.costBasis, 1200.5);

  assert.equal(holdingFormState(text("2000"), msft).dirty, false);
  // No number equals no basis, so without this the typo hides Save and the row looks clean.
  assert.equal(
    holdingFormState(text("abc"), { ...msft, costBasis: null }).dirty,
    true,
  );
});

void test("a quantity that is not a number says why Save is off, except in a form not yet filled in", () => {
  const msft = { name: "Microsoft", quantity: 10, costBasis: 2000 };
  const text = (quantity: string, ticker = "MSFT") => ({
    ticker,
    name: "Microsoft",
    quantity,
    costBasis: "2000",
  });
  for (const quantity of ["10 shares", ""]) {
    const row = holdingFormState(text(quantity), msft);
    assert.equal(row.canSave, false);
    assert.equal(row.problem, "Enter the quantity as a plain number.");
  }
  const added = holdingFormState(text("10 shares"));
  assert.equal(added.canSave, false);
  assert.equal(added.problem, "Enter the quantity as a plain number.");

  const empty = holdingFormState(text("", ""));
  assert.equal(empty.canSave, false);
  assert.equal(empty.problem, null);
});

void test("a row takes new numbers when the stored holding moved, and keeps my typing when it did not", () => {
  const before = { name: "Apple", quantity: 100, costBasis: 15000 };
  assert.deepEqual(
    rowTextAfterChange(before, { ...before, quantity: 150, costBasis: 20000 }),
    { name: "Apple", quantity: "150", costBasis: "20000" },
  );
  assert.deepEqual(rowTextAfterChange(before, { ...before, costBasis: null }), {
    name: "Apple",
    quantity: "100",
    costBasis: "",
  });
  assert.deepEqual(
    rowTextAfterChange(before, { ...before, name: "Apple Inc" }),
    {
      name: "Apple Inc",
      quantity: "100",
      costBasis: "15000",
    },
  );
  // A refetch of the same numbers has nothing to say to a row I am typing in.
  assert.equal(rowTextAfterChange(before, { ...before }), null);
  // The add form has no stored row to follow.
  assert.equal(rowTextAfterChange(undefined, undefined), null);
});

const parsedRows = (...rows: string[]) => ({ rows, notes: ["from the file"] });

void test("a failed parse takes the old preview away, so Replace cannot send a file it is not showing", async () => {
  const shown: unknown[] = [];
  const load = previewLoader(
    (csv: string) =>
      csv === "unreadable"
        ? Promise.reject(new Error("Failed to fetch"))
        : Promise.resolve(parsedRows(csv)),
    (preview) => shown.push(preview),
  );
  await load("text a", "a.csv");
  assert.deepEqual(shown.at(-1), {
    rows: ["text a"],
    notes: ["from the file"],
    csv: "text a",
    fileName: "a.csv",
  });
  await assert.rejects(load("unreadable", "b.csv"), /Failed to fetch/);
  assert.equal(shown.at(-1), null);
  await load("text b", "b.csv");
  assert.deepEqual(shown.at(-1), {
    rows: ["text b"],
    notes: ["from the file"],
    csv: "text b",
    fileName: "b.csv",
  });
});

void test("an earlier file that finishes last cannot take over the later file's preview", async () => {
  const pending = new Map<
    string,
    {
      resolve: (v: ReturnType<typeof parsedRows>) => void;
      reject: (e: Error) => void;
    }
  >();
  const shown: { csv: string; fileName: string; rows: string[] }[] = [];
  const load = previewLoader(
    (csv: string) =>
      new Promise<ReturnType<typeof parsedRows>>((resolve, reject) => {
        pending.set(csv, { resolve, reject });
      }),
    (preview) => {
      if (preview) shown.push(preview);
    },
  );

  const a = load("text a", "a.csv");
  const b = load("text b", "b.csv");
  pending.get("text b")?.resolve(parsedRows("B"));
  await b;
  pending.get("text a")?.resolve(parsedRows("A"));
  await a;
  assert.equal(shown.length, 1);
  assert.deepEqual(
    [shown[0]?.rows, shown[0]?.csv, shown[0]?.fileName],
    [["B"], "text b", "b.csv"],
  );

  // A late failure of the older file has nothing to report either.
  const c = load("text c", "c.csv");
  const d = load("text d", "d.csv");
  pending.get("text d")?.resolve(parsedRows("D"));
  await d;
  pending.get("text c")?.reject(new Error("Failed to fetch"));
  await c;
  assert.equal(shown.at(-1)?.fileName, "d.csv");
});

void test("notes from reading screenshots stay with that preview and do not follow the next file", async () => {
  const shown: ({ notes: string[] } | null)[] = [];
  const load = previewLoader(
    (csv: string) => Promise.resolve(parsedRows(csv)),
    (preview) => shown.push(preview),
  );
  await load("read", "screens.csv", ["Check AAPL's quantity."]);
  assert.deepEqual(shown.at(-1)?.notes, [
    "from the file",
    "Check AAPL's quantity.",
  ]);
  await load("text", "b.csv");
  assert.deepEqual(shown.at(-1)?.notes, ["from the file"]);
});

void test("the replace preview claims nothing until the current holdings have loaded", () => {
  const preview = { error: null, rows: [{ ticker: "TSLA", quantity: 1 }] };
  assert.equal(previewChanges(undefined, preview), null);
  assert.equal(
    previewSummary(null, false),
    "Loading your current holdings to compare.",
  );
  assert.equal(
    previewSummary(null, true),
    "Your current holdings could not be loaded, so what would change is unknown.",
  );

  // An empty portfolio has loaded, so it still gets counts and a working Replace.
  const fromEmpty = previewChanges([], preview);
  assert.equal(
    previewSummary(fromEmpty, false),
    "1 new, 0 with a new quantity, 0 removed, 0 unchanged.",
  );
  assert.deepEqual(
    previewChanges([{ ticker: "AAPL", quantity: 1 }], preview)?.removed,
    ["AAPL"],
  );

  assert.equal(previewChanges([], { error: "Unreadable.", rows: [] }), null);
  assert.equal(previewChanges([], null), null);
});

const importPage = readFileSync(
  path.join(import.meta.dirname, "../app/import/page.tsx"),
  "utf8",
);

void test("the holdings form says its cost basis is the position's total", () => {
  // A per-share figure typed here is taken as the total, which invents a huge gain.
  assert.match(importPage, />Total cost basis \(\$\)</);
  assert.match(importPage, /`Total cost basis of \$\{holding\.ticker\}`/);
  assert.match(importPage, /Total cost basis\s*<\/th>/);
  assert.doesNotMatch(
    importPage,
    />Cost basis \(\$\)<|`Cost basis of|>\s*Cost basis\s*</,
  );
});

void test("the money market hint on the form names the funds that count as cash", () => {
  assert.match(
    importPage.replace(/\s+/g, " "),
    /For cash and money market funds such as SWVXX, use ticker CASH/,
  );
});

void test("row counts read as English", () => {
  assert.equal(rowCount(0), "0 rows");
  assert.equal(rowCount(1), "1 row");
  assert.equal(rowCount(19), "19 rows");
});

void test("a new row is confirmed, and a second row for a ticker says the two combine", () => {
  assert.equal(addedMessage("NVDA", 0), "Added NVDA.");
  assert.match(
    addedMessage("AMZN", 1),
    /now has 2 rows, which count as one position/,
  );
  assert.match(addedMessage("AMZN", 1), /every row has a total cost basis/);
});

void test("the thesis tab says a full review is due only when it is", () => {
  const clock = "2026-11-05T19:32:10.730Z";
  assert.equal(reviewBasisNotice("Thesis", "Thesis", clock), null);
  // Reviews do not store break conditions, so a cleared clock is what tells of a change to them.
  assert.match(
    reviewBasisNotice("Thesis", "Thesis", null) ?? "",
    /full review, against your thesis and break conditions as they stand now/,
  );
  assert.match(
    reviewBasisNotice("New thesis", "Thesis", clock) ?? "",
    /ran before this version of your thesis/,
  );
  assert.equal(reviewBasisNotice(null, null, null), null);
  assert.equal(reviewBasisNotice("Thesis", "Thesis", undefined), null);
});

// The routes below import through the app's path alias, which Node cannot find by itself. The
// installed Node types predate this function.
const { registerHooks } = nodeModule as unknown as {
  registerHooks: (hooks: {
    resolve: (
      specifier: string,
      context: unknown,
      next: (specifier: string, context: unknown) => unknown,
    ) => unknown;
  }) => void;
};
registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith("~/")) return next(specifier, context);
    const base = path.join(import.meta.dirname, "..", specifier.slice(2));
    const file =
      [`${base}.ts`, `${base}.js`, path.join(base, "index.ts")].find(
        existsSync,
      ) ?? base;
    return next(pathToFileURL(file).href, context);
  },
});

const { holdingsRouter } = await import("./api/routers/holdings.ts");
const { dossiersRouter } = await import("./api/routers/dossiers.ts");
const { client, db } = await import("./db/index.ts");
await client.executeMultiple(
  "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
    "CREATE TABLE holdings (ticker TEXT, name TEXT, quantity REAL, cost_basis REAL, account_label TEXT, updated_at TEXT, PRIMARY KEY(ticker,account_label));" +
    "CREATE TABLE tickers (ticker TEXT PRIMARY KEY, cik TEXT, sector TEXT, industry TEXT, fmp_profile_json TEXT, last_full_review_at TEXT);",
);
const holdingRoutes = holdingsRouter.createCaller({ db });
const dossierRoutes = dossiersRouter.createCaller({ db });

void test("saving zero shares refuses the change and leaves the existing stock intact", async () => {
  await holdingRoutes.upsert({
    ticker: "ZEROTEST",
    quantity: 5,
    costBasis: 100,
  });
  await assert.rejects(
    holdingRoutes.upsert({ ticker: "ZEROTEST", quantity: 0, costBasis: 100 }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /nonzero.*shares/i);
      assert.equal((error as { code?: string }).code, "BAD_REQUEST");
      return true;
    },
  );
  assert.equal(
    (await holdingRoutes.list()).find((row) => row.ticker === "ZEROTEST")
      ?.quantity,
    5,
  );
  await holdingRoutes.delete({ ticker: "ZEROTEST" });
  await holdingRoutes.upsert({ ticker: "CASH", quantity: 0, costBasis: null });
  await holdingRoutes.upsert({ ticker: "SHRT", quantity: -2, costBasis: null });
  assert.equal(
    (await holdingRoutes.list()).find((row) => row.ticker === "CASH")?.quantity,
    0,
  );
  await holdingRoutes.delete({ ticker: "CASH" });
  await holdingRoutes.delete({ ticker: "SHRT" });
});

async function storedHoldings() {
  return (await holdingRoutes.list())
    .map(
      (h) =>
        `${h.ticker}|${h.accountLabel}|${h.quantity}|${h.costBasis ?? "none"}`,
    )
    .sort();
}

/** Routes write under data/ in the working directory, so they run in a throwaway one. */
async function inThrowawayFolder(work: () => Promise<void>) {
  const home = process.cwd();
  const temp = mkdtempSync(path.join(tmpdir(), "portchecker-positions-"));
  process.chdir(temp);
  try {
    await work();
  } finally {
    process.chdir(home);
    rmSync(temp, { recursive: true, force: true });
  }
}

void test("adding a ticker already listed in that account is refused and changes nothing", async () => {
  await client.execute("DELETE FROM holdings");
  const apple = {
    ticker: "AAPL",
    name: "Apple",
    quantity: 100,
    costBasis: 15000,
  };
  assert.deepEqual(await holdingRoutes.upsert({ ...apple, adding: true }), {
    ticker: "AAPL",
    otherRows: 0,
  });

  await assert.rejects(
    holdingRoutes.upsert({
      ticker: "aapl",
      quantity: 5,
      costBasis: null,
      adding: true,
    }),
    (e: Error & { code?: string }) =>
      e.code === "CONFLICT" &&
      e.message ===
        "AAPL is already listed. Change its row above, or give this one a different account.",
  );
  assert.deepEqual(await storedHoldings(), ["AAPL||100|15000"]);
  const { rows } = await client.execute("SELECT name FROM holdings");
  assert.equal(rows[0]?.name, "Apple");

  // Another account is a real second row, and the answer lets the form say so.
  assert.deepEqual(
    await holdingRoutes.upsert({
      ticker: "AAPL",
      accountLabel: "Roth",
      quantity: 3,
      costBasis: null,
      adding: true,
    }),
    { ticker: "AAPL", otherRows: 1 },
  );
  await assert.rejects(
    holdingRoutes.upsert({
      ticker: "AAPL",
      accountLabel: "Roth",
      quantity: 9,
      costBasis: null,
      adding: true,
    }),
    /AAPL is already listed in Roth\./,
  );

  // Saving a row is still an edit, and still replaces it.
  await holdingRoutes.upsert({ ...apple, quantity: 120, costBasis: 16000 });
  assert.deepEqual(await storedHoldings(), [
    "AAPL|Roth|3|none",
    "AAPL||120|16000",
  ]);

  // Adding cash again must not wipe the amount.
  await holdingRoutes.upsert({
    ticker: "CASH",
    quantity: 1000,
    costBasis: null,
    adding: true,
  });
  await assert.rejects(
    holdingRoutes.upsert({
      ticker: "CASH",
      quantity: 5,
      costBasis: null,
      adding: true,
    }),
    /CASH is already listed/,
  );
  assert.ok((await storedHoldings()).includes("CASH||1000|none"));
});

void test("a money market fund typed by hand is refused and pointed at CASH, as an import would count it", async () => {
  await client.execute("DELETE FROM holdings");
  for (const ticker of ["SWVXX", "swvxx", "SPAXX", "VMFXX"]) {
    for (const adding of [true, false]) {
      await assert.rejects(
        holdingRoutes.upsert({
          ticker,
          quantity: 3456.78,
          costBasis: null,
          adding,
        }),
        (e: Error & { code?: string }) =>
          e.code === "BAD_REQUEST" &&
          e.message ===
            `${ticker.toUpperCase()} is a money market fund, which counts as cash. Enter its dollar value under ticker CASH.`,
      );
    }
  }
  assert.deepEqual(await storedHoldings(), []);

  // Not a money market fund: CASH itself, and a real bond fund with a similar name.
  await holdingRoutes.upsert({ ticker: "CASH", quantity: 1, costBasis: null });
  await holdingRoutes.upsert({ ticker: "VCSH", quantity: 1, costBasis: null });
  assert.equal((await storedHoldings()).length, 2);

  // A row saved before this rule can still be removed.
  await client.execute(
    "INSERT INTO holdings VALUES ('SPAXX', '', 5, NULL, '', 'then')",
  );
  await holdingRoutes.delete({ ticker: "SPAXX" });
  assert.ok(!(await storedHoldings()).some((r) => r.startsWith("SPAXX")));

  // The route and an import agree on what counts as one.
  assert.equal(
    parsePositionsCsv(
      "Symbol,Description,Quantity,Price,Market Value,Cost Basis\nSWVXX,Schwab fund,3456.78,1,3456.78,--",
    ).rows[0]?.ticker,
    "CASH",
  );
});

void test("a screenshot pick over the limit gets one plain sentence, and the route holds the same limit", async () => {
  assert.equal(MAX_SCREENSHOTS, 12);
  assert.equal(screenshotPickProblem(MAX_SCREENSHOTS), null);
  assert.equal(screenshotPickProblem(1), null);
  assert.equal(
    screenshotPickProblem(MAX_SCREENSHOTS + 1),
    "Choose at most 12 images at a time.",
  );
  assert.match(importPage, /accept="\.png,\.jpg,\.jpeg,\.webp"/);

  await inThrowawayFolder(async () => {
    const images = Array.from({ length: MAX_SCREENSHOTS + 1 }, (_, i) => ({
      name: `${i}.png`,
      dataUrl: "data:image/png;base64,AAAA",
    }));
    await assert.rejects(
      holdingRoutes.parseScreenshots({ images }),
      (e: Error & { code?: string }) => e.code === "BAD_REQUEST",
    );
    // Refused before it wrote the images or reached a model.
    assert.equal(existsSync(path.join("data", "imports")), false);
  });
});

void test("a screenshot upload that is not an image file is refused before anything is written", async () => {
  // The helper is checked first: without it this test stops here and never reaches the route.
  for (const [name, ext] of [
    ["screen.png", ".png"],
    ["Screen Shot.JPG", ".jpg"],
    ["a.b.jpeg", ".jpeg"],
    ["x.webp", ".webp"],
    ["pasted image", ".png"],
    ["folder.d/pasted", ".png"],
    ["positions.exe", null],
    ["page.html", null],
    ["shot.png:stream", null],
    ["shot.png.js", null],
    ["shot.", null],
  ] as const) {
    assert.equal(screenshotExtension(name), ext, name);
  }
  await inThrowawayFolder(async () => {
    for (const name of ["positions.exe", "page.html", "shot.png:stream"]) {
      await assert.rejects(
        holdingRoutes.parseScreenshots({
          images: [{ name, dataUrl: "data:image/png;base64,AAAA" }],
        }),
        (e: Error & { code?: string }) => e.code === "BAD_REQUEST",
        name,
      );
    }
    // Refused before it wrote the images or reached a model.
    assert.equal(existsSync(path.join("data", "imports")), false);
  });
});

void test("the screenshot preview says when the other provider read the images", () => {
  assert.deepEqual(screenshotFallbackNotes(false, "claude"), []);
  assert.deepEqual(screenshotFallbackNotes(true, "claude"), [
    'Claude read these images, because the selected provider failed and "If one fails, use the other" is on in Settings.',
  ]);
  assert.match(screenshotFallbackNotes(true, "chatgpt")[0]!, /^ChatGPT read/);
  // The route adds it to the notes the preview already lists.
  assert.match(
    readFileSync(new URL("./api/routers/holdings.ts", import.meta.url), "utf8"),
    /\.\.\.screenshotFallbackNotes\(result\.usedFallback, result\.provider\)/,
  );
});

void test("changing the break conditions asks for a full review, and other edits do not", async () => {
  await inThrowawayFolder(async () => {
    const clock = "2026-11-05T19:32:10.730Z";
    const current = async () =>
      (await client.execute("SELECT last_full_review_at AS at FROM tickers"))
        .rows[0]?.at ?? null;
    const startClock = () =>
      client.execute({
        sql: "UPDATE tickers SET last_full_review_at = ?",
        args: [clock],
      });
    await client.execute("DELETE FROM tickers");
    await client.execute("INSERT INTO tickers (ticker) VALUES ('AAA')");

    const start = replaceSection(
      replaceSection(
        dossierTemplate("AAA", "Example"),
        "Thesis",
        "Margins keep rising.",
      ),
      "What would break the thesis",
      "- Margin below 10%.",
    );
    await dossierRoutes.save({ ticker: "AAA", markdown: start });
    await startClock();

    for (const free of [
      replaceSection(start, "Key numbers to watch", "- Margin 31%."),
      replaceSection(start, "Watch items", "- The next 10-Q."),
      `${start}\nA note at the end.\n`,
      start.replace(/\n/g, "\r\n"),
      replaceSection(
        start,
        "What would break the thesis",
        "\n\n- Margin below 10%.\n\n",
      ),
    ]) {
      await dossierRoutes.save({ ticker: "AAA", markdown: free });
      assert.equal(await current(), clock, free);
    }

    await dossierRoutes.save({ ticker: "AAA", markdown: start });
    await startClock();
    await dossierRoutes.save({
      ticker: "AAA",
      markdown: replaceSection(
        start,
        "What would break the thesis",
        "- Margin below 20%.",
      ),
    });
    assert.equal(await current(), null);

    await startClock();
    await dossierRoutes.save({
      ticker: "AAA",
      markdown: replaceSection(start, "Thesis", "Margins hold steady."),
    });
    assert.equal(await current(), null);
  });
});

void test("portfolio: loading facts uses stored holdings, newest cached prices, fund sectors and earnings offline", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 5, 12) });
  const offline = t.mock.method(globalThis, "fetch", () => {
    throw new Error("Portfolio facts must use the cache");
  });
  await client.executeMultiple(
    "CREATE TABLE IF NOT EXISTS fmp_cache (ticker TEXT, endpoint TEXT, fetched_on TEXT, payload_json TEXT, PRIMARY KEY(ticker,endpoint,fetched_on));" +
      "DELETE FROM holdings; DELETE FROM tickers; DELETE FROM fmp_cache;",
  );
  assert.equal((await loadPortfolioFacts()).holdings_updated_at, null);
  for (const [ticker, quantity, basis, account, updated] of [
    ["AAA", 2, 100, "IRA", "2026-11-04T10:00:00Z"],
    ["AAA", 1, 50, "Brokerage", "2026-11-05T10:00:00Z"],
    ["FUND", 1, null, "", "2026-11-05T10:00:00Z"],
    ["CASH", 100, null, "", "2026-11-05T10:00:00Z"],
  ] as const) {
    await client.execute({
      sql: "INSERT INTO holdings VALUES (?, ?, ?, ?, ?, ?)",
      args: [ticker, ticker, quantity, basis, account, updated],
    });
  }
  await client.execute(
    "INSERT INTO tickers (ticker, sector) VALUES ('AAA', 'Technology'), ('FUND', 'Financial Services')",
  );
  for (const [ticker, endpoint, fetched, payload] of [
    ["AAA", "quote", "2026-11-04", [{ price: 999, change: 900 }]],
    [
      "AAA",
      "quote",
      "2026-11-05",
      [{ price: 100, change: 5, changePercentage: 5.26 }],
    ],
    [
      "FUND",
      "quote",
      "2026-11-05",
      [{ price: 100, change: 0, changePercentage: 0 }],
    ],
    [
      "FUND",
      "etf/sector-weightings",
      "2026-11-05",
      [{ sector: "Energy", weightPercentage: 100 }],
    ],
    [
      "AAA",
      "earnings",
      "2026-11-05",
      [
        { date: "2026-11-04" },
        { date: "2026-11-06", epsEstimated: 2, revenueEstimated: 1000 },
      ],
    ],
    ["UNHELD", "earnings", "2026-11-05", [{ date: "2026-11-05" }]],
  ] as const) {
    await client.execute({
      sql: "INSERT INTO fmp_cache VALUES (?, ?, ?, ?)",
      args: [ticker, endpoint, fetched, JSON.stringify(payload)],
    });
  }
  const facts = await loadPortfolioFacts();
  assert.equal(facts.as_of, "2026-11-05");
  assert.equal(facts.holdings_updated_at, "2026-11-04T10:00:00Z");
  assert.equal(facts.total_value, 500);
  assert.equal(facts.cash_pct, 20);
  assert.equal(facts.day_change_value, 15);
  assert.equal(facts.day_change_pct, 3.09);
  assert.deepEqual(facts.sector_weights, [
    { sector: "Technology", weight_pct: 60 },
    { sector: "Energy", weight_pct: 20 },
    { sector: "Cash", weight_pct: 20 },
  ]);
  assert.deepEqual(facts.upcoming_earnings, [
    {
      ticker: "AAA",
      date: "2026-11-06",
      eps_estimated: 2,
      revenue_estimated: 1000,
    },
  ]);
  const position = facts.positions.find((p) => p.ticker === "AAA");
  assert.deepEqual(
    [
      position?.quantity,
      position?.cost_basis,
      position?.unrealized_gain,
      position?.quote_date,
    ],
    [3, 150, 150, "2026-11-05"],
  );
  assert.equal(offline.mock.callCount(), 0);
});
