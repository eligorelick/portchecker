// The import page's client code uses this file, so anything imported here at runtime reaches the
// browser. Keep it to `import type`.
import type { BriefResult } from "./research/prompts.ts";
import type { PortfolioFacts } from "./portfolio.ts";

/** Position context in dollars, shared by Today and the saved brief. */
export function positionSizeLine(
  ticker: string,
  facts: Pick<PortfolioFacts, "positions" | "total_value">,
) {
  const position = facts.positions.find((p) => p.ticker === ticker);
  if (
    position?.weight_pct == null ||
    position.value === null ||
    !Number.isFinite(position.weight_pct) ||
    !Number.isFinite(position.value) ||
    !Number.isFinite(facts.total_value) ||
    facts.total_value <= 0
  )
    return null;
  const dollars = (value: number) =>
    value.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    });
  return `Now ${position.weight_pct.toFixed(2)}% (${dollars(position.value)}). 1% of the portfolio is ${dollars(facts.total_value / 100)}.`;
}

type QueueDecision = {
  ticker: string;
  date: string;
  actionTaken: string;
  note: string;
  createdAt?: string | null;
};

export type QueueItem = {
  ticker: string;
  action: string | null;
  urgency: string | null;
  sizeHint: string | null;
  why: string | null;
  reasoning: string | null;
  decision: QueueDecision | null;
};

/** An attention-only brief entry may borrow its own review's action, never a later one. */
export const queueAction = (
  item: Pick<QueueItem, "action">,
  update: { result: { action: string } } | undefined,
  newer: boolean,
) => item.action ?? (newer ? null : (update?.result.action ?? null));

/** Later successful reviews, including quiet rechecks, supersede an old failure. */
export function stillFailed<T extends { ticker: string }>(
  failed: T[],
  updates: Map<string, { createdAt: string; recheckedAt: string | null }>,
  briefReadyAt: string | null,
) {
  return failed.filter((item) => {
    const update = updates.get(item.ticker);
    return (
      !update ||
      !briefReadyAt ||
      !(
        Date.parse(update.recheckedAt ?? update.createdAt) >
        Date.parse(briefReadyAt)
      )
    );
  });
}

export const holdingHasFlags = (row: {
  rejected: boolean;
  checks: { verdict: string }[] | null;
}) =>
  row.rejected || !!row.checks?.some((check) => check.verdict !== "verified");

const URGENCY_ORDER = ["today", "this_week", "no_rush"];

function urgencyRank(urgency: string | null) {
  const rank = urgency ? URGENCY_ORDER.indexOf(urgency) : -1;
  return rank < 0 ? URGENCY_ORDER.length : rank;
}

/**
 * The brief lists most tickers twice, under needs_attention and suggested_actions. This merges them
 * into one list, most urgent first. A logged decision marks an item but does not move it, so an
 * entry stays put while it is open. `decisions` must be newest first.
 */
export function buildQueue(
  brief: Pick<BriefResult, "date" | "needs_attention" | "suggested_actions">,
  decisions: QueueDecision[],
  briefReadyAt: string | null = null,
) {
  const items = new Map<string, QueueItem>();
  const item = (ticker: string) => {
    const existing = items.get(ticker);
    if (existing) return existing;
    const fresh: QueueItem = {
      ticker,
      action: null,
      urgency: null,
      sizeHint: null,
      why: null,
      reasoning: null,
      decision:
        decisions.find(
          (d) =>
            d.ticker === ticker &&
            (d.createdAt && briefReadyAt
              ? d.createdAt >= briefReadyAt
              : d.date >= brief.date),
        ) ?? null,
    };
    items.set(ticker, fresh);
    return fresh;
  };
  for (const entry of brief.suggested_actions) {
    Object.assign(item(entry.ticker), {
      action: entry.action,
      urgency: entry.urgency,
      sizeHint: entry.size_hint || null,
      reasoning: entry.reasoning,
    });
  }
  for (const entry of brief.needs_attention) {
    item(entry.ticker).why = entry.why;
  }
  return [...items.values()].sort(
    (a, b) => urgencyRank(a.urgency) - urgencyRank(b.urgency),
  );
}

type HoldingRow = {
  ticker: string;
  quantity: number;
  costBasis?: number | null;
  accountLabel?: string;
};

