import { diffArrays } from "diff";
import { and, desc, eq, gt, gte, isNull, lt } from "drizzle-orm";
import { convert } from "html-to-text";

import { env } from "../env.js";
import { db } from "./db/index.ts";
import { filings, fmpCache } from "./db/schema.ts";
import { today } from "./fmp.ts";

export const REPORT_FORMS = new Set(["10-K", "10-KT", "10-Q", "20-F", "40-F"]);
// A notice that a report will be late is rare and serious, so it counts as news like an 8-K.
const LATE_NOTICES = ["NT 10-K", "NT 10-Q", "NT 20-F"];
export const EVENT_FORMS = new Set([
  "8-K",
  "8-K/A",
  "6-K",
  "6-K/A",
  ...LATE_NOTICES,
]);
export const FULL_REVIEW_FORMS = new Set([
  ...REPORT_FORMS,
  ...[...REPORT_FORMS].map((f) => `${f}/A`),
  ...EVENT_FORMS,
]);
const TRACKED_FORMS = new Set([...FULL_REVIEW_FORMS, "4"]);
const ANNUAL_FORMS = new Set(["10-K", "10-KT", "20-F", "40-F"]);
const HISTORY_DAYS = 800; // two 10-K cycles is enough for diffs
const MIN_REQUEST_GAP_MS = 120; // keeps us near 8 requests/second, under SEC's limit of 10
const SEC_RETRY_MS = 3_000;
const DIFF_CAP_CHARS = 15_000;
const DIFF_ADDED_SHARE = 2 / 3; // what a filing now says matters more than what it stopped saying
const DIFF_VERSION = 4; // bump when the diff changes, so saved diffs are rebuilt from saved sections
const TEXT_FORMAT = 4; // bump when conversion or section bounds change, so both sides are read again
const EXHIBIT_TEXT_FORMAT = 5; // refresh event exhibits once to disclose unread nontext reports
const OLDER_PAGE_LIMIT = 12;
const EVENT_HEAD_CHARS = 6_000;
const EXHIBIT_HEAD_CHARS = 12_000; // an 8-K's item text plus the start of the exhibit it points to
// A results 8-K's exhibit, or a 6-K that can be a foreign issuer's quarterly report, is the news.
const RESULTS_HEAD_CHARS = 40_000;
const MIN_SECTION_CHARS = 100; // anything shorter is a table of contents entry
const HEADING_ONLY_SECTION_CHARS = 160_000;
const ANNUAL_EXHIBIT_PART_CHARS = 30_000;
const STATEMENT_SHARE = 0.3; // of a capped results excerpt, kept for the financial statements
export const UNREADABLE_RETRY_DAYS = 5;

export type Filing = typeof filings.$inferSelect;
export type Sections = {
  risk_factors: string | null;
  mda: string | null;
  diff: string | null;
  text_head: string | null;
  text_format?: number; // absent on rows saved before cells were separated and exhibits read
  diff_version?: number;
};

// Every SEC request goes through here so the User-Agent and pacing cannot be skipped.
export const edgarStats = { httpCalls: 0 };
let nextSlot = Promise.resolve();

// Reviews run side by side, so callers take turns rather than comparing timestamps.
function waitForSlot() {
  const slot = nextSlot;
  nextSlot = slot.then(
    () => new Promise((r) => setTimeout(r, MIN_REQUEST_GAP_MS)),
  );
  return slot;
}

