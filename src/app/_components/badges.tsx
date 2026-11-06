import type { PortfolioFacts } from "~/server/portfolio";
import type { VerifierResult } from "~/server/research/prompts";
import type { SecondOpinion } from "~/server/updates";

import {
  claimForReader,
  dayMoveLabel,
  gainLabel,
  moveColor,
  pct,
  signedPct,
  signedUsd,
  usd,
} from "./format";

type Verdict = VerifierResult["checks"][number]["verdict"];
type StripCheck = { verdict: Verdict | "not_checked"; claim?: string };

export function words(value: string) {
  const text = value.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const ACTION_STYLE: Record<string, string> = {
  hold: "border-line text-muted",
  add: "border-ok bg-ok-soft text-ok",
  trim: "border-warn bg-warn-soft text-warn",
  sell: "border-bad bg-bad-soft text-bad",
  review: "border-act bg-act-soft text-act",
};

/** The suggestion, the one label on the page that asks for something. */
export function ActionBadge({ action }: { action: string }) {
  return (
    <span
      className={`inline-block rounded-[3px] border px-1.5 py-px text-xs font-semibold whitespace-nowrap ${
        ACTION_STYLE[action] ?? "border-line text-muted"
      }`}
    >
      {words(action)}
    </span>
  );
}

const STATUS_STYLE: Record<string, string> = {
  thesis_strengthened: "text-ok",
  watch: "text-warn",
  thesis_weakened: "text-warn font-semibold",
  thesis_broken: "text-bad font-semibold",
};

/** "Watch" alone reads like an instruction next to a suggestion. */
export const statusLabel = (status: string) =>
  status === "watch"
    ? "On watch"
    : status === "no_change"
      ? "No material change"
      : words(status);

/** How the thesis is holding up. Quieter than the action, since it is context for it. */
export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`text-xs whitespace-nowrap ${STATUS_STYLE[status] ?? "text-muted"}`}
    >
      {statusLabel(status)}
    </span>
  );
}

const TICK_STYLE: Record<StripCheck["verdict"], string> = {
  verified: "bg-ok h-full",
  unverified: "bg-warn h-1/2",
  contradicted: "bg-bad h-full",
  not_checked: "bg-line h-1/2",
};

/**
 * One tick per claim the second model checked, plus claims it missed.
 * Height as well as color carries the verdict, so it still reads
 * without color. Counts come from checks and unmatched evidence, never from model text.
 */
export function ProofStrip({
  checks,
  size = "small",
}: {
  checks: StripCheck[] | null | undefined;
  size?: "small" | "large";
}) {
  if (!checks) {
    return (
      <span
        className="text-muted text-xs whitespace-nowrap"
        title="Quiet days get a light review with no second check."
      >
        Not checked
      </span>
    );
  }
  const passed = checks.filter((c) => c.verdict === "verified").length;
  const contradicted = checks.filter(
    (c) => c.verdict === "contradicted",
  ).length;
  const notChecked = checks.filter((c) => c.verdict === "not_checked").length;
  const unverified = checks.length - passed - contradicted - notChecked;
  const summary = [
    `${passed} of ${checks.length} claims verified`,
    unverified > 0 && `${unverified} could not be found`,
    contradicted > 0 && `${contradicted} contradicted`,
    notChecked > 0 && `${notChecked} not checked`,
  ]
    .filter(Boolean)
    .join(", ");

  if (size === "large") {
    return (
      <div>
        <div
          role="img"
          aria-label={summary}
          className="flex flex-wrap items-end gap-x-[3px] gap-y-1"
        >
          {checks.map((check, i) => (
            <span
              key={i}
              title={
                check.claim
                  ? `${words(check.verdict)}: ${claimForReader(check.claim)}`
                  : undefined
              }
              className="flex h-6 w-1 items-end"
            >
              <span
                className={`w-full rounded-[1px] ${TICK_STYLE[check.verdict]}`}
              />
            </span>
          ))}
        </div>
        <p
          className={`mt-1.5 text-sm ${contradicted ? "text-bad font-medium" : "text-muted"}`}
        >
          {summary}
        </p>
      </div>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-2 whitespace-nowrap"
      title={summary}
    >
      <span
        className={`w-9 text-xs ${contradicted ? "text-bad font-semibold" : "text-muted"}`}
      >
        <span className="sr-only">{summary}</span>
        <span aria-hidden>
          {passed}/{checks.length}
        </span>
      </span>
      {/* Whole pixels keep long strips crisp, and the strip's length shows how much was checked. */}
      <span aria-hidden className="inline-flex h-3.5 items-end gap-px">
        {checks.map((check, i) => (
          <span key={i} className={`w-0.5 ${TICK_STYLE[check.verdict]}`} />
        ))}
      </span>
    </span>
  );
}

const OPINION_LABEL: Record<SecondOpinion, string> = {
  agree: "Models agree",
  disagree: "Models disagree",
  second_pass_disagrees: "Second check disagrees",
};

export function AgreeBadge({
  opinion,
  rejected = false,
}: {
  opinion: SecondOpinion | null;
  rejected?: boolean;
}) {
  if (rejected) {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-bad text-xs font-semibold">
          ✗ Final check rejected
        </span>
        {opinion && opinion !== "agree" && <AgreeBadge opinion={opinion} />}
      </span>
    );
  }
  if (!opinion) return null;
  const agree = opinion === "agree";
  return (
    <span
      className={`text-xs whitespace-nowrap ${agree ? "text-ok" : "text-bad font-semibold"}`}
    >
      {agree ? "✓" : "≠"} {OPINION_LABEL[opinion]}
    </span>
  );
}

