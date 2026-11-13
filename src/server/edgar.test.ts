import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, mock, test } from "node:test";

import { and, eq } from "drizzle-orm";

// Only a whole `import type` is erased. Anything else would load edgar.ts, and so open the real
// database, before the lines below choose an in-memory one.
import type { Filing, Sections } from "./edgar.ts";

process.env.DATABASE_PATH = ":memory:";
process.env.SEC_USER_AGENT = "Portchecker test contact";

const { client, db } = await import("./db/index.ts");
const { filings, fmpCache, tickers } = await import("./db/schema.ts");
const {
  UNREADABLE_RETRY_DAYS,
  annualExhibitExcerpt,
  compactDiff,
  ensureSections,
  eventExcerpt,
  extractSections,
  fetchAnnualExhibit,
  fetchEventText,
  fetchFilingText,
  filingHtmlToText,
  filingSummary,
  fullChanges,
  gaveUpOnFiling,
  incorporatesAnnualReport,
  resolveCik,
  savedSections,
  syncFilings,
  FULL_REVIEW_FORMS,
} = await import("./edgar.ts");
const { ensureTicker, vendorFilingGaps, writePack } =
  await import("./research/pack.ts");

await client.executeMultiple(
  "CREATE TABLE filings(accession_no TEXT,ticker TEXT,form TEXT,filed_at TEXT,primary_doc_url TEXT,items TEXT,sections_json TEXT,processed_at TEXT,PRIMARY KEY(accession_no,ticker));",
);

await client.executeMultiple(
  "CREATE TABLE IF NOT EXISTS fmp_cache(ticker TEXT,endpoint TEXT,fetched_on TEXT,payload_json TEXT,PRIMARY KEY(ticker,endpoint,fetched_on));",
);
await client.executeMultiple(
  "CREATE TABLE IF NOT EXISTS tickers(ticker TEXT PRIMARY KEY,cik TEXT,sector TEXT,industry TEXT,fmp_profile_json TEXT,last_full_review_at TEXT);",
);

beforeEach(async () => {
  await client.execute("DELETE FROM filings");
  await client.execute("DELETE FROM fmp_cache");
  await client.execute("DELETE FROM tickers");
});
after(() => client.close());

const FOLDER = "/Archives/edgar/data/1/000000000126000001/";
const BASE = `https://www.sec.gov${FOLDER}`;
const ACCESSION = "0000000001-26-000001";
const PRIMARY = `${BASE}cover.htm`;
const INDEX = `${BASE}${ACCESSION}-index.html`;
const EX1 = `${BASE}ex1.htm`;
const EX2 = `${BASE}ex2.htm`;
const STATEMENT = "so its content was not read";

function filing(overrides: Partial<Filing> = {}): Filing {
  return {
    accessionNo: ACCESSION,
    ticker: "TEST",
    form: "8-K",
    filedAt: "2026-11-04",
    primaryDocUrl: PRIMARY,
    items: "9.01",
    sectionsJson: null,
    processedAt: null,
    ...overrides,
  };
}

type Doc = {
  type: string;
  file?: string;
  size?: number;
  href?: string;
  description?: string;
};

/** Laid out as EDGAR lays it out, including the rows that must be ignored. */
function indexPage(...docs: Doc[]) {
  const row = (seq: number, doc: Doc) => {
    const href = doc.href ?? `${FOLDER}${doc.file}`;
    return `<tr class="blueRow"><td scope="row" style="text-align: center;">${seq}</td><td scope="row">${doc.description ?? `${doc.type} document`}</td><td scope="row"><a href="${href}">${doc.file ?? "doc"}</a></td><td scope="row">${doc.type}</td><td scope="row">${doc.size ?? 100}</td></tr>`;
  };
  return `<html><body><table class="tableFile" summary="Document Format Files">
    <tr><th scope="col">Seq</th><th scope="col">Description</th><th scope="col">Document</th><th scope="col">Type</th><th scope="col">Size</th></tr>
    <tr><td scope="row">1</td><td scope="row">Form</td><td scope="row"><a href="/ix?doc=${FOLDER}cover.htm">cover.htm</a> &nbsp;&nbsp;<span style="color: green">iXBRL</span></td><td scope="row">8-K</td><td scope="row">9000</td></tr>
    ${docs.map((doc, i) => row(i + 2, doc)).join("\n")}
    <tr><td scope="row">&nbsp;</td><td scope="row">Complete submission text file</td><td scope="row"><a href="${FOLDER}${ACCESSION}.txt">${ACCESSION}.txt</a></td><td scope="row">&nbsp;</td><td scope="row">9999999</td></tr>
    </table></body></html>`;
}

/** Any URL not listed answers 404. Returns the URLs asked for, in order. */
function stubSec(pages: Record<string, string>) {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    const page = pages[url];
    return page === undefined
      ? new Response("not found", { status: 404 })
      : new Response(page);
  }) as typeof fetch;
  return urls;
}

async function stored(accessionNo = ACCESSION) {
  const [row] = await db
    .select()
    .from(filings)
    .where(
      and(eq(filings.accessionNo, accessionNo), eq(filings.ticker, "TEST")),
    );
  assert.ok(row);
  return row;
}

// 1. 8-K exhibits

void test("an 8-K with item 9.01 reads text EX-99 exhibits in number order, at most two, and no other exhibit", async () => {
  const urls = stubSec({
    [PRIMARY]: "COVER",
    [INDEX]: indexPage(
      { type: "EX-1.1", file: "ex-one.htm", size: 900 },
      { type: "EX-4.1", file: "ex-four.htm", size: 900 },
      { type: "EX-10.1", file: "ex-ten.htm", size: 900 },
      { type: "EX-99.3", file: "ex3.htm", size: 900 },
      { type: "EX-99.2", file: "ex2.htm", size: 20 },
      { type: "EX-99.1", file: "ex1.htm", size: 10 },
    ),
    [EX1]: "PRESS RELEASE",
    [EX2]: "SLIDES",
  });
  await fetchEventText(filing({ items: "8.01,9.01" }));
  assert.deepEqual(urls, [PRIMARY, INDEX, EX1, EX2]);
});

void test("exhibit numbers sort as numbers: 99.2 comes before 99.10, and a bare EX-99 comes first", async () => {
  const urls = stubSec({
    [PRIMARY]: "COVER",
    [INDEX]: indexPage(
      { type: "EX-99.10", file: "ten.htm" },
      { type: "EX-99.2", file: "ex2.htm" },
      { type: "EX-99", file: "ex1.htm" },
    ),
    [EX1]: "FIRST",
    [EX2]: "SECOND",
  });
  await fetchEventText(filing());
  assert.deepEqual(urls, [PRIMARY, INDEX, EX1, EX2]);
});

void test("Citi's EX-99.01 numbering counts as exhibit one, and EX-5.01 is left alone", async () => {
  const urls = stubSec({
    [PRIMARY]: "COVER",
    [INDEX]: indexPage(
      { type: "EX-5.01", file: "opinion.htm" },
      { type: "EX-99.02", file: "ex2.htm" },
      { type: "EX-99.01", file: "ex1.htm" },
    ),
    [EX1]: "FIRST",
    [EX2]: "SECOND",
  });
  await fetchEventText(filing());
  assert.deepEqual(urls, [PRIMARY, INDEX, EX1, EX2]);
});

void test("an exhibit's description does not decide its type", async () => {
  const urls = stubSec({
    [PRIMARY]: "COVER",
    [INDEX]: `<table><tr><td>2</td><td>EX-99.1 mentioned here</td><td><a href="${FOLDER}ten.htm">ten.htm</a></td><td>EX-10.1</td><td>100</td></tr></table>`,
  });
  assert.equal(await fetchEventText(filing()), "COVER");
  assert.deepEqual(urls, [PRIMARY, INDEX]);
});

void test("an 8-K without item 9.01 makes no index request", async () => {
  const urls = stubSec({ [PRIMARY]: "COVER" });
  for (const items of ["5.02", "2.02", "", null]) {
    urls.length = 0;
    assert.equal(await fetchEventText(filing({ items })), "COVER");
    assert.deepEqual(urls, [PRIMARY]);
  }
});

void test("an 8-K/A with item 9.01 reads its exhibits too", async () => {
  stubSec({
    [PRIMARY]: "COVER",
    [INDEX]: indexPage({ type: "EX-99.1", file: "ex1.htm" }),
    [EX1]: "AMENDED RESULTS",
  });
  const text = await fetchEventText(filing({ form: "8-K/A" }));
  assert.ok(text.includes("AMENDED RESULTS"));
});

void test("an 8-K with item 9.01 and no EX-99 returns only its primary document", async () => {
  const urls = stubSec({
    [PRIMARY]: "COVER",
    [INDEX]: indexPage(
      { type: "EX-1.1", file: "ex-one.htm" },
      { type: "EX-5.1", file: "ex-five.pdf" },
      { type: "EX-101.SCH", file: "data.xsd" },
    ),
  });
  assert.equal(await fetchEventText(filing()), "COVER");
  assert.deepEqual(urls, [PRIMARY, INDEX]);
});

void test("a 6-K reads its largest text EX-99 and discloses a larger unread PDF", async () => {
  const urls = stubSec({
    [PRIMARY]: "COVER",
    [INDEX]: indexPage(
      { type: "EX-99.1", file: "small.htm", size: 10 },
      { type: "EX-99.2", file: "ex2.htm", size: 900 },
      { type: "EX-99.3", file: "huge.pdf", size: 9000 },
    ),
    [EX2]: "RESULTS",
  });
  const text = await fetchEventText(filing({ form: "6-K", items: "" }));
  assert.deepEqual(urls, [PRIMARY, INDEX, EX2]);
  assert.ok(text.includes(`${STATEMENT}: ${BASE}huge.pdf`));
  assert.ok(
    text.endsWith(
      `Exhibit source: ${EX2}\n\nRESULTS\n\nPrimary document:\nCOVER`,
    ),
  );
});

void test("reports and Form 4 are untouched: primary document only, no index request", async () => {
  for (const form of ["10-K", "10-Q", "20-F", "40-F", "10-K/A", "4"]) {
    const urls = stubSec({ [PRIMARY]: "BODY" });
    assert.equal(await fetchEventText(filing({ form })), "BODY");
    assert.deepEqual(urls, [PRIMARY]);
  }
});

void test("item 2.02 puts the exhibit first, then the primary document", async () => {
  stubSec({
    [PRIMARY]: "COVER",
    [INDEX]: indexPage(
      { type: "EX-99.1", file: "ex1.htm" },
      { type: "EX-99.2", file: "ex2.htm" },
    ),
    [EX1]: "RESULTS",
    [EX2]: "COMMENTARY",
  });
  assert.equal(
    await fetchEventText(filing({ items: "2.02,7.01,8.01,9.01" })),
    `Exhibit source: ${EX1}\n\nRESULTS\n\nExhibit source: ${EX2}\n\nCOMMENTARY\n\nPrimary document:\nCOVER`,
  );
});

void test("other 8-Ks put the primary document first, because it holds the item text", async () => {
  stubSec({
    [PRIMARY]: "ITEM TEXT",
    [INDEX]: indexPage({ type: "EX-99.1", file: "ex1.htm" }),
    [EX1]: "RELEASE",
  });
  assert.equal(
    await fetchEventText(filing({ items: "5.02,9.01" })),
    `Primary document:\nITEM TEXT\n\nExhibit source: ${EX1}\n\nRELEASE`,
  );
});

// 2. Head caps

async function savedHead(row: Filing) {
  await db.insert(filings).values(row);
  return (await ensureSections(row))?.text_head ?? "";
}

void test("item 2.02 8-Ks keep 40,000 characters with the exhibit first", async () => {
  stubSec({
    [PRIMARY]: "COVER",
    [INDEX]: indexPage({ type: "EX-99.1", file: "ex1.htm" }),
    [EX1]: "r".repeat(50_000),
  });
  const head = await savedHead(filing({ items: "2.02,9.01" }));
  assert.equal(head.length, 40_000 + "\n[truncated]".length);
  assert.ok(head.startsWith("Exhibit source:"));
  assert.ok(head.endsWith("r\n[truncated]"));
});

void test("an item 2.02 8-K with no exhibit keeps 40,000 characters of its primary document", async () => {
  stubSec({ [PRIMARY]: "r".repeat(50_000) });
  const head = await savedHead(filing({ items: "2.02" }));
  assert.equal(head.length, 40_000 + "\n[truncated]".length);
});

void test("6-Ks keep 40,000 characters", async () => {
  stubSec({
    [PRIMARY]: "COVER",
    [INDEX]: indexPage({ type: "EX-99.1", file: "ex1.htm" }),
    [EX1]: "r".repeat(50_000),
  });
  const head = await savedHead(filing({ form: "6-K", items: "" }));
  assert.equal(head.length, 40_000 + "\n[truncated]".length);
});

void test("other 8-Ks keep 12,000 characters when an exhibit was read, with the item text kept", async () => {
  stubSec({
    [PRIMARY]: "ITEM TEXT",
    [INDEX]: indexPage({ type: "EX-99.1", file: "ex1.htm" }),
    [EX1]: "r".repeat(50_000),
  });
  const head = await savedHead(filing({ items: "8.01,9.01" }));
  assert.equal(head.length, 12_000 + "\n[truncated]".length);
  assert.ok(head.startsWith("Primary document:\nITEM TEXT"));
  assert.ok(head.includes("Exhibit source:"));
});

void test("other 8-Ks keep 6,000 characters when no exhibit was read", async () => {
  stubSec({ [PRIMARY]: "p".repeat(50_000) });
  const noExhibits = await savedHead(filing({ items: "5.02" }));
  assert.equal(noExhibits.length, 6_000 + "\n[truncated]".length);

  await client.execute("DELETE FROM filings");
  stubSec({
    [PRIMARY]: "p".repeat(50_000),
    [INDEX]: indexPage({ type: "EX-10.1", file: "ex-ten.htm" }),
  });
  const onlyAnAgreement = await savedHead(filing({ items: "1.01,9.01" }));
  assert.equal(onlyAnAgreement.length, 6_000 + "\n[truncated]".length);
});

void test("text that fits gets no truncation marker", async () => {
  stubSec({ [PRIMARY]: "SHORT" });
  assert.equal(await savedHead(filing({ items: "5.02" })), "SHORT");
});

// 3. A cover is not delivery

void test("a text exhibit that fails to download throws, however long the primary document is", async () => {
  const long = "p".repeat(20_000);
  for (const row of [
    filing({ items: "2.02,9.01" }),
    filing({ items: "8.01,9.01" }),
    filing({ form: "6-K", items: "" }),
  ]) {
    stubSec({
      [PRIMARY]: long,
      [INDEX]: indexPage({ type: "EX-99.1", file: "ex1.htm" }),
    });
    await assert.rejects(fetchEventText(row), /Could not resolve/);
  }
});

void test("a failed second exhibit throws rather than saving half the filing", async () => {
  stubSec({
    [PRIMARY]: "COVER",
    [INDEX]: indexPage(
      { type: "EX-99.1", file: "ex1.htm" },
      { type: "EX-99.2", file: "ex2.htm" },
    ),
    [EX1]: "RELEASE",
  });
  await assert.rejects(fetchEventText(filing()), /Could not resolve/);
});

void test("an unreadable index throws, however long the primary document is", async () => {
  const long = "p".repeat(20_000);
  for (const row of [filing(), filing({ form: "6-K", items: "" })]) {
    stubSec({ [PRIMARY]: long });
    await assert.rejects(fetchEventText(row), /Could not resolve/);
  }
});

