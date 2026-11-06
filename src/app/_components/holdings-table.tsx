"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import type { SecondOpinion } from "~/server/updates";
import { holdingHasFlags } from "~/server/queue";

import {
  ActionBadge,
  AgreeBadge,
  ProofStrip,
  StatusBadge,
  words,
} from "./badges";
import { moveColor, pct, shortDate, signedPct, usd } from "./format";

export type HoldingRow = {
  ticker: string;
  name: string;
  isCash: boolean;
  weight: number | null;
  price: number | null;
  value: number | null;
  dayPct: number | null;
  quoteOn: string | null;
  action: string | null;
  status: string | null;
  checks:
    | { verdict: "verified" | "unverified" | "contradicted" | "not_checked" }[]
    | null;
  verifiedScore: number | null;
  opinion: SecondOpinion | null;
  rejected: boolean;
  secondAction: string | null;
  headline: string | null;
  reviewedOn: string | null;
  hasThesis: boolean;
};

const FILTERS: {
  id: string;
  label: string;
  test: (row: HoldingRow) => boolean;
}[] = [
  { id: "all", label: "All", test: () => true },
  {
    id: "action",
    label: "Suggests a change",
    test: (row) => !!row.action && row.action !== "hold",
  },
  {
    id: "disagree",
    label: "Disagreement",
    test: (row) => !!row.opinion && row.opinion !== "agree",
  },
  {
    id: "flagged",
    label: "Claims to check",
    test: holdingHasFlags,
  },
  {
    id: "thesis",
    label: "No thesis",
    test: (row) => !row.isCash && !row.hasThesis,
  },
];

// Most consequential first, so sorting by suggestion puts what needs me at the top.
const ACTION_RANK = ["sell", "trim", "review", "add", "hold"];

const SORTS: Record<string, (row: HoldingRow) => number | string | null> = {
  ticker: (row) => row.ticker,
  weight: (row) => row.weight,
  value: (row) => row.value,
  price: (row) => (row.isCash ? null : row.price),
  day: (row) => (row.isCash ? null : row.dayPct),
  action: (row) => (row.action ? -ACTION_RANK.indexOf(row.action) : null),
  verified: (row) => row.verifiedScore,
};

const SORT_COLUMNS = [
  { id: "ticker", label: "Holding" },
  { id: "weight", label: "Weight", className: "text-right" },
  { id: "value", label: "Value", className: "hidden text-right xl:table-cell" },
  { id: "price", label: "Price", className: "hidden text-right md:table-cell" },
  { id: "day", label: "Today", className: "text-right" },
  { id: "action", label: "Suggestion", className: "hidden md:table-cell" },
  { id: "verified", label: "Verified", className: "hidden md:table-cell" },
];

function SortHeader({
  id,
  label,
  sort,
  onSort,
  className = "",
}: {
  id: string;
  label: string;
  sort: { key: string; descending: boolean };
  onSort: (key: string) => void;
  className?: string;
}) {
  const active = sort.key === id;
  return (
    <th
      scope="col"
      aria-sort={
        active ? (sort.descending ? "descending" : "ascending") : "none"
      }
      className={`px-2 py-2 font-medium whitespace-nowrap sm:px-3 ${className}`}
    >
      <button
        className={`hover:text-ink inline-flex items-center gap-1 ${active ? "text-ink font-semibold" : ""}`}
        onClick={() => onSort(id)}
      >
        {label}
        <span aria-hidden className="w-2 text-[0.625rem]">
          {active ? (sort.descending ? "▼" : "▲") : ""}
        </span>
      </button>
    </th>
  );
}

