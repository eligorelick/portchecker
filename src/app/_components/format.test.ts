import "../../server/test-env.ts";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import type { HoldingRow } from "./holdings-table";
import * as format from "./format.ts";
import { holdingHasFlags } from "../../server/queue.ts";

void test("money and percentages retain signs, rounding, zero and missing amounts", () => {
  assert.equal(format.usd(1234.5), "$1,234.50");
  assert.equal(format.usd(-1234.5, 0), "-$1,235");
  assert.equal(format.usd(0), "$0.00");
  assert.equal(format.usd(1.2, 3), "$1.200");
  for (const missing of [null, undefined]) {
    assert.equal(format.usd(missing), "—");
    assert.equal(format.signedUsd(missing), "—");
    assert.equal(format.pct(missing), "—");
    assert.equal(format.signedPct(missing), "—");
  }
  assert.equal(format.signedUsd(850), "+$850");
  assert.equal(format.signedUsd(-850), "−$850");
  assert.equal(format.signedUsd(-850.25, 2), "−$850.25");
  assert.equal(format.signedUsd(0), "$0");
  assert.equal(format.pct(12.34), "12.3%");
  assert.equal(format.pct(-12.345, 2), "-12.35%");
  assert.equal(format.pct(0), "0.0%");
  assert.equal(format.signedPct(1.234), "+1.23%");
  assert.equal(format.signedPct(-1.234), "−1.23%");
  assert.equal(format.signedPct(0), "0.00%");
});

void test("a positive move is green, a negative move red and zero or missing neutral", () => {
  assert.equal(format.moveColor(1), "text-ok");
  assert.equal(format.moveColor(-1), "text-bad");
  for (const neutral of [0, null, undefined]) {
    assert.equal(format.moveColor(neutral), "text-muted");
  }
});

void test("bare dates keep their calendar day and day counts across daylight saving", (t) => {
  const previous = process.env.TZ;
  t.after(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });
  for (const zone of ["America/Los_Angeles", "UTC", "Asia/Tokyo"]) {
    process.env.TZ = zone;
    assert.equal(format.shortDate("2026-11-04"), "Nov 4", zone);
    assert.equal(format.longDate("2026-11-04"), "Wednesday, November 4", zone);
    assert.equal(format.daysBetween("2026-10-31", "2026-11-02"), 2, zone);
    assert.equal(format.daysBetween("2026-03-07", "2026-03-09"), 2, zone);
    assert.equal(format.daysBetween("2026-11-04", "2026-11-04"), 0, zone);
    assert.equal(format.daysBetween("2026-11-09", "2026-11-04"), -5, zone);
    assert.equal(
      format.dayWithYear("2025-12-31", "2026-11-05"),
      "Dec 31, 2025",
      zone,
    );
    assert.equal(format.dayWithYear("2026-11-04", "2026-11-05"), "Nov 4", zone);
  }
  for (const invalid of [
    "",
    "pending",
    "2026-02-30",
    "2026-13-01",
    "2026-2-01",
  ]) {
    assert.equal(format.shortDate(invalid), "no date", invalid);
  }
  assert.equal(format.inDays(0), "today");
  assert.equal(format.inDays(1), "tomorrow");
  assert.equal(format.inDays(5), "in 5 days");
});

void test("session labels use a fixed local clock and retain the year for older dates", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 5, 12) });
  assert.equal(format.dayMoveWhen("2026-11-05"), "today");
  assert.equal(format.dayMoveWhen("2026-11-04"), "on Nov 4");
  assert.equal(format.dayMoveWhen("2025-11-04"), "on Nov 4, 2025");
  assert.equal(format.dayMoveWhen(null), "last session");
  assert.equal(format.dayMoveWhen("2026-02-30"), "last session");
  assert.equal(
    format.dayMoveLabel({
      newest: "2026-11-05",
      oldest: "2026-11-05",
      stale: [],
    }),
    "Today",
  );
  assert.equal(
    format.dayMoveLabel({
      newest: "2026-11-04",
      oldest: "2026-11-04",
      stale: [],
    }),
    "Last session (Nov 4)",
  );
});