void test("a failed exhibit leaves the filing unsaved so a later run retries it", async () => {
  const row = filing({ items: "2.02,9.01" });
  await db.insert(filings).values(row);
  stubSec({
    [PRIMARY]: "COVER",
    [INDEX]: indexPage({ type: "EX-99.1", file: "ex1.htm" }),
  });
  assert.equal(await ensureSections(row), null);
  assert.equal((await stored()).sectionsJson, null);
});

void test("a 6-K with no EX-99 and a short primary document reads its largest other text exhibit", async () => {
  const urls = stubSec({
    [PRIMARY]: "COVER",
    [INDEX]: indexPage(
      { type: "EX-1", file: "small.htm", size: 10 },
      { type: "EX-1.2", file: "ex2.htm", size: 900 },
      { type: "EX-13", file: "huge.pdf", size: 9000 },
      { type: "EX-101.INS", file: "data.xml", size: 90000 },
    ),
    [EX2]: "RESULTS IN EX-1",
  });
  const text = await fetchEventText(filing({ form: "6-K", items: "" }));
  assert.deepEqual(urls, [PRIMARY, INDEX, EX2]);
  assert.ok(text.includes(`Exhibit source: ${EX2}`));
  assert.ok(text.startsWith("This filing's main exhibit"));
});

void test("a 6-K with no EX-99 and a long primary document reads no other exhibit", async () => {
  const long = "p".repeat(6_000);
  const urls = stubSec({
    [PRIMARY]: long,
    [INDEX]: indexPage({ type: "EX-1", file: "ex1.htm" }),
  });
  assert.equal(await fetchEventText(filing({ form: "6-K", items: "" })), long);
  assert.deepEqual(urls, [PRIMARY, INDEX]);
});

void test("a 6-K with an EX-99 does not read EX-1, even when its primary document is short", async () => {
  const urls = stubSec({
    [PRIMARY]: "COVER",
    [INDEX]: indexPage(
      { type: "EX-1", file: "ex1.htm", size: 9000 },
      { type: "EX-99.1", file: "ex2.htm", size: 10 },
    ),
    [EX2]: "NOTICE",
  });
  await fetchEventText(filing({ form: "6-K", items: "" }));
  assert.deepEqual(urls, [PRIMARY, INDEX, EX2]);
});

void test("XBRL data files do not count as an exhibit that could not be read", async () => {
  stubSec({
    [PRIMARY]: "COVER",
    [INDEX]: indexPage(
      { type: "EX-101.SCH", file: "data.xsd" },
      { type: "EX-104", file: "cover.xml" },
    ),
  });
  assert.equal(
    await fetchEventText(filing({ form: "6-K", items: "" })),
    "COVER",
  );
});

void test("a readable event appendix does not hide the unread main PDF report", async () => {
  for (const row of [
    filing({ form: "6-K", items: "" }),
    filing({ items: "8.01,9.01" }),
  ]) {
    const urls = stubSec({
      [PRIMARY]: "Cover text. ".repeat(3000),
      [INDEX]: indexPage(
        { type: "EX-99.1", file: "earnings.pdf", size: 1_000_000 },
        { type: "EX-99.2", file: "ex2.htm", size: 1000 },
      ),
      [EX2]: "Investor relations contacts",
    });
    const text = await fetchEventText(row);
    assert.ok(text.startsWith("This filing's main exhibit"));
    assert.ok(text.includes(`${STATEMENT}: ${BASE}earnings.pdf`));
    assert.ok(text.includes("Investor relations contacts"));
    assert.ok(!urls.includes(`${BASE}earnings.pdf`));
  }
});

void test("an unread exhibit warning preserves the primary disclosure in an ordinary 8-K excerpt", async () => {
  const row = filing({ items: "1.01,9.01" });
  await db.insert(filings).values(row);
  stubSec({
    [PRIMARY]:
      "Item 1.01. The company agreed to acquire Example for $900 million.",
    [INDEX]: indexPage(
      { type: "EX-99.1", file: "presentation.pdf", size: 100_000 },
      { type: "EX-99.2", file: "ex2.htm", size: 50_000 },
    ),
    [EX2]: "Supplementary investor relations appendix. ".repeat(1000),
  });
  const sections = await ensureSections(row);
  assert.match(sections?.text_head ?? "", /content was not read/);
  assert.match(sections?.text_head ?? "", /Item 1\.01.*\$900 million/);
  assert.match(sections?.text_head ?? "", /Supplementary investor relations/);
});

void test("a PDF-only exhibit says the content was not read, and counts as delivered", async () => {
  const pdf = `${BASE}results.pdf`;
  for (const row of [
    filing({ items: "2.02,9.01" }),
    filing({ items: "8.01,9.01" }),
    filing({ form: "6-K", items: "" }),
  ]) {
    await client.execute("DELETE FROM filings");
    const urls = stubSec({
      [PRIMARY]: "p".repeat(20_000),
      [INDEX]: indexPage({ type: "EX-99.1", file: "results.pdf" }),
    });
    const head = await savedHead(row);
    // The statement comes first so that no cap can drop it.
    assert.ok(head.startsWith("This filing's main exhibit"));
    assert.ok(head.includes(STATEMENT));
    assert.ok(head.includes(pdf));
    assert.ok(!urls.includes(pdf));
  }
});

void test("a 6-K whose only other exhibit is a PDF says so too", async () => {
  stubSec({
    [PRIMARY]: "COVER",
    [INDEX]: indexPage({ type: "EX-1", file: "results.pdf" }),
  });
  const text = await fetchEventText(filing({ form: "6-K", items: "" }));
  assert.ok(text.includes(STATEMENT));
  assert.ok(text.endsWith("Primary document:\nCOVER"));
});

void test("an image-only exhibit is named as unread and the rest of the filing is kept", async () => {
  stubSec({
    [PRIMARY]: "COVER",
    [INDEX]: indexPage(
      { type: "EX-99.1", file: "ex1.htm" },
      { type: "EX-99.2", file: "ex2.htm" },
    ),
    [EX1]: "RESULTS",
    [EX2]: `<html><body><img src="slide1.jpg"></body></html>`,
  });
  const text = await fetchEventText(filing({ items: "2.02,9.01" }));
  assert.ok(text.includes("RESULTS"));
  assert.ok(text.includes(`${STATEMENT}: ${EX2}`));
});

// 4. Inline XBRL viewer links

void test("exhibit links through the inline XBRL viewer are unwrapped", async () => {
  for (const href of [
    `/ix?doc=${FOLDER}ex1.htm`,
    `https://www.sec.gov/ix?doc=${FOLDER}ex1.htm`,
  ]) {
    const urls = stubSec({
      [PRIMARY]: "COVER",
      [INDEX]: indexPage({ type: "EX-99.1", file: "ex1.htm", href }),
      [EX1]: "RESULTS",
    });
    const text = await fetchEventText(filing());
    assert.deepEqual(urls, [PRIMARY, INDEX, EX1]);
    assert.ok(text.includes(`Exhibit source: ${EX1}`));
  }
});

void test("a PDF behind the viewer link is named by its real address", async () => {
  stubSec({
    [PRIMARY]: "COVER",
    [INDEX]: indexPage({
      type: "EX-99.1",
      file: "results.pdf",
      href: `/ix?doc=${FOLDER}results.pdf`,
    }),
  });
  const text = await fetchEventText(filing({ form: "6-K", items: "" }));
  assert.ok(text.includes(`${STATEMENT}: ${BASE}results.pdf`));
});

void test("the same-origin and same-folder check still applies, with or without the viewer", async () => {
  const other = "/Archives/edgar/data/2/000000000226000002/ex1.htm";
  for (const href of [
    other,
    `/ix?doc=${other}`,
    `/ix?doc=${FOLDER}../000000000226000002/ex1.htm`,
    "https://example.com/Archives/edgar/data/1/000000000126000001/ex1.htm",
    `https://example.com/ix?doc=${FOLDER}ex1.htm`,
    `/ix?doc=https://example.com${FOLDER}ex1.htm`,
    `/ix?doc=//example.com${FOLDER}ex1.htm`,
    "/ix?doc=ex1.htm",
    "/ix",
  ]) {
    const urls = stubSec({
      [PRIMARY]: "COVER",
      [INDEX]: indexPage({ type: "EX-99.1", file: "ex1.htm", href }),
    });
    await assert.rejects(fetchEventText(filing()), /Could not resolve/, href);
    assert.deepEqual(urls, [PRIMARY, INDEX], href);
  }
});

// 5. Blank text

void test("a blank event read is not saved, and a later good read is", async () => {
  const row = filing({ items: "5.02" });
  await db.insert(filings).values(row);
  stubSec({ [PRIMARY]: "<html><body>   </body></html>" });
  assert.equal(await ensureSections(row), null);
  assert.equal((await stored()).sectionsJson, null);

  stubSec({ [PRIMARY]: "OFFICER LEFT" });
  assert.equal((await ensureSections(row))?.text_head, "OFFICER LEFT");
  assert.equal(savedSections(await stored())?.text_head, "OFFICER LEFT");
});

void test("a blank report is not saved", async () => {
  const row = filing({ form: "10-K", items: "" });
  await db.insert(filings).values(row);
  stubSec({ [PRIMARY]: "   " });
  assert.equal(await ensureSections(row), null);
  assert.equal(await ensureSections(row, "  \n "), null);
  assert.equal((await stored()).sectionsJson, null);
});

void test("a filing with nothing to read beyond a statement throws rather than saving it", async () => {
  stubSec({
    [PRIMARY]: "  ",
    [INDEX]: indexPage({ type: "EX-99.1", file: "results.pdf" }),
  });
  await assert.rejects(fetchEventText(filing()), /Could not resolve/);
  stubSec({
    [PRIMARY]: "  ",
    [INDEX]: indexPage({ type: "EX-99.1", file: "ex1.htm" }),
    [EX1]: "<img src='a.jpg'>",
  });
  await assert.rejects(fetchEventText(filing()), /Could not resolve/);
});

void test("a blank primary document with a good exhibit still counts as read", async () => {
  stubSec({
    [PRIMARY]: "  ",
    [INDEX]: indexPage({ type: "EX-99.1", file: "ex1.htm" }),
    [EX1]: "RESULTS",
  });
  const head = await savedHead(filing({ items: "2.02,9.01" }));
  assert.ok(head.includes("RESULTS"));
});

// 6. A failed diff

const report = (year: string) =>
  `Item 1A. Risk Factors\n${`Risk text ${year}. `.repeat(20)}\nItem 1B. Unresolved\nItem 7. Management's Discussion and Analysis\n${`Revenue grew in ${year}. `.repeat(20)}\nItem 7A. Quantitative`;

void test("a failed read of the previous filing keeps the current sections, and a later run makes the diff", async () => {
  const previousUrl = `${BASE}previous.htm`;
  const previous = filing({
    accessionNo: "previous",
    form: "10-K",
    filedAt: "2025-11-04",
    primaryDocUrl: previousUrl,
    items: "",
  });
  const current = filing({ form: "10-K", items: "" });
  await db.insert(filings).values([previous, current]);

  stubSec({ [PRIMARY]: report("2026") });
  const first = await ensureSections(current);
  assert.ok(first?.risk_factors?.includes("Risk text 2026"));
  assert.ok(first?.mda?.includes("Revenue grew in 2026"));
  assert.equal(first?.diff, null);
  const saved = await stored();
  assert.equal(savedSections(saved)?.diff, null);
  assert.ok(savedSections(saved)?.mda?.includes("Revenue grew in 2026"));

  const urls = stubSec({ [previousUrl]: report("2025") });
  const later = await ensureSections(saved);
  assert.deepEqual(urls, [previousUrl]);
  assert.ok(later?.diff?.includes("### Added"));
  assert.equal(savedSections(await stored())?.diff, later?.diff);
});

void test("a blank previous filing also leaves the current sections intact", async () => {
  const previousUrl = `${BASE}previous.htm`;
  const previous = filing({
    accessionNo: "previous",
    form: "10-K",
    filedAt: "2025-11-04",
    primaryDocUrl: previousUrl,
    items: "",
  });
  const current = filing({ form: "10-K", items: "" });
  await db.insert(filings).values([previous, current]);
  stubSec({ [PRIMARY]: report("2026"), [previousUrl]: "  " });
  const sections = await ensureSections(current);
  assert.ok(sections?.mda?.includes("2026"));
  assert.equal(sections?.diff, null);
  assert.equal((await stored("previous")).sectionsJson, null);
});

void test("a report with a readable previous filing still gets its diff straight away", async () => {
  const previousUrl = `${BASE}previous.htm`;
  const previous = filing({
    accessionNo: "previous",
    form: "10-K",
    filedAt: "2025-11-04",
    primaryDocUrl: previousUrl,
    items: "",
  });
  const current = filing({ form: "10-K", items: "" });
  await db.insert(filings).values([previous, current]);
  stubSec({ [PRIMARY]: report("2026"), [previousUrl]: report("2025") });
  const sections = await ensureSections(current);
  assert.ok(sections?.diff?.includes("### Added"));
  assert.equal(sections?.text_format, 4);
});

// 7. Rows saved before exhibits were read

const coverOnly: Sections = {
  risk_factors: null,
  mda: null,
  diff: null,
  text_head: "OLD COVER",
};
const currentCover: Sections = { ...coverOnly, text_format: 5 };

void test("a cached event refreshes mixed-format exhibit coverage once", async () => {
  const row = filing({
    items: "1.01,9.01",
    sectionsJson: JSON.stringify({ ...coverOnly, text_format: 4 }),
    processedAt: "2026-11-04T00:00:00.000Z",
  });
  await db.insert(filings).values(row);
  const urls = stubSec({
    [PRIMARY]: "Item 1.01. Acquisition agreement.",
    [INDEX]: indexPage(
      { type: "EX-99.1", file: "presentation.pdf" },
      { type: "EX-99.2", file: "ex2.htm" },
    ),
    [EX2]: "Investor contacts.",
  });
  const refreshed = await ensureSections(row);
  assert.match(refreshed?.text_head ?? "", /content was not read/);
  assert.match(refreshed?.text_head ?? "", /Acquisition agreement/);
  urls.length = 0;
  assert.equal(
    (await ensureSections(await stored()))?.text_head,
    refreshed?.text_head,
  );
  assert.deepEqual(urls, []);
});

void test("a failed exhibit-coverage refresh keeps cached text with a warning and retries later", async () => {
  const row = filing({
    items: "1.01,9.01",
    sectionsJson: JSON.stringify({ ...coverOnly, text_format: 4 }),
    processedAt: "2026-11-04T00:00:00.000Z",
  });
  await db.insert(filings).values(row);
  const urls = stubSec({});
  const result = await ensureSections(row);
  assert.match(result?.text_head ?? "", /could not recheck.*exhibits/i);
  assert.match(result?.text_head ?? "", /OLD COVER/);
  assert.equal(savedSections(await stored())?.text_format, 4);
  urls.length = 0;
  await ensureSections(await stored());
  assert.ok(urls.length > 0);
});