/** Compare ticker totals across relabeled exports, and retained accounts for lost basis. */
export function holdingChanges(current: HoldingRow[], incoming: HoldingRow[]) {
  const totals = (rows: { ticker: string; quantity: number }[]) => {
    const sums = new Map<string, number>();
    for (const row of rows) {
      sums.set(row.ticker, (sums.get(row.ticker) ?? 0) + row.quantity);
    }
    return sums;
  };
  const before = totals(current);
  const after = totals(incoming);
  // Counts catch reduced coverage; account matches catch a loss hidden by another account's gain.
  const losesBasis = (ticker: string) => {
    const known = (rows: typeof current) =>
      rows.filter((r) => r.costBasis != null).length;
    const was = current.filter((r) => r.ticker === ticker);
    const now = incoming.filter((r) => r.ticker === ticker);
    return (
      known(was) > 0 &&
      ((known(now) < now.length &&
        (known(was) === was.length || known(now) < known(was))) ||
        was.some((row) => {
          if (row.costBasis == null || row.accountLabel === undefined)
            return false;
          const matches = now.filter(
            (next) => next.accountLabel === row.accountLabel,
          );
          if (matches.length)
            return matches.some((next) => next.costBasis == null);
          // A renamed or removed account cannot safely explain away a missing basis.
          return (
            known(now) < now.length ||
            was.some(
              (old) =>
                old.accountLabel !== undefined &&
                now.some((next) => next.accountLabel === old.accountLabel),
            )
          );
        }))
    );
  };
  const basisTotal = (rows: HoldingRow[], ticker: string) => {
    const held = rows.filter((row) => row.ticker === ticker);
    return held.every((row) => row.costBasis != null)
      ? held.reduce((sum, row) => sum + row.costBasis!, 0)
      : null;
  };
  const basisChanges = new Map(
    [...after.keys()]
      .filter((t) => before.has(t))
      .flatMap((t) => {
        const oldBasis = basisTotal(current, t);
        const newBasis = basisTotal(incoming, t);
        const accountChanged = current.some(
          (row) =>
            row.ticker === t &&
            row.accountLabel !== undefined &&
            incoming.some(
              (next) =>
                next.ticker === t &&
                next.accountLabel === row.accountLabel &&
                (next.costBasis ?? null) !== (row.costBasis ?? null),
            ),
        );
        return oldBasis !== newBasis || accountChanged || losesBasis(t)
          ? [[t, { before: oldBasis, after: newBasis }] as const]
          : [];
      }),
  );
  return {
    before,
    after,
    added: [...after.keys()].filter((t) => !before.has(t)).length,
    changed: [...after].filter(([t, q]) => before.has(t) && before.get(t) !== q)
      .length,
    removed: [...before.keys()].filter((t) => !after.has(t)),
    losingBasis: [...after.keys()].filter(losesBasis),
    basisChanges,
    unchanged: [...after].filter(
      ([t, q]) => before.get(t) === q && !basisChanges.has(t),
    ).length,
  };
}

/**
 * What a replace would change. Holdings still loading are not an empty portfolio: that would read as
 * nothing removed, and the replace would then remove everything with no warning.
 */
export function previewChanges(
  current: HoldingRow[] | undefined,
  preview: { error: string | null; rows: HoldingRow[] } | null,
) {
  return preview && !preview.error && current
    ? holdingChanges(current, preview.rows)
    : null;
}

export function previewSummary(
  changes: ReturnType<typeof holdingChanges> | null,
  holdingsFailed: boolean,
) {
  if (changes) {
    return `${changes.added} new, ${changes.changed} with a new quantity, ${changes.basisChanges.size ? `${changes.basisChanges.size} with cost basis changes, ` : ""}${changes.removed.length} removed, ${changes.unchanged} unchanged.`;
  }
  return holdingsFailed
    ? "Your current holdings could not be loaded, so what would change is unknown."
    : "Loading your current holdings to compare.";
}

/**
 * Loads one file's preview at a time. Its rows stay with the text and name they came from, because
 * Replace imports what the preview holds. The old preview goes first, so a failed parse cannot leave
 * it under a new file's name, and an earlier load that finishes later is ignored either way.
 */
export function previewLoader<P extends { notes: string[] }>(
  parse: (csv: string) => Promise<P>,
  show: (preview: (P & { csv: string; fileName: string }) | null) => void,
) {
  let newest = 0;
  return async (
    input:
      | string
      | ((isCurrent: () => boolean) => Promise<{
          csv: string;
          fileName: string;
          notes?: string[];
        } | null>),
    fileName = "",
    extraNotes: string[] = [],
  ) => {
    const mine = ++newest;
    show(null);
    try {
      // Reserve the selection before reading a file or asking the server to read it.
      const data =
        typeof input === "string"
          ? { csv: input, fileName, notes: extraNotes }
          : await input(() => mine === newest);
      if (!data || mine !== newest) return;
      const { csv } = data;
      const parsed = await parse(csv);
      if (mine === newest) {
        show({
          ...parsed,
          csv,
          fileName: data.fileName,
          notes: [...parsed.notes, ...(data.notes ?? [])],
        });
      }
    } catch (error) {
      if (mine === newest) throw error;
    }
  };
}

