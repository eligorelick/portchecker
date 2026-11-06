import "./test-env.ts";

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, mock, test } from "node:test";

import type { Filing } from "./edgar.ts";
import type { FmpData } from "./fmp.ts";

process.env.SEC_USER_AGENT = "Portchecker test contact";
process.env.FMP_API_KEY = "test-key";

const { client, db } = await import("./db/index.ts");
const { filings, tickers } = await import("./db/schema.ts");
const {
  resolveCik,
  syncFilings,
  extractSections,
  compactDiff,
  ensureSections,
  eventExcerpt,
  filingSummary,
} = await import("./edgar.ts");
const {
  writePack,
  vendorFilingGaps,
  ensureTicker,
  buildResearchContext,
  latestFullPackDir,
  replacePackFolder,
  keyNumbers,
  dataWarnings,
} = await import("./research/pack.ts");

await client.executeMultiple(
  "CREATE TABLE filings(accession_no TEXT,ticker TEXT,form TEXT,filed_at TEXT,primary_doc_url TEXT,items TEXT,sections_json TEXT,processed_at TEXT,PRIMARY KEY(accession_no,ticker));" +
    "CREATE TABLE fmp_cache(ticker TEXT,endpoint TEXT,fetched_on TEXT,payload_json TEXT,PRIMARY KEY(ticker,endpoint,fetched_on));" +
    "CREATE TABLE tickers(ticker TEXT PRIMARY KEY,cik TEXT,sector TEXT,industry TEXT,fmp_profile_json TEXT,last_full_review_at TEXT);",
);
const originalFetch = globalThis.fetch;
beforeEach(async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 5, 12) });
  globalThis.fetch = async () => {
    throw new Error("Unexpected network call");
  };
  await client.executeMultiple(
    "DELETE FROM filings; DELETE FROM fmp_cache; DELETE FROM tickers;",
  );
});
afterEach(() => {
  mock.timers.reset();
  globalThis.fetch = originalFetch;
});
after(() => client.close());

const FOLDER = "/Archives/edgar/data/1/000000000126000001/";
const BASE = `https://www.sec.gov${FOLDER}`;

function filing(overrides: Partial<Filing> = {}): Filing {
  return {
    accessionNo: "0000000001-26-000001",
    ticker: "TEST",
    form: "8-K",
    filedAt: "2026-11-04",
    primaryDocUrl: `${BASE}cover.htm`,
    items: "",
    sectionsJson: null,
    processedAt: null,
    ...overrides,
  };
}
function stubSec(pages: Record<string, string>) {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    const page = pages[String(url)];
    return page === undefined
      ? new Response("not found", { status: 404 })
      : new Response(page);
  }) as typeof fetch;
  return urls;
}
const reportDoc = (risk: string, mda: string) =>
  `<p>Item 1A. Risk Factors</p><p>${risk}</p><p>Item 2. Unregistered Sales</p><p>Item 2. Management's Discussion and Analysis</p><p>${mda} ${"Discussion of results here. ".repeat(10)}</p><p>Item 3. Quantitative disclosures</p>`;

const fixture: FmpData = {
  isFund: false,
  quote: null,
  profile: null,
  income: [],
  balance: [],
  cashFlow: [],
  keyMetrics: [],
  keyMetricsTtm: null,
  ratios: [],
  ratiosTtm: null,
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
};

async function inPackFolder(work: () => void | Promise<void>) {
  const temp = mkdtempSync(path.join(tmpdir(), "portchecker-pack-"));
  const start = process.cwd();
  process.chdir(temp);
  try {
    mkdirSync(path.join("data", "dossiers"), { recursive: true });
    writeFileSync(path.join("data", "dossiers", "TEST.md"), "# TEST");
    await work();
  } finally {
    process.chdir(start);
    rmSync(temp, { recursive: true, force: true });
  }
}
const packOf = (dir: string) =>
  JSON.parse(readFileSync(path.join(dir, "pack.json"), "utf8")) as {
    price_summary: {
      total_return_1y_pct: number | null;
      distribution_yield_1y_pct: number | null;
    };
    earnings_history: { date: string }[];
    data_notes: string[];
    previous_position: {
      position: { quantity: number; weight_pct: number };
      snapshot_date: string;
      run_id: number | null;
      source: string;
      source_sha256: string;
    } | null;
    my_position: { quantity: number };
  };

function put(folder: string, name: string, text = "x") {
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, name), text);
}

void test("web research and filings each preserve a full pack beside a light pack", async () => {
  await inPackFolder(() => {
    for (const evidence of [
      "web_research.md",
      "filing_sections_10-Q.md",
      "new_8k_event.md",
    ]) {
      const dir = path.join("data", "packs", "2026-11-04", "TEST");
      put(dir, "pack.json", "{}");
      put(dir, evidence);
      assert.equal(latestFullPackDir("TEST"), dir);
      replacePackFolder(dir, false);
      assert.ok(existsSync(path.join(`${dir}.full`, evidence)));
      rmSync(`${dir}.full`, { recursive: true });
    }
    put(path.join("data", "packs", "2026-11-04", "TEST"), "pack.json", "{}");
    assert.equal(latestFullPackDir("TEST"), null);
  });
});

void test("moving a full pack aside replaces the older saved full pack", async () => {
  await inPackFolder(() => {
    const dir = path.join("data", "packs", "2026-11-04", "TEST");
    put(`${dir}.full`, "web_research.md", "older");
    put(dir, "web_research.md", "newer");
    replacePackFolder(dir, false);
    assert.equal(
      readFileSync(path.join(`${dir}.full`, "web_research.md"), "utf8"),
      "newer",
    );
    assert.equal(existsSync(dir), false);
  });
});