void test("a saved 8-K with item 9.01 is read again once and overwritten", async () => {
  const row = filing({
    items: "2.02,9.01",
    sectionsJson: JSON.stringify(coverOnly),
    processedAt: "2026-11-04T00:00:00.000Z",
  });
  await db.insert(filings).values(row);
  const urls = stubSec({
    [PRIMARY]: "COVER",
    [INDEX]: indexPage({ type: "EX-99.1", file: "ex1.htm" }),
    [EX1]: "RESULTS",
  });
  const refreshed = await ensureSections(row);
  assert.ok(refreshed?.text_head?.includes("RESULTS"));
  assert.equal(refreshed?.text_format, 5);
  const saved = await stored();
  assert.equal(savedSections(saved)?.text_head, refreshed?.text_head);
  assert.equal(savedSections(saved)?.text_format, 5);

  urls.length = 0;
  assert.equal((await ensureSections(saved))?.text_head, refreshed?.text_head);
  assert.deepEqual(urls, []);
});

void test("a new event read records its text format for every event form", async () => {
  for (const form of ["8-K", "8-K/A", "6-K", "6-K/A"]) {
    await client.execute("DELETE FROM filings");
    const row = filing({ form, items: "5.02" });
    await db.insert(filings).values(row);
    stubSec({ [PRIMARY]: "BODY", [INDEX]: indexPage() });
    assert.equal(
      (await ensureSections(row))?.text_format,
      form.startsWith("6-K") ? 5 : 4,
    );
  }
});

void test("a saved event in the current text format is not read again", async () => {
  const row = filing({
    items: "5.02",
    sectionsJson: JSON.stringify(currentCover),
  });
  const urls = stubSec({});
  assert.equal((await ensureSections(row))?.text_head, "OLD COVER");
  assert.deepEqual(urls, []);
});

void test("a saved 6-K is not read again unless its text is blank", async () => {
  const saved = filing({
    form: "6-K",
    items: "",
    sectionsJson: JSON.stringify(currentCover),
  });
  let urls = stubSec({});
  assert.equal((await ensureSections(saved))?.text_head, "OLD COVER");
  assert.deepEqual(urls, []);

  const blank = filing({
    form: "6-K",
    items: "",
    sectionsJson: JSON.stringify({ ...currentCover, text_head: " " }),
  });
  await db.insert(filings).values(blank);
  urls = stubSec({ [PRIMARY]: "REAL TEXT", [INDEX]: indexPage() });
  assert.equal((await ensureSections(blank))?.text_head, "REAL TEXT");
  assert.deepEqual(urls, [PRIMARY, INDEX]);
});

void test("a saved 8-K with blank text is read again whatever its items", async () => {
  const row = filing({
    items: "5.02",
    sectionsJson: JSON.stringify({ ...currentCover, text_head: "" }),
  });
  await db.insert(filings).values(row);
  stubSec({ [PRIMARY]: "REAL TEXT" });
  assert.equal((await ensureSections(row))?.text_head, "REAL TEXT");
});

void test("a failed refresh of a processed filing returns the saved text and keeps it", async () => {
  const row = filing({
    sectionsJson: JSON.stringify(coverOnly),
    processedAt: "2026-11-04T00:00:00.000Z",
  });
  await db.insert(filings).values(row);
  stubSec({ [PRIMARY]: "COVER" }); // the index answers 404
  const text = (await ensureSections(row))?.text_head ?? "";
  assert.match(text, /could not recheck.*exhibits/);
  assert.ok(text.endsWith("OLD COVER"));
  assert.deepEqual(savedSections(await stored()), coverOnly);
});

void test("a failed refresh of a processed filing with nothing saved worth keeping is a failed read", async () => {
  const row = filing({
    sectionsJson: JSON.stringify({ ...coverOnly, text_head: "" }),
    processedAt: "2026-11-04T00:00:00.000Z",
  });
  stubSec({ [PRIMARY]: "COVER" });
  assert.equal(await ensureSections(row), null);
});

void test("a failed refresh of a pending filing is a failed read", async () => {
  const row = filing({ sectionsJson: JSON.stringify(coverOnly) });
  await db.insert(filings).values(row);
  stubSec({ [PRIMARY]: "COVER" });
  assert.equal(await ensureSections(row), null);
  assert.deepEqual(savedSections(await stored()), coverOnly);
});

void test("a blank refresh of a processed filing does not overwrite its saved text", async () => {
  const row = filing({
    sectionsJson: JSON.stringify(coverOnly),
    processedAt: "2026-11-04T00:00:00.000Z",
  });
  await db.insert(filings).values(row);
  stubSec({ [PRIMARY]: "  ", [INDEX]: indexPage() });
  const text = (await ensureSections(row))?.text_head ?? "";
  assert.match(text, /could not recheck.*exhibits/);
  assert.ok(text.endsWith("OLD COVER"));
  assert.deepEqual(savedSections(await stored()), coverOnly);
});

// 8. Forms never filed before

const dateAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toLocaleDateString("en-CA");
const filingDateAgo = (days: number) =>
  new Date(
    Date.parse(
      new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
    ) -
      days * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);

function stubSubmissions(rows: { acc: string; form: string; age: number }[]) {
  stubSec({
    "https://data.sec.gov/submissions/CIK0000000001.json": JSON.stringify({
      filings: {
        recent: {
          accessionNumber: rows.map((r) => r.acc),
          filingDate: rows.map((r) => filingDateAgo(r.age)),
          form: rows.map((r) => r.form),
          primaryDocument: rows.map((r) => `${r.acc}.htm`),
          items: rows.map(() => ""),
        },
      },
    }),
  });
}

const pendingOf = async () =>
  (await syncFilings("TEST", "1")).map((f) => f.accessionNo);

void test("a ticker's very first sync treats only the last 7 days as new", async () => {
  stubSubmissions([
    { acc: "new", form: "10-K", age: 6 },
    { acc: "week-old", form: "20-F", age: 8 },
    { acc: "month-old", form: "10-Q", age: 25 },
  ]);
  assert.deepEqual(await pendingOf(), ["new"]);
  assert.ok((await stored("week-old")).processedAt);
  assert.ok((await stored("month-old")).processedAt);
});

void test("after the first sync every form counts as new for 30 days, even one never filed before", async () => {
  await db
    .insert(filings)
    .values(filing({ accessionNo: "old", processedAt: "done" }));
  stubSubmissions([
    { acc: "first-20f", form: "20-F", age: 8 },
    { acc: "first-10ka", form: "10-K/A", age: 29 },
    { acc: "known-8k", form: "8-K", age: 29 },
    { acc: "too-old-20f", form: "20-F", age: 31 },
    { acc: "too-old-8k", form: "8-K", age: 31 },
  ]);
  assert.deepEqual((await pendingOf()).sort(), [
    "first-10ka",
    "first-20f",
    "known-8k",
  ]);
  assert.ok((await stored("too-old-20f")).processedAt);
  assert.ok((await stored("too-old-8k")).processedAt);
});

void test("filing windows include the boundary SEC calendar date throughout the day", async () => {
  for (const instant of [
    "2026-11-05T05:30:00Z",
    "2026-11-05T17:00:00Z",
    "2026-11-06T00:01:00Z",
    "2026-11-06T04:59:00Z",
  ]) {
    mock.timers.enable({ apis: ["Date"], now: Date.parse(instant) });
    try {
      for (const [boundary, older, existing, lastReview] of [
        ["2026-10-29", "2026-10-28", false, null],
        ["2026-10-06", "2026-10-05", true, null],
        ["2026-07-28", "2026-07-27", true, "2026-01-01T12:00:00Z"],
      ] as const) {
        await client.execute("DELETE FROM filings");
        if (existing)
          await db
            .insert(filings)
            .values(filing({ accessionNo: "old", processedAt: "done" }));
        stubSec({
          "https://data.sec.gov/submissions/CIK0000000001.json": JSON.stringify(
            {
              filings: {
                recent: filingList([
                  ["boundary", "10-Q", boundary],
                  ["older", "8-K", older],
                ]),
              },
            },
          ),
        });
        assert.deepEqual(
          (await syncFilings("TEST", "1", lastReview)).map(
            (f) => f.accessionNo,
          ),
          ["boundary"],
          `${instant}, ${boundary}`,
        );
      }
    } finally {
      mock.timers.reset();
    }
  }
});

// 9. Giving up on a filing

void test("a filing is given up on UNREADABLE_RETRY_DAYS after its first failure, not its filing date", async () => {
  assert.equal(UNREADABLE_RETRY_DAYS, 5);
  // Filed long before the job first saw it, so its retries start from now.
  const filing = { accessionNo: "late-1", filedAt: "2026-10-01" };
  assert.equal(await gaveUpOnFiling(filing, "2026-11-04"), false);
  assert.equal(await gaveUpOnFiling(filing, "2026-11-05"), false);
  assert.equal(await gaveUpOnFiling(filing, "2026-11-09"), false);
  assert.equal(await gaveUpOnFiling(filing, "2026-11-10"), true);
  assert.equal(await gaveUpOnFiling(filing, "2026-12-30"), true);
  // Each filing keeps its own count.
  assert.equal(
    await gaveUpOnFiling({ accessionNo: "late-2" }, "2026-12-30"),
    false,
  );
});

// Found by attacking real filings: each of these lost or garbled something a review needed.

const GOING_CONCERN =
  "There is substantial doubt about our ability to continue as a going concern.";
const WEAKNESS =
  "We identified a material weakness in internal control over financial reporting.";
const boilerplate = (seed: string, count: number) =>
  Array.from(
    { length: count },
    (_, i) =>
      `The company ${seed} considers operating matter number ${i} across several business lines and geographic regions today.`,
  ).join("\n");

void test("a cap keeps the serious change, wherever it sits in the section", () => {
  const before = boilerplate("previously", 400);
  const after = `${boilerplate("currently", 400)}\n${GOING_CONCERN}\n${WEAKNESS}`;
  const diff = compactDiff(
    { risk_factors: before, mda: before },
    { risk_factors: after, mda: after },
  );
  const [risk, mda] = diff.split("## MD&A");
  for (const part of [risk, mda]) {
    assert.ok(part?.includes(GOING_CONCERN));
    assert.ok(part?.includes(WEAKNESS));
  }
  assert.ok(diff.length < 18_000);
  assert.match(diff, /less important changes are left out/);
  assert.match(diff, /filing_changes_/);
});

void test("a new idea outranks a routine update of the same sentence", () => {
  const routine = (quarter: string, value: number) =>
    `As of ${quarter} we held ${value} million in cash and equivalents across our main operating subsidiaries and regions.`;
  const before = Array.from({ length: 60 }, (_, i) => routine("March", i)).join(
    "\n",
  );
  const fresh =
    "We are now effectively shut out of our second largest market by new government export rules affecting nearly all products.";
  const after = `${Array.from({ length: 60 }, (_, i) => routine("June", i + 100)).join("\n")}\n${fresh}`;
  const diff = compactDiff(
    { risk_factors: before, mda: null },
    { risk_factors: after, mda: null },
  );
  const added = diff.split("### Added")[1] ?? "";
  assert.ok(added.includes(fresh));
  assert.ok(added.indexOf(fresh) < added.indexOf("As of June"));
});

void test("a sentence keeps its words across abbreviations", () => {
  const diff = compactDiff(
    {
      risk_factors:
        "Acme Inc. is our supplier. Contract No. 5 covers 3.5 billion dollars. We sell in the U.S. and abroad.",
      mda: null,
    },
    {
      risk_factors:
        "Beta Inc. is our supplier. Contract No. 6 covers 3.5 billion dollars. We sell in the U.S. and abroad.",
      mda: null,
    },
  );
  assert.ok(diff.includes("+ Beta Inc. is our supplier."));
  assert.ok(diff.includes("- Acme Inc. is our supplier."));
  assert.ok(diff.includes("+ Contract No. 6 covers 3.5 billion dollars."));
  assert.ok(!diff.includes("We sell in the U.S."));
});

void test("one changed table row is one change, not the whole table", () => {
  const table = (revenue: string) =>
    `Net sales $100 $90\nRevenue ${revenue} $80\nOperating income $20 $15`;
  const diff = compactDiff(
    { risk_factors: table("$90"), mda: null },
    { risk_factors: table("$95"), mda: null },
  );
  assert.ok(diff.includes("+ Revenue $95 $80"));
  assert.ok(!diff.includes("+ Net sales"));
});

void test("table cells stay apart, and a negative keeps its parenthesis", () => {
  const text = filingHtmlToText(`<table>
    <tr><td><p>Interest expense, net</p></td><td><p>(107.2</p></td><td><p>)</p></td><td>&nbsp;&nbsp;</td><td>(104.2</td><td>)</td></tr>
    <tr><td>Revenue</td><td>$</td><td>4,938</td><td>$</td><td>4,412</td><td>12</td><td>%</td></tr>
  </table>`);
  const lines = text.split("\n").filter(Boolean);
  assert.equal(lines[0], "Interest expense, net (107.2) (104.2)");
  assert.equal(lines[1], "Revenue $4,938 $4,412 12%");
});

void test("a whole page laid out in one table cell keeps its paragraphs", () => {
  const paragraph =
    "A long paragraph of real prose about the business. ".repeat(50);
  const text = filingHtmlToText(
    `<table><tr><td><p>${paragraph}</p><p>Item 7. Next section</p></td></tr></table>`,
  );
  assert.match(text, /^Item 7\. Next section$/m);
});

void test("a PDF is not read as text", async () => {
  stubSec({ [PRIMARY]: "%PDF-1.7 binary" });
  await assert.rejects(fetchFilingText(PRIMARY), /Not a text document/);
});

