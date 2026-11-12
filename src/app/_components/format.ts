import { plainWords } from "../../server/research/prompts.ts";

export { plainWords };

export const NOTE_BLOCKED = ["img"];
export const MODEL_TEXT_BLOCKED = ["img", "a"];
export const INSIDER_FILINGS_SHOWN = 20;
export const REVIEW_HISTORY_SHOWN = 30;

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"];

/** What a model's effort list allows. A model not in the list, such as a typed name, could be anything. */
export function effortsFor(
  model: string,
  models: { id: string; efforts: string[] }[],
) {
  const known = models.find((m) => m.id === model);
  if (known) return known.efforts;
  return model ? EFFORT_LEVELS : commonEfforts(models);
}

/** "Codex default" can be any listed model, so it offers only what all of them accept. */
function commonEfforts(models: { efforts: string[] }[]) {
  return EFFORT_LEVELS.filter(
    (level) =>
      models.length === 0 || models.every((m) => m.efforts.includes(level)),
  );
}

/** An amount that rounds to zero is zero, so nothing reads "-$0.00" or "+0.00%". */
const zeroed = (n: number, digits: number) =>
  Number(n.toFixed(digits)) === 0 ? 0 : n;

const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "");

export const usd = (n: number | null | undefined, digits = 2) =>
  n == null
    ? "—"
    : zeroed(n, digits).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      });

/** "+$850" or "−$850". */
export const signedUsd = (n: number | null | undefined, digits = 0) =>
  n == null ? "—" : `${sign(zeroed(n, digits))}${usd(Math.abs(n), digits)}`;

export const pct = (n: number | null | undefined, digits = 1) =>
  n == null ? "—" : `${zeroed(n, digits).toFixed(digits)}%`;

export const signedPct = (n: number | null | undefined) =>
  n == null ? "—" : `${sign(zeroed(n, 2))}${Math.abs(n).toFixed(2)}%`;

export const moveColor = (n: number | null | undefined) =>
  n == null || n === 0 ? "text-muted" : n > 0 ? "text-ok" : "text-bad";

// A bare YYYY-MM-DD is read as UTC, which shows the previous day west of Greenwich. Noon stays put.
const localDate = (day: string) => new Date(`${day}T12:00:00`);

/** "Wednesday, November 4" */
export const longDate = (day: string) =>
  localDate(day).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

/** "Nov 4" */
export const shortDate = (day: string) =>
  validDay(day)
    ? localDate(day).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : "no date";

const validDay = (day: string) => {
  const date = localDate(day);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(date.getTime()) &&
    date.getFullYear() === Number(day.slice(0, 4)) &&
    date.getMonth() + 1 === Number(day.slice(5, 7)) &&
    date.getDate() === Number(day.slice(8, 10))
  );
};

/** Pass null for now when the year should always be shown. */
export const dayWithYear = (
  day: string,
  now: string | null = new Date().toLocaleDateString("en-CA"),
) =>
  !validDay(day) || day.slice(0, 4) === now?.slice(0, 4)
    ? shortDate(day)
    : localDate(day).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });

function savedDay(value: string | null | undefined) {
  if (!value) return null;
  if (validDay(value)) return value;
  if (!validDay(value.slice(0, 10)) || !value.includes("T")) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleDateString("en-CA")
    : null;
}

export function holdingsUpdatedLabel(
  oldest: string | null | undefined,
  newest: string | null | undefined,
  now = new Date().toLocaleDateString("en-CA"),
) {
  const first = savedDay(oldest);
  const last = savedDay(newest);
  if (!first) return null;
  return `Holdings updated ${dayWithYear(first, now)}${last && last !== first ? ` to ${dayWithYear(last, now)}` : ""}`;
}

/** Date-only records cannot establish which event came first on the same day. */
export function holdingsChangedNote(
  kind: "brief" | "review",
  holdingsUpdatedAt: string | null | undefined,
  writtenAt: string | null | undefined,
  writtenDate?: string | null,
) {
  const changedDay = savedDay(holdingsUpdatedAt);
  const writtenDay = savedDay(writtenAt) ?? savedDay(writtenDate);
  if (!changedDay || !writtenDay) return null;
  const precise =
    holdingsUpdatedAt?.includes("T") &&
    writtenAt?.includes("T") &&
    savedDay(writtenAt);
  const changed = precise
    ? Date.parse(holdingsUpdatedAt!) > Date.parse(writtenAt!)
    : changedDay > writtenDay;
  return changed
    ? `Written before your holdings changed on ${dayWithYear(changedDay)}, so position sizes and cash in this ${kind} are from then.`
    : null;
}