void test("the crash sweep removes only old context folders", async () => {
  await inPackFolder(() => {
    const root = path.join("data", "packs");
    const dated = path.join(root, "2020-01-01", "TEST");
    const old = path.join(root, "_context-TEST-old");
    const fresh = path.join(root, "_context-TEST-fresh");
    put(dated, "pack.json", "{}");
    put(old, "pack.json");
    put(fresh, "pack.json");
    const hoursAgo = (hours: number) =>
      new Date(Date.now() - hours * 3_600_000);
    utimesSync(old, hoursAgo(2), hoursAgo(2));
    utimesSync(fresh, hoursAgo(0.25), hoursAgo(0.25));
    utimesSync(path.dirname(dated), hoursAgo(9000), hoursAgo(9000));
    const made = buildResearchContext("TEST");
    assert.ok(made);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true, "a running Ask keeps its folder");
    assert.equal(readFileSync(path.join(dated, "pack.json"), "utf8"), "{}");
    assert.equal(readFileSync(path.join(made, "pack.json"), "utf8"), "{}");
  });
});

void test("debt on a lagging statement keeps that statement's currency", () => {
  const rows = keyNumbers({
    income_statement_quarterly: [
      {
        date: "2026-09-30",
        period: "Q3",
        fiscalYear: "2026",
        reportedCurrency: "USD",
        revenue: 1,
      },
    ],
    balance_sheet_quarterly: [
      {
        date: "2026-06-30",
        period: "Q2",
        fiscalYear: "2026",
        reportedCurrency: "EUR",
        totalDebt: 5_000_000,
        cashAndCashEquivalents: 2_000_000,
      },
    ],
  }).flatMap((g) => g.rows);
  assert.deepEqual(
    rows.find(([label]) => label.startsWith("Total debt")),
    ["Total debt, Q2 2026", "EUR 5M"],
  );
  assert.deepEqual(
    rows.find(([label]) => label.startsWith("Cash and")),
    ["Cash and equivalents, Q2 2026", "EUR 2M"],
  );
});

void test("the former standing quote note is hidden while a specific warning stays", () => {
  assert.deepEqual(
    dataWarnings([
      "quote is as of when the job ran and may be intraday.",
      "The quote is old.",
    ]),
    ["The quote is old."],
  );
});

void test("failed new reports stay unread and failed history reports warn separately", async () => {
  await inPackFolder(async () => {
    const pending = filing({ accessionNo: "pending", form: "10-Q" });
    const history = filing({
      accessionNo: "history",
      form: "10-K",
      processedAt: "done",
    });
    const delivered = filing({
      accessionNo: "delivered",
      form: "8-K",
      items: "5.02",
      primaryDocUrl: `${BASE}readable.htm`,
    });
    const formFour = filing({ accessionNo: "insider", form: "4" });
    await db.insert(filings).values([pending, history, delivered, formFour]);
    stubSec({ [`${BASE}readable.htm`]: "A new director was appointed." });
    const result = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: fixture,
      includeFilings: true,
      newFilings: [pending, delivered, formFour],
    });
    assert.deepEqual([...result.unread], ["pending"]);
    const notes = packOf(result.dir).data_notes;
    assert.equal(
      notes.filter((note) => note.includes("edgar:pending")).length,
      1,
    );
    assert.ok(
      notes.some(
        (note) =>
          note.includes("The new 10-Q") && note.includes("edgar:pending"),
      ),
    );
    assert.ok(
      notes.some(
        (note) =>
          note.includes("edgar:history") &&
          note.includes("could not be read on this run"),
      ),
    );
    assert.ok(
      !notes.some(
        (note) =>
          note.includes("edgar:delivered") || note.includes("edgar:insider"),
      ),
    );
  });
});

void test("a failed sole quarterly report is not fetched again for nonexistent interim history", async () => {
  await inPackFolder(async () => {
    const report = filing({ form: "10-Q" });
    await db.insert(filings).values(report);
    const urls = stubSec({});
    const result = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: fixture,
      includeFilings: true,
      newFilings: [report],
    });
    assert.deepEqual([...result.unread], [report.accessionNo]);
    assert.deepEqual(urls, [report.primaryDocUrl]);
  });
});

void test("pack: dividends the plan refused give no total return, and a confirmed empty list does", async () => {
  await inPackFolder(async () => {
    const history = [
      { date: "2026-11-04", price: 110 },
      { date: "2025-11-04", price: 100 },
    ];
    const refused = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: {
        ...fixture,
        history,
        dividends: [],
        dividendsCoverageConfirmed: false,
      },
      includeFilings: false,
    });
    const summary = packOf(refused.dir).price_summary;
    assert.equal(summary.total_return_1y_pct, null);
    assert.equal(summary.distribution_yield_1y_pct, null);
    const confirmed = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: {
        ...fixture,
        history,
        dividends: [],
        dividendsCoverageConfirmed: true,
      },
      includeFilings: false,
    });
    assert.equal(packOf(confirmed.dir).price_summary.total_return_1y_pct, 10);
  });
});

void test("pack: earnings history holds reported quarters only, and old statements are stated", async () => {
  await inPackFolder(async () => {
    const { dir } = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: {
        ...fixture,
        income: [{ date: "2026-05-31", period: "Q1", fiscalYear: "2026" }],
        earnings: [
          { date: "2027-02-01", epsActual: null, epsEstimated: 2 },
          { date: "2026-10-01", epsActual: 1, epsEstimated: 1 },
        ],
      },
      includeFilings: false,
    });
    const pack = packOf(dir);
    assert.deepEqual(
      pack.earnings_history.map((e: { date: string }) => e.date),
      ["2026-10-01"],
    );
    assert.ok(
      pack.data_notes.some((n: string) => n.includes("more than 120 days old")),
    );
    const fresh = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: {
        ...fixture,
        income: [{ date: "2026-09-30", period: "Q3", fiscalYear: "2026" }],
      },
      includeFilings: false,
    });
    assert.ok(
      !packOf(fresh.dir).data_notes.some((n: string) => n.includes("days old")),
    );
    const fund = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: { ...fixture, isFund: true, income: [{ date: "2020-01-31" }] },
      includeFilings: false,
    });
    assert.ok(
      !packOf(fund.dir).data_notes.some((n: string) => n.includes("days old")),
    );
  });
});