void test("a heading-only section ends on a whole sentence", () => {
  const body = "Responding to regulatory inquiries can be time consuming. ";
  const { risk_factors: risk } = extractSections(
    "10-K",
    `preface ${"x".repeat(5000)}\n    RISK FACTORS\n${body.repeat(4000)}`,
  );
  assert.ok(risk?.includes("Cut off here"));
  assert.match(risk ?? "", /time consuming\.\n\[Cut off here/);
});

void test("a capped results excerpt keeps the income statement", () => {
  const front = "Headline results and commentary from management. ".repeat(
    2000,
  );
  const text = `${front}\nCONSOLIDATED STATEMENT OF INCOME\nNet sales 79,195 74,976\n${"x".repeat(50_000)}`;
  const excerpt = eventExcerpt(text, 40_000);
  assert.ok(excerpt.startsWith("Headline results"));
  assert.ok(excerpt.includes("Net sales 79,195 74,976"));
  assert.ok(excerpt.length < 40_100);
  // Already in the opening, or absent: a plain cap as before.
  const early = `CONSOLIDATED STATEMENT OF INCOME\nNet sales 1\n${front}`;
  assert.equal(
    eventExcerpt(early, 1000),
    `${early.slice(0, 1000)}\n[truncated]`,
  );
  assert.equal(
    eventExcerpt(front, 1000),
    `${front.slice(0, 1000)}\n[truncated]`,
  );
  assert.equal(eventExcerpt("short", 1000), "short");
});

void test("old saved sections are read again on both sides of a diff", async () => {
  const previousUrl = `${BASE}previous.htm`;
  const report = (risk: string) =>
    `<p>Item 1A. Risk Factors</p><p>${risk} ${"Filler risk text. ".repeat(10)}</p><p>Item 1B. Unresolved</p>`;
  const stale: Sections = {
    risk_factors: "Revenue$5$4 runs together.",
    mda: null,
    diff: "old diff",
    text_head: null,
  };
  const previous = filing({
    accessionNo: "0000000001-25-000001",
    form: "10-K",
    filedAt: "2025-02-01",
    primaryDocUrl: previousUrl,
    items: "",
    sectionsJson: JSON.stringify(stale),
    processedAt: "2025-02-02T00:00:00.000Z",
  });
  const current = filing({
    form: "10-K",
    items: "",
    sectionsJson: JSON.stringify(stale),
    processedAt: "2026-02-02T00:00:00.000Z",
  });
  await db.insert(filings).values([previous, current]);
  const urls = stubSec({
    [PRIMARY]: report("New risk appears here."),
    [previousUrl]: report("Old risk."),
  });
  const sections = await ensureSections(current);
  assert.equal(sections?.text_format, 4);
  assert.equal(sections?.diff_version, 4);
  assert.ok(sections?.diff?.includes("+ New risk appears here."));
  assert.ok(!sections?.diff?.includes("Revenue$5$4"));
  assert.deepEqual(urls.sort(), [PRIMARY, previousUrl].sort());

  // Current on both sides: no more requests.
  urls.length = 0;
  const [saved] = await db
    .select()
    .from(filings)
    .where(eq(filings.accessionNo, ACCESSION));
  assert.ok(saved);
  assert.equal((await ensureSections(saved))?.diff, sections?.diff);
  assert.deepEqual(urls, []);
  // The two formats are never compared when the old side cannot be refreshed.
  const everything = await fullChanges(saved, savedSections(saved)!);
  assert.ok(everything?.includes("+ New risk appears here."));
});

void test("a failed refresh of the previous filing never compares two text formats", async () => {
  const previousUrl = `${BASE}previous.htm`;
  const stale: Sections = {
    risk_factors: "Revenue$5$4 runs together in the old format here.",
    mda: null,
    diff: null,
    text_head: null,
  };
  const previous = filing({
    accessionNo: "0000000001-25-000001",
    form: "10-K",
    filedAt: "2025-02-01",
    primaryDocUrl: previousUrl,
    items: "",
    sectionsJson: JSON.stringify(stale),
    processedAt: "2025-02-02T00:00:00.000Z",
  });
  const current = filing({ form: "10-K", items: "" });
  await db.insert(filings).values([previous, current]);
  stubSec({
    [PRIMARY]: `Item 1A. Risk Factors\n${"Current risk text. ".repeat(10)}\nItem 1B. Unresolved`,
  });
  const sections = await ensureSections(current);
  assert.ok(sections?.risk_factors?.includes("Current risk text"));
  assert.equal(sections?.diff, null);
});

const submissions = (
  rows: [string, string, string][],
  files: { name: string; filingTo: string }[] = [],
) => ({
  filings: { recent: filingList(rows), files },
});
const filingList = (rows: [string, string, string][]) => ({
  accessionNumber: rows.map((r) => r[0]),
  form: rows.map((r) => r[1]),
  filingDate: rows.map((r) => r[2]),
  primaryDocument: rows.map(() => "doc.htm"),
  items: rows.map(() => ""),
});
const daysAgoIso = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const SUBMISSIONS = "https://data.sec.gov/submissions/CIK0000000001.json";

void test("a heavy filer's older pages supply last year's annual report", async () => {
  const page2 =
    "https://data.sec.gov/submissions/CIK0000000001-submissions-002.json";
  const page1 =
    "https://data.sec.gov/submissions/CIK0000000001-submissions-001.json";
  const urls = stubSec({
    [SUBMISSIONS]: JSON.stringify(
      submissions(
        [["a-1", "10-K", daysAgoIso(200)]],
        [
          {
            name: "CIK0000000001-submissions-001.json",
            filingTo: daysAgoIso(300),
          },
          {
            name: "CIK0000000001-submissions-002.json",
            filingTo: daysAgoIso(400),
          },
          {
            name: "CIK0000000001-submissions-003.json",
            filingTo: daysAgoIso(900),
          },
        ],
      ),
    ),
    [page1]: JSON.stringify(filingList([["b-1", "424B2", daysAgoIso(310)]])),
    [page2]: JSON.stringify(filingList([["b-2", "10-K", daysAgoIso(560)]])),
  });
  await syncFilings("TEST", "1");
  const rows = await db
    .select()
    .from(filings)
    .where(eq(filings.ticker, "TEST"));
  assert.deepEqual(rows.map((r) => r.accessionNo).sort(), ["a-1", "b-2"]);
  // Stops once it has what it needs, and never reads past the history window.
  assert.ok(!urls.some((u) => u.includes("-003")));
  assert.equal(urls.length, 3);
  // Both annual reports are known now, so no more paging.
  urls.length = 0;
  await syncFilings("TEST", "1");
  assert.deepEqual(urls, [SUBMISSIONS]);
});

void test("a search of older pages that found nothing waits 30 days", async () => {
  const page =
    "https://data.sec.gov/submissions/CIK0000000001-submissions-001.json";
  const urls = stubSec({
    [SUBMISSIONS]: JSON.stringify(
      submissions(
        [["a-1", "10-K", daysAgoIso(200)]],
        [
          {
            name: "CIK0000000001-submissions-001.json",
            filingTo: daysAgoIso(300),
          },
        ],
      ),
    ),
    [page]: JSON.stringify(filingList([["b-1", "424B2", daysAgoIso(310)]])),
  });
  await syncFilings("TEST", "1");
  assert.ok(urls.includes(page));
  urls.length = 0;
  await syncFilings("TEST", "1");
  assert.deepEqual(urls, [SUBMISSIONS]);
});

void test("a late filing notice is tracked and forces a full review", async () => {
  assert.ok(FULL_REVIEW_FORMS.has("NT 10-Q"));
  assert.ok(FULL_REVIEW_FORMS.has("NT 10-K"));
  assert.equal(filingSummary("NT 10-Q", null), "Late filing notice");
  stubSec({
    [SUBMISSIONS]: JSON.stringify(
      submissions([["n-1", "NT 10-Q", daysAgoIso(1)]]),
    ),
  });
  const pending = await syncFilings("TEST", "1");
  assert.deepEqual(
    pending.map((f) => f.form),
    ["NT 10-Q"],
  );
});

void test("a filing whose number or date could not be part of a file name is not tracked", async () => {
  stubSec({
    [SUBMISSIONS]: JSON.stringify(
      submissions([
        // Both fields are later joined into file names under data/packs.
        ["x/../../../../../outside", "8-K", daysAgoIso(1)],
        ["..", "8-K", daysAgoIso(1)],
        ["0000000001-26-000002", "8-K", `../../${daysAgoIso(1)}`],
        ["0000000001-26-000003", "8-K", "not a date"],
        // The right shape, but no such day: its age cannot be worked out, so nothing dates it.
        ["0000000001-26-000005", "8-K", "2026-13-45"],
        ["0000000001-26-000004", "8-K", daysAgoIso(1)],
      ]),
    ),
  });
  const pending = await syncFilings("TEST", "1");
  assert.deepEqual(
    pending.map((f) => f.accessionNo),
    ["0000000001-26-000004"],
  );
  const rows = await db
    .select()
    .from(filings)
    .where(eq(filings.ticker, "TEST"));
  assert.deepEqual(
    rows.map((r) => r.accessionNo),
    ["0000000001-26-000004"],
  );
});

void test("an annual report in an exhibit is found and excerpted", async () => {
  assert.equal(
    incorporatesAnnualReport("20-F", {
      risk_factors: "x".repeat(9000),
      mda: null,
    }),
    true,
  );
  assert.equal(
    incorporatesAnnualReport("10-K", { risk_factors: "see EX-13", mda: null }),
    true,
  );
  assert.equal(
    incorporatesAnnualReport("10-K", {
      risk_factors: "x".repeat(9000),
      mda: null,
    }),
    false,
  );
  assert.equal(
    incorporatesAnnualReport("10-Q", { risk_factors: null, mda: null }),
    false,
  );
  stubSec({
    [INDEX]: indexPage(
      { type: "EX-15.2", file: "small.htm", size: 10 },
      { type: "EX-15.1", file: "annual.htm", size: 900 },
      { type: "EX-15.3", file: "scan.pdf", size: 9000 },
    ),
    [`${BASE}annual.htm`]: "<p>Annual report</p>",
  });
  const row = filing({ form: "20-F", items: "" });
  const exhibit = await fetchAnnualExhibit(row);
  assert.equal(exhibit?.url, `${BASE}annual.htm`);
  assert.equal(await fetchAnnualExhibit(filing({ form: "10-Q" })), null);
  const text = `${"front ".repeat(10_000)}\nRisk management\nWe rely on one active ingredient.\n${"more ".repeat(100)}\nFinancial performance\nSales rose.\n${"tail ".repeat(100)}`;
  const excerpt = annualExhibitExcerpt(text);
  assert.ok(excerpt.includes("We rely on one active ingredient."));
  assert.ok(excerpt.includes("Sales rose."));
});

const fundFixture = {
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

async function inPackFolder(work: () => Promise<void>) {
  const temp = mkdtempSync(path.join(tmpdir(), "portchecker-edgar-pack-"));
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

const reportDoc = (risk: string, mda: string) =>
  `<p>Item 1A. Risk Factors</p><p>${risk}</p><p>Item 2. Unregistered Sales</p><p>Item 2. Management's Discussion and Analysis</p><p>${mda} ${"Discussion of results here. ".repeat(10)}</p><p>Item 3. Quantitative disclosures</p>`;

void test("a 10-Q that points back keeps the earlier 10-Q's risk updates in the pack", async () => {
  await inPackFolder(async () => {
    const q = (accession: string, filedAt: string, doc: string) =>
      filing({
        accessionNo: accession,
        form: "10-Q",
        filedAt,
        items: "",
        primaryDocUrl: `${BASE}${doc}`,
        processedAt: "2026-01-01T00:00:00.000Z",
      });
    await db.insert(filings).values([
      filing({
        accessionNo: "k-1",
        form: "10-K",
        filedAt: "2026-02-01",
        items: "",
        primaryDocUrl: `${BASE}annual.htm`,
        processedAt: "2026-01-01T00:00:00.000Z",
      }),
      q("q-1", "2026-05-01", "march.htm"),
      q("q-2", "2026-10-30", "sept.htm"),
    ]);
    stubSec({
      [`${BASE}annual.htm`]: `<p>Item 1A. Risk Factors</p><p>${"Annual risk. ".repeat(40)}</p><p>Item 1B. Unresolved</p><p>Item 7. Management's Discussion and Analysis</p><p>${"Annual results. ".repeat(40)}</p><p>Item 8. Financial Statements</p>`,
      [`${BASE}march.htm`]: reportDoc(
        `Our realignment is expected to reduce our workforce by approximately 20%. ${"More detail on the plan. ".repeat(60)}`,
        "March results.",
      ),
      [`${BASE}sept.htm`]: reportDoc(
        "No material updates beyond our Annual Report and our Quarterly Reports on Form 10-Q for March and June. " +
          "Further words so this is not a table of contents entry at all.",
        "September results.",
      ),
    });
    const { written } = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: fundFixture,
      includeFilings: true,
    });
    const interim = written.find(
      (n) =>
        n.startsWith("filing_sections_10-Q_2026-05-01") && n.endsWith(".md"),
    );
    assert.ok(interim, `no interim file in ${written.join(", ")}`);
    const body = readFileSync(
      path.join("data", "packs", "2026-11-04", "TEST", interim),
      "utf8",
    );
    assert.match(body, /workforce by approximately 20%/);
    assert.ok(!body.includes("March results"));
  });
});

void test("a 10-Q that stands alone adds no older 10-Q to the pack", async () => {
  await inPackFolder(async () => {
    const q = (accession: string, filedAt: string, doc: string) =>
      filing({
        accessionNo: accession,
        form: "10-Q",
        filedAt,
        items: "",
        primaryDocUrl: `${BASE}${doc}`,
        processedAt: "2026-01-01T00:00:00.000Z",
      });
    await db
      .insert(filings)
      .values([
        q("q-1", "2026-05-01", "march.htm"),
        q("q-2", "2026-10-30", "sept.htm"),
      ]);
    stubSec({
      [`${BASE}march.htm`]: reportDoc(`${"Long risk. ".repeat(200)}`, "March."),
      [`${BASE}sept.htm`]: reportDoc(`${"Long risk. ".repeat(200)}`, "Sept."),
    });
    const { written } = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: fundFixture,
      includeFilings: true,
    });
    assert.ok(
      !written.some(
        (n) => n.includes("2026-05-01") && n.startsWith("filing_sections"),
      ),
    );
    assert.ok(
      written.some((n) => n.startsWith("filing_sections_10-Q_2026-10-30")),
    );
  });
});

void test("a full pack holds every changed sentence, and a results filing's whole text", async () => {
  await inPackFolder(async () => {
    const annual = (risk: string) =>
      `<p>Item 1A. Risk Factors</p><p>${risk} ${"Stable risk text stays. ".repeat(10)}</p><p>Item 1B. Unresolved</p><p>Item 7. Management's Discussion and Analysis</p><p>${"Stable results text stays. ".repeat(10)}</p><p>Item 8. Financial Statements</p>`;
    await db.insert(filings).values([
      filing({
        accessionNo: "k-0",
        form: "10-K",
        filedAt: "2025-02-01",
        items: "",
        primaryDocUrl: `${BASE}old.htm`,
        processedAt: "2025-03-01T00:00:00.000Z",
      }),
      filing({
        accessionNo: "k-1",
        form: "10-K",
        filedAt: "2026-02-01",
        items: "",
        primaryDocUrl: `${BASE}new.htm`,
        processedAt: "2026-03-01T00:00:00.000Z",
      }),
      filing({
        accessionNo: "e-1",
        filedAt: "2026-11-03",
        items: "2.02,9.01",
        processedAt: "2026-11-03T12:00:00.000Z",
      }),
    ]);
    stubSec({
      [`${BASE}old.htm`]: annual("Old risk sentence is here."),
      [`${BASE}new.htm`]: annual("A brand new risk sentence is here."),
      [PRIMARY]: "<p>Cover</p>",
      [`${BASE}e-1-index.html`]: indexPage({
        type: "EX-99.1",
        file: "ex1.htm",
      }),
      [EX1]: `<p>${"Quarterly commentary continues here. ".repeat(3000)}</p><p>THE LAST LINE OF THE RELEASE</p>`,
    });
    const { dir, written } = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: fundFixture,
      includeFilings: true,
    });
    const changes = written.find((n) =>
      n.startsWith("filing_changes_10-K_2026-02-01"),
    );
    assert.ok(changes, written.join(", "));
    assert.match(
      readFileSync(path.join(dir, changes), "utf8"),
      /\+ A brand new risk sentence is here\./,
    );
    const event = written.find((n) => n.startsWith("filing_event_2026-11-03"));
    assert.ok(event, written.join(", "));
    assert.match(
      readFileSync(path.join(dir, event), "utf8"),
      /THE LAST LINE OF THE RELEASE/,
    );
    const excerpt = written.find((n) => n.startsWith("new_8k_2026-11-03"));
    assert.ok(excerpt);
    assert.ok(
      !readFileSync(path.join(dir, excerpt), "utf8").includes("THE LAST LINE"),
    );
    assert.ok(existsSync(dir) && readdirSync(dir).length > 3);
  });
});