async function secFetch(url: string) {
  if (!env.SEC_USER_AGENT) throw new Error("SEC_USER_AGENT is not set in .env");
  for (let attempt = 0; ; attempt++) {
    await waitForSlot();
    edgarStats.httpCalls += 1;
    const res = await fetch(url, {
      headers: { "User-Agent": env.SEC_USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) return res;
    if (attempt === 0 && [429, 502, 503, 504].includes(res.status)) {
      await new Promise((r) => setTimeout(r, SEC_RETRY_MS));
      continue;
    }
    throw new Error(`SEC returned ${res.status} for ${url}`);
  }
}

/** Ticker to CIK, cached for 30 days; a miss refreshes an older list once that day. */
export async function resolveCik(ticker: string): Promise<string | null> {
  const [cached] = await db
    .select()
    .from(fmpCache)
    .where(
      and(
        eq(fmpCache.ticker, "_SEC"),
        eq(fmpCache.endpoint, "company_tickers"),
      ),
    )
    .orderBy(desc(fmpCache.fetchedOn))
    .limit(1);

  const ageDays = cached
    ? (Date.parse(today()) - Date.parse(cached.fetchedOn)) / 86_400_000
    : Infinity;

  let list: Record<string, { cik_str: number; ticker: string }>;
  const stored = cached
    ? (JSON.parse(cached.payloadJson) as typeof list)
    : null;
  if (
    stored &&
    ageDays < 30 &&
    (ageDays <= 0 || Object.values(stored).some((c) => c.ticker === ticker))
  ) {
    list = stored;
  } else {
    const res = await secFetch(
      "https://www.sec.gov/files/company_tickers.json",
    );
    list = (await res.json()) as typeof list;
    await db
      .delete(fmpCache)
      .where(
        and(
          eq(fmpCache.ticker, "_SEC"),
          eq(fmpCache.endpoint, "company_tickers"),
        ),
      );
    await db.insert(fmpCache).values({
      ticker: "_SEC",
      endpoint: "company_tickers",
      fetchedOn: today(),
      payloadJson: JSON.stringify(list),
    });
  }

  const match = Object.values(list).find((c) => c.ticker === ticker);
  return match ? String(match.cik_str) : null;
}

type FilingList = {
  accessionNumber: string[];
  filingDate: string[];
  form: string[];
  primaryDocument: string[];
  items: string[];
};
type Submissions = {
  filings: {
    recent: FilingList;
    files?: { name: string; filingTo: string }[];
  };
};

/**
 * Inserts filings we have not seen and returns those still waiting to be reviewed. The first
 * time a ticker is seen, only the last 7 days count as new; older filings are diff history. After
 * that at least 30 days count, extended for a gap in full reviews up to 100 days.
 */
export async function syncFilings(
  ticker: string,
  cik: string,
  lastFullReviewAt: string | null = null,
) {
  const padded = cik.padStart(10, "0");
  const res = await secFetch(
    `https://data.sec.gov/submissions/CIK${padded}.json`,
  );
  const { recent, files = [] } = ((await res.json()) as Submissions).filings;

  const existing = await db
    .select({ accessionNo: filings.accessionNo, form: filings.form })
    .from(filings)
    .where(eq(filings.ticker, ticker));
  const known = new Set(existing.map((f) => f.accessionNo));
  let annualReports = existing.filter((f) => ANNUAL_FORMS.has(f.form)).length;

  const now = new Date();
  const dayMs = 86_400_000;
  const nowIso = now.toISOString();
  // Filing dates are SEC calendar dates, not instants at UTC midnight. An elapsed-hours check
  // ages them out partway through their last eligible day, even earlier in western US zones.
  const secDate = (date: Date) =>
    date.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const asOf = Date.parse(secDate(now));
  const ageOf = (date: string) =>
    (asOf - Date.parse(date.length === 10 ? date : secDate(new Date(date)))) /
    dayMs;
  const reviewAge = lastFullReviewAt ? ageOf(lastFullReviewAt) : 0;
  const newWithinDays = existing.length
    ? Math.min(100, Math.max(30, Number.isFinite(reviewAge) ? reviewAge : 0))
    : 7;

  const insertAll = async (list: FilingList) => {
    for (let i = 0; i < list.accessionNumber.length; i++) {
      const form = list.form[i] ?? "";
      const accessionNo = list.accessionNumber[i] ?? "";
      const filedAt = list.filingDate[i] ?? "";
      const ageDays = ageOf(filedAt);
      if (!TRACKED_FORMS.has(form) || known.has(accessionNo)) continue;
      // Both become part of file names in a pack, so neither may carry a path.
      if (!/^[\w-]+$/.test(accessionNo) || !/^\d{4}-\d{2}-\d{2}$/.test(filedAt))
        continue;
      // A date with the right shape but no such day has no age, and must not pass as recent.
      if (!Number.isFinite(ageDays) || ageDays > HISTORY_DAYS) continue;
      known.add(accessionNo);
      if (ANNUAL_FORMS.has(form)) annualReports += 1;

      await db
        .insert(filings)
        .values({
          accessionNo,
          ticker,
          form,
          filedAt,
          primaryDocUrl: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNo.replaceAll("-", "")}/${list.primaryDocument[i]}`,
          items: list.items[i] ?? "",
          // Older filings are history, for example after selling a stock and rebuying it later.
          processedAt: ageDays > newWithinDays ? nowIso : null,
        })
        .onConflictDoNothing();
    }
  };
  await insertAll(recent);

  // A heavy filer's recent list can hold under a year, hiding last year's annual report and so any
  // comparison with it. Citi's sat four older pages back. A search that found nothing is not
  // repeated for 30 days, since every page is a request.
  if (annualReports < 2 && files.length) {
    const marker = `older_pages_${ticker}`;
    const [searched] = await db
      .select()
      .from(fmpCache)
      .where(and(eq(fmpCache.ticker, "_SEC"), eq(fmpCache.endpoint, marker)))
      .orderBy(desc(fmpCache.fetchedOn))
      .limit(1);
    if (!searched || ageOf(searched.fetchedOn) >= 30) {
      const inRange = files.filter((f) => ageOf(f.filingTo) <= HISTORY_DAYS);
      for (const page of inRange.slice(0, OLDER_PAGE_LIMIT)) {
        const older = await secFetch(
          `https://data.sec.gov/submissions/${page.name}`,
        );
        await insertAll((await older.json()) as FilingList);
        if (annualReports >= 2) break;
      }
      await db
        .delete(fmpCache)
        .where(and(eq(fmpCache.ticker, "_SEC"), eq(fmpCache.endpoint, marker)));
      await db.insert(fmpCache).values({
        ticker: "_SEC",
        endpoint: marker,
        fetchedOn: today(),
        payloadJson: "[]",
      });
    }
  }

  return db
    .select()
    .from(filings)
    .where(and(eq(filings.ticker, ticker), isNull(filings.processedAt)))
    .orderBy(desc(filings.filedAt));
}

/**
 * Stops a filing that stays unusable from forcing a full review every day. The days count from the
 * first failure, not the filing date, or one first seen a week late would get no retry at all.
 */
export async function gaveUpOnFiling(
  filing: Pick<Filing, "accessionNo">,
  asOf: string,
): Promise<boolean> {
  const marker = `retrying:${filing.accessionNo}`;
  const [first] = await db
    .select({ on: fmpCache.fetchedOn })
    .from(fmpCache)
    .where(and(eq(fmpCache.ticker, "_SEC"), eq(fmpCache.endpoint, marker)))
    .limit(1);
  if (!first) {
    await db.insert(fmpCache).values({
      ticker: "_SEC",
      endpoint: marker,
      fetchedOn: asOf,
      payloadJson: "[]",
    });
    return false;
  }
  return (
    (Date.parse(asOf) - Date.parse(first.on)) / 86_400_000 >
    UNREADABLE_RETRY_DAYS
  );
}

// Long cells are layout, such as a whole document wrapped in one table, and keep their paragraphs.
const FLATTEN_CELL_CHARS = 2_000;

/** A cell's inner paragraphs would otherwise split "(107.2" from its ")" across blank lines. */
function flattenTableCells(html: string) {
  return html.replace(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi, (cell) =>
    cell.length > FLATTEN_CELL_CHARS
      ? cell
      : cell.replace(/<\/?(?:p|div|br|center)\b[^>]*>/gi, " "),
  );
}

/**
 * HTML to plain text, one table row per line with its cells apart. Without this a results table
 * reads "Revenue$4,938$4,41212%", which no reader can split into current, prior and change.
 */
export function filingHtmlToText(html: string) {
  return convert(flattenTableCells(html), {
    wordwrap: false,
    limits: { maxInputLength: 64_000_000 },
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "table", options: { uppercaseHeaderCells: false } },
      { selector: "ix\\:header", format: "skip" }, // inline XBRL metadata
      {
        selector: "tr",
        format: "block",
        options: { leadingLineBreaks: 1, trailingLineBreaks: 1 },
      },
      { selector: "td", format: "inlineSurround", options: { suffix: " " } },
      { selector: "th", format: "inlineSurround", options: { suffix: " " } },
    ],
  })
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .replace(/\(\s*(\d[\d,.]*)\s*\)/g, "($1)") // negatives whose ")" sat in its own cell
    .replace(/\$ (?=[\d(])/g, "$")
    .replace(/(\d) %/g, "$1%");
}