void test("pack: a blank report writes no filing file and counts as unread", async () => {
  await inPackFolder(async () => {
    const report = filing({
      accessionNo: "q-blank",
      form: "10-Q",
      primaryDocUrl: `${BASE}blank.htm`,
    });
    await db.insert(filings).values(report);
    stubSec({ [`${BASE}blank.htm`]: "<html><body> </body></html>" });
    const { written, unread } = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: fixture,
      includeFilings: true,
      newFilings: [report],
    });
    assert.ok(
      !written.some((n) => n.startsWith("filing_")),
      written.join(", "),
    );
    assert.deepEqual([...unread], ["q-blank"]);
  });
});

const q = (accession: string, filedAt: string, doc: string) =>
  filing({
    accessionNo: accession,
    form: "10-Q",
    filedAt,
    primaryDocUrl: `${BASE}${doc}`,
    processedAt: "2026-01-01T00:00:00.000Z",
  });
const annual = (filedAt: string) =>
  filing({
    accessionNo: "k-1",
    form: "10-K",
    filedAt,
    primaryDocUrl: `${BASE}annual.htm`,
    processedAt: "2026-01-01T00:00:00.000Z",
  });
const ANNUAL_DOC = `<p>Item 1A. Risk Factors</p><p>${"Annual risk. ".repeat(40)}</p><p>Item 1B. Unresolved</p><p>Item 7. Management's Discussion and Analysis</p><p>${"Annual results. ".repeat(40)}</p><p>Item 8. Financial Statements</p>`;
const POINTER =
  "No material updates beyond our Annual Report and our Quarterly Reports on Form 10-Q for March and June. Further words so this is not a table of contents entry at all.";
const earlierRiskFile = (written: string[], date: string) =>
  written.some((n) => n.startsWith(`filing_sections_10-Q_${date}`));

void test("interim risks: a 10-Q from before the annual report stays out", async () => {
  await inPackFolder(async () => {
    await db
      .insert(filings)
      .values([
        q("q-0", "2025-11-01", "old.htm"),
        annual("2026-02-01"),
        q("q-1", "2026-05-01", "march.htm"),
        q("q-2", "2026-10-30", "sept.htm"),
      ]);
    stubSec({
      [`${BASE}annual.htm`]: ANNUAL_DOC,
      [`${BASE}old.htm`]: reportDoc(
        `Old update. ${"Old detail. ".repeat(200)}`,
        "Old.",
      ),
      [`${BASE}march.htm`]: reportDoc(
        `March update. ${"March detail. ".repeat(200)}`,
        "March.",
      ),
      [`${BASE}sept.htm`]: reportDoc(POINTER, "Sept."),
    });
    const { written } = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: fixture,
      includeFilings: true,
    });
    assert.ok(earlierRiskFile(written, "2026-05-01"), written.join(", "));
    assert.ok(!earlierRiskFile(written, "2025-11-01"), written.join(", "));
  });
});

void test("interim risks: a reference after the opening does not pull in earlier quarters", async () => {
  await inPackFolder(async () => {
    await db
      .insert(filings)
      .values([
        q("q-1", "2026-05-01", "march.htm"),
        q("q-2", "2026-10-30", "sept.htm"),
      ]);
    stubSec({
      [`${BASE}march.htm`]: reportDoc(
        `March update. ${"March detail. ".repeat(200)}`,
        "March.",
      ),
      [`${BASE}sept.htm`]: reportDoc(
        `${"A long risk stated in full. ".repeat(1000)} See our Quarterly Reports on Form 10-Q.`,
        "Sept.",
      ),
    });
    const { written } = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: fixture,
      includeFilings: true,
    });
    assert.ok(!earlierRiskFile(written, "2026-05-01"), written.join(", "));
  });
});

void test("interim risks: a short section naming only this Quarterly Report is not a pointer", async () => {
  await inPackFolder(async () => {
    await db
      .insert(filings)
      .values([
        q("q-1", "2026-05-01", "march.htm"),
        q("q-2", "2026-10-30", "sept.htm"),
      ]);
    stubSec({
      [`${BASE}march.htm`]: reportDoc(
        `March update. ${"March detail. ".repeat(200)}`,
        "March.",
      ),
      [`${BASE}sept.htm`]: reportDoc(
        `The risks set forth in this Quarterly Report could hurt us. ${"A risk. ".repeat(100)}`,
        "Sept.",
      ),
    });
    const { written } = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: fixture,
      includeFilings: true,
    });
    assert.ok(!earlierRiskFile(written, "2026-05-01"), written.join(", "));
  });
});

void test("interim risks: an earlier 10-Q with almost no risk text adds nothing", async () => {
  await inPackFolder(async () => {
    await db
      .insert(filings)
      .values([
        q("q-1", "2026-05-01", "march.htm"),
        q("q-2", "2026-10-30", "sept.htm"),
      ]);
    stubSec({
      [`${BASE}march.htm`]: reportDoc(
        "There have been no material changes to the risk factors described in our Annual Report for the year ended December 2025.",
        "March.",
      ),
      [`${BASE}sept.htm`]: reportDoc(POINTER, "Sept."),
    });
    const { written } = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: fixture,
      includeFilings: true,
    });
    assert.ok(!earlierRiskFile(written, "2026-05-01"), written.join(", "));
  });
});