export function dayMoveWhen(
  quoteDate: string | null,
  now = new Date().toLocaleDateString("en-CA"),
) {
  if (!quoteDate || !validDay(quoteDate)) return "last session";
  return quoteDate === now ? "today" : `on ${dayWithYear(quoteDate, now)}`;
}

export const shares = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: 6 });

export const cappedLabel = (count: number, cap: number) =>
  count >= cap ? `latest ${cap}` : String(count);

export function gainLabel(withBasis: number, holdings: number) {
  if (withBasis === 0) return null;
  return withBasis === holdings
    ? "Unrealized gain"
    : `Unrealized gain, ${withBasis} of ${holdings} holdings`;
}

export function packDates(pack: {
  quote?: { as_of_et?: unknown } | null;
  generated_on?: unknown;
}) {
  return [
    typeof pack.quote?.as_of_et === "string" &&
      pack.quote.as_of_et &&
      `Prices as of ${pack.quote.as_of_et}.`,
    typeof pack.generated_on === "string" &&
      pack.generated_on &&
      `Research file from ${dayWithYear(pack.generated_on, null)}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function diffLines(diff: string) {
  return diff
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      if (line.startsWith("### "))
        return { kind: "subhead" as const, text: line.slice(4) };
      if (line.startsWith("## "))
        return { kind: "head" as const, text: line.slice(3) };
      return {
        kind: "plain" as const,
        text: line.replace(
          /^\[(\d+) less important changes are left out here;.*\]$/,
          "[$1 less important changes are not shown]",
        ),
      };
    });
}

export const dossierHasUnsavedChanges = (
  text: string,
  markdown: string,
  unsavedCopy: string | null,
) => text !== markdown || unsavedCopy !== null;

export function dataNoteForReader(note: string) {
  return plainWords(
    note
      .replace(
        /\bfreeCashFlowYieldTTM\b/g,
        "free cash flow yield over the last 12 months",
      )
      .replace(
        /\bevToEBITDATTM\b/g,
        "enterprise value to EBITDA over the last 12 months",
      )
      .replace(/\bkey_metrics_ttm\b/g, "key metrics over the last 12 months")
      .replace(/\bkey_metrics_annual\b/g, "annual key metrics")
      .replace(/\brevenue_yoy_pct\b/g, "year-on-year revenue growth")
      .replace(/\bincome_statement_quarterly\b/g, "quarterly income statements")
      .replace(/\bvaluation_and_growth\b/g, "valuation and growth"),
  );
}

/** "Nov 4, 2:59 PM" */
export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** "today", "tomorrow" or "in 5 days". */
export const inDays = (days: number) =>
  days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;

/** Whole days from one YYYY-MM-DD to another. */
export const daysBetween = (from: string, to: string) =>
  Math.round(
    (localDate(to).getTime() - localDate(from).getTime()) / 86_400_000,
  );

export type QuoteDates = {
  newest: string | null;
  oldest: string | null;
  stale: string[];
};

export function dayMoveLabel(
  dates?: QuoteDates,
  now = new Date().toLocaleDateString("en-CA"),
) {
  if (!dates || dates.newest === now) return "Today";
  return `Last session${dates.newest ? ` (${dayWithYear(dates.newest, now)})` : " (date unavailable)"}`;
}

/** The summary above the table explains the session; its column needs a phone-sized label. */
export function dayColumnLabel(
  dates?: QuoteDates,
  now = new Date().toLocaleDateString("en-CA"),
) {
  if (!dates || dates.newest === now) return "Today";
  return dates.newest ? shortDate(dates.newest) : "Last session";
}

/** Only a matching verified check can fold away. */
export function groupEvidence<T extends { check: { verdict: string } | null }>(
  entries: T[],
) {
  return {
    flagged: entries.filter((entry) => entry.check?.verdict !== "verified"),
    clean: entries.filter((entry) => entry.check?.verdict === "verified"),
  };
}

export const checkRejected = (update: {
  verification: { conclusion_supported?: boolean } | null;
}) => update.verification?.conclusion_supported === false;

export const conclusionNote = (supported: boolean, disagree: boolean) =>
  !supported
    ? {
        tone: "text-bad font-medium",
        text: "✗ The evidence does not support this conclusion.",
      }
    : disagree
      ? {
          tone: "text-warn",
          text: "The second check accepts the facts behind this conclusion, but would act differently.",
        }
      : { tone: "text-ok", text: "✓ The evidence supports this conclusion." };

export const allClearText = (web: number) =>
  web > 0
    ? `✓ The second check confirmed all listed claims against the research files. ${web} ${web === 1 ? "cites" : "cite"} web summaries, which are model-written, not the documents themselves.`
    : "✓ The second check confirmed all listed claims against the research files.";

const CLAIM_LABELS: Record<string, string> = {
  what_changed: "What's new",
  business_view: "Business",
  valuation_view: "Valuation",
  evidence_against: "Case against",
  next_proof_point: "What to watch",
  dossier_current_view: "Current view",
  would_change_my_mind: "What would change my mind",
};

/** Display only: the original claims still pair with their checks and determine the score. */
export function claimForReader(claim: string) {
  return plainWords(
    claim
      .split(/(https?:\/\/[^\s<>"']+)/gi)
      .map((part, i) =>
        i % 2
          ? part
          : part
              .replace(
                /^(reasoning|headline)(?:\[\d+\])?:/,
                (_, word: string) =>
                  `${word.charAt(0).toUpperCase()}${word.slice(1)}:`,
              )
              .replace(
                /\b(what_changed|business_view|valuation_view|evidence_against|next_proof_point|dossier_current_view|would_change_my_mind)(?:\[\d+\])?/g,
                (_, field: string) => CLAIM_LABELS[field]!,
              )
              .replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/g, (field) =>
                field.replaceAll("_", " "),
              ),
      )
      .join(""),
  );
}

/** Older dossiers already contain shortened claims. Hide a partial word and figure at the cut. */
export function currentViewForReader(view: string) {
  const marker = "The second check could not confirm:";
  const at = view.indexOf(marker);
  if (at < 0) return view;
  return (
    view.slice(0, at) +
    view.slice(at).replace(/^- (.+)$/gm, (_, line: string) => {
      let claim = claimForReader(line);
      if (claim.endsWith("...")) {
        claim = claim.slice(0, -3);
        const end = claim.lastIndexOf(" ");
        if (end >= 0) claim = claim.slice(0, end).replace(/\s+\S*\d\S*$/, "");
        claim += "...";
      }
      return `- ${claim}`;
    })
  );
}

/** A source may cite several files and links; retain its full text in the UI's title. */
export function sourceParts(source: string) {
  return source
    .split(/;\s*(?=(?:news:|edgar:|file:|fmp:|dossier\b|https?:\/\/))/i)
    .map((part) => {
      const accession = /(?<!\d)\d{10}-\d{2}-\d{6}(?!\d)/.exec(part)?.[0];
      const url = /https?:\/\/[^\s)]+/i.exec(part)?.[0];
      const file = part.replace(/^file:/, "");
      const filing =
        /filing_(?:sections_|diff_|changes_)?(.+?)_(\d{4}-\d{2}-\d{2})/.exec(
          file,
        );
      const eventDate = /new_8k_(\d{4}-\d{2}-\d{2})/.exec(file)?.[1];
      const namedFile = [
        ["pack.json", "Research data"],
        ["web_research.md", "Web research"],
        ["claim_excerpts.md", "Filing excerpts"],
        ["dossier", "My research file"],
      ].find(([name]) => file.startsWith(name!))?.[1];
      let secFiling = false;
      if (url && !part.startsWith("news:")) {
        try {
          const parsed = new URL(url);
          secFiling =
            /(^|\.)sec\.gov$/i.test(parsed.hostname) &&
            /^\/archives\//i.test(parsed.pathname);
        } catch {
          // A malformed citation remains readable without being treated as an SEC filing.
        }
      }
      const label = accession
        ? `EDGAR ${accession}`
        : url
          ? secFiling
            ? "SEC filing"
            : "News article"
          : filing
            ? `${filing[1]}, ${filing[2]}`
            : eventDate
              ? `8-K, ${eventDate}`
              : file.startsWith("pack.json#")
                ? `Research data: ${plainWords(file.slice("pack.json#".length))}`
                : (namedFile ??
                  (part.startsWith("fmp:") ? `FMP ${part.slice(4)}` : part));
      return { label, accession, url };
    });
}
