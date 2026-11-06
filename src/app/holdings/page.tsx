import Link from "next/link";
import type { Metadata } from "next";

import {
  MissingPrices,
  PortfolioSummary,
  QuoteWarning,
} from "~/app/_components/badges";
import { checkRejected, dayColumnLabel, pct } from "~/app/_components/format";
import {
  HoldingsTable,
  type HoldingRow,
} from "~/app/_components/holdings-table";
import {
  briefAndQueue,
  portfolioFacts,
  proofChecks,
  reviews,
} from "~/app/_components/page-data";
import { readThesis } from "~/server/dossier";
import { verifiedScore } from "~/server/research/run";
import { listedActions, secondOpinion } from "~/server/updates";

export const metadata: Metadata = { title: "Holdings" };

export default async function HoldingsPage() {
  const [facts, updates, { queue, runId }] = await Promise.all([
    portfolioFacts(),
    reviews(),
    briefAndQueue(),
  ]);
  const actions = listedActions(queue, updates, runId);

  const rows: HoldingRow[] = facts.positions.map((p) => {
    const update = updates.get(p.ticker);
    return {
      ticker: p.ticker,
      name: p.name,
      isCash: p.ticker === "CASH",
      weight: p.weight_pct,
      price: p.price,
      value: p.value,
      dayPct: p.day_change_pct,
      quoteOn: p.quote_date,
      action: actions.get(p.ticker) ?? null,
      status: update?.result.status ?? null,
      // Only the verdicts go to the browser. The table has no use for the claims themselves.
      checks:
        (update
          ? proofChecks(update)?.map((c) => ({ verdict: c.verdict }))
          : null) ?? null,
      verifiedScore: update
        ? verifiedScore(update.verification, update.result.evidence)
        : null,
      opinion: update ? secondOpinion(update) : null,
      rejected: update ? checkRejected(update) : false,
      secondAction: update?.verification?.independent_action ?? null,
      headline: update?.result.headline ?? null,
      reviewedOn: update
        ? new Date(update.createdAt).toLocaleDateString("en-CA")
        : null,
      hasThesis: !!readThesis(p.ticker),
    };
  });

  const sectors = facts.sector_weights.filter((s) => s.weight_pct > 0);
  const largest = Math.max(...sectors.map((s) => s.weight_pct), 1);

  return (
    <div className="space-y-6">
      <header className="border-line flex flex-wrap items-end justify-between gap-x-10 gap-y-4 border-b pb-5">
        <div>
          <h1 className="text-2xl leading-tight font-semibold tracking-tight">
            Holdings
          </h1>
          <Link href="/import" className="btn btn-small mt-2">
            Update holdings
          </Link>
        </div>
        {rows.length > 0 && <PortfolioSummary facts={facts} />}
      </header>

      {rows.length === 0 ? (
        <section className="sheet p-5">
          <h2 className="font-semibold">No holdings yet</h2>
          <p className="text-muted mt-1 text-sm">
            Upload a Schwab export or screenshots, or type them in.
          </p>
          <Link href="/import" className="btn btn-primary mt-3">
            Add holdings
          </Link>
        </section>
      ) : (
        <>
          <HoldingsTable
            rows={rows}
            dayLabel={dayColumnLabel(facts.quote_dates)}
            dayDate={facts.quote_dates.newest}
          />
          <QuoteWarning facts={facts} />

          <MissingPrices tickers={facts.missing_prices} />

          {sectors.length > 0 && (
            <section aria-labelledby="sectors-title">
              <h2 id="sectors-title" className="text-lg font-semibold">
                Sector weights
              </h2>
              <p className="text-muted text-sm">
                Share of the portfolio by sector, looking through funds to what
                they own.
              </p>
              <ul className="mt-3 grid gap-x-10 gap-y-1.5 md:grid-cols-2">
                {sectors.map((s) => (
                  <li
                    key={s.sector}
                    className="grid grid-cols-[minmax(0,10rem)_1fr_3rem] items-center gap-3 text-sm"
                  >
                    <span className="truncate" title={s.sector}>
                      {s.sector}
                    </span>
                    <span aria-hidden className="block">
                      <span
                        className="bg-act block h-1.5 rounded-r-full"
                        style={{
                          width: `${(s.weight_pct / largest) * 100}%`,
                        }}
                      />
                    </span>
                    <span className="text-right font-medium">
                      {pct(s.weight_pct)}
                    </span>
                  </li>
                ))}
              </ul>
              {facts.funds_no_breakdown.length > 0 && (
                <p className="text-muted mt-2 text-sm">
                  Funds, no breakdown:{" "}
                  {facts.funds_no_breakdown
                    .map((fund) => `${fund.ticker} ${pct(fund.weight_pct, 2)}`)
                    .join(", ")}
                  .
                </p>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