export async function fetchFilingText(url: string) {
  const res = await secFetch(url);
  const body = await res.text();
  if (body.startsWith("%PDF")) throw new Error(`Not a text document: ${url}`);
  return filingHtmlToText(body);
}

export const itemList = (row: Filing) =>
  (row.items ?? "").split(",").map((item) => item.trim());

function exhibitUrl(href: string, base: string) {
  const link = new URL(href, base);
  // Inline XBRL documents are linked through SEC's viewer page.
  const url =
    link.pathname === "/ix"
      ? new URL(link.searchParams.get("doc") ?? "", link)
      : link;
  if (
    url.origin !== "https://www.sec.gov" ||
    !url.pathname.startsWith(new URL(base).pathname)
  )
    throw new Error("Invalid SEC exhibit path");
  return url.href;
}

/** A filing's exhibits as its EDGAR index lists them, without XBRL data files. */
async function filingExhibits(row: Filing, base: string) {
  const index = await (
    await secFetch(`${base}${row.accessionNo}-index.html`)
  ).text();
  return [...index.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].flatMap((m) => {
    const cells = [...m[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(
      (c) => c[1]!.trim(),
    );
    const type = cells.at(-2)?.replace(/<[^>]*>/g, "") ?? "";
    // EX-101 and EX-104 are XBRL data, not exhibits anyone reads.
    if (!/^EX-(?!10[14]\b)/i.test(type)) return [];
    const href = /href=["']([^"']+)["']/i.exec(cells.join(" "))?.[1];
    const size = Number(
      cells
        .at(-1)
        ?.replace(/<[^>]*>/g, "")
        .replace(/,/g, ""),
    );
    const description = cells[1]?.replace(/<[^>]*>/g, "") ?? "";
    return href
      ? [{ type, href, description, size: Number.isFinite(size) ? size : 0 }]
      : [];
  });
}

const baseOf = (row: Filing) =>
  row.primaryDocUrl.slice(0, row.primaryDocUrl.lastIndexOf("/") + 1);

const ANNUAL_EXHIBIT_TYPES: Record<string, RegExp> = {
  "10-K": /^EX-13/i,
  "20-F": /^EX-15/i,
  "40-F": /^EX-99/i,
};

/** An amendment reads like the report it amends, and a transition report like a 10-K. */
function baseForm(form: string) {
  const base = form.replace(/\/A$/, "");
  return base === "10-KT" ? "10-K" : base;
}

/**
 * Some annual reports keep their substance elsewhere: a 20-F or 40-F usually points to an exhibit,
 * and a 10-K can use an EX-13. NVO's Risk Factors item is one paragraph pointing to its exhibit.
 */
export function incorporatesAnnualReport(
  form: string,
  sections: Pick<Sections, "risk_factors" | "mda">,
) {
  const base = baseForm(form);
  if (base === "20-F" || base === "40-F") return true;
  return (
    base === "10-K" &&
    (sections.risk_factors?.length ?? 0) + (sections.mda?.length ?? 0) < 2_000
  );
}

/** The largest text exhibit holding the annual report, or null when the filing has none. */
export async function fetchAnnualExhibit(row: Filing) {
  const type = ANNUAL_EXHIBIT_TYPES[baseForm(row.form)];
  if (!type) return null;
  const base = baseOf(row);
  const [largest] = (await filingExhibits(row, base))
    .filter(
      (e) =>
        type.test(e.type) &&
        /\.(?:html?|txt)$/i.test(e.href) &&
        !/\bconsents?\b/i.test(e.description),
    )
    .sort((a, b) => b.size - a.size);
  if (!largest) return null;
  const url = exhibitUrl(largest.href, base);
  const text = await fetchFilingText(url);
  return text.trim() ? { url, text } : null;
}

/** The parts of an annual report exhibit a reader with a size limit most needs. */
export function annualExhibitExcerpt(text: string) {
  const parts = [
    ["Risk", /risk\s+(?:factors|management)|principal\s+risks/],
    [
      "Results",
      /financial\s+(?:performance|review)|management.{0,3}s\s+(?:review|discussion)|operating\s+(?:results|review)/,
    ],
  ] as const;
  const found = parts.flatMap(([title, heading]) => {
    const section = sectionByHeading(text, heading, ANNUAL_EXHIBIT_PART_CHARS);
    return section ? [`### ${title}\n\n${section}`] : [];
  });
  return found.length
    ? found.join("\n\n")
    : text.slice(0, ANNUAL_EXHIBIT_PART_CHARS);
}

/**
 * An event filing's primary document can be only a cover, so this also reads a 6-K's largest EX-99
 * and an 8-K's first two, which are normally the press release, when item 9.01 says it has
 * exhibits. A cover alone is not delivery, so a failed index or exhibit throws and a later run
 * retries it. An exhibit with no text can never be read, so the text says so, rather than leaving
 * the filing pending and forcing a full review every day. The order decides what a cap keeps.
 */
export async function fetchEventText(row: Filing) {
  const primary = await fetchFilingText(row.primaryDocUrl);
  const sixK = row.form.startsWith("6-K");
  const items = itemList(row);
  if (!sixK && !(row.form.startsWith("8-K") && items.includes("9.01")))
    return primary;
  const base = baseOf(row);
  try {
    const exhibits = await filingExhibits(row, base);
    const ex99 = exhibits.filter((e) => /^EX-99(?:[.\s-]|$)/i.test(e.type));
    // A 6-K's results can sit in an EX-1 when it has no EX-99 and its primary is only a cover.
    const pool =
      ex99.length || !sixK || primary.length >= EVENT_HEAD_CHARS
        ? ex99
        : exhibits;
    const exhibitNumber = (type: string) =>
      Number(/^EX-99\D*(\d*)/i.exec(type)?.[1]);
    pool.sort((a, b) =>
      sixK ? b.size - a.size : exhibitNumber(a.type) - exhibitNumber(b.type),
    );
    const isText = (e: (typeof pool)[number]) =>
      /\.(?:html?|txt)$/i.test(e.href);
    const chosen = pool.filter(isText).slice(0, sixK ? 1 : 2);

    // A readable appendix does not deliver a higher-ranked report that is a PDF or image.
    // Keep the notice ahead of content caps without retrying a permanently nontext exhibit.
    const omitted = pool.slice(0, sixK ? 1 : 2).filter((e) => !isText(e));
    const warnings = omitted.map(
      (e) =>
        `This filing's main exhibit is not a text document, so its content was not read: ${exhibitUrl(e.href, base)}`,
    );
    const parts: string[] = [];
    for (const exhibit of chosen) {
      const url = exhibitUrl(exhibit.href, base);
      const text = await fetchFilingText(url);
      // A blank exhibit is a page of images, such as slides. Retrying would not change that.
      parts.push(
        text.trim()
          ? `Exhibit source: ${url}\n\n${text}`
          : `This exhibit has no text, so its content was not read: ${url}`,
      );
    }
    if (!parts.length && !warnings.length) return primary;

    const read = parts.some((p) => p.startsWith("Exhibit source:"));
    if (!read && !primary.trim()) throw new Error("Blank filing text");
    const body =
      !read || sixK || items.includes("2.02")
        ? `${parts.join("\n\n")}\n\nPrimary document:\n${primary}`
        : `Primary document:\n${primary}\n\n${parts.join("\n\n")}`;
    return [...warnings, body].join("\n\n");
  } catch (error) {
    throw new Error(`Could not resolve exhibits of ${row.accessionNo}`, {
      cause: error,
    });
  }
}

/**
 * Finds a section by heading. A table-of-contents hit runs only a few characters to the next
 * heading, so the longest span from a heading to its end marker is the real section. End markers
 * must start a line where possible: mid-sentence text such as "see Item 8" is not the end.
 */
function extractSection(text: string, start: RegExp, end: RegExp) {
  const anchored = (re: RegExp, flags: string) =>
    new RegExp(`^[\\s|]*(?:part\\s+i+[\\s,.—–-]*)?(?:${re.source})`, flags);
  const headingStarts = [...text.matchAll(anchored(start, "gim"))];
  const starts = headingStarts.length
    ? headingStarts
    : [...text.matchAll(new RegExp(start.source, "gi"))];

  let best: string | null = null;
  for (const m of starts) {
    const from = m.index;
    const tail = text.slice(from + m[0].length);
    let stop = tail.search(anchored(end, "im"));
    if (stop < 0) stop = tail.search(new RegExp(end.source, "i"));
    if (stop < 0) continue;
    const section = text.slice(from, from + m[0].length + stop).trim();
    if (!best || section.length > best.length) best = section;
  }
  return best && best.length >= MIN_SECTION_CHARS ? best : null;
}

/**
 * For reports with no Item headings, such as Citi's. The heading is all there is to go on, so this
 * takes text from the first one past the table of contents, bounded by a heading or a size limit.
 */
function sectionByHeading(
  text: string,
  heading: RegExp,
  limit = HEADING_ONLY_SECTION_CHARS,
  ends?: RegExp,
) {
  const pattern = new RegExp(
    `^[\\s|]*(?:${heading.source})[^\\n]{0,60}$`,
    "gim",
  );
  for (const m of text.matchAll(pattern)) {
    if (m.index < text.length * 0.01) continue;
    const window = text.slice(m.index, m.index + limit);
    const stop = ends ? window.slice(20_000).search(ends) : -1;
    if (stop >= 0) return window.slice(0, 20_000 + stop).trim();
    if (m.index + limit >= text.length) {
      const rest = text.slice(m.index).trim();
      return ends
        ? `${rest}\n[The end of this section could not be identified; text continues to the end of the report.]`
        : rest;
    }
    const end = Math.max(window.lastIndexOf(". "), window.lastIndexOf(".\n"));
    const whole = end > 0 ? window.slice(0, end + 1) : window;
    return `${whole.trim()}\n[Cut off here: this report has no standard section markers.]`;
  }
  return null;
}

const GAP = "[\\s.:|—–-]*";
const RISK_START = new RegExp(`item\\s*1a${GAP}risk\\s+factors`);
const MDA_TITLE = "management.{0,3}s\\s+discussion";
const RISK_HEADING = /risk\s+factors/;
const MDA_HEADING = /management.{0,3}s\s+discussion\s+and\s+analysis/;

export function extractSections(form: string, text: string) {
  form = baseForm(form);
  if (form === "40-F") return { risk_factors: null, mda: null };
  if (form === "20-F")
    return {
      risk_factors: extractSection(
        text,
        /item\s*3[.\s]*d[.\s]*risk\s+factors|d[.\s]+risk\s+factors/,
        /item\s*4\b/,
      ),
      mda: extractSection(
        text,
        /item\s*5[.\s]*operating\s+and\s+financial\s+review/,
        /item\s*6\b/,
      ),
    };
  const byItem =
    form === "10-K"
      ? {
          risk_factors: extractSection(
            text,
            RISK_START,
            new RegExp(
              `item\\s*1b${GAP}|item\\s*1c${GAP}|item\\s*2${GAP}properties`,
            ),
          ),
          mda: extractSection(
            text,
            new RegExp(`item\\s*7${GAP}${MDA_TITLE}`),
            new RegExp(`item\\s*7a${GAP}|item\\s*8${GAP}financial`),
          ),
        }
      : {
          risk_factors: extractSection(
            text,
            RISK_START,
            new RegExp(
              `item\\s*2${GAP}unregistered|item\\s*3${GAP}defaults|item\\s*5${GAP}other|item\\s*6${GAP}exhibits`,
            ),
          ),
          mda: extractSection(
            text,
            new RegExp(`item\\s*2${GAP}${MDA_TITLE}`),
            new RegExp(`item\\s*3${GAP}quantitative|item\\s*4${GAP}controls`),
          ),
        };
  return {
    risk_factors:
      byItem.risk_factors ??
      sectionByHeading(
        text,
        RISK_HEADING,
        HEADING_ONLY_SECTION_CHARS,
        /^(?:SUSTAINABILITY|MANAGEMENT['’]S DISCUSSION AND ANALYSIS|FINANCIAL STATEMENTS(?: AND SUPPLEMENTARY DATA)?|SIGNATURES)$/m,
      ),
    mda:
      byItem.mda ??
      sectionByHeading(
        text,
        MDA_HEADING,
        HEADING_ONLY_SECTION_CHARS,
        /^RISK FACTORS$/m,
      ),
  };
}

// Page furniture changes every year and would otherwise make unchanged sentences look new.
function contentLines(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim());
  const headings = new Map<string, number>();
  for (const line of lines) {
    if (/^[A-Z][A-Z .,&'’-]{4,}$/.test(line))
      headings.set(line, (headings.get(line) ?? 0) + 1);
  }
  return lines.filter((l) => {
    if (!l) return false;
    if ((headings.get(l) ?? 0) >= 3) return false;
    if (/^[-=_*]{3,}$/.test(l) || /^-?\s?\d{1,4}\s?-?$/.test(l)) return false;
    if (/^table of contents$/i.test(l)) return false;
    if (/^(?:part\s+[ivx]+|item\s+\d+[a-z]?\.?)$/i.test(l)) return false;
    return !(
      l.length < 100 &&
      /\|?\s*form\s+(?:10-[kq]|20-f|40-f)\b/i.test(l) &&
      /\d\s*$/.test(l)
    );
  });
}

const ABBREVIATION =
  /(?:^|[\s("'“‘])(?:Inc|Corp|Co|Ltd|LLC|No|Nos|vs|Mr|Ms|Mrs|Dr|St|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|U\.S|U\.K|e\.g|i\.e|Item\s\d+[A-Z]?|(?:[A-Z]\.)+[A-Z]|[A-Z])\.$/;

const ENDS_SENTENCE = /[.!?:;]["”’)]*$/;
const TABLE_ROW = /[\d)%—-]\s+[$(]?[\d—-][\d,.]*[%)]?$/; // ends in two figures
const BULLET = /^[•▪·●○–—-]/;
const LONG_LINE = 35;
const WRAPPED_SHARE = 0.7;

/**
 * Puts a paragraph back together. Nasdaq's filings set every printed line as its own block, and any
 * filing can break a sentence across a page. Left apart, the pieces read as false changes, like
 * "2025." or "As of". Starting in lower case always continues a line, but a capital only does in a
 * filing wrapped this way throughout, where it would otherwise join headings to what follows.
 */
function rejoinLines(lines: string[]) {
  const prose = lines.filter(
    (l) => l.length >= LONG_LINE && /[a-z]/.test(l) && !TABLE_ROW.test(l),
  );
  const wrapped =
    prose.filter((l) => !ENDS_SENTENCE.test(l)).length >
    prose.length * WRAPPED_SHARE;
  const joined: string[] = [];
  for (const line of lines) {
    const before = joined.at(-1);
    const lower = /^[a-z]/.test(line);
    const continues =
      before !== undefined &&
      !ENDS_SENTENCE.test(before) &&
      (wrapped &&
      before.length >= LONG_LINE &&
      !BULLET.test(line) &&
      (lower || (!TABLE_ROW.test(before) && !TABLE_ROW.test(line)))
        ? true
        : lower && !TABLE_ROW.test(before));
    if (continues) joined[joined.length - 1] = `${before} ${line}`;
    else joined.push(line);
  }
  return joined;
}

/** A table row stays one unit, and a period after "Inc." or "No." does not end a sentence. */
function sentencesOf(text: string) {
  const sentences: string[] = [];
  for (const line of rejoinLines(contentLines(text))) {
    let current = "";
    for (const piece of line.split(/(?<=[.!?])\s+/)) {
      current = current ? `${current} ${piece}` : piece;
      if (!ABBREVIATION.test(current)) {
        sentences.push(current);
        current = "";
      }
    }
    if (current) sentences.push(current);
  }
  return sentences;
}

function sentenceChanges(previous: string, current: string) {
  const added: string[] = [];
  const removed: string[] = [];
  for (const part of diffArrays(sentencesOf(previous), sentencesOf(current))) {
    if (part.added) added.push(...part.value);
    if (part.removed) removed.push(...part.value);
  }
  // A sentence on both sides only moved, so it is not a change.
  const addedSet = new Set(added);
  const removedSet = new Set(removed);
  return {
    added: added.filter((s) => !removedSet.has(s)),
    removed: removed.filter((s) => !addedSet.has(s)),
  };
}

// Too serious to leave to chance, wherever in the section it appears.
// Each names the company's own trouble: "bankruptcy" alone ranked a distributor's hypothetical first,
// and "restated" alone every "amended and restated" credit agreement.
const ALWAYS_FIRST =
  /going concern|substantial doubt|material weakness|restatement|(?<!amended and )restated (?:our |its |the |previously )|(?:our|the company.s|we (?:may|could|might) be) .{0,40}delist|notice of (?:non-?compliance|delisting)|fil(?:e|ed|ing) for bankruptcy|chapter 11|subpoena|foreclosed/i;

const wordsOf = (s: string) => new Set(s.toLowerCase().match(/[a-z]{4,}/g));

// The same sentence with new dates or figures, which every period's report repeats.
const withoutFigures = (s: string) =>
  s
    .toLowerCase()
    .replace(/\d[\d,.]*/g, "#")
    .replace(
      /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|first|second|third|fourth|fiscal)\b/g,
      "@",
    );

const STATED_FIGURE =
  /\$\s?\d[\d,.]*(?:\s(?:billion|million|trillion))?|\d[\d,.]*\s?%|\d[\d,.]*\s(?:billion|million|trillion)/gi;

// A routine sentence can still disclose a meaningful change in customer concentration or exposure.
function movedFigures(added: string[], removed: string[]) {
  const previous = new Map(removed.map((s) => [withoutFigures(s), s]));
  return added
    .flatMap((sentence) => {
      if (wordsOf(sentence).size < 5 || !/[.!?:;]$/.test(sentence)) return [];
      const before = previous.get(withoutFigures(sentence));
      if (!before) return [];
      const old = before.match(STATED_FIGURE) ?? [];
      const current = sentence.match(STATED_FIGURE) ?? [];
      if (!old.length || old.length !== current.length) return [];
      const numberOf = (figure: string) =>
        Number(figure.replace(/[^\d.]/g, ""));
      const move = Math.max(
        ...current.map((figure, i) => {
          const prior = numberOf(old[i]!);
          const value = numberOf(figure);
          return prior === 0
            ? value === 0
              ? 0
              : Infinity
            : Math.abs((value - prior) / prior);
        }),
      );
      return move >= 0.1
        ? [{ sentence: `${sentence} (${old.join(", ")} before)`, move }]
        : [];
    })
    .sort((a, b) => b.move - a.move)
    .map((row) => row.sentence);
}

/**
 * Most important first, so a cap cuts the least useful. Position must not decide: a cap by position
 * kept boilerplate and tables, and lost NVDA's "effectively foreclosed from the China market". After
 * the serious terms come sentences least like anything on the other side, which are the new ideas,
 * and last come routine updates and table rows.
 */
function byImportance(changes: string[], otherSide: string[]) {
  const routine = new Set(otherSide.map(withoutFigures));
  const others = otherSide.map(wordsOf);
  return changes
    .map((sentence, position) => {
      const words = wordsOf(sentence);
      let closest = 0;
      for (const other of others) {
        let shared = 0;
        for (const word of words) if (other.has(word)) shared += 1;
        closest = Math.max(
          closest,
          shared / Math.max(words.size + other.size - shared, 1),
        );
      }
      const isProse = words.size >= 8 && /[.!?:;]$/.test(sentence);
      const tier = ALWAYS_FIRST.test(sentence)
        ? 0
        : routine.has(withoutFigures(sentence))
          ? 3
          : isProse
            ? 1
            : 2;
      return { sentence, position, tier, closest };
    })
    .sort(
      (a, b) =>
        a.tier - b.tier || a.closest - b.closest || a.position - b.position,
    )
    .map((row) => row.sentence);
}

type SectionPair = {
  risk_factors: string | null;
  mda: string | null;
  risk_compared_with?: string;
};

const diffTitles = (previous: SectionPair, current: SectionPair) =>
  [
    ["Risk Factors", previous.risk_factors, current.risk_factors],
    ["MD&A", previous.mda, current.mda],
  ] as const;

/**
 * Compact added/removed list, most important first. Each section gets its own share of the cap, so
 * both are seen, and added and removed each get their own, so a long list cannot hide the other.
 */
export function compactDiff(previous: SectionPair, current: SectionPair) {
  const parts: string[] = [];
  const titled = diffTitles(previous, current);
  for (const [title, before, after] of titled) {
    const comparison =
      title === "Risk Factors" && previous.risk_compared_with
        ? `Compared with the ${previous.risk_compared_with}.\n\n`
        : "";
    if (!before || !after) {
      parts.push(`## ${title}\n\nNot compared: section missing from a filing.`);
      continue;
    }
    const { added, removed } = sentenceChanges(before, after);
    const list = (lines: string[], mark: string, cap: number) => {
      const kept: string[] = [];
      let used = 0;
      for (const line of lines) {
        const text = `${mark} ${line}`;
        if (kept.length && used + text.length > cap) break;
        kept.push(text.length > cap ? `${text.slice(0, cap)}...` : text);
        used += text.length + 1;
      }
      const more = lines.length - kept.length;
      return (
        (kept.join("\n") || "(none)") +
        (more
          ? `\n[${more} less important changes are left out here; filing_changes_*.txt lists them all]`
          : "")
      );
    };
    const share = DIFF_CAP_CHARS / titled.length;
    const moved = title === "Risk Factors" ? movedFigures(added, removed) : [];
    parts.push(
      `## ${title}\n\n${comparison}### Added\n${list(byImportance(added, removed), "+", share * DIFF_ADDED_SHARE)}\n\n### Removed\n${list(byImportance(removed, added), "-", share * (1 - DIFF_ADDED_SHARE))}${moved.length ? `\n\n### Figures that moved\n${list(moved, "~", share * 0.2)}` : ""}`,
    );
  }
  return parts.join("\n\n");
}

/** Every changed sentence, in filing order, for a reader that can search a long file. */
function allChanges(previous: SectionPair, current: SectionPair) {
  return diffTitles(previous, current)
    .map(([title, before, after]) => {
      if (!before || !after) return `## ${title}\n\nNot compared.`;
      const { added, removed } = sentenceChanges(before, after);
      const list = (lines: string[], mark: string) =>
        lines.map((l) => `${mark} ${l}`).join("\n") || "(none)";
      const comparison =
        title === "Risk Factors" && previous.risk_compared_with
          ? `Compared with the ${previous.risk_compared_with}.\n\n`
          : "";
      return `## ${title}\n\n${comparison}### Added\n${list(added, "+")}\n\n### Removed\n${list(removed, "-")}`;
    })
    .join("\n\n");
}

export function savedSections(row: Filing) {
  return row.sectionsJson ? (JSON.parse(row.sectionsJson) as Sections) : null;
}

async function saveSections(row: Filing, sections: Sections) {
  await db
    .update(filings)
    .set({ sectionsJson: JSON.stringify(sections) })
    .where(
      and(
        eq(filings.accessionNo, row.accessionNo),
        eq(filings.ticker, row.ticker),
      ),
    );
}

const STATEMENT_HEADING =
  /^[^\n]{0,40}(?:statements?\s+of\s+(?:consolidated\s+)?(?:income|operations|earnings|comprehensive income)|income\s+statements?)[^\n]{0,40}$/gim;

/**
 * The opening of an event filing, and its income statement if a cap would lose it. Citi's starts
 * past 62,000 characters and NVO's past 88,000, so headline figures had nothing to be checked with.
 */
export function eventExcerpt(text: string, cap: number) {
  if (text.length <= cap) return text;
  const headChars = Math.floor(cap * (1 - STATEMENT_SHARE));
  const headings = [...text.matchAll(STATEMENT_HEADING)];
  const inHead = headings.some((m) => m.index < headChars);
  const later = headings.find((m) => m.index >= headChars);
  if (inHead || !later) return `${text.slice(0, cap)}\n[truncated]`;
  const statement = text.slice(later.index, later.index + cap - headChars);
  return `${text.slice(0, headChars)}\n[truncated]\n\n${statement}\n[truncated]`;
}

// `knownText` saves a second download when the caller has just fetched this same filing.
async function extractedFor(
  row: Filing,
  knownText?: string,
): Promise<Sections> {
  const saved = savedSections(row);
  const items = itemList(row);
  const isEvent = EVENT_FORMS.has(row.form);
  const textFormat =
    row.form.startsWith("6-K") ||
    (row.form.startsWith("8-K") && items.includes("9.01"))
      ? EXHIBIT_TEXT_FORMAT
      : TEXT_FORMAT;
  // Old rows hold text from an earlier conversion: 8-Ks only their cover, and tables run together.
  const refresh =
    saved &&
    ((saved.text_format ?? 1) < textFormat ||
      (isEvent && !saved.text_head?.trim()));
  if (saved && !refresh) return saved;
  try {
    const text = knownText ?? (await fetchEventText(row));
    if (!text.trim()) throw new Error(`Blank text for ${row.accessionNo}`);
    const headChars =
      row.form.startsWith("6-K") || items.includes("2.02")
        ? RESULTS_HEAD_CHARS
        : /^Exhibit source: /m.test(text)
          ? EXHIBIT_HEAD_CHARS
          : EVENT_HEAD_CHARS;
    const sections: Sections = isEvent
      ? {
          risk_factors: null,
          mda: null,
          diff: null,
          text_head: eventExcerpt(text, headChars),
          text_format: textFormat,
        }
      : {
          ...extractSections(row.form, text),
          diff: null,
          text_head: null,
          text_format: textFormat,
        };
    await saveSections(row, sections);
    return sections;
  } catch (error) {
    // A filing already reviewed keeps what it has. A pending one fails, so it is retried.
    const keep = isEvent
      ? saved?.text_head?.trim()
      : saved?.risk_factors || saved?.mda;
    if (row.processedAt && saved && keep) {
      if (
        textFormat === EXHIBIT_TEXT_FORMAT &&
        (saved.text_format ?? 1) < textFormat
      )
        return {
          ...saved,
          text_head: `This run could not recheck this filing's exhibits. The cached text below may omit unread exhibits.\n\n${saved.text_head}`,
        };
      return saved;
    }
    throw error;
  }
}

/** The previous filing of the same form, read in the current text format, or null. */
async function previousSections(row: Filing, current: Sections) {
  const [previous] = await db
    .select()
    .from(filings)
    .where(
      and(
        eq(filings.ticker, row.ticker),
        eq(filings.form, row.form),
        lt(filings.filedAt, row.filedAt),
      ),
    )
    .orderBy(desc(filings.filedAt))
    .limit(1);
  if (!previous) return null;
  const sections = await extractedFor(previous);
  // Comparing two text formats would report every table as changed.
  if (sections.text_format !== TEXT_FORMAT) return null;
  if (row.form === "10-Q") {
    const [annual] = await db
      .select()
      .from(filings)
      .where(
        and(
          eq(filings.ticker, row.ticker),
          eq(filings.form, "10-K"),
          gt(filings.filedAt, previous.filedAt),
          lt(filings.filedAt, row.filedAt),
        ),
      )
      .orderBy(desc(filings.filedAt))
      .limit(1);
    const annualSections = annual
      ? await extractedFor(annual).catch(() => null)
      : null;
    if (
      annualSections?.text_format === TEXT_FORMAT &&
      annualSections.risk_factors &&
      current.risk_factors &&
      current.risk_factors.length >= annualSections.risk_factors.length * 0.8
    ) {
      const currentSentences = new Set(sentencesOf(current.risk_factors));
      const annualSentences = sentencesOf(annualSections.risk_factors);
      const matched = annualSentences.reduce(
        (chars, sentence) =>
          chars + (currentSentences.has(sentence) ? sentence.length : 0),
        0,
      );
      if (matched > 0 && matched >= annualSentences.join("").length * 0.6)
        return {
          ...sections,
          risk_factors: annualSections.risk_factors,
          risk_compared_with: `10-K filed ${annual!.filedAt}`,
        };
    }
  }
  return sections;
}

// NVO's diff reads as a comparison with its previous 20-F, while its real risks sit in EX-15.1.
const diffOpening = (form: string, sections: Sections) =>
  incorporatesAnnualReport(form, sections)
    ? "This compares the main document only. An annual report exhibit, where there is one, can hold most of the risks and results, and it was not compared.\n\n"
    : "";

/**
 * Sections and diff for a 10-K or 10-Q, or the opening text of an 8-K, saved on the filing row.
 * Form 4 stores nothing: it is only a date and a link. Returns null when extraction fails.
 */
export async function ensureSections(
  row: Filing,
  knownText?: string,
): Promise<Sections | null> {
  if (row.form === "4") return null;
  try {
    const sections = await extractedFor(row, knownText);
    if (
      EVENT_FORMS.has(row.form) ||
      row.form.endsWith("/A") ||
      (sections.diff && sections.diff_version === DIFF_VERSION)
    )
      return sections;
    try {
      const previous = await previousSections(row, sections);
      if (previous) {
        sections.diff = `${diffOpening(row.form, sections)}${compactDiff(previous, sections)}`;
        sections.diff_version = DIFF_VERSION;
        await saveSections(row, sections);
      }
    } catch {
      // This filing was still read. Its diff is not current, so a later run tries again.
    }
    return sections;
  } catch {
    // Extraction is best effort: the job carries on without this filing's sections.
    return null;
  }
}

/** Every changed sentence since the previous filing of this form, or null if it cannot be told. */
export async function fullChanges(row: Filing, sections: Sections) {
  try {
    const previous = await previousSections(row, sections);
    return previous
      ? `${diffOpening(row.form, sections)}${allChanges(previous, sections)}`
      : null;
  } catch {
    return null;
  }
}

// What each 8-K item number means. Exhibits say nothing on their own, so they are left out.
const EIGHT_K_ITEMS: Record<string, string> = {
  "1.01": "Material agreement",
  "1.02": "Agreement ended",
  "1.03": "Bankruptcy",
  "1.05": "Cybersecurity incident",
  "2.01": "Acquisition or sale",
  "2.02": "Results",
  "2.03": "New debt",
  "2.04": "Debt trigger",
  "2.05": "Restructuring",
  "2.06": "Impairment",
  "3.01": "Listing notice",
  "3.02": "Unregistered share sale",
  "3.03": "Shareholder rights change",
  "4.01": "Auditor change",
  "4.02": "Restatement",
  "5.01": "Change of control",
  "5.02": "Officer or director change",
  "5.03": "Charter or bylaw change",
  "5.07": "Shareholder vote",
  "7.01": "Investor disclosure",
  "8.01": "Other event",
};

/**
 * The newest filings plus the latest of every other form, given rows newest first. A foreign
 * issuer's routine 6-Ks would otherwise push its annual report off the list.
 */
export function filingsToList<T extends { form: string }>(rows: T[]) {
  return rows.filter(
    (row, i) => i < 20 || rows.findIndex((r) => r.form === row.form) === i,
  );
}

/** One line on what a filing is. */
export function filingSummary(form: string, items: string | null): string {
  if (form.endsWith("/A"))
    return `${filingSummary(form.slice(0, -2), items) || form.slice(0, -2)} amendment`;
  if (["10-K", "20-F", "40-F"].includes(form)) return "Annual report";
  if (form === "10-KT") return "Transition report";
  if (form === "6-K") return "Foreign issuer report";
  if (form.startsWith("NT ")) return "Late filing notice";
  if (form === "10-Q") return "Quarterly report";
  if (form !== "8-K" || !items) return "";
  return items
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "9.01")
    .map((item) => EIGHT_K_ITEMS[item] ?? `Item ${item}`)
    .join(", ");
}

export async function recentFilings(
  ticker: string,
  form: string,
  limit: number | null,
  since?: string,
) {
  const query = db
    .select()
    .from(filings)
    .where(
      and(
        eq(filings.ticker, ticker),
        eq(filings.form, form),
        since ? gte(filings.filedAt, since) : undefined,
      ),
    )
    .orderBy(desc(filings.filedAt));
  return limit === null ? query : query.limit(limit);
}