export const rowCount = (n: number) => `${n} ${n === 1 ? "row" : "rows"}`;

export const MAX_SCREENSHOTS = 12;

export const screenshotPickProblem = (count: number) =>
  count > MAX_SCREENSHOTS
    ? `Choose at most ${MAX_SCREENSHOTS} images at a time.`
    : null;

/**
 * The extension a saved screenshot gets, or null when the upload is not one of the image types the
 * picker offers. A name with no extension is saved as PNG.
 */
export function screenshotExtension(name: string) {
  const ext = (/\.[^./\\]*$/.exec(name)?.[0] ?? ".png").toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp"].includes(ext) ? ext : null;
}

/** Screenshots can show account details, so the preview says when the other provider read them. */
export const screenshotFallbackNotes = (
  usedFallback: boolean,
  provider: string,
) =>
  usedFallback
    ? [
        `${provider === "claude" ? "Claude" : "ChatGPT"} read these images, because the selected provider failed and "If one fails, use the other" is on in Settings.`,
      ]
    : [];

/**
 * A number typed into a holding's form, or null. Number() alone would take 0x10 as 16. Exponents
 * stay, because the form fills itself from the stored value and String(1e21) has one.
 */
export function parseOptionalNumber(text: string) {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

type StoredHolding = {
  name: string;
  quantity: number;
  costBasis: number | null;
};

/**
 * What a holding's form may do with the text in it. A blank cost basis clears the stored one on
 * purpose, so a typo must not read as a blank.
 */
export function holdingFormState(
  text: { ticker: string; name: string; quantity: string; costBasis: string },
  holding?: StoredHolding,
) {
  const quantity = parseOptionalNumber(text.quantity);
  const costBasis = parseOptionalNumber(text.costBasis);
  const quantityBad =
    quantity === null && (holding !== undefined || text.quantity.trim() !== "");
  const costBad = costBasis === null && text.costBasis.trim() !== "";
  return {
    quantity,
    costBasis,
    canSave: text.ticker.trim() !== "" && quantity !== null && !costBad,
    dirty: holding
      ? text.name !== holding.name ||
        quantity !== holding.quantity ||
        costBasis !== holding.costBasis ||
        costBad
      : true,
    problem: quantityBad
      ? "Enter the quantity as a plain number."
      : costBad
        ? "Enter the total cost basis as a plain number."
        : null,
  };
}

/** The text a holding's form starts with. A new holding starts blank. */
export const holdingFormText = (holding?: StoredHolding) => ({
  name: holding?.name ?? "",
  quantity: holding ? String(holding.quantity) : "",
  costBasis: holding?.costBasis == null ? "" : String(holding.costBasis),
});

/**
 * A row keeps what I type across refetches, so it must be told when the stored holding itself moved,
 * through a Replace or another tab. Its old text would read as an unsaved edit, and its Save would
 * write the old numbers back. Returns the new text, or null to leave the row alone.
 */
export function rowTextAfterChange(
  seen: StoredHolding | undefined,
  holding: StoredHolding | undefined,
) {
  if (!seen || !holding) return null;
  return seen.name === holding.name &&
    seen.quantity === holding.quantity &&
    seen.costBasis === holding.costBasis
    ? null
    : holdingFormText(holding);
}

/** A second row for a ticker is allowed, since accounts add together, but it should not pass in silence. */
export const addedMessage = (ticker: string, otherRows: number) =>
  otherRows
    ? `Added ${ticker}. It now has ${otherRows + 1} rows, which count as one position, and shows a gain only when every row has a total cost basis.`
    : `Added ${ticker}.`;

const TICKER_DONE =
  /^\S+ \S+: (?:(?:no_change|watch|thesis_\w+), \w+, verified|FAILED\.|No market data|Skipped:|Setup failed:)/;

/** How far a running job has got, read from its log. Null until it has counted its tickers. */
export function runProgress(logText: string) {
  const counted = /(\d+) tickers to review\./.exec(logText)?.[1];
  if (!counted) return null;
  const only = /Reviewing only: (.*)\./.exec(logText)?.[1]?.split(", ");
  // A subset run still fetches every holding, so a failure elsewhere is not progress on this list.
  const counts = (line: string) =>
    TICKER_DONE.test(line) &&
    (!only || only.includes(line.split(" ")[1]?.replace(":", "") ?? ""));
  return {
    done: logText.split("\n").filter(counts).length,
    total: only ? only.length : Number(counted),
  };
}