void test("holdings date labels show the local range and collapse updates on one day", () => {
  const stamp = (day: number, hour = 12) =>
    new Date(2026, 10, day, hour).toISOString();
  assert.equal(
    format.holdingsUpdatedLabel(stamp(4), stamp(5), "2026-11-05"),
    "Holdings updated Nov 4 to Nov 5",
  );
  assert.equal(
    format.holdingsUpdatedLabel(stamp(5, 9), stamp(5, 15), "2026-11-05"),
    "Holdings updated Nov 5",
  );
  assert.equal(
    format.holdingsUpdatedLabel("2025-12-31", "2026-01-01", "2026-11-05"),
    "Holdings updated Dec 31, 2025 to Jan 1",
  );
  assert.equal(
    format.holdingsUpdatedLabel(stamp(4), null, "2026-11-05"),
    "Holdings updated Nov 4",
  );
  assert.equal(format.holdingsUpdatedLabel(null, null), null);
});

void test("saved text only warns when holdings changed after it was written", () => {
  const before = new Date(2026, 10, 5, 8).toISOString();
  const written = new Date(2026, 10, 5, 12).toISOString();
  const after = new Date(2026, 10, 5, 18).toISOString();
  for (const kind of ["brief", "review"] as const) {
    const note = format.holdingsChangedNote(kind, after, written);
    assert.match(
      note!,
      new RegExp(
        `Written before your holdings changed on .+, so position sizes and cash in this ${kind} are from then\\.`,
      ),
    );
    assert.equal(format.holdingsChangedNote(kind, before, written), null);
    assert.equal(format.holdingsChangedNote(kind, written, written), null);
    assert.equal(
      format.holdingsChangedNote(
        kind,
        "2026-11-05T19:00:00+01:00",
        "2026-11-05T18:00:00Z",
      ),
      null,
    );
    assert.equal(format.holdingsChangedNote(kind, after, "2026-11-05"), null);
    assert.equal(format.holdingsChangedNote(kind, "2026-11-05", written), null);
    assert.ok(format.holdingsChangedNote(kind, "2026-11-06", written));
    assert.ok(
      format.holdingsChangedNote(kind, "2026-11-06", null, "2026-11-05"),
    );
    assert.equal(
      format.holdingsChangedNote(kind, after, null, "2026-11-05"),
      null,
    );
    for (const missing of [
      null,
      undefined,
      "",
      "invalid",
      "2026-02-30",
      "2026-02-30T12:00:00Z",
    ]) {
      assert.equal(format.holdingsChangedNote(kind, missing, written), null);
      assert.equal(format.holdingsChangedNote(kind, after, missing), null);
    }
  }
});

type Element = { type: unknown; props: Record<string, unknown>; key?: string };