export function HoldingsTable({
  rows,
  dayLabel = "Today",
  dayDate = null,
}: {
  rows: HoldingRow[];
  dayLabel?: string;
  dayDate?: string | null;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState({ key: "weight", descending: true });

  const visible = useMemo(() => {
    const test = FILTERS.find((f) => f.id === filter)?.test ?? (() => true);
    const read = SORTS[sort.key] ?? SORTS.weight!;
    return [...rows.filter(test)].sort((a, b) => {
      const left = read(a);
      const right = read(b);
      // Missing values stay at the bottom whichever way the column is sorted.
      if (left === null) return right === null ? 0 : 1;
      if (right === null) return -1;
      const order =
        typeof left === "string"
          ? left.localeCompare(String(right))
          : left - Number(right);
      return sort.descending ? -order : order;
    });
  }, [rows, filter, sort]);

  function onSort(key: string) {
    setSort((current) =>
      current.key === key
        ? { key, descending: !current.descending }
        : { key, descending: key !== "ticker" },
    );
  }

  return (
    <section aria-label="All holdings" className="space-y-3">
      <div
        role="group"
        aria-label="Filter holdings"
        className="flex flex-wrap gap-1.5"
      >
        {FILTERS.map((f) => {
          const count = rows.filter(f.test).length;
          if (f.id !== "all" && count === 0) return null;
          return (
            <button
              key={f.id}
              aria-pressed={filter === f.id}
              className={`btn btn-small ${
                filter === f.id
                  ? "border-ink bg-ink hover:bg-ink hover:border-ink text-white"
                  : ""
              }`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              <span className="font-normal opacity-75">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="sheet overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-muted border-line border-b text-left text-xs">
            <tr>
              {SORT_COLUMNS.map((column) => (
                <SortHeader
                  key={column.id}
                  {...column}
                  label={column.id === "day" ? dayLabel : column.label}
                  sort={sort}
                  onSort={onSort}
                />
              ))}
              <th
                scope="col"
                className="hidden px-2 py-2 font-medium sm:px-3 lg:table-cell"
              >
                Latest review
              </th>
            </tr>
          </thead>
          <tbody className="divide-line divide-y">
            {visible.map((row) => (
              <tr
                key={row.ticker}
                className={
                  row.isCash ? "" : "hover:bg-act-soft/40 cursor-pointer"
                }
                onClick={(e) => {
                  // The ticker link handles itself, and selecting text is not a click on the row.
                  if (
                    row.isCash ||
                    (e.target as HTMLElement).closest("a") ||
                    window.getSelection()?.toString()
                  ) {
                    return;
                  }
                  router.push(`/t/${row.ticker}`);
                }}
              >
                <td className="px-2 py-2 align-top sm:px-3 lg:w-44">
                  {row.isCash ? (
                    <span className="font-semibold">Cash</span>
                  ) : (
                    <Link
                      href={`/t/${row.ticker}`}
                      className="font-semibold hover:underline"
                    >
                      {row.ticker}
                    </Link>
                  )}
                  {!row.isCash && (
                    <span
                      className="text-muted block max-w-36 truncate text-xs md:max-w-44"
                      title={row.name}
                    >
                      {row.name}
                    </span>
                  )}
                  {/* A phone has no room for these columns, so they stack under the name. */}
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 md:hidden">
                    {row.action && <ActionBadge action={row.action} />}
                    {row.status && row.status !== "no_change" && (
                      <StatusBadge status={row.status} />
                    )}
                    <AgreeBadge opinion={row.opinion} rejected={row.rejected} />
                    {row.opinion &&
                      row.opinion !== "agree" &&
                      row.secondAction && (
                        <span className="text-bad text-xs">
                          Second check: {words(row.secondAction)}
                        </span>
                      )}
                    {!row.isCash && <ProofStrip checks={row.checks} />}
                  </span>
                  {row.headline && (
                    <span className="model-text mt-1 line-clamp-3 block text-[0.9375rem] leading-snug md:hidden">
                      {row.headline}
                    </span>
                  )}
                  {row.headline && row.reviewedOn && (
                    <span className="text-muted block text-xs md:hidden">
                      {shortDate(row.reviewedOn)}
                    </span>
                  )}
                </td>
                <td className="px-2 py-2 text-right align-top sm:px-3">
                  {pct(row.weight)}
                  {row.isCash && (
                    <span className="text-muted block text-xs xl:hidden">
                      {usd(row.value, 0)}
                    </span>
                  )}
                </td>
                <td className="hidden px-2 py-2 text-right align-top sm:px-3 xl:table-cell">
                  {usd(row.value, 0)}
                </td>
                <td className="hidden px-2 py-2 text-right align-top sm:px-3 md:table-cell">
                  {row.isCash ? "" : usd(row.price)}
                </td>
                <td
                  className={`px-2 py-2 text-right align-top sm:px-3 ${moveColor(row.dayPct)}`}
                >
                  {row.isCash ? "" : signedPct(row.dayPct)}
                  {!row.isCash && row.quoteOn !== dayDate && (
                    <span className="text-muted block text-xs">
                      {row.quoteOn ? shortDate(row.quoteOn) : "Undated"}
                    </span>
                  )}
                </td>
                <td className="hidden px-2 py-2 align-top sm:px-3 md:table-cell">
                  {row.action && <ActionBadge action={row.action} />}
                  {row.status && row.status !== "no_change" && (
                    <span className="mt-0.5 block">
                      <StatusBadge status={row.status} />
                    </span>
                  )}
                </td>
                <td className="hidden px-2 py-2 align-top sm:px-3 md:table-cell">
                  {!row.isCash && <ProofStrip checks={row.checks} />}
                  {(row.opinion || row.rejected) && (
                    <span className="mt-0.5 block">
                      <AgreeBadge
                        opinion={row.opinion}
                        rejected={row.rejected}
                      />
                      {row.opinion &&
                        row.opinion !== "agree" &&
                        row.secondAction && (
                          <span className="text-bad block text-xs">
                            Second check: {words(row.secondAction)}
                          </span>
                        )}
                    </span>
                  )}
                </td>
                <td className="hidden px-2 py-2 align-top sm:px-3 lg:table-cell">
                  {row.headline && (
                    <span
                      className="model-text line-clamp-2 text-[0.9375rem] leading-snug"
                      title={row.headline}
                    >
                      {row.headline}
                    </span>
                  )}
                  {row.headline && row.reviewedOn && (
                    <span className="text-muted block text-xs">
                      {shortDate(row.reviewedOn)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={8} className="text-muted px-3 py-6 text-center">
                  No holdings match this filter.{" "}
                  <button
                    className="text-link"
                    onClick={() => setFilter("all")}
                  >
                    Show all
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