const VERDICT_MARK: Record<Verdict, { mark: string; style: string }> = {
  verified: { mark: "✓ Verified", style: "text-ok" },
  unverified: { mark: "? Unverified", style: "text-warn font-medium" },
  contradicted: { mark: "✗ Contradicted", style: "text-bad font-semibold" },
};

export function VerdictMark({ verdict }: { verdict: Verdict | null }) {
  if (!verdict) return <span className="text-muted">Not checked</span>;
  const { mark, style } = VERDICT_MARK[verdict];
  return <span className={`whitespace-nowrap ${style}`}>{mark}</span>;
}

export function Chevron({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width="16"
      height="16"
      className={`chevron ${className}`}
    >
      <path
        d="M6 3.5 10.5 8 6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The label of an expandable section. `className` sets its padding and text size. */
export function DisclosureSummary({
  className,
  children,
}: {
  className: string;
  children: React.ReactNode;
}) {
  return (
    <summary
      className={`text-act hover:bg-act-soft -ml-1 inline-flex items-center gap-1 rounded-[3px] pr-2 pl-0.5 font-medium ${className}`}
    >
      <Chevron />
      {children}
    </summary>
  );
}

export function MissingPrices({ tickers }: { tickers: string[] }) {
  if (tickers.length === 0) return null;
  return (
    <p className="notice bg-warn-soft text-warn">
      No price yet for {tickers.join(", ")}, so{" "}
      {tickers.length === 1 ? "it is" : "they are"} left out of the totals until
      the next run.
    </p>
  );
}

/** The whole portfolio on one line. Every figure here is computed in code. */
export function QuoteWarning({ facts }: { facts: PortfolioFacts }) {
  const dates = facts.quote_dates;
  const tickers = [
    ...new Set([
      ...(dates?.stale ?? []),
      ...(dates && dates.oldest !== dates.newest
        ? facts.positions
            .filter((p) => p.ticker !== "CASH" && p.quote_date !== dates.newest)
            .map((p) => p.ticker)
        : []),
    ]),
  ];
  const leftOut = facts.day_change_left_out ?? [];
  if (!tickers.length && !leftOut.length) return null;
  return (
    <p className="text-warn text-xs">
      {tickers.length > 0 && (
        <>
          Prices for {tickers.join(", ")} are from earlier sessions. They are
          still included in the portfolio value.
        </>
      )}
      {leftOut.length > 0 && (
        <>
          {tickers.length > 0 && " "}The day&apos;s total leaves out{" "}
          {leftOut.join(", ")}.
        </>
      )}
    </p>
  );
}

export function PortfolioSummary({ facts }: { facts: PortfolioFacts }) {
  const gain = gainLabel(
    facts.positions_with_cost_basis,
    facts.positions.filter((p) => p.ticker !== "CASH").length,
  );
  return (
    <dl className="flex flex-wrap items-end gap-x-6 gap-y-2">
      <div className="basis-full sm:basis-auto">
        <dt className="text-muted text-xs">Portfolio value</dt>
        <dd className="text-2xl leading-tight font-semibold tracking-tight">
          {usd(facts.total_value, 0)}
        </dd>
      </div>
      <div>
        <dt className="text-muted text-xs">
          {dayMoveLabel(facts.quote_dates)}
        </dt>
        <dd className={`font-medium ${moveColor(facts.day_change_pct)}`}>
          {signedUsd(facts.day_change_value)} ({signedPct(facts.day_change_pct)}
          )
        </dd>
      </div>
      {gain && (
        <div>
          <dt className="text-muted text-xs">{gain}</dt>
          <dd
            className={`font-medium ${moveColor(facts.unrealized_gain_where_known)}`}
          >
            {signedUsd(facts.unrealized_gain_where_known)}
          </dd>
        </div>
      )}
      <div>
        <dt className="text-muted text-xs">Cash</dt>
        <dd className="font-medium">{pct(facts.cash_pct)}</dd>
      </div>
      <div>
        <dt className="text-muted text-xs">Top 5 holdings</dt>
        <dd className="font-medium">{pct(facts.top5_concentration_pct)}</dd>
      </div>
    </dl>
  );
}
