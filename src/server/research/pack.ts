import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import { signedPct } from "../../app/_components/format.ts";
import { TICKER_PATTERN } from "../csv.ts";
import { db } from "../db/index.ts";
import { tickers } from "../db/schema.ts";
import { dossierPath, ensureDossier } from "../dossier.ts";
import {
  annualExhibitExcerpt,
  ensureSections,
  REPORT_FORMS,
  EVENT_FORMS,
  fetchAnnualExhibit,
  fetchEventText,
  fetchFilingText,
  fullChanges,
  incorporatesAnnualReport,
  itemList,
  recentFilings,
  resolveCik,
  savedSections,
  type Filing,
} from "../edgar.ts";
import {
  BANK_LIKE,
  cashFlowMissing,
  ebitdaRowsInDoubt,
  fetchProfile,
  fundamentalContext,
  hasReported,
  nextEarnings,
  num,
  oneCurrency,
  priceSummary,
  relativeToMarket,
  reportingCurrency,
  upcomingEstimates,
  yearAgoRow,
  type FmpData,
  type Row,
} from "../fmp.ts";
import { PACK_DATA_NOTES } from "./prompts.ts";

const str = (v: unknown) => (typeof v === "string" ? v : "");

const INTERIM_RISK_MIN_CHARS = 1_000; // shorter says little beyond "no material changes"
const INTERIM_POINTER_OPENING_CHARS = 1_200;
const THIN_REPORT_CHARS = 2_000;
const QUARTERLY_6K_DAYS = 100;
// Anything shorter is a routine notice rather than a foreign issuer's quarterly report.
const QUARTERLY_6K_MIN_CHARS = 6_000;
const CONTEXT_PREFIX = "_context-";
const CONTEXT_MAX_AGE_MS = 60 * 60_000;

export function packDir(date: string, ticker?: string) {
  return path.join(
    "data",
    "packs",
    date,
    ...(ticker ? [path.basename(ticker)] : []),
  );
}

/** Newest pack folder that has this ticker, or null. */
export function latestPackDir(ticker: string) {
  const root = packDir("");
  if (!existsSync(root)) return null;
  const dates = readdirSync(root)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse();
  for (const date of dates) {
    const dir = packDir(date, ticker);
    if (existsSync(path.join(dir, "pack.json"))) return dir;
  }
  return null;
}

/** Read before replacing a pack, so same-day reviews retain their earlier code-derived position. */
export function previousPositionSnapshot(
  ticker: string,
  date: string,
  previousReview: unknown,
) {
  if (
    !TICKER_PATTERN.test(ticker) ||
    !previousReview ||
    typeof previousReview !== "object"
  )
    return null;
  const review = previousReview as Record<string, unknown>;
  const priorDate = review.date;
  if (
    typeof priorDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(priorDate) ||
    priorDate > date
  )
    return null;
  const filename = path.join(packDir(priorDate, ticker), "pack.json");
  try {
    const raw = readFileSync(filename, "utf8");
    const pack = JSON.parse(raw) as Record<string, unknown>;
    if (
      pack.ticker !== ticker ||
      pack.generated_on !== priorDate ||
      !pack.my_position ||
      typeof pack.my_position !== "object"
    )
      return null;
    if (
      typeof pack.run_id === "number" &&
      typeof review.run_id === "number" &&
      pack.run_id !== review.run_id
    )
      return null;
    // New manual packs explicitly have no run identity. Legacy prior-day packs can still supply
    // a dated snapshot, but an unbound same-day pack cannot stand in for the preceding review.
    if (
      typeof review.run_id === "number" &&
      (pack.run_id === null ||
        (pack.run_id === undefined && priorDate === date))
    )
      return null;
    const position = pack.my_position as Record<string, unknown>;
    const fields = [
      "quantity",
      "value",
      "weight_pct",
      "portfolio_cash_pct",
      "portfolio_total_value",
    ];
    if (
      !fields.every(
        (field) =>
          typeof position[field] === "number" &&
          Number.isFinite(position[field]),
      ) ||
      Number(position.portfolio_total_value) <= 0
    )
      return null;
    return {
      snapshot_date: priorDate,
      run_id: typeof pack.run_id === "number" ? pack.run_id : null,
      source: filename.split(path.sep).join("/"),
      source_sha256: createHash("sha256").update(raw).digest("hex"),
      position: Object.fromEntries(
        Object.entries(position).filter(
          ([key, value]) =>
            fields.includes(key) ||
            ([
              "cost_basis",
              "unrealized_gain",
              "unrealized_gain_pct",
              "portfolio_top5_concentration_pct",
            ].includes(key) &&
              (value === null ||
                (typeof value === "number" && Number.isFinite(value)))),
        ),
      ),
    };
  } catch {
    // Missing or malformed history is a missing source, never an invitation to use model prose.
    return null;
  }
}

const isFullPack = (dir: string) =>
  existsSync(dir) &&
  readdirSync(dir).some(
    (name) => name === "web_research.md" || /^(filing_|new_8k_)/.test(name),
  );

/** Newest pack that has filings or web research, including one a later light pack set aside. */
export function latestFullPackDir(ticker: string) {
  const root = packDir("");
  if (!existsSync(root)) return null;
  const dates = readdirSync(root)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse();
  for (const date of dates) {
    const dir = packDir(date, ticker);
    if (isFullPack(dir)) return dir;
    if (isFullPack(`${dir}.full`)) return `${dir}.full`;
  }
  return null;
}

/**
 * Clears the way for a new pack. A same-day light review must not destroy the documents behind the
 * full review still on screen, so that pack moves aside until a new full one replaces it.
 */
export function replacePackFolder(dir: string, includeFilings: boolean) {
  const kept = `${dir}.full`;
  if (includeFilings) {
    rmSync(kept, { recursive: true, force: true });
  } else if (isFullPack(dir)) {
    rmSync(kept, { recursive: true, force: true });
    renameSync(dir, kept);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
}

/**
 * A folder for Ask and thesis drafts, which need more than any one pack holds: the newest numbers,
 * the last full review's documents, and the dossier as it is now, since I may have edited it since
 * the pack was written. The caller removes it. Returns null before the first review.
 */
export function buildResearchContext(ticker: string) {
  const full = latestFullPackDir(ticker);
  const newest = latestPackDir(ticker) ?? full;
  if (!newest) return null;
  const root = packDir("");
  // Sweep any left behind by a crash.
  for (const name of readdirSync(root)) {
    const old = path.join(root, name);
    if (
      name.startsWith(CONTEXT_PREFIX) &&
      Date.now() - statSync(old).mtimeMs > CONTEXT_MAX_AGE_MS
    ) {
      rmSync(old, { recursive: true, force: true });
    }
  }
  const dir = mkdtempSync(
    path.join(root, `${CONTEXT_PREFIX}${path.basename(ticker)}-`),
  );
  const copyAll = (from: string) => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.isFile())
        copyFileSync(path.join(from, entry.name), path.join(dir, entry.name));
    }
  };
  if (full && full !== newest) copyAll(full);
  copyAll(newest);
  if (existsSync(dossierPath(ticker))) {
    copyFileSync(dossierPath(ticker), path.join(dir, "dossier.md"));
  }
  return dir;
}