void test("a 20-F's exhibit reaches the pack, and a failed read is stated", async () => {
  await inPackFolder(async () => {
    const twenty = filing({
      accessionNo: "f-1",
      form: "20-F",
      filedAt: "2026-02-04",
      items: "",
      processedAt: "2026-03-01T00:00:00.000Z",
    });
    await db.insert(filings).values(twenty);
    const doc = `<p>Item 3.D. Risk Factors</p><p>${"See our annual report for risks. ".repeat(10)}</p><p>Item 4. Company</p><p>Item 5. Operating and Financial Review</p><p>${"See our annual report for results. ".repeat(10)}</p><p>Item 6. Directors</p>`;
    stubSec({
      [PRIMARY]: doc,
      [`${BASE}f-1-index.html`]: indexPage({
        type: "EX-15.1",
        file: "annual.htm",
        size: 50,
      }),
      [`${BASE}annual.htm`]: `<p>${"Front matter. ".repeat(500)}</p><p>Risk management</p><p>We depend on one active ingredient.</p><p>${"Detail. ".repeat(50)}</p>`,
    });
    const { dir, written } = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: fundFixture,
      includeFilings: true,
    });
    assert.ok(
      written.some((n) => n.startsWith("filing_exhibit_20-F")),
      written.join(", "),
    );
    const sections = written.find((n) => n.startsWith("filing_sections_20-F"));
    assert.ok(sections);
    assert.match(
      readFileSync(path.join(dir, sections), "utf8"),
      /## Annual report exhibit[\s\S]*one active ingredient/,
    );

    stubSec({ [PRIMARY]: doc });
    const failed = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: fundFixture,
      includeFilings: true,
    });
    const pack = JSON.parse(
      readFileSync(path.join(failed.dir, "pack.json"), "utf8"),
    ) as { data_notes: string[] };
    assert.ok(pack.data_notes.some((n) => n.includes("annual report exhibit")));
  });
});

void test("a filing wrapped line by line still diffs by sentence", () => {
  const wrap = (text: string) =>
    text
      .match(/.{1,58}(?:\s|$)/g)!
      .map((l) => l.trim())
      .join("\n");
  const prose = (cash: string) =>
    Array.from(
      { length: 12 },
      (_, i) =>
        `Our business number ${i} operates across several regions and provides critical services to institutional customers around the world.`,
    ).join(" ") +
    ` As of September 30, 2026, we held ${cash} million in investments with original maturities greater than 90 days.` +
    " Our other business provides products to public companies and growth companies.";
  const diff = compactDiff(
    { risk_factors: wrap(prose("$18")), mda: null },
    { risk_factors: wrap(prose("$134")), mda: null },
  );
  assert.ok(
    diff.includes(
      "+ As of September 30, 2026, we held $134 million in investments with original maturities greater than 90 days.",
    ),
    diff,
  );
  const added = diff.split("### Added")[1]?.split("### Removed")[0] ?? "";
  assert.equal(added.split("\n").filter((l) => l.startsWith("+")).length, 1);
});

void test("a sentence broken by a page's running head is one sentence", () => {
  const page = (word: string) =>
    `Long standing paragraph that stays the same in both filings here.\nAgents that are not adequately\nPART II\nItem 1A\n${word}, facilitate unauthorized access to data.`;
  const diff = compactDiff(
    { risk_factors: page("watched"), mda: null },
    { risk_factors: page("controlled"), mda: null },
  );
  assert.ok(
    diff.includes(
      "+ Agents that are not adequately controlled, facilitate unauthorized access to data.",
    ),
    diff,
  );
});

void test("rows of a table and headings stay apart in a normal filing", () => {
  const filed = (cash: string) =>
    [
      "Risks Related to Our Business and Our Industry",
      "We compete with many other companies in every market we serve today.",
      "Cash and cash equivalents held at the end of the period",
      `Net sales ${cash} 90`,
      "Operating income 20 15",
    ].join("\n");
  const diff = compactDiff(
    { risk_factors: filed("100"), mda: null },
    { risk_factors: filed("120"), mda: null },
  );
  assert.ok(diff.includes("+ Net sales 120 90"), diff);
  assert.ok(!diff.includes("Operating income"), diff);
  assert.ok(!diff.includes("We compete"), diff);
});

void test("only the company's own trouble ranks first, not boilerplate naming it", () => {
  const line = (i: number) =>
    `A brand new discussion of topic number ${i} concerning unrelated considerations about future growth prospects appears here.`;
  const rank = (serious: string) => {
    const after = `${Array.from({ length: 5 }, (_, i) => line(i)).join("\n")}\n${serious}`;
    const added = compactDiff(
      {
        risk_factors: "Prior text stayed the same over the period.",
        mda: null,
      },
      {
        risk_factors: `Prior text stayed the same over the period.\n${after}`,
        mda: null,
      },
    ).split("### Added")[1];
    return added?.indexOf(serious) ?? -1;
  };
  for (const serious of [
    "There is substantial doubt about our ability to continue as a going concern.",
    "We restated our previously issued financial statements for the prior year.",
    "We received a subpoena from the Department of Justice about our pricing.",
    "We may be forced to file for bankruptcy protection if lenders do not agree.",
    "We received a notice of noncompliance from the exchange about our filing.",
  ])
    assert.ok(rank(serious) < 10, serious);
  for (const routine of [
    "The bankruptcy of a significant distributor could affect the sales we report.",
    "An increase in the number of delistings could reduce our listing revenue overall.",
    "We entered into an amended and restated credit agreement with our banks.",
  ])
    assert.ok(rank(routine) > 10, routine);
});

void test("vendor figures a quarter's 10-Q never prints are flagged, as EXPE's were", async () => {
  await inPackFolder(async () => {
    await db.insert(filings).values(
      filing({
        accessionNo: "q-1",
        form: "10-Q",
        filedAt: "2026-08-06",
        items: "",
        primaryDocUrl: `${BASE}q.htm`,
        processedAt: "2026-08-07T00:00:00.000Z",
      }),
    );
    stubSec({
      [`${BASE}q.htm`]: reportDoc(
        `${"Risk text here. ".repeat(40)}`,
        "<p>Revenue 4,315 3,786</p><p>Operating income 800 485</p><p>Net income 878 330</p>",
      ),
    });
    const row = (
      date: string,
      revenue: number,
      operating: number,
      net: number,
    ) => ({
      date,
      period: "Q2",
      fiscalYear: date.slice(0, 4),
      reportedCurrency: "USD",
      revenue,
      operatingIncome: operating,
      netIncome: net,
    });
    const { dir } = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: {
        ...fundFixture,
        income: [
          row("2026-06-30", 4_315_000_000, 1_031_000_000, 878_000_000),
          row("2025-06-30", 3_786_000_000, 485_000_000, 330_000_000),
        ],
      },
      includeFilings: true,
    });
    const pack = JSON.parse(
      readFileSync(path.join(dir, "pack.json"), "utf8"),
    ) as {
      data_notes: string[];
    };
    const note = pack.data_notes.find((n) => n.includes("do not appear"));
    assert.ok(note);
    assert.match(note, /latest quarter operating income 1031000000/);
    assert.ok(!note.includes("revenue"));
    assert.ok(!note.includes("year-ago"));
  });
});

void test("a 10-Q for another quarter is not used to judge the vendor's figures", async () => {
  await inPackFolder(async () => {
    await db.insert(filings).values(
      filing({
        accessionNo: "q-2",
        form: "10-Q",
        filedAt: "2026-11-01",
        items: "",
        primaryDocUrl: `${BASE}q.htm`,
        processedAt: "2026-11-02T00:00:00.000Z",
      }),
    );
    stubSec({
      [`${BASE}q.htm`]: reportDoc(
        "Risk text. ".repeat(60),
        "September quarter.",
      ),
    });
    const { dir } = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: {
        ...fundFixture,
        income: [
          {
            date: "2026-06-30",
            period: "Q2",
            fiscalYear: "2026",
            reportedCurrency: "USD",
            revenue: 4_315_000_000,
          },
        ],
      },
      includeFilings: true,
    });
    const pack = JSON.parse(
      readFileSync(path.join(dir, "pack.json"), "utf8"),
    ) as {
      data_notes: string[];
    };
    assert.ok(!pack.data_notes.some((n) => n.includes("do not appear")));
  });
});

void test("a full 10-Q risk section naming itself brings no earlier 10-Q into the pack", async () => {
  await inPackFolder(async () => {
    const q = (accession: string, filedAt: string, doc: string) =>
      filing({
        accessionNo: accession,
        form: "10-Q",
        filedAt,
        items: "",
        primaryDocUrl: `${BASE}${doc}`,
        processedAt: "2026-01-01T00:00:00.000Z",
      });
    await db
      .insert(filings)
      .values([
        q("q-1", "2026-05-01", "march.htm"),
        q("q-2", "2026-10-30", "sept.htm"),
      ]);
    // QCOM's says "set forth in this Quarterly Report", and at 132,835 characters it restates them all.
    const full = `The risks set forth in this Quarterly Report could hurt us. ${"A long risk. ".repeat(100)}`;
    stubSec({
      [`${BASE}march.htm`]: reportDoc(
        `${"March risk text. ".repeat(200)}`,
        "March.",
      ),
      [`${BASE}sept.htm`]: reportDoc(full, "Sept."),
    });
    const { written } = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: fundFixture,
      includeFilings: true,
    });
    assert.ok(
      !written.some((n) => n.startsWith("filing_sections_10-Q_2026-05-01")),
    );
  });
});

void test("an earlier 10-Q delivered as new keeps its MD&A when the latest points back", async () => {
  await inPackFolder(async () => {
    const q = (accession: string, filedAt: string, doc: string) =>
      filing({
        accessionNo: accession,
        form: "10-Q",
        filedAt,
        items: "",
        primaryDocUrl: `${BASE}${doc}`,
      });
    const march = q("q-1", "2026-05-01", "march.htm");
    const sept = q("q-2", "2026-10-30", "sept.htm");
    await db.insert(filings).values([march, sept]);
    stubSec({
      [`${BASE}march.htm`]: reportDoc(
        `March risk update. ${"More detail here. ".repeat(80)}`,
        "Liquidity fell sharply in March.",
      ),
      [`${BASE}sept.htm`]: reportDoc(
        "No material updates beyond our Quarterly Reports on Form 10-Q for March and June. Enough words here to pass as a section at all.",
        "September results.",
      ),
    });
    const { dir, written } = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: fundFixture,
      includeFilings: true,
      newFilings: [march, sept],
    });
    const name = written.find((n) =>
      n.startsWith("filing_sections_10-Q_2026-05-01"),
    );
    assert.ok(name);
    assert.match(
      readFileSync(path.join(dir, name), "utf8"),
      /Liquidity fell sharply/,
    );
  });
});

void test("a thin annual report with no readable exhibit says so", async () => {
  await inPackFolder(async () => {
    const forty = filing({
      accessionNo: "f-40",
      form: "40-F",
      filedAt: "2026-02-04",
      items: "",
      processedAt: "2026-03-01T00:00:00.000Z",
    });
    await db.insert(filings).values(forty);
    stubSec({
      [PRIMARY]: "<p>Cover page only. See the annual report exhibit.</p>",
      [`${BASE}f-40-index.html`]: indexPage({
        type: "EX-99.1",
        file: "annual.pdf",
        size: 9000,
      }),
    });
    const { dir } = await writePack({
      ticker: "TEST",
      date: "2026-11-04",
      fmp: fundFixture,
      includeFilings: true,
    });
    const pack = JSON.parse(
      readFileSync(path.join(dir, "pack.json"), "utf8"),
    ) as {
      data_notes: string[];
    };
    assert.ok(
      pack.data_notes.some((n) =>
        n.includes("no readable annual report exhibit"),
      ),
    );
  });
});

void test("a results release judges the vendor's figures until the 10-Q is filed, and says so", async () => {
  await inPackFolder(async () => {
    await db.insert(filings).values([
      filing({
        accessionNo: "q-old",
        form: "10-Q",
        filedAt: "2026-08-06",
        items: "",
        primaryDocUrl: `${BASE}q.htm`,
        processedAt: "2026-08-07T00:00:00.000Z",
      }),
      filing({
        accessionNo: "ek-new",
        form: "8-K",
        filedAt: "2026-11-04",
        items: "2.02",
        primaryDocUrl: `${BASE}ek.htm`,
        processedAt: null,
      }),
    ]);
    stubSec({
      [`${BASE}q.htm`]: reportDoc(
        "Risk text here. ".repeat(40),
        "June quarter.",
      ),
      [`${BASE}ek.htm`]:
        "<html><body><p>Revenue 4,938 4,411</p><p>Operating income 1,326 1,036</p><p>Net income 1,030 959</p></body></html>",
    });
    const row = (
      date: string,
      revenue: number,
      operating: number,
      net: number,
    ) => ({
      date,
      period: "Q3",
      fiscalYear: date.slice(0, 4),
      reportedCurrency: "USD",
      revenue,
      operatingIncome: operating,
      netIncome: net,
    });
    const { dir } = await writePack({
      ticker: "TEST",
      date: "2026-11-05",
      fmp: {
        ...fundFixture,
        income: [
          row("2026-09-30", 4_938_000_000, 1_326_000_000, 1_030_000_000),
          row("2025-09-30", 4_411_000_000, 1_128_000_000, 959_000_000),
        ],
      },
      includeFilings: true,
      newFilings: [
        filing({
          accessionNo: "ek-new",
          form: "8-K",
          filedAt: "2026-11-04",
          items: "2.02",
          primaryDocUrl: `${BASE}ek.htm`,
          processedAt: null,
        }),
      ],
    });
    const pack = JSON.parse(
      readFileSync(path.join(dir, "pack.json"), "utf8"),
    ) as { data_notes: string[] };
    const gap = pack.data_notes.find((n) => n.includes("do not appear"));
    assert.match(gap ?? "", /results release filed 2026-11-04/);
    assert.match(gap ?? "", /year-ago quarter operating income 1128000000/);
    assert.ok(!(gap ?? "").includes("latest quarter"));
    assert.ok(
      pack.data_notes.some((n) => n.includes("come from the earnings release")),
    );
  });
});

const PROCESSED = "2026-01-01T00:00:00.000Z";
const reportRow = (
  accessionNo: string,
  form: string,
  filedAt: string,
  doc = `${accessionNo}.htm`,
) =>
  filing({
    accessionNo,
    form,
    filedAt,
    items: "",
    primaryDocUrl: `${BASE}${doc}`,
    processedAt: PROCESSED,
  });
const statementRow = (
  date: string,
  revenue: number,
  operating: number,
  net: number,
) => ({
  date,
  period: "Q3",
  fiscalYear: date.slice(0, 4),
  reportedCurrency: "USD",
  revenue,
  operatingIncome: operating,
  netIncome: net,
});
const notesIn = (dir: string) =>
  (
    JSON.parse(readFileSync(path.join(dir, "pack.json"), "utf8")) as {
      data_notes: string[];
    }
  ).data_notes;
const fromRelease = (n: string) => n.includes("come from the earnings release");
const notPrinted = (notes: string[]) =>
  notes.find((n) => n.includes("do not appear")) ?? "";