// Node cannot execute TSX. Compile the actual table and supply hooks and JSX without a browser;
// all filtering, column readers, sorting and header callbacks still come from the component.
const tableCode = ts.transpileModule(
  readFileSync(new URL("./holdings-table.tsx", import.meta.url), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

function tableHarness(rows: HoldingRow[]) {
  let filter = "all";
  let sort = { key: "weight", descending: true };
  const exports = {} as {
    HoldingsTable: (props: { rows: HoldingRow[] }) => Element;
  };
  const jsx = (
    type: unknown,
    props: Record<string, unknown>,
    key?: string,
  ): Element => ({ type, props, key });
  const modules: Record<string, unknown> = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: {
      useMemo: (read: () => unknown) => read(),
      useState: (initial: unknown) =>
        typeof initial === "string"
          ? [
              filter,
              (next: string) => {
                filter = next;
              },
            ]
          : [
              sort,
              (next: (current: typeof sort) => typeof sort) => {
                sort = next(sort);
              },
            ],
    },
    "next/link": { default: "a" },
    "next/navigation": { useRouter: () => ({ push: () => undefined }) },
    "~/server/queue": { holdingHasFlags },
    "./format": format,
    "./badges": {
      ActionBadge: "action",
      AgreeBadge: "agreement",
      ProofStrip: "proof",
      StatusBadge: "status",
      words: (value: string) => value,
    },
  };
  runInNewContext(tableCode, {
    exports,
    require: (name: string) => {
      assert.ok(name in modules, `Unexpected table dependency: ${name}`);
      return modules[name];
    },
  });
  const elements = (value: unknown): Element[] => {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    const element = value as Element;
    return [element, ...elements(element.props.children)];
  };
  const render = () => elements(exports.HoldingsTable({ rows }));
  return {
    order: () => {
      const result: string[] = [];
      for (const element of render()) {
        if (element.type === "tr" && element.key) result.push(element.key);
      }
      return result;
    },
    click: (key: string) => {
      const header = render().find((element) => element.props.id === key);
      assert.ok(header, `Missing sort header: ${key}`);
      (header.props.onSort as (key: string) => void)(key);
    },
  };
}

const tableRow = (ticker: string, value: number | null): HoldingRow => ({
  ticker,
  name: ticker,
  isCash: false,
  weight: value,
  price: value,
  value,
  dayPct: value,
  quoteOn: null,
  action: null,
  status: null,
  checks: null,
  verifiedScore: value,
  opinion: null,
  rejected: false,
  secondAction: null,
  headline: null,
  reviewedOn: null,
  hasThesis: true,
});

void test("every numeric column sorts numerically in both directions and keeps missing values last", () => {
  const amounts = [
    tableRow("TWO", 2),
    tableRow("MISSING", null),
    tableRow("TEN", 10),
    tableRow("ALSO-MISSING", null),
    tableRow("ONE", 1),
    tableRow("NEGATIVE", -2),
    tableRow("ZERO", 0),
  ];
  for (const [key, field] of [
    ["weight", "weight"],
    ["value", "value"],
    ["price", "price"],
    ["day", "dayPct"],
    ["verified", "verifiedScore"],
  ] as const) {
    // Other columns have a different order, so reading the wrong column cannot pass.
    const rows = amounts.map((row, i) => ({
      ...row,
      weight: i + 100,
      value: i + 1000,
      price: i + 2000,
      dayPct: i + 3000,
      verifiedScore: i + 4000,
      [field]: row.value,
    }));
    const table = tableHarness(rows);
    if (key !== "weight") table.click(key);
    assert.deepEqual(
      table.order(),
      ["TEN", "TWO", "ONE", "ZERO", "NEGATIVE", "MISSING", "ALSO-MISSING"],
      key,
    );
    table.click(key);
    assert.deepEqual(
      table.order(),
      ["NEGATIVE", "ZERO", "ONE", "TWO", "TEN", "MISSING", "ALSO-MISSING"],
      key,
    );
    assert.deepEqual(
      rows.map((row) => row.ticker),
      ["TWO", "MISSING", "TEN", "ALSO-MISSING", "ONE", "NEGATIVE", "ZERO"],
    );
  }
});

void test("ticker sorting compares names, starts alphabetically and toggles direction", () => {
  const table = tableHarness([
    tableRow("Z", 1),
    tableRow("B", 2),
    tableRow("A", 3),
  ]);
  table.click("ticker");
  assert.deepEqual(table.order(), ["A", "B", "Z"]);
  table.click("ticker");
  assert.deepEqual(table.order(), ["Z", "B", "A"]);
});

void test("suggestions sort by consequence and cash stays last for price and day move", () => {
  const suggestions = ["hold", "add", "review", "trim", "sell", null];
  const table = tableHarness(
    suggestions.map((action, i) => ({ ...tableRow(`T${i}`, i), action })),
  );
  table.click("action");
  assert.deepEqual(table.order(), ["T4", "T3", "T2", "T1", "T0", "T5"]);
  table.click("action");
  assert.deepEqual(table.order(), ["T0", "T1", "T2", "T3", "T4", "T5"]);
  for (const key of ["price", "day"]) {
    const cash = tableHarness([
      { ...tableRow("CASH", 999), isCash: true },
      tableRow("AAA", 2),
      tableRow("BBB", 10),
    ]);
    cash.click(key);
    assert.deepEqual(cash.order(), ["BBB", "AAA", "CASH"]);
    cash.click(key);
    assert.deepEqual(cash.order(), ["AAA", "BBB", "CASH"]);
  }
});