/** The next run gives this ticker a full review, because what it is judged against has changed. */
export async function requestFullReview(ticker: string) {
  await db
    .update(tickers)
    .set({ lastFullReviewAt: null })
    .where(eq(tickers.ticker, ticker));
}

/** Makes sure the ticker has a row (CIK, profile) and a dossier. */
export async function ensureTicker(ticker: string, holdingName: string) {
  const [existing] = await db
    .select()
    .from(tickers)
    .where(eq(tickers.ticker, ticker));

  let row = existing;
  // The daily FMP profile cache and 30-day SEC ticker-list cache provide the refresh clocks.
  // Reconcile on every call so daily profile fetching cannot hide an old metadata row's age.
  const profileRefresh = await fetchProfile(ticker).catch(() => null);
  const lookup = await resolveCik(ticker).then(
    (cik) => ({ cik, error: null as string | null }),
    (error: unknown) => ({
      cik: null,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  {
    const profile = profileRefresh;
    const cik = lookup.cik;
    const values = {
      cik: cik ?? row?.cik ?? null,
      sector: str(profile?.sector) || row?.sector || null,
      industry: str(profile?.industry) || row?.industry || null,
      fmpProfileJson: profile
        ? JSON.stringify({
            ...(row?.fmpProfileJson
              ? (JSON.parse(row.fmpProfileJson) as Row)
              : {}),
            ...Object.fromEntries(
              Object.entries(profile).filter(
                ([, v]) => v !== null && v !== undefined && v !== "",
              ),
            ),
          })
        : (row?.fmpProfileJson ?? null),
    };
    if (row)
      [row] = await db
        .update(tickers)
        .set(values)
        .where(eq(tickers.ticker, ticker))
        .returning();
    else
      [row] = await db
        .insert(tickers)
        .values({ ticker, ...values })
        .returning();
  }
  if (!row) throw new Error(`Could not create a ticker row for ${ticker}`);

  const profile = row.fmpProfileJson
    ? (JSON.parse(row.fmpProfileJson) as Record<string, unknown>)
    : null;
  const name = str(profile?.companyName) || holdingName || ticker;
  ensureDossier(ticker, name);
  return { ...row, secLookupError: lookup.error };
}

// These fields repeat on every statement row and carry nothing for a reviewer.
function trimRows(rows: FmpData["income"], limit: number) {
  return rows.slice(0, limit).map((row) => {
    const {
      link: _link,
      finalLink: _final,
      cik: _cik,
      symbol: _symbol,
      ...rest
    } = row;
    return rest;
  });
}

const filingHeader = (f: Filing) =>
  `# ${f.form} filed ${f.filedAt}\n\nSource: edgar:${f.accessionNo}\nDocument: ${f.primaryDocUrl}\n`;

const reportStem = (f: Filing) =>
  `${f.form.replaceAll("/", "-")}_${f.filedAt}_${f.accessionNo}`;

/** Returns false if the filing could not be read, so it can be tried again on the next run. */
async function writeReportFiles(dir: string, f: Filing, notes: string[]) {
  const stem = reportStem(f);
  let text: string;
  try {
    text = await fetchFilingText(f.primaryDocUrl);
    if (!text.trim()) return false;
    writeFileSync(
      path.join(dir, `filing_${stem}.txt`),
      `${filingHeader(f)}\n${text}`,
    );
  } catch {
    return false;
  }
  const sections = await ensureSections(f, text);
  if (!sections) return false;
  let incorporated = "";
  // An amendment often changes only one part, such as Part III, so thin is normal for it.
  const amendment = f.form.endsWith("/A");
  if (incorporatesAnnualReport(f.form, sections)) {
    try {
      const exhibit = await fetchAnnualExhibit(f);
      if (exhibit) {
        writeFileSync(
          path.join(dir, `filing_exhibit_${stem}.txt`),
          `${filingHeader(f)}\nExhibit source: ${exhibit.url}\n\n${exhibit.text}`,
        );
        incorporated = `\n## Annual report exhibit\n\n${annualExhibitExcerpt(exhibit.text)}\n`;
      } else if (
        !amendment &&
        (sections.risk_factors?.length ?? 0) + (sections.mda?.length ?? 0) <
          THIN_REPORT_CHARS
      ) {
        notes.push(
          `The ${f.form} filed ${f.filedAt} (edgar:${f.accessionNo}) has almost no risk or results text and no readable annual report exhibit, perhaps because it is a PDF, so those sections are incomplete.`,
        );
      }
    } catch {
      notes.push(
        `The ${f.form} filed ${f.filedAt} (edgar:${f.accessionNo}) ${amendment ? "may point" : "points"} to an annual report exhibit that could not be read, so its risk and results sections ${amendment ? "may be" : "are"} incomplete.`,
      );
    }
  }
  writeFileSync(
    path.join(dir, `filing_sections_${stem}.md`),
    `${filingHeader(f)}\n## Risk Factors\n\n${sections.risk_factors ?? "No section with a recognizable heading was found in this filing."}\n\n## MD&A\n\n${sections.mda ?? "No section with a recognizable heading was found in this filing."}\n${!sections.risk_factors && !sections.mda ? `\n## Filing text (head)\n\n${text.slice(0, 80000)}${text.length > 80000 ? "\n[truncated; full text is in filing_*.txt]" : ""}` : ""}${incorporated}\n`,
  );
  if (sections.diff) {
    writeFileSync(
      path.join(dir, `filing_diff_${stem}.md`),
      `${filingHeader(f)}\nChanges compared with the previous ${f.form}, most important first.\n\n${sections.diff}\n`,
    );
    const everything = await fullChanges(f, sections);
    if (everything) {
      writeFileSync(
        path.join(dir, `filing_changes_${stem}.txt`),
        `${filingHeader(f)}\nEvery changed sentence compared with the previous ${f.form}, in filing order.\n\n${everything}\n`,
      );
    }
  }
  return true;
}

/**
 * A short Risk Factors item in the latest 10-Q can rest on an earlier 10-Q. CBOE's latest says no
 * material updates beyond its March and June reports, and March's holds an expected 20% workforce
 * cut found nowhere else in the pack. NVDA's says the same of its April report at the start of 34,905
 * characters of updates, so the opening decides, not the length.
 */
async function writeInterimRisks(dir: string, ticker: string) {
  const [annual] = await recentFilings(ticker, "10-K", 1);
  const [latest, ...earlier] = (await recentFilings(ticker, "10-Q", 4)).filter(
    (q) => !annual || q.filedAt > annual.filedAt,
  );
  if (!latest || !earlier.length) return;
  const risk = (await ensureSections(latest))?.risk_factors ?? "";
  // "This Quarterly Report on Form 10-Q" is a section naming itself, and its text is already in the pack.
  if (
    !/(?<!this\s(?:quarterly\s+report\s+on\s+)?)(?:form\s+10-q|quarterly\s+reports?)/i.test(
      risk.slice(0, INTERIM_POINTER_OPENING_CHARS),
    )
  )
    return;
  for (const q of earlier) {
    const file = path.join(dir, `filing_sections_${reportStem(q)}.md`);
    // Already delivered as a new filing, with its MD&A, which this would overwrite.
    if (existsSync(file)) continue;
    const text = (await ensureSections(q))?.risk_factors;
    if (!text || text.length < INTERIM_RISK_MIN_CHARS) continue;
    writeFileSync(
      file,
      `${filingHeader(q)}\nThe latest 10-Q still relies on this report's risk factor updates, so a risk its diff lists as Removed may still apply.\n\n## Risk Factors\n\n${text}\n`,
    );
  }
}

async function writeEightK(dir: string, f: Filing) {
  const sections = await ensureSections(f);
  writeFileSync(
    path.join(dir, `new_8k_${f.filedAt}_${f.accessionNo}.md`),
    `${filingHeader(f)}\nItems: ${f.items ?? ""}\n\n${sections?.text_head ?? "Could not read this filing."}\n`,
  );
  // The saved opening is capped, so the whole document goes beside it for a reader that can search.
  if (sections?.text_head?.includes("[truncated]")) {
    try {
      writeFileSync(
        path.join(dir, `filing_event_${f.filedAt}_${f.accessionNo}.txt`),
        `${filingHeader(f)}\nItems: ${f.items ?? ""}\n\n${await fetchEventText(f)}\n`,
      );
    } catch {
      // The opening is still delivered, and the file says where it was cut.
    }
  }
  return Boolean(sections?.text_head?.trim());
}

/**
 * A labelled row must agree in the requested period's column, not just print the amount somewhere.
 * Without a readable header, use the usual current/prior order and flag anything we cannot confirm.
 */
function filingPrints(
  text: string,
  value: number,
  label: RegExp,
  column: number,
  months: number,
  year: number,
) {
  const size = Math.abs(value);
  const written = (n: number, digits = 0) =>
    n.toLocaleString("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  const figures = [
    written(size),
    written(size / 1e3),
    written(size / 1e6),
    written(size / 1e6, 1),
    // A vendor's fourth quarter is the year minus nine months, so it can be $1M off the release.
    ...(size >= 1e9 ? [written(size / 1e6 - 1), written(size / 1e6 + 1)] : []),
  ].map((figure) => Number(figure.replaceAll(",", "")));
  const lines = text.split("\n");
  return lines.some((line, lineIndex) => {
    const matchedLabel = label.exec(line);
    if (!matchedLabel) return false;
    let selectedColumn = column;
    // Headers can reverse the years, or put quarterly and year-to-date columns on the same row.
    for (let i = lineIndex - 1; i >= Math.max(0, lineIndex - 80); i--) {
      const header = lines[i]!;
      const years = [...header.matchAll(/\b20\d{2}\b/g)];
      if (
        !years.length ||
        !/^[\s,|/]*$/.test(
          header
            .slice(years[0]!.index)
            .replace(
              /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},?/gi,
              "",
            )
            .replace(/\b20\d{2}\b/g, ""),
        )
      )
        continue;
      const durations = [
        ...lines
          .slice(Math.max(0, i - 4), i + 1)
          .join(" ")
          .matchAll(
            /\b(three|six|nine|twelve|3|6|9|12)\s+months|\bquarters?\s+ended|\byears?\s+ended/gi,
          ),
      ].map((m) =>
        m[1]
          ? ([3, 6, 9, 12][
              ["three", "six", "nine", "twelve"].indexOf(m[1].toLowerCase())
            ] ?? Number(m[1]))
          : /^quarter/i.test(m[0])
            ? 3
            : 12,
      );
      const group = durations.length ? durations.indexOf(months) : 0;
      const width = years.length / Math.max(1, durations.length);
      if (group < 0 || !Number.isInteger(width)) return false;
      const offset = years
        .slice(group * width, (group + 1) * width)
        .findIndex((m) => Number(m[0]) === year);
      if (offset < 0) return false;
      selectedColumn = group * width + offset;
      break;
    }
    const beforeLabel = line.slice(0, matchedLabel.index);
    const heading =
      line
        .slice(/\d/.test(beforeLabel) ? matchedLabel.index : 0)
        .split(/\d/, 1)[0] ?? "";
    // A bare amount under "Net loss" or "Cash used in operations" is negative too. Mixed
    // "income (loss)" and "provided by (used in)" labels leave the sign to each amount.
    const lossLabel =
      (/\bloss(?:es)?\b/i.test(heading) &&
        !/\b(?:income|profit|earnings)\b/i.test(heading)) ||
      (/\bused\b/i.test(heading) &&
        !/\b(?:provided|generated)\b/i.test(heading));
    const body = line
      .slice(matchedLabel.index + matchedLabel[0].length)
      .replace(
        /\(\s*note\s+\d+[a-z]?\s*\)|\[\d+\]|\([a-z]\)|[⁰¹²³⁴⁵⁶⁷⁸⁹]/gi,
        "",
      )
      .replace(/[-−]\s*[$€£¥]\s*/g, "−")
      .replace(
        /[$€£¥]|\b(?:USD|EUR|GBP|DKK|CAD|AUD|CHF|NOK|SEK|JPY|CNY)\b/gi,
        "",
      );
    const amounts = [
      ...body.matchAll(
        /(?<![\d,.])(?:\(\s*)?(?:−\s*|[-–—](?=\d))?\s*(\d[\d,]*(?:\.\d+)?)(?:\s*\))?(?![\d,]|\.\d)|[–—]|(?<!\S)-(?!\S)/g,
      ),
    ];
    const first = amounts[0];
    // Prose does not establish table columns. Bare numeric parentheses remain amounts: (1)
    // can be a loss, so treating it as a note reference could accept the prior period by mistake.
    if (!first || /[a-z%]/i.test(body.slice(first.index))) return false;
    const amount = amounts[selectedColumn];
    if (
      !amount?.[1] ||
      !figures.includes(Number(amount[1].replaceAll(",", "")))
    )
      return false;
    const negative = /\(|[-−–—]/.test(amount[0]) || lossLabel;
    return value === 0 || negative === value < 0;
  });
}

// A figure the valuation block left out as unreliable must not stay in the pack under another name.
// The checker cited QCOM's 22.57 from a field the note did not name, and CBOE's bad cash flow rows gave
// 179.81 times free cash flow and 121.59 times operating cash flow.
const VENDOR_EBITDA_FIELD =
  /^(evToEBITDA|enterpriseValueMultiple|netDebtToEBITDA|ebitdaMargin)(TTM)?$/;
const VENDOR_CASH_FIELD =
  /freeCashFlow|operatingCashFlow|capex|capitalExpenditure|incomeQuality/i;

function withoutDoubted(row: Row, ebitda: unknown, freeCash: unknown) {
  return Object.fromEntries(
    Object.entries(row).filter(
      ([field, value]) =>
        !(
          ebitda === null &&
          VENDOR_EBITDA_FIELD.test(field) &&
          // A loss gives no multiple, but the margin that shows the loss is still a figure.
          !(field.startsWith("ebitdaMargin") && (num(value) ?? 0) < 0)
        ) && !(freeCash === null && VENDOR_CASH_FIELD.test(field)),
    ),
  );
}

const VENDOR_FILING_FIELDS = {
  revenue: { name: "revenue", label: /revenue|\bsales\b/i },
  operatingIncome: {
    name: "operating income",
    label:
      /operating\s+(?:income|profit|earnings|\(?loss)|(?:income|earnings|profit|loss)(?:\/\(loss\)|\s+\(loss\))?\s+from\s+operations/i,
  },
  netIncome: {
    name: "net income",
    label: /net\s+(?:income|earnings|profit|\(?loss)|profit\s+for\s+the/i,
  },
};
const OPERATING_CASH_LABEL =
  /\bcash\b[^\n]*\b(?:operating|operations)\b|\b(?:operating|operations)\b[^\n]*\bcash\b/i;
const TEN_Q_MAX_DAYS = 75;

/**
 * A 10-Q prints year-to-date operating cash flow for this year and last, and a 10-K the whole year,
 * which the vendor's quarters must add up to. CBOE's 2025 came to 844.9M against 1,400.5M, though only
 * its Q3 2026 row looked wrong on its own. Null when they do, or when there is nothing to add.
 */
function cashSumNotInReport(text: string, fmp: FmpData) {
  const latest = fmp.cashFlow[0];
  const count = Number(/^Q([1-4])$/.exec(String(latest?.period))?.[1]);
  const year = Number(latest?.fiscalYear);
  if (
    !count ||
    !year ||
    latest?.date !== fmp.income[0]?.date ||
    BANK_LIKE.test(String(fmp.profile?.industry))
  )
    return null;
  for (const fiscalYear of [year, year - 1]) {
    const rows = fmp.cashFlow.filter(
      (r) =>
        Number(r.fiscalYear) === fiscalYear &&
        Number(String(r.period).slice(1)) <= count,
    );
    const amounts = rows.map((r) => num(r.operatingCashFlow));
    // Zero means the vendor has no data for that quarter yet, which proves nothing.
    if (rows.length !== count || !oneCurrency(rows) || !amounts.every((a) => a))
      continue;
    const total = amounts.reduce<number>((sum, a) => sum + (a ?? 0), 0);
    if (
      !filingPrints(
        text,
        total,
        OPERATING_CASH_LABEL,
        year - fiscalYear,
        count * 3,
        Number(String(rows[0]?.date).slice(0, 4)),
      )
    )
      return {
        label: `fiscal ${fiscalYear} Q1${count > 1 ? ` to Q${count}` : ""}`,
        total,
      };
  }
  return null;
}

/**
 * Vendor figures the quarter's own 10-Q never prints. The growth panel rests on them, and EXPE's
 * operating income was $1,031M from the vendor against $800M in its 10-Q. A filing may also just not
 * have that line, so this is a reason to look, not proof.
 */
export function vendorFilingGaps(dir: string, fmp: FmpData) {
  const latest = fmp.income[0];
  if (typeof latest?.date !== "string") return [];
  const quarterEnd = Date.parse(latest.date);
  if (!Number.isFinite(quarterEnd)) return [];
  const names = readdirSync(dir);
  const filedAfterQuarter = (pattern: RegExp) =>
    names.flatMap((name) => {
      const date = pattern.exec(name)?.[1];
      if (!date) return [];
      const days = (Date.parse(date) - quarterEnd) / 86400000;
      return days > 0 && days <= TEN_Q_MAX_DAYS ? [{ name, date }] : [];
    });
  const tenQ = filedAfterQuarter(
    /^filing_10-Q_(\d{4}-\d{2}-\d{2})_.*\.txt$/,
  )[0];
  const tenK = filedAfterQuarter(
    /^filing_10-KT?_(\d{4}-\d{2}-\d{2})_.*\.txt$/,
  )[0];
  const notes: string[] = [];
  // A changed non-GAAP cash measure can make a valid vendor history incomparable with guidance.
  // Keep both sources; do not silently substitute guessed filing-derived cash-flow amounts.
  for (const name of names) {
    const date = /^filing_.*?(\d{4}-\d{2}-\d{2})_.*\.txt$/.exec(name)?.[1];
    if (!date) continue;
    const days = (Date.parse(date) - quarterEnd) / 86400000;
    if (days <= 0 || days > TEN_Q_MAX_DAYS) continue;
    const text = readFileSync(path.join(dir, name), "utf8").replace(
      /\s+/g,
      " ",
    );
    if (
      /\bdefinition\s+of\s+free\s+cash\s+flow\s+(?:(?:has|have)\s+(?:been\s+)?|(?:was|were|is|are)\s+)?(?:updated|changed|revised)\b/i.test(
        text,
      )
    ) {
      const restated =
        /comparative.{0,80}restat|restat.{0,80}comparative/i.test(text)
          ? " The source also restates comparative figures."
          : "";
      notes.push(
        `The free cash flow definition changed in file:${name}.${restated} The vendor's cash-flow yield and historical median are vendor-defined measures, not a confirmed like-for-like comparison with company free cash flow guidance. Reconcile the operating-cash and spending definitions before using the history as valuation support; keep company guidance on its own stated basis. Use a consistent source and definition for every numerator and deduction.`,
      );
      break;
    }
  }
  const report = fmp.cashFlow[0]?.period === "Q4" ? tenK : tenQ;
  const cashGap =
    report &&
    cashSumNotInReport(readFileSync(path.join(dir, report.name), "utf8"), fmp);
  if (report && cashGap)
    notes.push(
      `The vendor's operating cash flow for ${cashGap.label} adds up to ${cashGap.total}, which could not be confirmed for that period in the ${report.name.startsWith("filing_10-KT_") ? "10-KT" : report === tenK ? "10-K" : "10-Q"} filed ${report.date}. Its cash flow rows may not match the filing, so take cash flow from the filing and disregard the trailing and year-earlier free cash flow totals.`,
    );
  // A filer of 10-Qs that has not filed this one gives the vendor only its earnings release to read.
  // One filed since the quarter ended means the vendor is behind instead, which other notes say.
  const reportSince = names.some((name) => {
    const filed = /^filing_10-(?:Q|KT?)_(\d{4}-\d{2}-\d{2})_/.exec(name)?.[1];
    return filed && Date.parse(filed) > quarterEnd;
  });
  if (!reportSince && names.some((n) => n.startsWith("filing_10-Q_")))
    notes.push(
      `The newest vendor statements end ${latest.date}, and no 10-Q or 10-K for that period is in this pack, so they come from the earnings release. The vendor often mislabels balance sheet and cash flow lines at this stage, so prefer the tables in the release, and treat those lines as unconfirmed if the release is not in this pack.`,
    );
  const rows = [
    { period: "latest quarter", row: latest },
    { period: "year-ago quarter", row: yearAgoRow(fmp.income) },
  ];
  const compareWith = (name: string) => {
    const text = readFileSync(path.join(dir, name), "utf8");
    return rows.flatMap(({ period, row }) =>
      Object.entries(VENDOR_FILING_FIELDS).flatMap(
        ([field, { name, label }]) => {
          const value = num(row?.[field]);
          return value === null || value === 0
            ? []
            : [
                {
                  text: `${period} ${name} ${value}`,
                  latest: row === latest,
                  prints: filingPrints(
                    text,
                    value,
                    label,
                    row === latest ? 0 : 1,
                    3,
                    Number(String(row?.date).slice(0, 4)),
                  ),
                },
              ];
        },
      ),
    );
  };
  // An annual report does not print its fourth quarter on its own, so it cannot speak for that row,
  // and an 8-K about anything but results says nothing about any figure.
  const release = tenQ
    ? undefined
    : [
        ...filedAfterQuarter(/^filing_event_(\d{4}-\d{2}-\d{2})_.*\.txt$/),
        ...filedAfterQuarter(/^new_8k_(\d{4}-\d{2}-\d{2})_.*\.md$/),
      ].find((f) => compareWith(f.name).some((c) => c.latest && c.prints));
  const filed = tenQ ?? release;
  if (!filed) return notes;
  const gaps = compareWith(filed.name)
    .filter((c) => !c.prints)
    .map((c) => c.text);
  if (gaps.length)
    notes.push(
      `These vendor figures do not appear to match their stated periods in the ${tenQ ? "10-Q" : "results release"} filed ${filed.date}: ${gaps.join("; ")}. The filing may group them differently or not report that line, but valuation_and_growth is computed from them, so use the filing's own figures where it has them.`,
    );
  return notes;
}

/**
 * Writes the files a model reads for one ticker. A LIGHT pack is dossier.md + pack.json. A pack
 * with filings adds the latest 10-K and 10-Q and any recent 8-Ks. Returns the file names and
 * any filings that could not be read.
 */
export async function writePack(opts: {
  ticker: string;
  date: string;
  fmp: FmpData;
  market?: { sp500_proxy_spy: Row | null } | null;
  position?: unknown;
  includeFilings: boolean;
  newFilings?: Filing[];
  previousReview?: unknown;
  runId?: number;
  extraNotes?: string[];
}) {
  if (!TICKER_PATTERN.test(opts.ticker))
    throw new Error("Enter a valid ticker.");
  const {
    ticker,
    date,
    fmp,
    market,
    position,
    includeFilings,
    newFilings = [],
    previousReview,
    extraNotes = [],
  } = opts;
  const dir = packDir(date, ticker);
  const previousPosition = previousPositionSnapshot(
    ticker,
    date,
    previousReview,
  );
  replacePackFolder(dir, includeFilings);
  mkdirSync(dir, { recursive: true });

  copyFileSync(dossierPath(ticker), path.join(dir, "dossier.md"));

  const formFours = await recentFilings(ticker, "4", 10);
  const unread = new Set(
    newFilings.filter((f) => f.form !== "4").map((f) => f.accessionNo),
  );
  const context = fundamentalContext(fmp, date);
  const valuation = context?.valuation;
  const trailingRow = (row: Row | null) =>
    row &&
    withoutDoubted(
      row,
      valuation?.ev_to_ebitda_ttm,
      valuation?.fcf_yield_ttm_pct,
    );
  // Annual ratios can be absent, so their history cannot be the only record of a bad income year.
  const badEbitdaYears = new Set(
    ebitdaRowsInDoubt(fmp.income)
      .map((quarter) => quarter.fiscalYear)
      .filter((year) => typeof year === "string"),
  );
  const annualRows = (rows: Row[]) =>
    trimRows(rows, 3).map((row) => {
      const year = valuation?.history_by_fiscal_year.find(
        (y) => y.fiscal_year_end === row.date,
      );
      const ebitdaDoubted =
        !fmp.isFund &&
        (BANK_LIKE.test(String(fmp.profile?.industry)) ||
          (typeof row.fiscalYear === "string" &&
            badEbitdaYears.has(row.fiscalYear)));
      return withoutDoubted(
        row,
        ebitdaDoubted ? null : year?.ev_to_ebitda,
        year?.fcf_yield_pct,
      );
    });
  const notes = [
    ...PACK_DATA_NOTES,
    ...(context?.data_notes ?? []),
    ...extraNotes,
  ];
  const latestQuarter = fmp.income[0]?.date;
  if (
    !fmp.isFund &&
    typeof latestQuarter === "string" &&
    Date.parse(date) - Date.parse(latestQuarter) > 120 * 86400000
  )
    notes.push(
      `The newest quarterly statement is dated ${latestQuarter}, more than 120 days old.`,
    );
  const summary = priceSummary(
    fmp.history,
    fmp.dividendsCoverageConfirmed === false ? undefined : fmp.dividends,
  );
  // Every payment behind the year's total, so it can be added up here. A monthly payer has over eight,
  // and a declared payment still to come sits ahead of them in the list.
  const paymentsInYear = summary?.distributions_1y_count
    ? fmp.dividends.filter((d) => String(d.date) > summary.start_date).length
    : 0;
  const pack = {
    ticker,
    generated_on: date,
    run_id: opts.runId ?? null,
    quote: fmp.quote,
    company: fmp.profile
      ? {
          name: fmp.profile.companyName,
          sector: fmp.profile.sector,
          industry: fmp.profile.industry,
          exchange: fmp.profile.exchange,
          description: str(fmp.profile.description).slice(0, 800),
        }
      : null,
    data_notes: notes,
    my_position: position ?? null,
    previous_review: previousReview ?? null,
    previous_position: previousPosition,
    is_fund: fmp.isFund,
    price_summary: summary,
    relative_to_sp500: relativeToMarket(fmp, market?.sp500_proxy_spy),
    valuation_and_growth: context,
    market_context: market ?? null,
    next_earnings: nextEarnings(fmp.earnings, date),
    earnings_history: fmp.earnings.filter(hasReported),
    analyst_estimates_annual: upcomingEstimates(fmp.estimates, date).slice(
      0,
      3,
    ),
    price_target_consensus: fmp.priceTargetConsensus,
    price_target_summary: fmp.priceTargetSummary,
    price_target_changes: fmp.priceTargetNews.map((n) => ({
      published: n.publishedDate,
      firm: n.analystCompany,
      target: n.priceTarget,
      price_when_posted: n.priceWhenPosted,
      title: n.newsTitle,
      url: n.newsURL,
    })),
    grades_consensus: fmp.gradesConsensus,
    grade_changes_last_90_days: fmp.grades.filter(
      (g) => g.previousGrade !== g.newGrade,
    ),
    financial_health_scores: fmp.scores,
    fmp_rating_snapshot: fmp.rating,
    insider_trades: fmp.insiderTrades.map((t) => ({
      filed: t.filingDate,
      traded: t.transactionDate,
      who: t.reportingName,
      role: t.typeOfOwner,
      type: t.transactionType,
      acquired_or_disposed: t.acquisitionOrDisposition,
      shares: t.securitiesTransacted,
      price: t.price,
    })),
    dividends: fmp.dividends.slice(0, Math.max(8, paymentsInYear)),
    fund_info: fmp.fundInfo,
    fund_sector_weights: fmp.fundSectors,
    fund_country_weights: fmp.fundCountries,
    key_metrics_ttm: trailingRow(fmp.keyMetricsTtm),
    key_metrics_annual: annualRows(fmp.keyMetrics),
    ratios_ttm: trailingRow(fmp.ratiosTtm),
    ratios_annual: annualRows(fmp.ratios),
    income_statement_quarterly: trimRows(fmp.income, 8),
    balance_sheet_quarterly: trimRows(fmp.balance, 8),
    cash_flow_quarterly: trimRows(fmp.cashFlow, 8),
    news_last_7_days: fmp.news.map((n) => ({
      publishedDate: n.publishedDate,
      publisher: n.publisher,
      title: n.title,
      url: n.url,
      text: str(n.text).slice(0, 600),
    })),
    new_filings: newFilings.map((f) => ({
      form: f.form,
      filed_at: f.filedAt,
      source: `edgar:${f.accessionNo}`,
      items: f.items,
    })),
    insider_filings_form_4: [
      ...new Map(
        [...formFours, ...newFilings.filter((f) => f.form === "4")].map((f) => [
          f.accessionNo,
          f,
        ]),
      ).values(),
    ].map((f) => ({
      filed_at: f.filedAt,
      source: `edgar:${f.accessionNo}`,
      url: f.primaryDocUrl,
    })),
  };
  let hasFilingText = false;
  if (includeFilings) {
    const selected = new Map(
      newFilings.filter((f) => f.form !== "4").map((f) => [f.accessionNo, f]),
    );
    let newestReport = "";
    for (const form of REPORT_FORMS) {
      const [latest] = await recentFilings(ticker, form, 1);
      if (latest) selected.set(latest.accessionNo, latest);
      if (latest && latest.filedAt > newestReport)
        newestReport = latest.filedAt;
      // An amendment changes the report it follows, so it stays with it in every full pack.
      const [amended] = await recentFilings(ticker, `${form}/A`, 1);
      if (amended && (!latest || amended.filedAt >= latest.filedAt))
        selected.set(amended.accessionNo, amended);
    }
    // A new holding has never read its older 6-Ks, and the quarterly report test below needs their
    // text. This comes before the rows below are fetched, so they hold what it saved and read nothing twice.
    const sixKSince = new Date(Date.parse(date) - QUARTERLY_6K_DAYS * 86400000)
      .toISOString()
      .slice(0, 10);
    for (const f of await recentFilings(ticker, "6-K", null, sixKSince))
      await ensureSections(f);
    for (const form of EVENT_FORMS) {
      for (const f of await recentFilings(ticker, form, 25)) {
        if (Date.parse(date) - Date.parse(f.filedAt) <= 14 * 86400000)
          selected.set(f.accessionNo, f);
      }
    }
    // Until the 10-Q arrives, up to 37 days later at Citi, the release is that quarter's only filing.
    const results = (await recentFilings(ticker, "8-K", 25)).find(
      (f) => f.filedAt > newestReport && itemList(f).includes("2.02"),
    );
    if (results) selected.set(results.accessionNo, results);
    // A foreign issuer's quarterly report is a 6-K, which must not age out after 14 days.
    const [quarterly] = (await recentFilings(ticker, "6-K", null, sixKSince))
      .filter(
        (f) =>
          Date.parse(date) - Date.parse(f.filedAt) <=
            QUARTERLY_6K_DAYS * 86400000 &&
          (savedSections(f)?.text_head?.length ?? 0) > QUARTERLY_6K_MIN_CHARS,
      )
      .sort(
        (a, b) =>
          (savedSections(b)?.text_head?.length ?? 0) -
          (savedSections(a)?.text_head?.length ?? 0),
      );
    if (quarterly) selected.set(quarterly.accessionNo, quarterly);
    for (const f of selected.values()) {
      const delivered = EVENT_FORMS.has(f.form)
        ? await writeEightK(dir, f)
        : await writeReportFiles(dir, f, notes);
      if (delivered) {
        unread.delete(f.accessionNo);
        hasFilingText = true;
      } else if (newFilings.some((n) => n.accessionNo === f.accessionNo))
        unread.add(f.accessionNo);
      // Not new, so nothing retries it and a review would read an older report as the latest.
      else
        notes.push(
          `The ${f.form} filed ${f.filedAt} (edgar:${f.accessionNo}) could not be read on this run, so its text is missing from this pack.`,
        );
    }
  }
  if (includeFilings) {
    await writeInterimRisks(dir, ticker);
    notes.push(...vendorFilingGaps(dir, fmp));
  } else {
    // A light pack shows the same vendor rows, so it keeps the warnings the last full pack earned.
    const full = latestFullPackDir(ticker);
    if (full) notes.push(...vendorFilingGaps(full, fmp));
  }
  // A LIGHT pack leaves filings out by design, so this only speaks when they were asked for.
  if (includeFilings && !fmp.isFund && !hasFilingText)
    notes.push(
      "No SEC filing text is available in this pack for this stock; the filing evidence is incomplete.",
    );
  if (includeFilings) {
    for (const f of newFilings.filter((n) => unread.has(n.accessionNo))) {
      notes.push(
        `The new ${f.form} filed ${f.filedAt} (edgar:${f.accessionNo}) could not be read, so its text is missing from this pack.`,
      );
    }
  }
  // Written last, because the notes depend on which filings were delivered.
  // Vendor floats run to 15 decimals. Four keeps the meaning and stops false precision in prose.
  writeFileSync(
    path.join(dir, "pack.json"),
    JSON.stringify(
      pack,
      (_key, value: unknown) =>
        typeof value === "number" && !Number.isInteger(value)
          ? Number(value.toFixed(4))
          : value,
      2,
    ),
  );
  // The folder was emptied above, so this lists exactly what this call wrote.
  return { dir, written: readdirSync(dir), unread };
}

type PackRow = Row | null | undefined;
type SavedPack = {
  quote?: PackRow;
  company?: PackRow;
  price_summary?: PackRow;
  ratios_ttm?: PackRow;
  key_metrics_ttm?: PackRow;
  is_fund?: boolean | null;
  fund_info?: PackRow;
  valuation_and_growth?: { growth?: PackRow; valuation?: PackRow } | null;
  income_statement_quarterly?: PackRow[];
  balance_sheet_quarterly?: PackRow[];
  cash_flow_quarterly?: PackRow[];
};

// The notes are written for the models, which keep reading them as they are in pack.json.
const NOTE_FOR_MODELS: [RegExp, string][] = [
  [/ Disregard [^.]*\./g, ""],
  // These two are about figures the page does not show.
  [/ The vendor's price to book, its median[^.]*\./g, ""],
  [/ The next-year P\/E is the multiple on the later year\./g, ""],
  [/, and disregard \w+ in key_metrics_ttm\./g, "."],
  [/ Do not compare revenue in income_statement_quarterly[^.]*\./g, ""],
  [
    /revenue_yoy_pct and the operating margins here use the reported revenue in earnings_history/g,
    "revenue growth and the operating margins here use the reported revenue",
  ],
  [/figures in valuation_and_growth describe/g, "figures here describe"],
  [
    /but valuation_and_growth is computed from them/g,
    "but the growth and valuation figures are computed from them",
  ],
  [/ \(edgar:[^)]*\)/g, ""],
];
// Whole amounts only: an accession number, a date or a clock time has a neighbor this refuses.
const NOTE_AMOUNT = /(?<![\w:.-])([+-]?)(\d{5,}(?:\.\d+)?)(?![\w-])/g;

/**
 * A pack's notes about this ticker's own data, in words for the page. The rest are standing guidance
 * for the models. Amounts read in the currency a foreign filer's own note names.
 */
export function dataWarnings(notes: string[] | undefined) {
  const all = notes ?? [];
  const currency =
    all
      .map(
        (note) =>
          /^Statements, .* are in ([A-Z]{3})\. The quote/.exec(note)?.[1],
      )
      .find(Boolean) ?? "USD";
  // Both say the statements are old, and the results note says why.
  const lagged = all.some((note) =>
    note.startsWith("Results were reported on "),
  );
  return all
    .filter(
      (note) =>
        !PACK_DATA_NOTES.includes(note) &&
        // In packs written before this standing note was reworded.
        note !== "quote is as of when the job ran and may be intraday." &&
        !(lagged && note.endsWith("more than 120 days old.")),
    )
    .map((note) =>
      NOTE_FOR_MODELS.reduce(
        (text, [pattern, words]) => text.replace(pattern, words),
        note,
      ).replace(NOTE_AMOUNT, (_, sign: string, digits: string) => {
        const value = Number(digits) * (sign === "-" ? -1 : 1);
        return `${sign === "+" ? "+" : ""}${compact(value, currency)}`;
      }),
    );
}

/** The newest pack.json saved for a ticker, or null. */
export function readPack(ticker: string): SavedPack | null {
  const dir = latestPackDir(ticker);
  if (!dir) return null;
  return JSON.parse(
    readFileSync(path.join(dir, "pack.json"), "utf8"),
  ) as SavedPack;
}

const compact = (v: unknown, currency = "USD") => {
  const n = num(v);
  if (n === null) return null;
  const amount = Math.abs(n).toLocaleString("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  });
  const sign = n < 0 ? "−" : "";
  return currency === "USD"
    ? `${sign}$${amount}`
    : `${sign}${currency} ${amount}`;
};
const plain = (v: unknown) => {
  const n = num(v);
  return n === null ? null : n.toFixed(2);
};
const money = (v: unknown) => {
  const n = plain(v);
  return n === null ? null : `$${n}`;
};
const ratioPct = (v: unknown) => {
  const n = num(v);
  return n === null ? null : `${(n * 100).toFixed(1).replace("-", "−")}%`;
};
const rawPct = (v: unknown) => {
  const n = plain(v);
  return n === null ? null : `${n.replace("-", "−")}%`;
};
// A move, which shows its direction either way. Null keeps the row out, where signedPct prints a dash.
const movePct = (v: unknown) => {
  const n = num(v);
  return n === null ? null : signedPct(n);
};

/** Grouped, because fourteen unlabeled numbers in a grid are hard to find anything in. */
export function keyNumbers(pack: SavedPack) {
  const income = pack.income_statement_quarterly?.[0];
  const balance = pack.balance_sheet_quarterly?.[0];
  const cash = pack.cash_flow_quarterly?.[0];
  const periodOf = (row: PackRow) =>
    row ? `${String(row.period)} ${String(row.fiscalYear)}` : "";
  const quarter = periodOf(income);
  // A vendor can be a quarter behind on one statement, which must not read as the same quarter.
  const labelled = (label: string, row: PackRow) =>
    row && income && row.date !== income.date
      ? `${label}, ${periodOf(row)}`
      : label;
  const currency = reportingCurrency(income) ?? "USD";
  const growth = pack.valuation_and_growth?.growth;
  const amount = (value: unknown, row: PackRow) =>
    compact(value, reportingCurrency(row) ?? currency);
  // A new listing has no one-year return, and its range is not a year's. Older packs always have one.
  const rangeLabel = (word: string) =>
    pack.price_summary?.return_1y_pct === null
      ? `${word} since ${str(pack.price_summary.start_date)}`
      : `1-year ${word.toLowerCase()}`;
  // Zero is far likelier a figure the vendor lacks than a free fund or one holding nothing.
  const fundFigure = (v: unknown) => (num(v) === 0 ? null : num(v));
  // Packs from before the vendor checks hold figures those checks have since corrected.
  const estimates = growth?.revenue_basis
    ? pack.valuation_and_growth?.valuation
    : null;
  const forwardYear = str(estimates?.forward_estimate_fiscal_year_end);
  const years = num(estimates?.pe_fiscal_years_counted);
  const overYears = years
    ? `, last ${years} fiscal ${years === 1 ? "year" : "years"}`
    : "";
  const peLow = plain(estimates?.pe_low_last_5_fiscal_years);
  const peHigh = plain(estimates?.pe_high_last_5_fiscal_years);
  const groups: { title: string; rows: [string, string | null][] }[] = [
    {
      title: "Price",
      rows: [
        ["Price", money(pack.quote?.price)],
        [
          pack.is_fund ? "Fund market value" : "Market cap",
          compact(pack.quote?.marketCap),
        ],
        [rangeLabel("High"), money(pack.price_summary?.high_1y)],
        [rangeLabel("Low"), money(pack.price_summary?.low_1y)],
        ["5-day return", movePct(pack.price_summary?.return_5d_pct)],
        ["1-year return", movePct(pack.price_summary?.return_1y_pct)],
      ],
    },
    {
      title: "Fund",
      rows: pack.is_fund
        ? [
            ["Expense ratio", rawPct(fundFigure(pack.fund_info?.expenseRatio))],
            [
              "Distribution yield, last 12 months",
              rawPct(pack.price_summary?.distribution_yield_1y_pct),
            ],
            [
              "Number of holdings",
              fundFigure(pack.fund_info?.holdingsCount)?.toLocaleString(
                "en-US",
              ) ?? null,
            ],
            ["Asset class", str(pack.fund_info?.assetClass) || null],
          ]
        : [],
    },
    {
      title: "Valuation and returns, trailing 12 months",
      rows: [
        [
          "P/E",
          (num(pack.ratios_ttm?.priceToEarningsRatioTTM) ?? 1) <= 0
            ? "Not meaningful"
            : plain(pack.ratios_ttm?.priceToEarningsRatioTTM),
        ],
        [
          "Net margin",
          ratioPct(
            // Where revenue_basis says so, the vendor's margin divides by gross revenue.
            growth?.revenue_basis === "reported"
              ? growth.net_margin_ttm_on_reported_revenue
              : pack.ratios_ttm?.netProfitMarginTTM,
          ),
        ],
        ["Return on equity", ratioPct(pack.key_metrics_ttm?.returnOnEquityTTM)],
        [
          "Price to common book",
          plain(pack.valuation_and_growth?.valuation?.price_to_common_book_ttm),
        ],
      ],
    },
    {
      // The page adds its own P/E row to the first group whose title starts with "Valuation", which is not this.
      title: "Forward and historical valuation",
      rows: [
        [
          // The labels carry what the models' standing note says: the two P/Es rest on different earnings.
          `Forward P/E on usually adjusted estimates${forwardYear ? `, fiscal year ending ${forwardYear}` : ""}`,
          plain(estimates?.forward_pe),
        ],
        [
          `Median P/E on reported earnings${overYears}`,
          plain(estimates?.pe_median_last_5_fiscal_years),
        ],
        [
          `P/E range${overYears}`,
          peLow && peHigh ? `${peLow} to ${peHigh}` : null,
        ],
        [
          "Trailing P/E without income from outside operations",
          plain(estimates?.pe_ttm_without_other_income),
        ],
        [
          "Free cash flow yield, trailing 12 months, vendor figures",
          rawPct(estimates?.fcf_yield_ttm_pct),
        ],
        [
          "Upside to analyst target",
          movePct(estimates?.analyst_target_upside_pct),
        ],
      ],
    },
    {
      title: quarter ? `Latest quarter, ${quarter}` : "Latest quarter",
      rows: [
        [
          "Revenue",
          compact(
            growth?.latest_quarter_reported_revenue ?? income?.revenue,
            currency,
          ),
        ],
        [
          "Revenue growth, year on year",
          growth?.revenue_basis ? movePct(growth.revenue_yoy_pct) : null,
        ],
        ["Net income", compact(income?.netIncome, currency)],
        [
          labelled("Free cash flow", cash),
          cashFlowMissing(cash) ||
          growth?.latest_quarter_free_cash_flow_usable === false
            ? null
            : amount(cash?.freeCashFlow, cash),
        ],
        [
          // When the vendor has leases they are in its total: MSFT's $133.93B is $98.45B of leases.
          labelled(
            (num(balance?.capitalLeaseObligations) ?? 0) > 0
              ? "Debt and leases"
              : "Total debt",
            balance,
          ),
          // A bank's total holds repos and customer funds, so no plain label can be accurate. An
          // insurer's is plain borrowing: what makes it bank-like is the premiums in its cash flow.
          growth?.bank_like === true &&
          !/insurance/i.test(str(pack.company?.industry))
            ? null
            : amount(balance?.totalDebt, balance),
        ],
        [
          labelled("Cash and equivalents", balance),
          amount(balance?.cashAndCashEquivalents, balance),
        ],
      ],
    },
  ];
  return groups
    .map((group) => ({
      title: group.title,
      rows: group.rows.filter(
        (row): row is [string, string] => row[1] !== null,
      ),
    }))
    .filter((group) => group.rows.length > 0);
}