// vendorFilingGaps reads only the folder's file names and text.
function gapsIn(files: Record<string, string>, income: FmpData["income"]) {
  const dir = mkdtempSync(path.join(tmpdir(), "portchecker-vendor-"));
  try {
    for (const [name, text] of Object.entries(files))
      writeFileSync(path.join(dir, name), text);
    return vendorFilingGaps(dir, { ...fixture, income });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const row = (
  date: string,
  revenue: number,
  operatingIncome: number,
  netIncome: number,
) => ({
  date,
  revenue,
  operatingIncome,
  netIncome,
});

void test("operating income cannot confirm a different operating cash-flow total", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "portchecker-cash-label-"));
  const fmp = {
    ...fixture,
    income: [{ date: "2026-09-30", period: "Q3", fiscalYear: "2026" }],
    cashFlow: [3, 2, 1].map((quarter) => ({
      date:
        quarter === 3
          ? "2026-09-30"
          : quarter === 2
            ? "2026-06-30"
            : "2026-03-31",
      period: `Q${quarter}`,
      fiscalYear: "2026",
      reportedCurrency: "USD",
      operatingCashFlow: 100_000_000,
    })),
  };
  try {
    for (const label of [
      "Net cash provided by operating activities",
      "Cash flows from operations",
      "Net cash generated from operating activities",
    ]) {
      for (const amount of [412, 300]) {
        writeFileSync(
          path.join(dir, "filing_10-Q_2026-10-30_x.txt"),
          `CONSOLIDATED FINANCIAL STATEMENTS\n(in millions)\nNine Months Ended September 30,\n2026 2025\nOperating income 300 250\n${label} ${amount} 390\n`,
        );
        const warnings = vendorFilingGaps(dir, fmp);
        assert.equal(
          warnings.some((note) => /operating cash flow/i.test(note)),
          amount !== 300,
          `${label}: ${amount}`,
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("vendor gaps: a figure must stand alone, not sit inside a longer number", () => {
  const notes = gapsIn(
    {
      "filing_10-Q_2026-08-06_q.txt":
        "Revenue 4,315\nOperating income 1,800\nNet income 878,123",
    },
    [row("2026-06-30", 4_315_000_000, 800_000_000, 878_000_000)],
  );
  const note = notes.join(" ");
  assert.match(
    note,
    /latest quarter operating income 800000000/,
    "1,800 is not 800",
  );
  assert.match(
    note,
    /latest quarter net income 878000000/,
    "878,123 is not 878",
  );
  assert.doesNotMatch(note, /latest quarter revenue/);
});

void test("vendor gaps: a current foreign filing definition change qualifies cash-flow comparisons", () => {
  const notes = gapsIn(
    {
      "filing_event_2026-11-04_0001.txt":
        "Effective Q1 2026, the definition of Free cash flow has been updated and comparative figures have been restated accordingly. Free cash flow is net cash generated from operating activities less purchase of property, plant and equipment.",
    },
    [row("2026-09-30", 100, 20, 10)],
  );
  assert.ok(
    notes.some(
      (note) =>
        /free cash flow definition/i.test(note) &&
        /filing_event_2026-11-04_0001.txt/.test(note),
    ),
  );
  assert.ok(
    notes.some(
      (note) =>
        /vendor/i.test(note) && /guidance/i.test(note) && /compar/i.test(note),
    ),
  );
  const old = gapsIn(
    {
      "filing_event_2025-11-04_old.txt":
        "The definition of Free cash flow has been updated.",
    },
    [row("2026-09-30", 100, 20, 10)],
  );
  assert.equal(
    old.some((note) => /free cash flow definition/i.test(note)),
    false,
  );
});

void test("packs: a dated prior position survives same-day replacement without trusting model prose", async () => {
  await inPackFolder(async () => {
    put(
      "data/packs/2026-11-05/TEST",
      "pack.json",
      JSON.stringify({
        ticker: "TEST",
        generated_on: "2026-11-05",
        run_id: 16,
        my_position: {
          quantity: 9,
          value: 900,
          weight_pct: 14.9,
          portfolio_cash_pct: 31,
          portfolio_total_value: 6040,
        },
      }),
    );
    const { dir } = await writePack({
      ticker: "TEST",
      date: "2026-11-05",
      fmp: { ...fixture, isFund: true },
      includeFilings: false,
      position: { quantity: 11, weight_pct: 17.91 },
      previousReview: {
        date: "2026-11-05",
        run_id: 16,
        reasoning: "The earlier model invented 99 shares",
      },
    });
    const pack = packOf(dir);
    assert.ok(pack.previous_position);
    assert.equal(pack.previous_position.position.quantity, 9);
    assert.equal(pack.previous_position.position.weight_pct, 14.9);
    assert.equal(pack.previous_position.snapshot_date, "2026-11-05");
    assert.equal(pack.previous_position.run_id, 16);
    assert.equal(pack.my_position.quantity, 11);
    assert.match(pack.previous_position.source, /2026-11-05/);
  });
});

void test("packs: future or malformed prior positions are not promoted to evidence", async () => {
  await inPackFolder(async () => {
    put(
      "data/packs/2026-11-06/TEST",
      "pack.json",
      JSON.stringify({
        ticker: "TEST",
        generated_on: "2026-11-06",
        my_position: { quantity: 99, weight_pct: 5 },
      }),
    );
    const { dir } = await writePack({
      ticker: "TEST",
      date: "2026-11-05",
      fmp: { ...fixture, isFund: true },
      includeFilings: false,
      previousReview: { date: "2026-11-06" },
    });
    const pack = packOf(dir);
    assert.equal(pack.previous_position, null);
  });
});

void test("packs: a new manual pack with no run identity cannot replace a prior research position", async () => {
  await inPackFolder(async () => {
    put(
      "data/packs/2026-11-05/TEST",
      "pack.json",
      JSON.stringify({
        ticker: "TEST",
        generated_on: "2026-11-05",
        run_id: null,
        my_position: {
          quantity: 99,
          value: 9900,
          weight_pct: 20,
          portfolio_cash_pct: 10,
          portfolio_total_value: 49500,
        },
      }),
    );
    const { dir } = await writePack({
      ticker: "TEST",
      date: "2026-11-05",
      fmp: { ...fixture, isFund: true },
      includeFilings: false,
      previousReview: { date: "2026-11-05", run_id: 16 },
    });
    assert.equal(packOf(dir).previous_position, null);
  });
});

void test("vendor gaps: unchanged or negated cash-flow definitions are not change warnings", () => {
  for (const text of [
    "The definition of free cash flow has not changed.",
    "The definition of free cash flow is unchanged.",
    "We have not revised the definition of free cash flow.",
  ]) {
    const notes = gapsIn({ "filing_event_2026-11-04_0001.txt": text }, [
      row("2026-09-30", 100, 20, 10),
    ]);
    assert.equal(
      notes.some((note) => /free cash flow definition/i.test(note)),
      false,
      text,
    );
  }
});

void test("vendor gaps: a zero figure is not reported as missing", () => {
  const notes = gapsIn(
    { "filing_10-Q_2026-08-06_q.txt": "Revenue 4,315\nNet income 878" },
    [row("2026-06-30", 4_315_000_000, 0, 878_000_000)],
  );
  assert.deepEqual(
    notes.filter((n) => n.includes("do not appear")),
    [],
  );
});

void test("vendor gaps: a 10-K for the period means no earnings-release warning", () => {
  const notes = gapsIn(
    {
      "filing_10-Q_2026-08-06_old.txt": "older",
      "filing_10-K_2027-02-10_k.txt": "Revenue 4,315. Net income 878.",
    },
    [row("2026-12-31", 4_315_000_000, 0, 878_000_000)],
  );
  assert.ok(!notes.some((n) => n.includes("come from the earnings release")));
});

void test("vendor gaps: an 8-K with only last year's figures is not the results release", () => {
  const notes = gapsIn(
    {
      "filing_10-Q_2026-08-06_old.txt": "older",
      "new_8k_2026-10-20_x.md":
        "A note on last year: revenue was 4,411 for the period.",
    },
    [
      row("2026-09-30", 4_938_000_000, 1_326_000_000, 1_030_000_000),
      row("2025-09-30", 4_411_000_000, 1_128_000_000, 959_000_000),
    ],
  );
  assert.ok(!notes.some((n) => n.includes("do not appear")), notes.join(" | "));
  assert.ok(notes.some((n) => n.includes("come from the earnings release")));
});

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

void test("resolveCik: a ticker gets its own CIK, and an unlisted one gets none", async () => {
  stubSec({
    [TICKERS_URL]: JSON.stringify({
      0: { cik_str: 111, ticker: "OTHER" },
      1: { cik_str: 222, ticker: "TEST" },
    }),
  });
  assert.equal(await resolveCik("TEST"), "222");
  assert.equal(await resolveCik("VOO"), null);
});

void test("resolveCik: the list is refreshed after 30 days", async () => {
  await client.execute({
    sql: "INSERT INTO fmp_cache VALUES ('_SEC','company_tickers',?,?)",
    args: [
      new Date(Date.now() - 40 * 86400000).toLocaleDateString("en-CA"),
      JSON.stringify({ 0: { cik_str: 1, ticker: "NEW" } }),
    ],
  });
  const urls = stubSec({
    [TICKERS_URL]: JSON.stringify({ 0: { cik_str: 2, ticker: "NEW" } }),
  });
  assert.equal(await resolveCik("NEW"), "2");
  assert.equal(urls.length, 1);
});

const dateAgo = (d: number) =>
  new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
const submissions = (recent: object, files: object[] = []) =>
  JSON.stringify({ filings: { recent, files } });

void test("syncFilings: filings older than the history window are not stored", async () => {
  stubSec({
    "https://data.sec.gov/submissions/CIK0000000001.json": submissions({
      accessionNumber: ["new", "ancient"],
      filingDate: [dateAgo(10), dateAgo(1000)],
      form: ["10-K", "10-K"],
      primaryDocument: ["a.htm", "b.htm"],
      items: ["", ""],
    }),
  });
  await syncFilings("TEST", "1");
  const stored = (
    await client.execute("SELECT accession_no FROM filings")
  ).rows.map((r) => r.accession_no);
  assert.deepEqual(stored, ["new"]);
});

void test("syncFilings: older pages stop once two annual reports are known, and skip pages out of range", async () => {
  const page = (accession: string, date: string) =>
    JSON.stringify({
      accessionNumber: [accession],
      filingDate: [date],
      form: ["10-K"],
      primaryDocument: ["a.htm"],
      items: [""],
    });
  const urls = stubSec({
    "https://data.sec.gov/submissions/CIK0000000001.json": submissions(
      {
        accessionNumber: ["k1"],
        filingDate: [dateAgo(10)],
        form: ["10-K"],
        primaryDocument: ["a.htm"],
        items: [""],
      },
      [
        { name: "too-old.json", filingTo: dateAgo(2000) },
        { name: "p1.json", filingTo: dateAgo(100) },
        { name: "p2.json", filingTo: dateAgo(300) },
      ],
    ),
    "https://data.sec.gov/submissions/p1.json": page("k2", dateAgo(380)),
    "https://data.sec.gov/submissions/p2.json": page("k3", dateAgo(600)),
    "https://data.sec.gov/submissions/too-old.json": page("k4", dateAgo(2100)),
  });
  await syncFilings("TEST", "1");
  assert.ok(urls.some((u) => u.endsWith("p1.json")));
  assert.ok(
    !urls.some((u) => u.endsWith("p2.json")),
    "two annual reports are enough",
  );
  assert.ok(
    !urls.some((u) => u.endsWith("too-old.json")),
    "a page past the window is not asked for",
  );
});

void test("sections: a contents entry alone is not a section", () => {
  const text = `Item 1A. Risk Factors 5\nItem 1B. Unresolved Staff Comments 20\n`;
  assert.equal(extractSections("10-K", text).risk_factors, null);
});

void test("ensureTicker keeps stored facts when the vendor sends blanks", async () => {
  await inPackFolder(async () => {
    await db.insert(tickers).values({
      ticker: "TEST",
      cik: "123",
      sector: "Technology",
      industry: "Software",
      fmpProfileJson: JSON.stringify({
        companyName: "Prior",
        description: "Keep",
        country: "US",
        website: "https://example.test",
      }),
    });
    stubSec({
      [TICKERS_URL]: JSON.stringify({ 0: { cik_str: 123, ticker: "TEST" } }),
    });
    await resolveCik("TEST");
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("/profile"))
        return Response.json([
          {
            companyName: "Prior",
            description: "",
            country: null,
            website: undefined,
            sector: "",
            industry: "",
          },
        ]);
      throw new Error("no network");
    }) as typeof fetch;
    const row = await ensureTicker("TEST", "Name");
    assert.equal(row.sector, "Technology");
    assert.equal(row.industry, "Software");
    assert.deepEqual(JSON.parse(row.fmpProfileJson ?? "{}"), {
      companyName: "Prior",
      description: "Keep",
      country: "US",
      website: "https://example.test",
    });
    assert.ok(existsSync(path.join("data", "dossiers", "TEST.md")));
  });
});

const added = (diff: string) =>
  (diff.split("### Added")[1] ?? "").split("### Removed")[0] ?? "";
const removed = (diff: string) => diff.split("### Removed")[1] ?? "";

void test("sections: a 10-KT is read as a 10-K", () => {
  const body = "Our supply chain could be disrupted. ".repeat(40);
  const text = `Item 1A. Risk Factors\n${body}\nItem 1B. Unresolved\nItem 7. Management's Discussion and Analysis\n${body}\nItem 8. Financial Statements\n`;
  const sections = extractSections("10-KT", text);
  assert.ok(sections.risk_factors?.startsWith("Item 1A. Risk Factors"));
  assert.ok(sections.mda?.startsWith("Item 7."));
});

void test("diff: a bare page number is not a change", () => {
  const diff = compactDiff(
    { risk_factors: "We face competition.\n12\nSupply is tight.", mda: null },
    { risk_factors: "We face competition.\n47\nSupply is tight.", mda: null },
  );
  assert.doesNotMatch(diff, /47/);
  assert.doesNotMatch(diff, /12/);
});

void test("diff: a moved sentence shows on neither side, whichever way it moved", () => {
  for (const [before, after] of [
    [
      "Alpha one. Beta two. Gamma three.",
      "Gamma three. Alpha one. Delta four.",
    ],
    [
      "Gamma three. Alpha one. Delta four.",
      "Alpha one. Beta two. Gamma three.",
    ],
    ["Alpha one. Beta two. Gamma three.", "Beta two. Gamma three. Alpha one."],
  ]) {
    const diff = compactDiff(
      { risk_factors: before!, mda: null },
      { risk_factors: after!, mda: null },
    );
    assert.doesNotMatch(diff, /[+-] Gamma three\./, `${before} -> ${after}`);
    assert.doesNotMatch(diff, /[+-] Alpha one\./, `${before} -> ${after}`);
  }
});

const filler = (word: string, n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      `Routine ${word} statement number ${i} about ordinary matters across the business and its many operating regions.`,
  ).join("\n");
const firstAdded = (line: string, others = filler("currently", 400)) =>
  added(
    compactDiff(
      { risk_factors: filler("previously", 400), mda: null },
      { risk_factors: `${others}\n${line}`, mda: null },
    ),
  );

void test("diff: each serious term survives the cap", () => {
  for (const line of [
    "There is substantial doubt about our ability to continue.",
    "We concluded a going concern qualification applies.",
    "We identified a material weakness in internal control.",
    "A restatement of prior periods is required by the auditor.",
    "We have restated our prior financial statements.",
    "We received a notice of delisting from the exchange.",
    "We may file for bankruptcy protection next year.",
    "We filed under chapter 11 in the third quarter.",
    "We received a subpoena from a federal regulator.",
    "We are effectively foreclosed from a large market.",
  ]) {
    assert.ok(firstAdded(line).includes(line), line);
  }
});

void test("diff: amended and restated is not a restatement", () => {
  const amended =
    "We amended and restated our credit agreement with the lenders in the third quarter of this year.";
  const fresh =
    "Government export rules now shut us out of our second largest market with almost no warning given.";
  const list = added(
    compactDiff(
      {
        risk_factors:
          "We entered into a credit agreement with the lenders in the third quarter of this year.",
        mda: null,
      },
      {
        risk_factors: `${amended}
${fresh}`,
        mda: null,
      },
    ),
  );
  assert.ok(
    list.includes(fresh) && list.indexOf(fresh) < list.indexOf(amended),
    list,
  );
});

void test("diff: a new table row ranks ahead of a routine update, and a new idea ahead of a near copy", () => {
  const routine = (value: number) =>
    `As of the end of the period we held ${value} million in cash and equivalents across our main operating subsidiaries and regions.`;
  const row = "Revenue 4,938 4,412";
  const list = added(
    compactDiff(
      { risk_factors: routine(1), mda: null },
      { risk_factors: `${routine(2)}\n${row}`, mda: null },
    ),
  );
  assert.ok(list.includes(row));
  assert.ok(list.indexOf(row) < list.indexOf("As of the end"), list);

  const before =
    "We sell a wide range of products through distributors in many different regions around the world.";
  const near =
    "We sell a wide range of products through wholesalers in many different regions around the world.";
  const fresh =
    "Government export rules now shut us out of our second largest market with almost no warning given.";
  const order = added(
    compactDiff(
      { risk_factors: before, mda: null },
      { risk_factors: `${near}\n${fresh}`, mda: null },
    ),
  );
  assert.ok(order.includes(fresh));
  assert.ok(order.indexOf(fresh) < order.indexOf(near), order);
});

void test("diff: a sentence longer than its cap is cut and marked", () => {
  const long = `${"word ".repeat(2000).trim()}.`;
  const diff = compactDiff(
    { risk_factors: "Short old line here.", mda: null },
    { risk_factors: long, mda: null },
  );
  const list = added(diff);
  assert.ok(list.length < 5_100, String(list.length));
  assert.match(list, /\.\.\.\n/);
});

void test("diff: what a filing now says gets twice the room of what it stopped saying", () => {
  const lines = (word: string) =>
    Array.from(
      { length: 300 },
      (_, i) =>
        `${word} sentence number ${i} says something different about the business and its many markets today.`,
    ).join("\n");
  const diff = compactDiff(
    { risk_factors: lines("Older"), mda: null },
    { risk_factors: lines("Newer"), mda: null },
  );
  const risk = diff.split("## MD&A")[0] ?? "";
  assert.ok(added(risk).length > 4_500, String(added(risk).length));
  assert.ok(removed(risk).length < 2_800, String(removed(risk).length));
});

void test("excerpt: a statement already in the opening means a plain cap, even with a later one", () => {
  const front = "Commentary from management on the quarter. ".repeat(100);
  const text = `CONSOLIDATED STATEMENT OF INCOME\nNet sales 1\n${front}\nCONSOLIDATED STATEMENTS OF OPERATIONS\nMore ${"x".repeat(5000)}`;
  assert.equal(eventExcerpt(text, 1000), `${text.slice(0, 1000)}\n[truncated]`);
});

const CURRENT = { risk_factors: null, mda: null, diff: null, text_format: 4 };

void test("a saved 8-K in the current format with blank text is read again", async () => {
  const row = filing({
    items: "5.02",
    sectionsJson: JSON.stringify({ ...CURRENT, text_head: "" }),
  });
  await db.insert(filings).values(row);
  stubSec({ [`${BASE}cover.htm`]: "REAL TEXT" });
  assert.equal((await ensureSections(row))?.text_head, "REAL TEXT");
});

const section = (text: string) =>
  `Item 1A. Risk Factors\n${text} ${"Stable risk text stays here. ".repeat(10)}`;

void test("an amendment gets no diff, even with an earlier amendment on file", async () => {
  const saved = (risk: string) =>
    JSON.stringify({
      risk_factors: section(risk),
      mda: null,
      diff: null,
      text_head: null,
      text_format: 4,
    });
  const older = filing({
    accessionNo: "a-1",
    form: "10-Q/A",
    filedAt: "2026-02-01",
    sectionsJson: saved("Old."),
    processedAt: "x",
  });
  const newer = filing({
    accessionNo: "a-2",
    form: "10-Q/A",
    filedAt: "2026-08-01",
    sectionsJson: saved("New."),
    processedAt: "x",
  });
  await db.insert(filings).values([older, newer]);
  assert.equal((await ensureSections(newer))?.diff, null);
});

void test("a diff from an older version is rebuilt from the saved sections", async () => {
  const saved = (risk: string, extra = {}) =>
    JSON.stringify({
      risk_factors: section(risk),
      mda: null,
      diff: null,
      text_head: null,
      text_format: 4,
      ...extra,
    });
  const older = filing({
    accessionNo: "k-1",
    form: "10-K",
    filedAt: "2025-02-01",
    sectionsJson: saved("Old."),
    processedAt: "x",
  });
  const newer = filing({
    accessionNo: "k-2",
    form: "10-K",
    filedAt: "2026-02-01",
    sectionsJson: saved("New.", { diff: "old diff", diff_version: 1 }),
    processedAt: "x",
  });
  await db.insert(filings).values([older, newer]);
  const sections = await ensureSections(newer);
  assert.notEqual(sections?.diff, "old diff");
  assert.match(sections?.diff ?? "", /\+ .*New\./);
  assert.equal(sections?.diff_version, 4);
});

void test("a 40-F and a 20-F read as annual reports", () => {
  assert.equal(filingSummary("40-F", null), "Annual report");
  assert.equal(filingSummary("20-F", null), "Annual report");
});

const FULL = { ticker: "TEST", date: "2026-11-04", includeFilings: true };
const event = (
  accessionNo: string,
  filedAt: string,
  form = "8-K",
  textHead = "text",
) =>
  filing({
    accessionNo,
    filedAt,
    form,
    processedAt: "x",
    sectionsJson: JSON.stringify({ ...CURRENT, text_head: textHead }),
  });

void test("pack: an 8-K older than 14 days stays out unless it is new", async () => {
  await inPackFolder(async () => {
    await db
      .insert(filings)
      .values([event("recent", "2026-10-25"), event("old", "2026-10-01")]);
    const { written } = await writePack({ ...FULL, fmp: fixture });
    assert.ok(written.some((n) => n.includes("recent")));
    assert.ok(!written.some((n) => n.includes("_old")));
    const pending = event("pending", "2026-10-01");
    await db.insert(filings).values(pending);
    const next = await writePack({
      ...FULL,
      fmp: fixture,
      newFilings: [pending],
    });
    assert.ok(next.written.some((n) => n.includes("_pending")));
    assert.deepEqual([...next.unread], []);
  });
});

void test("pack: the quarterly 6-K is the longest recent one over the minimum", async () => {
  await inPackFolder(async () => {
    const pick = async (rows: Filing[]) => {
      await client.execute("DELETE FROM filings");
      await db.insert(filings).values(rows);
      const { written } = await writePack({ ...FULL, fmp: fixture });
      return written
        .filter((n) => n.startsWith("new_8k_"))
        .map((n) => /_([a-z]+).md$/.exec(n)?.[1]);
    };
    const six = (name: string, filed: string, chars: number) =>
      event(name, filed, "6-K", "x".repeat(chars));
    // Whichever is filed first, the longest wins.
    assert.deepEqual(
      await pick([
        six("short", "2026-08-01", 7_000),
        six("long", "2026-09-01", 9_000),
        six("longest", "2026-08-15", 12_000),
      ]),
      ["longest"],
    );
    assert.deepEqual(
      await pick([
        six("short", "2026-08-01", 7_000),
        six("long", "2026-08-15", 9_000),
        six("longest", "2026-09-01", 12_000),
      ]),
      ["longest"],
    );
    assert.deepEqual(await pick([six("aged", "2026-05-01", 50_000)]), []);
    assert.deepEqual(await pick([six("notice", "2026-09-01", 5_000)]), []);
  });
});

void test("pack: an unread quarterly 6-K beyond twenty-five newer notices is read once and delivered", async () => {
  await inPackFolder(async () => {
    const notices = Array.from({ length: 25 }, (_, i) =>
      event(
        `notice${i}`,
        new Date(Date.parse("2026-11-04") - i * 86400000)
          .toISOString()
          .slice(0, 10),
        "6-K",
      ),
    );
    const quarterly = filing({
      accessionNo: "quarterly",
      form: "6-K",
      filedAt: "2026-09-01",
      primaryDocUrl: `${BASE}quarterly.htm`,
      processedAt: "done",
    });
    const outside = filing({
      accessionNo: "outside",
      form: "6-K",
      filedAt: "2026-06-01",
      primaryDocUrl: `${BASE}outside.htm`,
      processedAt: "done",
    });
    await db.insert(filings).values([...notices, quarterly, outside]);
    const text = "Quarterly sales fell and liquidity deteriorated. ".repeat(
      200,
    );
    const urls = stubSec({
      [`${BASE}quarterly.htm`]: `<p>${text}</p>`,
      [`${BASE}quarterly-index.html`]: "<table></table>",
    });
    const result = await writePack({ ...FULL, fmp: fixture });
    const delivered = result.written.find(
      (n) => n.startsWith("new_8k_") && n.includes("_quarterly"),
    );
    assert.ok(delivered);
    assert.match(
      readFileSync(path.join(result.dir, delivered), "utf8"),
      /Quarterly sales fell/,
    );
    assert.equal(
      urls.filter((url) => url === quarterly.primaryDocUrl).length,
      1,
    );
    assert.ok(!urls.includes(outside.primaryDocUrl));
  });
});

void test("pack: an amendment older than the latest report stays out", async () => {
  await inPackFolder(async () => {
    const report = (accessionNo: string, form: string, filedAt: string) =>
      filing({
        accessionNo,
        form,
        filedAt,
        processedAt: "x",
        sectionsJson: JSON.stringify({
          ...CURRENT,
          risk_factors: "Risk. ".repeat(50),
          mda: "Results. ".repeat(50),
          diff: "d",
          diff_version: 4,
        }),
      });
    await db
      .insert(filings)
      .values([
        report("latest", "10-Q", "2026-08-01"),
        report("olderamend", "10-Q/A", "2026-03-01"),
      ]);
    stubSec({ [`${BASE}cover.htm`]: "<p>Report body</p>" });
    const { written } = await writePack({ ...FULL, fmp: fixture });
    assert.ok(
      written.some((n) => n.startsWith("filing_sections_10-Q_")),
      written.join(", "),
    );
    assert.ok(!written.some((n) => n.includes("10-Q-A")), written.join(", "));
  });
});

void test("pack: a fund with no filings is not told its filing evidence is incomplete", async () => {
  await inPackFolder(async () => {
    const { dir } = await writePack({
      ...FULL,
      fmp: { ...fixture, isFund: true },
    });
    const pack = JSON.parse(
      readFileSync(path.join(dir, "pack.json"), "utf8"),
    ) as { data_notes: string[] };
    assert.ok(!pack.data_notes.some((n) => n.includes("No SEC filing text")));
    const stock = await writePack({ ...FULL, fmp: fixture });
    const stockPack = JSON.parse(
      readFileSync(path.join(stock.dir, "pack.json"), "utf8"),
    ) as { data_notes: string[] };
    assert.ok(
      stockPack.data_notes.some((n) => n.includes("No SEC filing text")),
    );
  });
});

void test("pack: floats are rounded to four places and whole numbers left alone", async () => {
  await inPackFolder(async () => {
    const { dir } = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      includeFilings: false,
      fmp: {
        ...fixture,
        quote: { pe: 12.345678, volume: 1_000_000, yield: 0.036 },
      },
    });
    const pack = JSON.parse(
      readFileSync(path.join(dir, "pack.json"), "utf8"),
    ) as { quote: Record<string, number> };
    assert.deepEqual(pack.quote, {
      pe: 12.3457,
      volume: 1_000_000,
      yield: 0.036,
    });
  });
});

void test("pack: only a real change of grade is listed", async () => {
  await inPackFolder(async () => {
    const { dir } = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      includeFilings: false,
      fmp: {
        ...fixture,
        grades: [
          { date: "2026-10-01", previousGrade: "Buy", newGrade: "Buy" },
          { date: "2026-10-02", previousGrade: "Buy", newGrade: "Hold" },
        ],
      },
    });
    const pack = JSON.parse(
      readFileSync(path.join(dir, "pack.json"), "utf8"),
    ) as { grade_changes_last_90_days: unknown[] };
    assert.equal(pack.grade_changes_last_90_days.length, 1);
  });
});
