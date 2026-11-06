import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";

import {
  ActionBadge,
  AgreeBadge,
  Chevron,
  MissingPrices,
  PortfolioSummary,
  QuoteWarning,
  ProofStrip,
  words,
} from "~/app/_components/badges";
import {
  dateTime,
  checkRejected,
  daysBetween,
  holdingsChangedNote,
  holdingsUpdatedLabel,
  inDays,
  longDate,
  shortDate,
} from "~/app/_components/format";
import {
  briefAndQueue,
  portfolioFacts,
  proofChecks,
  reviews,
} from "~/app/_components/page-data";
import { ReasoningChain } from "~/app/_components/reasoning-chain";
import { DecisionForm } from "~/app/_components/ticker-tools";
import { db } from "~/server/db";
import { tickerUpdates } from "~/server/db/schema";
import { readThesis } from "~/server/dossier";
import { today } from "~/server/fmp";
import { positionSizeLine, queueAction, stillFailed } from "~/server/queue";
import { plainWords } from "~/server/research/prompts";
import { providerLabel } from "~/server/settings";
import {
  filingLinks,
  heldQueue,
  openCalls,
  secondOpinion,
  reviewNewerThanBrief,
  type UpdateView,
} from "~/server/updates";

export const metadata: Metadata = {
  title: { absolute: "Today · Portchecker" },
};