/** The vendor notes for a folder holding exactly these files. */
function gapNotes(
  files: Record<string, string>,
  income: Record<string, unknown>[],
  cashFlow: Record<string, unknown>[] = [],
) {
  const dir = mkdtempSync(path.join(tmpdir(), "portchecker-edgar-gaps-"));
  try {
    for (const [name, text] of Object.entries(files))
      writeFileSync(path.join(dir, name), text);
    return vendorFilingGaps(dir, { ...fundFixture, income, cashFlow });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const TEN_Q_FILE = "filing_10-Q_2026-10-30_x.txt";

void test("a results 8-K older than 14 days stays until that quarter's report is filed", async () => {
  await inPackFolder(async () => {
    const eightK = (accessionNo: string, filedAt: string, items: string) =>
      filing({
        accessionNo,
        filedAt,
        items,
        primaryDocUrl: `${BASE}${accessionNo}.htm`,
        processedAt: PROCESSED,
      });
    await db
      .insert(filings)
      .values([
        reportRow("q-june", "10-Q", "2026-08-06"),
        eightK("ek-july", "2026-07-21", "2.02"),
        eightK("ek-oct", "2026-10-13", "2.02,9.01"),
        eightK("ek-other", "2026-10-01", "8.01"),
      ]);
    const pages = {
      [`${BASE}q-june.htm`]: reportDoc("Risk text. ".repeat(60), "June."),
      [`${BASE}ek-july.htm`]: "<p>Older results.</p>",
      [`${BASE}ek-oct.htm`]: "<p>Revenues 23,845 22,100</p>",
      [`${BASE}ek-oct-index.html`]: indexPage(),
      [`${BASE}ek-other.htm`]: "<p>Another event.</p>",
    };
    stubSec(pages);
    const fmp = {
      ...fundFixture,
      income: [statementRow("2026-09-30", 23_845e6, 7_307e6, 5_245e6)],
    };
    const options = {
      ticker: "TEST",
      date: "2026-11-05",
      fmp,
      includeFilings: true,
    };
    const waiting = await writePack(options);
    const eightKs = (names: string[]) =>
      names.filter((n) => n.startsWith("new_8k_"));
    assert.deepEqual(eightKs(waiting.written), ["new_8k_2026-10-13_ek-oct.md"]);
    const note = notesIn(waiting.dir).find(fromRelease);
    assert.match(
      note ?? "",
      /treat those lines as unconfirmed if the release is not in this pack/,
    );

    await db.insert(filings).values(reportRow("q-sept", "10-Q", "2026-11-04"));
    stubSec({
      ...pages,
      [`${BASE}q-sept.htm`]: reportDoc("Risk text. ".repeat(60), "Sept."),
    });
    const filed = await writePack(options);
    assert.deepEqual(eightKs(filed.written), []);
    assert.ok(!notesIn(filed.dir).some(fromRelease));
  });
});

void test("digits on another line do not vouch for a vendor figure", () => {
  const notes = gapNotes(
    {
      [TEN_Q_FILE]:
        "Total revenues 1,358.8\nNet income 428.2\nGoodwill impairment 500\n",
    },
    [
      {
        date: "2026-09-30",
        period: "Q3",
        fiscalYear: "2026",
        revenue: 1_358_800_000,
        netIncome: 500_000_000,
      },
    ],
  );
  assert.match(notPrinted(notes), /latest quarter net income 500000000/);
  assert.ok(!notPrinted(notes).includes("revenue"));
});

void test("an 8-K with a chance match is not taken for the results release", () => {
  const notes = gapNotes(
    {
      "filing_10-Q_2026-08-06_x.txt": "Older quarter.",
      "new_8k_2026-10-20_x.md": "We issued $650 million of senior notes.",
    },
    [statementRow("2026-09-30", 1_500e6, 650e6, 300e6)],
  );
  assert.equal(notPrinted(notes), "");
});

void test("the ways filings label these lines all count, so a true figure is not flagged", () => {
  for (const [lines, operating, net] of [
    [
      "Total net revenues 500\nIncome from operations 200\nNet income attributable to Acme 100",
      200e6,
      100e6,
    ],
    [
      "Net sales $500\nOperating (loss) income 200\nNet (loss) income (100)",
      200e6,
      -100e6,
    ],
    [
      "Revenues, net of interest expense 500\nIncome (loss) from operations 200\nNet earnings 100",
      200e6,
      100e6,
    ],
    [
      "Sales 500\nOperating profit 200\nProfit for the period 100",
      200e6,
      100e6,
    ],
    [
      "Total revenue 500.0\nLoss from operations (200)\nNet loss (100)",
      -200e6,
      -100e6,
    ],
    ["Revenue 500\nOperating income 200\nNet income 100", 200e6, 100e6],
  ] as const)
    assert.equal(
      notPrinted(
        gapNotes({ [TEN_Q_FILE]: lines }, [
          statementRow("2026-09-30", 500e6, operating, net),
        ]),
      ),
      "",
      lines,
    );
});

void test("a vendor figure $1M off is not flagged at $1B or more, and a bigger or smaller one still is", () => {
  const notes = (text: string, ...row: [number, number, number]) =>
    notPrinted(
      gapNotes({ [TEN_Q_FILE]: text }, [statementRow("2026-09-30", ...row)]),
    );
  const large = notes(
    "Total revenues 11,270\nOperating income 1,356\nNet income 1,036",
    11_271_000_000,
    1_355_000_000,
    1_128_000_000,
  );
  assert.match(large, /latest quarter net income 1128000000/);
  assert.ok(!large.includes("revenue"), large);
  assert.ok(!large.includes("operating income"), large);
  // Under $1B a million is too much of the figure to wave through.
  assert.match(
    notes(
      "Total revenues 901\nOperating income 300\nNet income 200",
      900e6,
      300e6,
      200e6,
    ),
    /latest quarter revenue 900000000/,
  );
  // Two million off at $1B or more is a real difference.
  assert.match(
    notes(
      "Total revenues 2,002\nOperating income 300\nNet income 200",
      2_000e6,
      300e6,
      200e6,
    ),
    /latest quarter revenue 2000000000/,
  );
});

void test("a vendor cash flow total must print on an operating cash flow line", () => {
  const income = [statementRow("2026-09-30", 500e6, 200e6, 100e6)];
  const cash = [
    {
      date: "2026-09-30",
      period: "Q1",
      fiscalYear: "2026",
      reportedCurrency: "USD",
      operatingCashFlow: 300e6,
    },
  ];
  const cashNote = (text: string) =>
    gapNotes({ [TEN_Q_FILE]: text }, income, cash).find((n) =>
      n.includes("operating cash flow"),
    );
  assert.match(
    cashNote("Goodwill 300\nNet cash provided by operating activities 412") ??
      "",
    /adds up to 300000000/,
  );
  for (const line of [
    "Net cash provided by operating activities 300",
    "Net cash from operations 300",
    "Cash flows from operating activities: 300",
  ])
    assert.equal(cashNote(line), undefined, line);
});

void test("a vendor behind a report filed since the quarter ended is not said to read from the release", async () => {
  await inPackFolder(async () => {
    await db.insert(filings).values(reportRow("q-sept", "10-Q", "2026-10-30"));
    stubSec({
      [`${BASE}q-sept.htm`]: reportDoc("Risk text. ".repeat(60), "Sept."),
    });
    const { dir } = await writePack({
      ticker: "TEST",
      date: "2026-11-05",
      fmp: {
        ...fundFixture,
        income: [statementRow("2026-06-30", 4_000e6, 500e6, 300e6)],
      },
      includeFilings: true,
    });
    assert.ok(!notesIn(dir).some(fromRelease));
    assert.ok(notesIn(dir).some((n) => n.includes("more than 120 days old")));
  });
  const june = [statementRow("2026-06-30", 4_000e6, 500e6, 300e6)];
  // A 10-K can also come more than 75 days after the quarter it reports.
  for (const annual of ["10-K", "10-KT"])
    assert.ok(
      !gapNotes(
        {
          "filing_10-Q_2026-05-01_x.txt": "March.",
          [`filing_${annual}_2026-09-28_x.txt`]: "Annual.",
        },
        june,
      ).some(fromRelease),
      annual,
    );
  // With only reports from before the quarter ended, the release is still all the vendor had.
  assert.ok(
    gapNotes({ "filing_10-Q_2026-05-01_x.txt": "March." }, june).some(
      fromRelease,
    ),
  );
});

void test("a long update whose opening rests on an earlier 10-Q brings it in, and says what its diff means", async () => {
  await inPackFolder(async () => {
    // NVDA's own opening, on a section of 34,905 characters.
    const opening =
      "Other than the risk factors listed below, there have been no material changes from the risk factors previously described under Item 1A of our Annual Report on Form 10-K for the fiscal year ended January 25, 2026 and Item 1A of our Quarterly Report on Form 10-Q for the fiscal quarter ended April 26, 2026.";
    await db
      .insert(filings)
      .values([
        reportRow("q-apr", "10-Q", "2026-05-20"),
        reportRow("q-aug", "10-Q", "2026-08-26"),
      ]);
    stubSec({
      [`${BASE}q-apr.htm`]: reportDoc(
        `Some of our customers are developing their own ASICs. ${"April risk text. ".repeat(300)}`,
        "April.",
      ),
      [`${BASE}q-aug.htm`]: reportDoc(
        `${opening} ${"Update text stays here. ".repeat(1400)}`,
        "August.",
      ),
    });
    const { dir, written } = await writePack({
      ticker: "TEST",
      date: "2026-11-05",
      fmp: fundFixture,
      includeFilings: true,
    });
    const name = written.find((n) =>
      n.startsWith("filing_sections_10-Q_2026-05-20"),
    );
    assert.ok(name, written.join(", "));
    const body = readFileSync(path.join(dir, name), "utf8");
    assert.match(body, /developing their own ASICs/);
    assert.match(body, /a risk its diff lists as Removed may still apply/);
  });
});

void test("a 10-Q naming only itself, or naming a 10-Q far past its opening, brings in nothing earlier", async () => {
  for (const risk of [
    // SCHW's own opening.
    `In evaluating the Company and our business, you should carefully consider the risks and uncertainties described in Part I – Item 1A – Risk Factors in our most recent Annual Report on Form 10-K, together with the other information in this Quarterly Report on Form 10-Q, including our condensed consolidated financial statements. ${"Spot crypto risk. ".repeat(100)}`,
    `${"A full section of risks. ".repeat(100)} See also our Quarterly Reports on Form 10-Q for more.`,
  ]) {
    await client.execute("DELETE FROM filings");
    await inPackFolder(async () => {
      await db
        .insert(filings)
        .values([
          reportRow("q-may", "10-Q", "2026-05-08"),
          reportRow("q-aug", "10-Q", "2026-08-07"),
        ]);
      stubSec({
        [`${BASE}q-may.htm`]: reportDoc("May risk. ".repeat(300), "May."),
        [`${BASE}q-aug.htm`]: reportDoc(risk, "August."),
      });
      const { written } = await writePack({
        ticker: "TEST",
        date: "2026-11-05",
        fmp: fundFixture,
        includeFilings: true,
      });
      assert.ok(
        !written.some((n) => n.startsWith("filing_sections_10-Q_2026-05-08")),
        written.join(", "),
      );
    });
  }
});

void test("a report that is not new and could not be read is stated, and not left to retry", async () => {
  await inPackFolder(async () => {
    await db
      .insert(filings)
      .values([
        reportRow("k", "10-K", "2026-02-20"),
        reportRow("q", "10-Q", "2026-08-06"),
      ]);
    stubSec({
      [`${BASE}k.htm`]: `<p>Item 1A. Risk Factors</p><p>${"Annual risk. ".repeat(200)}</p><p>Item 1B. Unresolved</p><p>Item 7. Management's Discussion and Analysis</p><p>${"Annual results. ".repeat(200)}</p><p>Item 8. Financial Statements</p>`,
    });
    const { dir, unread } = await writePack({
      ticker: "TEST",
      date: "2026-11-05",
      fmp: fundFixture,
      includeFilings: true,
    });
    assert.ok(
      notesIn(dir).some((n) =>
        n.startsWith("The 10-Q filed 2026-08-06 (edgar:q) could not be read"),
      ),
      notesIn(dir).join(" | "),
    );
    assert.equal(unread.size, 0);
  });
});

void test("a new report that could not be read keeps its own note and stays pending", async () => {
  await inPackFolder(async () => {
    const pending = filing({
      accessionNo: "q",
      form: "10-Q",
      filedAt: "2026-11-04",
      items: "",
      primaryDocUrl: `${BASE}q.htm`,
    });
    await db.insert(filings).values(pending);
    stubSec({});
    const { dir, unread } = await writePack({
      ticker: "TEST",
      date: "2026-11-05",
      fmp: fundFixture,
      includeFilings: true,
      newFilings: [pending],
    });
    assert.deepEqual([...unread], ["q"]);
    const mentions = notesIn(dir).filter((n) => n.includes("(edgar:q)"));
    assert.equal(mentions.length, 1);
    assert.ok(mentions[0]?.startsWith("The new 10-Q filed 2026-11-04"));
  });
});

void test("a new foreign holding's unread quarterly 6-K reaches the pack, read once", async () => {
  await inPackFolder(async () => {
    const sixK = (accessionNo: string, filedAt: string) =>
      filing({
        accessionNo,
        form: "6-K",
        filedAt,
        items: "",
        primaryDocUrl: `${BASE}${accessionNo}.htm`,
        processedAt: "2026-11-04T00:00:00.000Z",
      });
    const brandNew = {
      ...sixK("six-new", "2026-11-04"),
      processedAt: null,
    };
    await db
      .insert(filings)
      .values([
        sixK("six-report", "2026-10-06"),
        sixK("six-notice", "2026-09-06"),
        sixK("six-old", "2026-05-06"),
        sixK("six-recent", "2026-11-01"),
        brandNew,
      ]);
    const urls = stubSec({
      [`${BASE}six-new.htm`]: "<p>A notice filed yesterday.</p>",
      [`${BASE}six-new-index.html`]: indexPage(),
      [`${BASE}six-recent.htm`]: "<p>A notice filed this week.</p>",
      [`${BASE}six-recent-index.html`]: indexPage(),
      [`${BASE}six-report.htm`]: `<p>${"Quarterly report sales grew. ".repeat(500)}</p>`,
      [`${BASE}six-report-index.html`]: indexPage(),
      [`${BASE}six-notice.htm`]: "<p>Share repurchase notice.</p>",
      [`${BASE}six-notice-index.html`]: indexPage(),
      [`${BASE}six-old.htm`]: `<p>${"An older quarterly report. ".repeat(500)}</p>`,
      [`${BASE}six-old-index.html`]: indexPage(),
    });
    const { dir, written } = await writePack({
      ticker: "TEST",
      date: "2026-11-05",
      fmp: fundFixture,
      includeFilings: true,
      newFilings: [brandNew],
    });
    assert.deepEqual(written.filter((n) => n.startsWith("new_8k_")).sort(), [
      "new_8k_2026-10-06_six-report.md",
      "new_8k_2026-11-01_six-recent.md",
      "new_8k_2026-11-04_six-new.md",
    ]);
    for (const name of ["six-report", "six-recent", "six-new"])
      assert.equal(
        urls.filter((u) => u.endsWith(`${name}.htm`)).length,
        1,
        name,
      );
    assert.equal(urls.filter((u) => u.endsWith("six-old.htm")).length, 0);
    assert.ok(!notesIn(dir).some((n) => n.includes("No SEC filing text")));
  });
});

void test("a report's diff says when it compared only the main document", async () => {
  const foreign = (word: string) =>
    `<p>Item 3.D. Risk Factors</p><p>${word} ${"See our annual report for risks. ".repeat(10)}</p><p>Item 4. Company</p><p>Item 5. Operating and Financial Review</p><p>${"See our annual report for results. ".repeat(10)}</p><p>Item 6. Directors</p>`;
  await db
    .insert(filings)
    .values([
      reportRow("f-0", "20-F", "2025-02-05"),
      { ...reportRow("f-1", "20-F", "2026-02-04"), processedAt: null },
    ]);
  stubSec({
    [`${BASE}f-0.htm`]: foreign("We withdraw little water."),
    [`${BASE}f-1.htm`]: foreign("We withdraw a lot of water."),
  });
  const twenty = await stored("f-1");
  const sections = await ensureSections(twenty);
  assert.match(sections?.diff ?? "", /^This compares the main document only\./);
  assert.match(sections?.diff ?? "", /\+ We withdraw a lot of water\./);
  assert.match(
    (sections && (await fullChanges(twenty, sections))) ?? "",
    /^This compares the main document only\./,
  );
  assert.match(
    savedSections(await stored("f-1"))?.diff ?? "",
    /^This compares the main document only\./,
  );

  const annual = (word: string) =>
    `<p>Item 1A. Risk Factors</p><p>${word} ${"Annual risk. ".repeat(400)}</p><p>Item 1B. Unresolved</p><p>Item 7. Management's Discussion and Analysis</p><p>${"Annual results. ".repeat(40)}</p><p>Item 8. Financial Statements</p>`;
  await db
    .insert(filings)
    .values([
      reportRow("k-0", "10-K", "2025-02-05"),
      { ...reportRow("k-1", "10-K", "2026-02-04"), processedAt: null },
    ]);
  stubSec({
    [`${BASE}k-0.htm`]: annual("Old."),
    [`${BASE}k-1.htm`]: annual("New."),
  });
  const full = await ensureSections(await stored("k-1"));
  assert.match(full?.diff ?? "", /^## Risk Factors/);
});

void test("a diff saved before the main document line is built again from saved sections", async () => {
  const sections = (word: string) =>
    JSON.stringify({
      risk_factors: `${word} ${"See our annual report for risks. ".repeat(10)}`,
      mda: "See our annual report for results. ".repeat(10),
      diff: "## Risk Factors\n\nAn older diff.",
      diff_version: 2,
      text_head: null,
      text_format: 4,
    });
  await db.insert(filings).values([
    {
      ...reportRow("f-0", "20-F", "2025-02-05"),
      sectionsJson: sections("Old."),
    },
    {
      ...reportRow("f-1", "20-F", "2026-02-04"),
      sectionsJson: sections("New."),
    },
  ]);
  const urls = stubSec({});
  const rebuilt = await ensureSections(await stored("f-1"));
  assert.match(rebuilt?.diff ?? "", /^This compares the main document only\./);
  assert.deepEqual(urls, []);
});

void test("an amended or transition annual report reads its exhibit the way the original does", async () => {
  const thin = { risk_factors: "See the exhibit.", mda: null };
  for (const form of ["20-F/A", "40-F/A", "10-K/A", "10-KT", "10-KT/A"])
    assert.ok(incorporatesAnnualReport(form, thin), form);
  assert.ok(!incorporatesAnnualReport("10-Q/A", thin));
  assert.ok(
    !incorporatesAnnualReport("10-K/A", {
      risk_factors: "Risk. ".repeat(500),
      mda: null,
    }),
  );

  await inPackFolder(async () => {
    await db
      .insert(filings)
      .values([
        reportRow("f-1", "20-F", "2026-02-04"),
        reportRow("f-2", "20-F/A", "2026-03-04"),
      ]);
    const doc = `<p>Item 3.D. Risk Factors</p><p>${"See our annual report for risks. ".repeat(10)}</p><p>Item 4. Company</p><p>Item 5. Operating and Financial Review</p><p>${"See our annual report for results. ".repeat(10)}</p><p>Item 6. Directors</p>`;
    stubSec({
      [`${BASE}f-1.htm`]: doc,
      [`${BASE}f-1-index.html`]: indexPage(),
      [`${BASE}f-2.htm`]: doc,
      [`${BASE}f-2-index.html`]: indexPage({
        type: "EX-15.1",
        file: "annual.htm",
        size: 50,
      }),
      [`${BASE}annual.htm`]: `<p>${"Front matter. ".repeat(500)}</p><p>Risk management</p><p>We restated one active ingredient's risk.</p><p>${"Detail. ".repeat(50)}</p>`,
    });
    const { dir, written } = await writePack({
      ticker: "TEST",
      date: "2026-11-05",
      fmp: fundFixture,
      includeFilings: true,
    });
    assert.ok(
      written.some((n) => n.startsWith("filing_exhibit_20-F-A_2026-03-04")),
      written.join(", "),
    );
    const sections = written.find((n) =>
      n.startsWith("filing_sections_20-F-A_2026-03-04"),
    );
    assert.ok(sections);
    const body = readFileSync(path.join(dir, sections), "utf8");
    assert.match(body, /^# 20-F\/A filed 2026-03-04/);
    assert.match(body, /## Annual report exhibit[\s\S]*one active ingredient/);
  });
});

void test("a transition report's EX-13 is read like a 10-K's", async () => {
  await inPackFolder(async () => {
    await db.insert(filings).values(reportRow("t-1", "10-KT", "2026-03-04"));
    stubSec({
      [`${BASE}t-1.htm`]: "<p>Cover page only. See the annual report.</p>",
      [`${BASE}t-1-index.html`]: indexPage({
        type: "EX-13.1",
        file: "annual.htm",
      }),
      [`${BASE}annual.htm`]: `<p>${"Annual report text. ".repeat(100)}</p>`,
    });
    const { written } = await writePack({
      ticker: "TEST",
      date: "2026-11-05",
      fmp: fundFixture,
      includeFilings: true,
    });
    assert.ok(
      written.some((n) => n.startsWith("filing_exhibit_10-KT_2026-03-04")),
      written.join(", "),
    );
  });
});

void test("an image-only incorporated annual report leaves an explicit pack warning", async () => {
  await inPackFolder(async () => {
    const row = filing({ form: "20-F", filedAt: "2026-03-04", items: null });
    await db.insert(filings).values(row);
    stubSec({
      [PRIMARY]:
        "<p>See the incorporated annual report for risk factors and operating results.</p>",
      [INDEX]: indexPage({ type: "EX-15.1", file: "annual.htm", size: 100000 }),
      [`${BASE}annual.htm`]: '<html><body><img src="annual.png"></body></html>',
    });
    assert.equal(await fetchAnnualExhibit(row), null);
    const { dir, written } = await writePack({
      ticker: "TEST",
      date: "2026-11-05",
      fmp: fundFixture,
      includeFilings: true,
    });
    assert.ok(
      notesIn(dir).some((note) =>
        /no readable annual report exhibit.*incomplete/.test(note),
      ),
    );
    assert.ok(!written.some((name) => name.startsWith("filing_exhibit_")));
  });
});

void test("an amendment with only Part III is not said to be missing its risks and results", async () => {
  await inPackFolder(async () => {
    await db
      .insert(filings)
      .values([
        reportRow("k-1", "10-K", "2026-02-20"),
        reportRow("k-2", "10-K/A", "2026-03-04"),
      ]);
    stubSec({
      [`${BASE}k-1.htm`]: `<p>Item 1A. Risk Factors</p><p>${"Annual risk. ".repeat(200)}</p><p>Item 1B. Unresolved</p><p>Item 7. Management's Discussion and Analysis</p><p>${"Annual results. ".repeat(200)}</p><p>Item 8. Financial Statements</p>`,
      [`${BASE}k-2.htm`]: "<p>Part III. Directors and executive pay.</p>",
      [`${BASE}k-2-index.html`]: indexPage({
        type: "EX-31.1",
        file: "certification.htm",
      }),
    });
    const { dir, written } = await writePack({
      ticker: "TEST",
      date: "2026-11-05",
      fmp: fundFixture,
      includeFilings: true,
    });
    assert.ok(written.some((n) => n.startsWith("filing_10-K-A_2026-03-04")));
    assert.ok(
      !notesIn(dir).some((n) => n.includes("(edgar:k-2)")),
      notesIn(dir).join(" | "),
    );

    // Its exhibit list could not be read, so nobody knows what it holds, and the note says only that.
    stubSec({
      [`${BASE}k-1.htm`]: `<p>Item 1A. Risk Factors</p><p>${"Annual risk. ".repeat(200)}</p><p>Item 1B. Unresolved</p><p>Item 7. Management's Discussion and Analysis</p><p>${"Annual results. ".repeat(200)}</p><p>Item 8. Financial Statements</p>`,
      [`${BASE}k-2.htm`]: "<p>Part III. Directors and pay.</p>",
    });
    const unknown = await writePack({
      ticker: "TEST",
      date: "2026-11-05",
      fmp: fundFixture,
      includeFilings: true,
    });
    assert.match(
      notesIn(unknown.dir).find((n) => n.includes("(edgar:k-2)")) ?? "",
      /may point to an annual report exhibit that could not be read, so its risk and results sections may be incomplete/,
    );
  });
});

void test("a light pack keeps the vendor warnings the last full pack earned", async () => {
  await inPackFolder(async () => {
    const fmp = {
      ...fundFixture,
      income: [statementRow("2026-09-30", 500e6, 200e6, 100e6)],
    };
    const light = (date: string) =>
      writePack({ ticker: "TEST", date, fmp, includeFilings: false });

    // With no full pack anywhere there is nothing to compare, and that is not an error.
    const first = await light("2026-11-01");
    assert.ok(!notesIn(first.dir).some(fromRelease));

    await db.insert(filings).values(reportRow("q-june", "10-Q", "2026-08-06"));
    stubSec({
      [`${BASE}q-june.htm`]: reportDoc("Risk text. ".repeat(60), "June."),
    });
    const full = await writePack({
      ticker: "TEST",
      date: "2026-11-03",
      fmp,
      includeFilings: true,
    });
    assert.ok(notesIn(full.dir).some(fromRelease));

    const nextDay = await light("2026-11-04");
    assert.ok(notesIn(nextDay.dir).some(fromRelease));
    assert.deepEqual([...nextDay.written].sort(), ["dossier.md", "pack.json"]);

    // The same day's light pack sets the full one aside, and it still counts.
    const sameDay = await light("2026-11-03");
    assert.ok(notesIn(sameDay.dir).some(fromRelease));
    assert.deepEqual([...sameDay.written].sort(), ["dossier.md", "pack.json"]);
  });
});

void test("large risk figure moves remain visible when routine changes are capped", () => {
  const risk = (word: string, share: number, note: number, total: number) =>
    `${boilerplate(word, 200)}\nOur top ten customers accounted for approximately ${share}% of our consolidated revenues.\nThe accounting assumptions described under Note ${note} remain important to understanding our business.\nTotal $${total} $90\nWe last discussed these operational matters in ${note === 5 ? 2024 : 2025}.`;
  const before = risk("previously", 50, 5, 100);
  const after = risk("currently", 57, 9, 200);
  const diff = compactDiff(
    { risk_factors: before, mda: before },
    { risk_factors: after, mda: after },
  );
  const [risks, mda] = diff.split("## MD&A");
  const moved = risks?.split("### Figures that moved")[1] ?? "";
  assert.match(
    moved,
    /~ Our top ten customers accounted for approximately 57% of our consolidated revenues\. \(50% before\)/,
  );
  assert.doesNotMatch(moved, /Note 9|Total|2025/);
  assert.doesNotMatch(mda ?? "", /Figures that moved/);
  assert.ok(diff.length < 18_000);
});

void test("heading-only sections stop at their natural ends and retain risk subheadings", () => {
  const prose =
    "Operational conditions influence future business performance across markets. ".repeat(
      350,
    );
  const text = `preface ${"x".repeat(5_000)}\nMANAGEMENT'S DISCUSSION AND ANALYSIS\n${prose}\nRISK FACTORS\n${prose}\nMARKET-RELATED RISKS\n${prose}\nSTRATEGIC RISKS\n${prose}\nSUSTAINABILITY\nCredit table rows 100 200\n${prose}`;
  const sections = extractSections("10-K", text);
  assert.match(sections.risk_factors ?? "", /STRATEGIC RISKS/);
  assert.doesNotMatch(
    sections.risk_factors ?? "",
    /SUSTAINABILITY|Credit table|Cut off here/,
  );
  assert.doesNotMatch(
    sections.mda ?? "",
    /RISK FACTORS|MARKET-RELATED RISKS|Cut off here/,
  );
  assert.match(sections.mda ?? "", /Operational conditions/);
});

void test("uppercase risk subheadings without the word risk retain their disclosures", () => {
  const text = `Preface ${"x".repeat(5_000)}\nMANAGEMENT'S DISCUSSION AND ANALYSIS\n${"Operating conditions remain stable. ".repeat(800)}\nRISK FACTORS\n${"We depend on reliable systems to operate globally. ".repeat(500)}\nCYBERSECURITY AND DATA PRIVACY\nOur controls failed and attackers stole customer passwords.\n${"We face substantial new litigation and remediation expenses. ".repeat(100)}\nSUSTAINABILITY\nUnrelated sustainability information.`;
  const sections = extractSections("10-K", text);
  assert.match(sections.risk_factors ?? "", /CYBERSECURITY AND DATA PRIVACY/);
  assert.match(
    sections.risk_factors ?? "",
    /attackers stole customer passwords/,
  );
  assert.doesNotMatch(
    sections.risk_factors ?? "",
    /SUSTAINABILITY|Unrelated sustainability/,
  );
  assert.doesNotMatch(sections.mda ?? "", /RISK FACTORS/);
});

void test("a heading-only section with no identified end retains the text with an uncertainty notice", () => {
  const text = `Preface ${"x".repeat(5_000)}\nRISK FACTORS\n${"We depend on reliable systems to operate globally. ".repeat(500)}\nCYBERSECURITY AND DATA PRIVACY\nAttackers stole customer passwords.`;
  const risk = extractSections("10-K", text).risk_factors ?? "";
  assert.match(risk, /Attackers stole customer passwords/);
  assert.match(risk, /end of this section could not be identified/);
});

void test("a saved report with the old truncated risk section is extracted again", async () => {
  const risk = "We depend on reliable systems to operate globally. ".repeat(
    500,
  );
  const text = `Preface ${"x".repeat(5_000)}\nRISK FACTORS\n${risk}\nCYBERSECURITY AND DATA PRIVACY\nAttackers stole customer passwords.\nSUSTAINABILITY\nOther information.`;
  const row = reportRow("old-bounds", "10-K", "2026-11-04");
  row.sectionsJson = JSON.stringify({
    risk_factors: risk,
    mda: null,
    text_head: null,
    diff: null,
    text_format: 3,
  });
  await db.insert(filings).values(row);
  const urls = stubSec({ [row.primaryDocUrl]: `<pre>${text}</pre>` });
  assert.match(
    (await ensureSections(row))?.risk_factors ?? "",
    /Attackers stole customer passwords/,
  );
  assert.deepEqual(urls, [row.primaryDocUrl]);
});

void test("a long standalone quarterly risk update keeps its prior-quarter comparison", async () => {
  const common =
    "We depend on suppliers to deliver inventory on schedule. ".repeat(25);
  const prior = reportRow("quarter-april", "10-Q", "2026-04-29");
  const annual = reportRow("annual-july", "10-K", "2026-07-29");
  const current = reportRow("quarter-october", "10-Q", "2026-10-28");
  await db.insert(filings).values([prior, annual, current]);
  stubSec({
    [prior.primaryDocUrl]: reportDoc(
      `${common}The only supplier has stopped shipping and we cannot replace it.`,
      "April results.",
    ),
    [annual.primaryDocUrl]: `<p>Item 1A. Risk Factors</p><p>${"Foreign currency exchange movements could adversely affect our earnings. ".repeat(23)}</p><p>Item 1B. Unresolved</p>`,
    [current.primaryDocUrl]: reportDoc(
      `${common}Our only supplier has resumed all shipments and the shortage is resolved.`,
      "October results.",
    ),
  });
  const sections = await ensureSections(current);
  assert.ok(sections);
  for (const diff of [sections.diff, await fullChanges(current, sections)]) {
    assert.doesNotMatch(diff ?? "", /Compared with the 10-K|Foreign currency/);
    assert.match(diff ?? "", /- The only supplier has stopped shipping/);
    assert.match(diff ?? "", /\+ Our only supplier has resumed all shipments/);
    assert.match(diff ?? "", /- April results\./);
  }
});

void test("plural auditor consents cannot stand in for an annual report", async () => {
  for (const description of [
    "CONSENTS OF INDEPENDENT REGISTERED PUBLIC ACCOUNTING FIRMS",
    "Auditors' consents",
  ]) {
    const consent = {
      type: "EX-15.1",
      file: "consents.htm",
      description,
      size: 900,
    };
    const row = filing({ form: "20-F" });
    stubSec({
      [INDEX]: indexPage(consent),
      [`${BASE}consents.htm`]: "We consent to incorporation by reference.",
    });
    assert.equal(await fetchAnnualExhibit(row), null);
    stubSec({
      [INDEX]: indexPage(consent, {
        type: "EX-15.1",
        file: "annual.htm",
        description: "Annual report",
        size: 100,
      }),
      [`${BASE}annual.htm`]: "Annual report risk factors and results.",
    });
    assert.equal(
      (await fetchAnnualExhibit(row))?.text,
      "Annual report risk factors and results.",
    );
  }
});

void test("a quarterly risk restatement compares with an intervening annual report while results compare with the prior quarter", async () => {
  const common =
    "We depend on reliable systems to serve our customers across international markets. ".repeat(
      20,
    );
  const july =
    "We introduced autonomous services that create a distinct operational risk.";
  const october =
    "New agent permissions could expose confidential records to unauthorized users.";
  const annual = reportRow("annual-july", "10-K", "2026-07-29");
  const april = reportRow("quarter-april", "10-Q", "2026-04-29");
  const current = reportRow("quarter-october", "10-Q", "2026-10-28");
  await db.insert(filings).values([april, annual, current]);
  stubSec({
    [april.primaryDocUrl]: reportDoc(
      common,
      "April operating results weakened.",
    ),
    [annual.primaryDocUrl]: `<p>Item 1A. Risk Factors</p><p>${common}${july}</p><p>Item 1B. Unresolved</p><p>Item 7. Management's Discussion and Analysis</p><p>${"July operating results improved. ".repeat(10)}</p><p>Item 7A. Quantitative</p>`,
    [current.primaryDocUrl]: reportDoc(
      `${common}${july} ${october}`,
      "October operating results stabilized.",
    ),
  });
  const sections = await ensureSections(current);
  assert.ok(sections);
  for (const diff of [sections.diff, await fullChanges(current, sections)]) {
    const [risk, mda] = (diff ?? "").split("## MD&A");
    assert.match(risk ?? "", /Compared with the 10-K filed 2026-07-29\./);
    assert.ok(risk?.includes(`+ ${october}`));
    assert.ok(!risk?.includes(`+ ${july}`));
    assert.match(mda ?? "", /- April operating results weakened\./);
    assert.doesNotMatch(mda ?? "", /July operating results/);
  }
});

void test("a short quarterly risk update keeps the prior-quarter comparison", async () => {
  const prior = reportRow("quarter-april", "10-Q", "2026-04-29");
  const annual = reportRow("annual-july", "10-K", "2026-07-29");
  const current = reportRow("quarter-october", "10-Q", "2026-10-28");
  await db.insert(filings).values([prior, annual, current]);
  const common =
    "Our systems face ordinary operational risks across markets. ".repeat(5);
  stubSec({
    [prior.primaryDocUrl]: reportDoc(
      `${common}Prior quarterly risk.`,
      "April results.",
    ),
    [annual.primaryDocUrl]: `<p>Item 1A. Risk Factors</p><p>${common.repeat(10)}</p><p>Item 1B. Unresolved</p><p>Item 7. Management's Discussion and Analysis</p><p>${"July results. ".repeat(20)}</p><p>Item 7A. Quantitative</p>`,
    [current.primaryDocUrl]: reportDoc(
      `${common}New quarterly risk.`,
      "October results.",
    ),
  });
  const diff = (await ensureSections(current))?.diff ?? "";
  assert.doesNotMatch(diff, /Compared with the 10-K/);
  assert.match(diff, /- Prior quarterly risk\./);
  assert.match(diff, /\+ New quarterly risk\./);
});

void test("an unreadable intervening annual report preserves the quarterly comparison", async () => {
  const prior = reportRow("quarter-april", "10-Q", "2026-04-29");
  const annual = reportRow("annual-july", "10-K", "2026-07-29");
  const current = reportRow("quarter-october", "10-Q", "2026-10-28");
  await db.insert(filings).values([prior, annual, current]);
  stubSec({
    [prior.primaryDocUrl]: reportDoc(
      "Prior quarterly risk. ".repeat(20),
      "April results.",
    ),
    [current.primaryDocUrl]: reportDoc(
      "New quarterly risk. ".repeat(20),
      "October results.",
    ),
  });
  const diff = (await ensureSections(current))?.diff ?? "";
  assert.doesNotMatch(diff, /Compared with the 10-K/);
  assert.match(diff, /- Prior quarterly risk\./);
});

void test("a transient SEC failure retries once and permanent failures do not retry", async () => {
  for (const [statuses, expectedCalls, succeeds] of [
    [[503, 200], 2, true],
    [[429, 200], 2, true],
    [[502, 200], 2, true],
    [[504, 200], 2, true],
    [[404], 1, false],
    [[500], 1, false],
    [[503, 503], 2, false],
  ] as const) {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
      return new Response("Filing recovered.", { status });
    }) as typeof fetch;
    if (succeeds)
      assert.equal(await fetchFilingText(PRIMARY), "Filing recovered.");
    else await assert.rejects(fetchFilingText(PRIMARY), /SEC returned/);
    assert.equal(calls.length, expectedCalls, String(statuses));
    assert.ok(calls.every((url) => url === PRIMARY));
  }
});

void test("a filing with many open headings still keeps independent lines apart", () => {
  const lines = (word: string) =>
    [
      ...Array.from(
        { length: 60 },
        (_, i) =>
          `A closed discussion sentence about operations and clients numbered ${i}.`,
      ),
      ...Array.from(
        { length: 70 },
        (_, i) =>
          `Segment heading remains without any closing punctuation ${i}`,
      ),
      `Segment heading called ${word} without any closing punctuation`,
    ].join("\n");
  const diff = compactDiff(
    { risk_factors: lines("before"), mda: null },
    { risk_factors: lines("after"), mda: null },
  );
  assert.deepEqual(
    diff.split("\n").filter((l) => l.startsWith("+ ")),
    ["+ Segment heading called after without any closing punctuation"],
  );
});

void test("foreign annual running heads do not count as changed filing content", () => {
  const diff = compactDiff(
    {
      risk_factors: "Novo Nordisk Form 20-F 2024\nUnchanged risk text.",
      mda: null,
    },
    {
      risk_factors: "Novo Nordisk Form 20-F 2025\nUnchanged risk text.",
      mda: null,
    },
  );
  assert.deepEqual(
    diff.split("\n").filter((l) => /^[+-] /.test(l)),
    [],
  );
});

void test("repeated company page heads disappear before broken sentences rejoin", () => {
  const text = (word: string) =>
    `Clients may at times\nTHE CHARLES SCHWAB CORPORATION\n${word} additional funds.\nTHE CHARLES SCHWAB CORPORATION\nOther unchanged text.\nTHE CHARLES SCHWAB CORPORATION`;
  const diff = compactDiff(
    { risk_factors: text("withdraw"), mda: null },
    { risk_factors: text("deposit"), mda: null },
  );
  assert.match(diff, /\+ Clients may at times deposit additional funds\./);
  assert.doesNotMatch(diff, /THE CHARLES SCHWAB CORPORATION/);
});

void test("item references stay in the sentence even inside quotation marks", () => {
  const sentence = (year: number) =>
    `See "Item 1A. of our Annual Report for ${year}" for details.`;
  const diff = compactDiff(
    { risk_factors: sentence(2024), mda: null },
    { risk_factors: sentence(2025), mda: null },
  );
  assert.deepEqual(
    diff.split("\n").filter((l) => l.startsWith("+ ")),
    [`+ ${sentence(2025)}`],
  );
});

void test("dotted company names stay with the rest of their sentence", () => {
  const diff = compactDiff(
    {
      risk_factors:
        "Banco de Mexico, S.A. de C.V. stays important.\nAcme Holdings L.P. sold shares.",
      mda: null,
    },
    {
      risk_factors:
        "Banco de Mexico, S.A. de C.V. grew sharply.\nAcme Holdings L.P. bought shares.",
      mda: null,
    },
  );
  assert.deepEqual(
    diff.split("\n").filter((l) => l.startsWith("+ ")),
    [
      "+ Banco de Mexico, S.A. de C.V. grew sharply.",
      "+ Acme Holdings L.P. bought shares.",
    ],
  );
});

void test("transition reports and cybersecurity events have descriptive filing labels", () => {
  assert.equal(filingSummary("10-KT", null), "Transition report");
  assert.equal(filingSummary("10-KT/A", null), "Transition report amendment");
  assert.equal(filingSummary("8-K", "1.05,9.01"), "Cybersecurity incident");
});

void test("a gap in full reviews extends new filings to at most one hundred days", async () => {
  for (const [reviewDays, filingDays, expectedPending, existing] of [
    [40, 35, true, true],
    [3, 35, false, true],
    [null, 35, false, true],
    [400, 130, false, true],
    [400, 8, false, false],
  ] as const) {
    await client.execute("DELETE FROM filings");
    if (existing)
      await db
        .insert(filings)
        .values(filing({ accessionNo: "old", processedAt: "done" }));
    stubSubmissions([{ acc: "gap-quarter", form: "10-Q", age: filingDays }]);
    const pending = await syncFilings(
      "TEST",
      "1",
      reviewDays === null ? null : filingDateAgo(reviewDays),
    );
    assert.equal(
      pending.some((f) => f.accessionNo === "gap-quarter"),
      expectedPending,
      String(reviewDays),
    );
    assert.equal(
      (await stored("gap-quarter")).processedAt === null,
      expectedPending,
    );
  }
});

const COMPANY_LIST = "https://www.sec.gov/files/company_tickers.json";

void test("a cache miss refreshes an older SEC company list only once that day", async () => {
  const oldList = { "0": { ticker: "AAA", cik_str: 1 } };
  await db.insert(fmpCache).values({
    ticker: "_SEC",
    endpoint: "company_tickers",
    fetchedOn: dateAgo(10),
    payloadJson: JSON.stringify(oldList),
  });
  const urls = stubSec({
    [COMPANY_LIST]: JSON.stringify({
      ...oldList,
      "1": { ticker: "NEWIPO", cik_str: 9 },
    }),
  });
  assert.equal(await resolveCik("AAA"), "1");
  assert.equal(urls.length, 0);
  assert.equal(await resolveCik("NEWIPO"), "9");
  assert.deepEqual(urls, [COMPANY_LIST]);
  assert.equal(await resolveCik("UNLISTED"), null);
  assert.deepEqual(urls, [COMPANY_LIST]);
  const rows = await db.select().from(fmpCache);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.fetchedOn, dateAgo(0));
});

void test("a failed refresh on a ticker miss preserves the older SEC list", async () => {
  const payloadJson = JSON.stringify({ "0": { ticker: "AAA", cik_str: 1 } });
  await db.insert(fmpCache).values({
    ticker: "_SEC",
    endpoint: "company_tickers",
    fetchedOn: dateAgo(10),
    payloadJson,
  });
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  await assert.rejects(resolveCik("NEWIPO"), /SEC returned 503/);
  const [cached] = await db.select().from(fmpCache);
  assert.equal(cached?.payloadJson, payloadJson);
  assert.equal(cached?.fetchedOn, dateAgo(10));
  assert.equal(await resolveCik("AAA"), "1");
});

void test("ticker setup distinguishes an SEC lookup failure from an absent ticker without losing a known CIK", async () => {
  await inPackFolder(async () => {
    await db.insert(fmpCache).values({
      ticker: "TEST",
      endpoint: "profile",
      fetchedOn: dateAgo(0),
      payloadJson: "[]",
    });
    globalThis.fetch = async () => new Response("forbidden", { status: 403 });
    const failed = await ensureTicker("TEST", "Test Company");
    assert.equal(failed.cik, null);
    assert.match(failed.secLookupError ?? "", /SEC returned 403/);
    assert.equal(failed.lastFullReviewAt, null);
    await db
      .update(tickers)
      .set({ cik: "1" })
      .where(eq(tickers.ticker, "TEST"));
    const known = await ensureTicker("TEST", "Test Company");
    assert.equal(known.cik, "1");
    assert.match(known.secLookupError ?? "", /SEC returned 403/);
    stubSec({ [COMPANY_LIST]: "{}" });
    const absent = await ensureTicker("TEST", "Test Company");
    assert.equal(absent.secLookupError, null);
    assert.equal(absent.cik, "1");
  });
});

void test("an invalid pack ticker is rejected before any pack folder is written", async () => {
  await inPackFolder(async () => {
    for (const ticker of ["../TEST", "x/TEST", "x\\TEST", "", "test"]) {
      await assert.rejects(
        writePack({
          ticker,
          date: "2026-11-05",
          fmp: fundFixture,
          includeFilings: false,
        }),
        /valid ticker/i,
      );
      assert.ok(!existsSync(path.join("data", "packs", "2026-11-05")));
    }
  });
});

void test("auditors' consents are never selected as annual report exhibits", async () => {
  for (const [form, type] of [
    ["20-F", "EX-15.1"],
    ["40-F/A", "EX-99.1"],
  ]) {
    const row = filing({ form });
    const urls = stubSec({
      [INDEX]: indexPage({
        type: type!,
        file: "consent.htm",
        description: "CONSENT OF INDEPENDENT REGISTERED PUBLIC ACCOUNTING FIRM",
        size: 900,
      }),
      [`${BASE}consent.htm`]:
        "We consent to incorporation by reference of our report.",
    });
    assert.equal(await fetchAnnualExhibit(row), null);
    assert.deepEqual(urls, [INDEX]);
    stubSec({
      [INDEX]: indexPage(
        {
          type: type!,
          file: "consent.htm",
          description: "Auditor's consent",
          size: 900,
        },
        {
          type: type!,
          file: "annual.htm",
          description: "Annual report",
          size: 100,
        },
      ),
      [`${BASE}annual.htm`]: "Annual report risk factors and results.",
    });
    assert.equal(
      (await fetchAnnualExhibit(row))?.text,
      "Annual report risk factors and results.",
    );
  }
});

void test("a transition report is used to check annual vendor cash flow totals", async () => {
  await inPackFolder(async () => {
    const dir = path.join("data", "transition-check");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "filing_10-KT_2026-02-20_transition.txt"),
      "Net cash provided by operating activities 90 80",
    );
    const fmp = {
      ...fundFixture,
      income: [{ date: "2025-12-31" }],
      cashFlow: Array.from({ length: 4 }, (_, i) => ({
        date: i === 0 ? "2025-12-31" : `2025-0${4 - i}-30`,
        fiscalYear: "2025",
        period: `Q${4 - i}`,
        operatingCashFlow: 10e6,
        reportedCurrency: "USD",
      })),
    };
    const notes = vendorFilingGaps(dir, fmp);
    assert.ok(
      notes.some(
        (n) =>
          n.includes("operating cash flow") &&
          n.includes("10-KT filed 2026-02-20"),
      ),
      notes.join(" | "),
    );
  });
});