function GettingStarted({ hasHoldings }: { hasHoldings: boolean }) {
  const steps = [
    {
      title: "Add your holdings",
      detail: "Upload a Schwab export or screenshots, or type them in.",
      href: "/import",
      action: "Add holdings",
      done: hasHoldings,
    },
    {
      title: "Choose your AI",
      detail:
        "ChatGPT is on by default. Sign in with codex login, or add a Claude key.",
      href: "/settings",
      action: "Open settings",
      done: false,
    },
    {
      title: "Run research",
      detail:
        "Press Run research. The first run is the slowest, since every holding gets a full review.",
      done: false,
    },
  ];
  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Set up your first brief
        </h1>
        <p className="text-muted mt-1">
          Three steps to your first brief. For a new one each day, schedule
          <code> pnpm research </code> as the README shows.
        </p>
      </div>
      <ol className="sheet divide-line divide-y">
        {steps.map((step, i) => (
          <li key={step.title} className="flex items-start gap-3 p-4">
            <span
              aria-hidden
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                step.done ? "bg-ok text-white" : "bg-act-soft text-act"
              }`}
            >
              {step.done ? "✓" : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="font-medium">
                {step.title}
                {step.done && <span className="sr-only"> (done)</span>}
              </h2>
              <p className="text-muted mt-0.5 text-sm">{step.detail}</p>
            </div>
            {step.href && !step.done && (
              <Link href={step.href} className="btn btn-small">
                {step.action}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Reviews are saved one by one, so a run with no brief must not look like a fresh install. */
function NoBriefYet({ reviewed }: { reviewed: UpdateView[] }) {
  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">No brief yet</h1>
        <p className="text-muted mt-1">
          {reviewed.length}{" "}
          {reviewed.length === 1 ? "holding has" : "holdings have"} a saved
          review, but no run has written a brief. Press Run research for one
          that covers every holding.
        </p>
      </div>
      <ul className="sheet divide-line divide-y">
        {reviewed.map((update) => (
          <li key={update.ticker} className="p-3">
            <Link
              href={`/t/${update.ticker}`}
              className="text-link font-semibold"
            >
              {update.ticker}
            </Link>{" "}
            <ActionBadge action={update.result.action} />{" "}
            <AgreeBadge
              opinion={secondOpinion(update)}
              rejected={checkRejected(update)}
            />{" "}
            {secondOpinion(update) && secondOpinion(update) !== "agree" && (
              <span className="text-bad text-xs">
                Second check: {words(update.verification!.independent_action)}
              </span>
            )}{" "}
            <ProofStrip checks={proofChecks(update)} />{" "}
            <span className="model-text">
              {plainWords(update.result.headline)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default async function TodayPage() {
  const [
    facts,
    updates,
    links,
    { brief, queue: briefQueue, provider, runId, briefReadyAt, decisions },
  ] = await Promise.all([
    portfolioFacts(),
    reviews(),
    filingLinks(),
    briefAndQueue(),
  ]);
  const hasHoldings = facts.positions.length > 0;
  const stocks = facts.positions.filter((p) => p.ticker !== "CASH");
  const held = new Set(stocks.map((p) => p.ticker));
  const reviewed = [...updates.values()].filter((update) =>
    held.has(update.ticker),
  );
  const { queue, openCount } = heldQueue(briefQueue, held);
  if (hasHoldings && !brief && reviewed.length > 0) {
    return <NoBriefYet reviewed={reviewed} />;
  }
  if (!brief || !hasHoldings) {
    return <GettingStarted hasHoldings={hasHoldings} />;
  }

  const now = today();
  const holdingsDate = facts.holdings_updated_at
    ? new Date(facts.holdings_updated_at).toLocaleDateString("en-CA")
    : null;
  const holdingsLabel = holdingsUpdatedLabel(
    facts.holdings_updated_at,
    facts.holdings_latest_updated_at,
  );
  const holdingsNote = holdingsChangedNote(
    "brief",
    facts.holdings_latest_updated_at,
    briefReadyAt,
    brief.date,
  );
  const failed = stillFailed(brief.failed ?? [], updates, briefReadyAt);
  const daysOld = daysBetween(brief.date, now);
  const soonEarnings = facts.upcoming_earnings.filter((e) => {
    const days = daysBetween(now, e.date);
    return days >= 0 && days <= 14;
  });
  const covered = new Set(
    runId === null
      ? []
      : (
          await db
            .select({ ticker: tickerUpdates.ticker })
            .from(tickerUpdates)
            .where(eq(tickerUpdates.runId, runId))
        ).map((row) => row.ticker),
  );
  const reviewedCount = stocks.filter((p) => covered.has(p.ticker)).length;
  const allReviewed = stocks.length > 0 && reviewedCount === stocks.length;
  const missingThesis = stocks.filter((p) => !readThesis(p.ticker));
  const newer = openCalls(briefQueue, updates, decisions, held);

  return (
    <div className="space-y-6">
      <header className="border-line flex flex-wrap items-end justify-between gap-x-10 gap-y-4 border-b pb-5">
        <div>
          <h1 className="text-2xl leading-tight font-semibold tracking-tight">
            {longDate(brief.date)}
          </h1>
          <p className="text-muted mt-1 text-sm">
            {daysOld > 0
              ? `This brief is ${daysOld} ${daysOld === 1 ? "day" : "days"} old. Press Run research for a new one.`
              : `Daily brief by ${providerLabel(provider)}${brief.used_fallback ? ", after a fallback" : ""}`}
          </p>
        </div>
        <PortfolioSummary facts={facts} />
      </header>

      <p className="text-muted text-xs">
        Brief {shortDate(brief.date)} · Reviewed {reviewedCount} of{" "}
        {stocks.length} current holdings · Quotes{" "}
        {facts.quote_dates?.newest
          ? shortDate(facts.quote_dates.newest)
          : "date unavailable"}
        {holdingsDate && (
          <span
            className={daysBetween(holdingsDate, now) > 30 ? "text-warn" : ""}
          >
            {" "}
            · {holdingsLabel}
          </span>
        )}
      </p>
      <QuoteWarning facts={facts} />
      {brief.local_correction && (
        <div className="notice bg-act-soft text-sm">
          <p className="font-semibold">Local correction</p>
          <p>{brief.local_correction.notes.join(" ")}</p>
          <p className="text-muted mt-1 text-xs">
            The original model checks are retained; these amendments were not
            reviewed by another model.
          </p>
        </div>
      )}
      {holdingsNote && (
        <p className="notice bg-warn-soft text-warn text-sm">{holdingsNote}</p>
      )}
      {!!brief.untraced_figures?.length && (
        <p className="notice bg-warn-soft text-warn text-sm">
          Some figures in this brief could not be traced to the research files.
          Check the supporting evidence before acting on them.
        </p>
      )}
      <p className="model-text max-w-[65ch] text-xl leading-normal">
        {plainWords(brief.summary)}
      </p>

      {failed.length > 0 && (
        <div className="notice bg-bad-soft text-bad">
          <h2 className="font-semibold">
            Could not review {failed.length}{" "}
            {failed.length === 1 ? "holding" : "holdings"}
          </h2>
          <ul className="text-ink mt-1 space-y-0.5">
            {failed.map((f) => (
              <li key={f.ticker}>
                <strong>{f.ticker}:</strong> {f.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      <MissingPrices tickers={facts.missing_prices} />

      <div className="grid gap-x-8 gap-y-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <section aria-labelledby="queue-title" className="min-w-0">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="queue-title" className="text-lg font-semibold">
              {newer.length > 0
                ? `${openCount + newer.length} to look at`
                : queue.length === 0
                  ? daysOld > 0
                    ? "Nothing to act on in this brief"
                    : "Nothing needs you today"
                  : openCount === 0
                    ? daysOld > 0
                      ? "All done for this brief"
                      : "All done for today"
                    : `${openCount} to look at`}
            </h2>
            {queue.length > openCount && (
              <span className="text-muted text-sm">
                {queue.length - openCount} of {queue.length} decided
              </span>
            )}
          </div>

          {newer.length > 0 && (
            <div className="notice bg-warn-soft mt-2">
              <p className="font-medium">
                Open calls this brief does not cover
              </p>
              <ul className="mt-1 space-y-1">
                {newer.map((update) => (
                  <li key={update.ticker}>
                    <Link
                      href={`/t/${update.ticker}`}
                      className="text-link font-semibold"
                    >
                      {update.ticker}
                    </Link>{" "}
                    <ActionBadge action={update.result.action} />{" "}
                    <AgreeBadge
                      opinion={secondOpinion(update)}
                      rejected={checkRejected(update)}
                    />{" "}
                    {secondOpinion(update) &&
                      secondOpinion(update) !== "agree" && (
                        <span className="text-bad text-xs">
                          Second check:{" "}
                          {words(update.verification!.independent_action)}
                        </span>
                      )}{" "}
                    <ProofStrip checks={proofChecks(update)} />{" "}
                    <span className="model-text">
                      {plainWords(update.result.headline)}
                    </span>{" "}
                    <span className="text-muted text-xs">
                      {dateTime(update.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {queue.length === 0 && newer.length > 0 ? null : queue.length ===
            0 ? (
            <p className="text-muted mt-1 text-sm">
              {!allReviewed
                ? "None of the holdings that were reviewed needs a change."
                : "Every holding was reviewed and none needs a change."}{" "}
              <Link href="/holdings" className="text-link">
                See all holdings
              </Link>
            </p>
          ) : (
            <ul className="sheet divide-line mt-2 divide-y">
              {queue.map((item) => {
                const update = updates.get(item.ticker);
                const newer = update
                  ? reviewNewerThanBrief(update, runId)
                  : false;
                const thesis = readThesis(item.ticker);
                const action = queueAction(item, update, newer);
                const sizeLine =
                  action && action !== "hold"
                    ? positionSizeLine(item.ticker, facts)
                    : null;
                return (
                  <li key={item.ticker}>
                    <details>
                      <summary
                        className={`hover:bg-act-soft/40 flex gap-2 p-3 ${item.decision ? "bg-paper" : ""}`}
                      >
                        <Chevron className="mt-1" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <strong className="font-semibold">
                              {item.ticker}
                            </strong>
                            {action && <ActionBadge action={action} />}
                            {item.urgency && (
                              <span className="text-muted text-xs">
                                {words(item.urgency)}
                              </span>
                            )}
                            {update && (
                              <span className="flex flex-wrap items-center gap-x-3 sm:ml-auto">
                                <AgreeBadge
                                  opinion={secondOpinion(update)}
                                  rejected={checkRejected(update)}
                                />
                                {secondOpinion(update) &&
                                  secondOpinion(update) !== "agree" && (
                                    <span className="text-bad text-xs">
                                      Second check:{" "}
                                      {words(
                                        update.verification!.independent_action,
                                      )}
                                    </span>
                                  )}
                                <ProofStrip checks={proofChecks(update)} />
                              </span>
                            )}
                          </div>
                          {newer && (
                            <p className="text-warn mt-1 text-xs">
                              The action, reasoning, size and urgency here come
                              from the earlier brief. Newer research suggests{" "}
                              {words(update!.result.action)}.
                            </p>
                          )}
                          <p className="model-text mt-1 max-w-prose">
                            {plainWords(item.why ?? item.reasoning ?? "")}
                          </p>
                          {item.decision && (
                            <p className="text-ok mt-1 text-sm font-medium">
                              ✓ You logged: {item.decision.actionTaken},{" "}
                              {shortDate(item.decision.date)}
                            </p>
                          )}
                        </div>
                      </summary>
                      <div className="border-line space-y-5 border-t border-dashed px-3 py-4 sm:pl-9">
                        {item.why && item.reasoning && (
                          <p className="model-text max-w-prose">
                            {plainWords(item.reasoning)}
                          </p>
                        )}
                        {item.sizeHint && (
                          <p className="text-sm">
                            <span className="text-muted">
                              {newer ? "Earlier brief size: " : "Size: "}
                            </span>
                            <span className="model-text">
                              {plainWords(item.sizeHint)}
                            </span>
                          </p>
                        )}
                        {sizeLine && (
                          <p className="text-muted text-sm">{sizeLine}</p>
                        )}
                        {update ? (
                          <ReasoningChain
                            update={update}
                            thesis={thesis}
                            links={links}
                          />
                        ) : (
                          <p className="text-muted text-sm">
                            No review stored for this ticker.
                          </p>
                        )}
                        <div className="border-line grid gap-4 border-t pt-4 md:grid-cols-[minmax(0,20rem)_1fr]">
                          <div>
                            <h3 className="mb-2 text-sm font-semibold">
                              Log what you did
                            </h3>
                            <DecisionForm ticker={item.ticker} />
                          </div>
                          <p className="text-sm md:justify-self-end">
                            <Link
                              href={`/t/${item.ticker}`}
                              className="text-link"
                            >
                              Open the {item.ticker} page
                            </Link>
                          </p>
                        </div>
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <aside className="space-y-6 text-sm">
          {soonEarnings.length > 0 && (
            <section>
              <h2 className="font-semibold">Earnings in the next 14 days</h2>
              <ul className="mt-1.5 space-y-1">
                {soonEarnings.map((e) => (
                  <li key={e.ticker} className="flex justify-between gap-3">
                    <Link href={`/t/${e.ticker}`} className="text-link">
                      {e.ticker}
                    </Link>
                    <span className="text-muted">
                      {shortDate(e.date)}, {inDays(daysBetween(now, e.date))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {missingThesis[0] && (
            <section>
              <h2 className="font-semibold">Theses to write</h2>
              <p className="text-muted mt-1">
                {missingThesis.length} of {stocks.length} holdings{" "}
                {missingThesis.length === 1 ? "has" : "have"} no thesis, so
                {missingThesis.length === 1
                  ? " its review judges"
                  : " their reviews judge"}{" "}
                the evidence alone.
              </p>
              <Link
                href={`/t/${missingThesis[0].ticker}?tab=notes`}
                className="btn btn-small mt-2"
              >
                Start with {missingThesis[0].ticker}, your largest
              </Link>
            </section>
          )}

          {brief.portfolio_observations.length > 0 && (
            <section>
              <h2 className="font-semibold">About the portfolio</h2>
              <ul className="model-text model-list mt-1.5 text-base">
                {brief.portfolio_observations.map((line, i) => (
                  <li key={i}>{plainWords(line)}</li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
