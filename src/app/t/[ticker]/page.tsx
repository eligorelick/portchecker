import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import ReactMarkdown from "react-markdown";

import {
  ActionBadge,
  AgreeBadge,
  Chevron,
  DisclosureSummary,
  ProofStrip,
  StatusBadge,
  statusLabel,
  words,
} from "~/app/_components/badges";
import {
  checkRejected,
  cappedLabel,
  currentViewForReader,
  dataNoteForReader,
  dayMoveWhen,
  dayWithYear,
  dateTime,
  daysBetween,
  diffLines,
  holdingsChangedNote,
  inDays,
  INSIDER_FILINGS_SHOWN,
  MODEL_TEXT_BLOCKED,
  moveColor,
  NOTE_BLOCKED,
  packDates,
  pct,
  plainWords,
  REVIEW_HISTORY_SHOWN,
  shares,
  shortDate,
  signedPct,
  signedUsd,
  usd,
} from "~/app/_components/format";
import {
  briefAndQueue,
  portfolioFacts,
  proofChecks,
  tickerNumbers,
} from "~/app/_components/page-data";
import { ReasoningChain } from "~/app/_components/reasoning-chain";
import {
  AskBox,
  DecisionForm,
  DossierEditor,
  ThesisDrafter,
} from "~/app/_components/ticker-tools";
import { db } from "~/server/db";
import { decisions, filings, holdings, tickers } from "~/server/db/schema";
import {
  dossierHash,
  dossierSection,
  readDossier,
  thesisText,
} from "~/server/dossier";
import { filingsToList, filingSummary, savedSections } from "~/server/edgar";
import { today } from "~/server/fmp";
import { dataWarnings, readPack } from "~/server/research/pack";
import { TEMPLATE_HINTS } from "~/server/research/prompts";
import { providerLabel } from "~/server/settings";
import {
  currentReview,
  filingLinks,
  secondOpinion,
  reviewBasisNotice,
  reviewNewerThanBrief,
  tickerHistory,
} from "~/server/updates";

const NO_LINKS: Record<string, string> = {};

function NoteSection({
  title,
  body,
  byModel = false,
}: {
  title: string;
  body: string | null;
  byModel?: boolean;
}) {
  const text = body && !TEMPLATE_HINTS.has(body) ? body : null;
  return (
    <section>
      <h3 className="font-semibold">{title}</h3>
      {text ? (
        <div
          className={`prose-dossier mt-1.5 max-w-prose ${byModel ? "model-text" : "text-sm"}`}
        >
          <ReactMarkdown
            disallowedElements={byModel ? MODEL_TEXT_BLOCKED : NOTE_BLOCKED}
            unwrapDisallowed
          >
            {byModel ? plainWords(currentViewForReader(text)) : text}
          </ReactMarkdown>
        </div>
      ) : (
        <p className="text-muted mt-1 text-sm">Nothing here yet.</p>
      )}
    </section>
  );
}

const TABS = [
  { id: "reasoning", label: "Reasoning", short: "Reasoning" },
  { id: "notes", label: "Thesis and notes", short: "Thesis" },
  { id: "data", label: "Numbers and filings", short: "Numbers" },
  { id: "history", label: "History", short: "History" },
] as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ ticker: string }>;
}): Promise<Metadata> {
  return { title: decodeURIComponent((await params).ticker).toUpperCase() };
}

function FilingDiff({ diff }: { diff: string }) {
  return (
    <div className="bg-paper border-line mt-1 max-h-96 space-y-1 overflow-auto rounded-[3px] border p-2 text-xs break-words whitespace-pre-wrap">
      {diffLines(diff).map((line, i) =>
        line.kind === "head" ? (
          <h4 key={i} className="font-semibold">
            {line.text}
          </h4>
        ) : line.kind === "subhead" ? (
          <h5 key={i} className="font-medium">
            {line.text}
          </h5>
        ) : (
          <p key={i}>{line.text}</p>
        ),
      )}
    </div>
  );
}

export default async function TickerPage({
  params,
  searchParams,
}: {
  params: Promise<{ ticker: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const ticker = decodeURIComponent((await params).ticker).toUpperCase();
  const requestedTab = (await searchParams).tab;
  const tab = TABS.some((t) => t.id === requestedTab)
    ? requestedTab
    : "reasoning";
  // Each of these is only read on some tabs, and filing rows can hold megabytes of section text.
  const needsLinks = tab === "reasoning" || tab === "history";
  const needsFilings = tab === "data";

  const [
    history,
    links,
    facts,
    filingRows,
    decisionRows,
    holdingRows,
    { queue, runId },
    tickerRows,
  ] = await Promise.all([
    tickerHistory(ticker, REVIEW_HISTORY_SHOWN),
    needsLinks ? filingLinks() : NO_LINKS,
    portfolioFacts(),
    needsFilings
      ? db
          .select()
          .from(filings)
          .where(eq(filings.ticker, ticker))
          .orderBy(desc(filings.filedAt))
      : [],
    db
      .select()
      .from(decisions)
      .where(eq(decisions.ticker, ticker))
      .orderBy(desc(decisions.date), desc(decisions.id)),
    db.select().from(holdings).where(eq(holdings.ticker, ticker)),
    briefAndQueue(),
    db
      .select({ lastFullReviewAt: tickers.lastFullReviewAt })
      .from(tickers)
      .where(eq(tickers.ticker, ticker)),
  ]);

  const reportFilings = filingsToList(filingRows.filter((f) => f.form !== "4"));
  const allInsiderFilings = filingRows.filter((f) => f.form === "4");
  const insiderFilings = allInsiderFilings.slice(0, INSIDER_FILINGS_SHOWN);
  const dossier = readDossier(ticker);
  if (!dossier && !history.length && !holdingRows.length) notFound();

  const position = facts.positions.find((p) => p.ticker === ticker);
  const latest = currentReview(history);
  const holdingsNote = latest
    ? holdingsChangedNote(
        "review",
        facts.holdings_latest_updated_at,
        latest.createdAt,
      )
    : null;
  const pack = needsFilings ? readPack(ticker) : null;
  const numberGroups = pack ? tickerNumbers(pack) : [];
  const extraPack = pack as typeof pack & {
    data_notes?: string[];
  };
  const warnings = dataWarnings(extraPack?.data_notes).map(dataNoteForReader);
  const price = pack?.price_summary;
  const thesis = dossier ? thesisText(dossier) : null;
  const basisNotice = latest
    ? reviewBasisNotice(
        thesis,
        latest.thesisAtReview,
        tickerRows[0]?.lastFullReviewAt,
      )
    : null;
  const earnings = facts.upcoming_earnings.find((e) => e.ticker === ticker);

  // Step through holdings in the same order as the sidebar, which a phone does not show.
  const walk = facts.positions.filter((p) => p.ticker !== "CASH");
  const place = walk.findIndex((p) => p.ticker === ticker);
  const previous = place > 0 ? walk[place - 1]?.ticker : undefined;
  const next = place >= 0 ? walk[place + 1]?.ticker : undefined;

  const opinion = latest ? secondOpinion(latest) : null;
  const rejected = latest ? checkRejected(latest) : false;
  // The brief can differ from the analyst, often asking for a review when the two passes disagree.
  const briefAction = queue.find((item) => item.ticker === ticker)?.action;
  const newerThanBrief = latest ? reviewNewerThanBrief(latest, runId) : false;
  const briefDiffers =
    !newerThanBrief &&
    !!latest &&
    !!briefAction &&
    briefAction !== latest.result.action;
  const timeline = [
    ...decisionRows.map((d) => ({
      key: `d${d.id}`,
      sortDate: d.date,
      decision: d,
      review: null,
      holdingsNote: null,
    })),
    ...history.map((u) => ({
      key: `r${u.id}`,
      sortDate: new Date(u.createdAt).toLocaleDateString("en-CA"),
      decision: null,
      review: u,
      holdingsNote: holdingsChangedNote(
        "review",
        facts.holdings_latest_updated_at,
        u.createdAt,
      ),
    })),
  ].sort((a, b) => b.sortDate.localeCompare(a.sortDate));

  return (
    <div className="space-y-5">
      <div className="text-muted flex items-center justify-between gap-4 text-sm">
        <Link href="/holdings" className="hover:text-ink">
          ‹ All holdings
        </Link>
        <span className="flex gap-4">
          {previous && (
            <Link href={`/t/${previous}?tab=${tab}`} className="hover:text-ink">
              ‹ {previous}
            </Link>
          )}
          {next && (
            <Link href={`/t/${next}?tab=${tab}`} className="hover:text-ink">
              {next} ›
            </Link>
          )}
        </span>
      </div>

      <header>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">{ticker}</h1>
          <span className="text-muted">{position?.name}</span>
        </div>
        {position && (
          <p className="text-muted mt-1 text-sm">
            {position.price === null ? (
              "No price yet"
            ) : (
              <>
                {pct(position.weight_pct)} of the portfolio,{" "}
                {usd(position.price)}
                {position.day_change_pct !== null && (
                  <>
                    ,{" "}
                    <span className={moveColor(position.day_change_pct)}>
                      {signedPct(position.day_change_pct)}
                    </span>{" "}
                    {dayMoveWhen(position.quote_date)}
                  </>
                )}
              </>
            )}
          </p>
        )}
      </header>

      {!holdingRows.length && (
        <p className="notice bg-warn-soft text-warn">
          Historical research: {ticker} is not in your current holdings. Saved
          reviews and notes remain available here.
        </p>
      )}

      {/* The answer first. Everything below this explains it. */}
      {latest ? (
        <section aria-label="Current call" className="sheet p-4 sm:p-5">
          {newerThanBrief && briefAction && (
            <p className="text-warn mb-2 text-xs">
              The earlier brief said {words(briefAction)}. Newer research
              exists, and the call below comes from it.
            </p>
          )}
          <dl className="flex flex-wrap items-end gap-x-10 gap-y-3">
            <div>
              <dt className="text-muted text-xs">
                {briefDiffers ? "Latest brief" : "Suggestion"}
              </dt>
              <dd className="text-3xl leading-tight font-semibold tracking-tight">
                {words(briefDiffers ? briefAction : latest.result.action)}
              </dd>
            </div>
            {briefDiffers && (
              <div>
                <dt className="text-muted text-xs">Analyst</dt>
                <dd className="text-lg font-medium">
                  {words(latest.result.action)}
                </dd>
              </div>
            )}
            {latest.verification && (
              <div>
                <dt className="text-muted text-xs">Second check</dt>
                <dd className="text-lg font-medium">
                  {words(latest.verification.independent_action)}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-muted text-xs">Research status</dt>
              <dd className="text-lg font-medium">
                {statusLabel(latest.result.status)}
              </dd>
            </div>
            {(opinion || rejected) && (
              <div className="pb-1">
                <AgreeBadge opinion={opinion} rejected={rejected} />
              </div>
            )}
          </dl>
          <p className="model-text mt-3 max-w-prose text-xl leading-snug">
            {plainWords(latest.result.headline)}
          </p>
          <div className="mt-4">
            <ProofStrip checks={proofChecks(latest)} size="large" />
          </div>
          <a
            href="#log-decision"
            className="btn btn-small mt-3 w-full sm:w-auto xl:hidden"
          >
            Log a decision
          </a>
          <p className="text-muted mt-2 text-xs">
            {latest.depth === "FULL" ? "Full" : "Light"} review,{" "}
            {dateTime(latest.createdAt)}
            {latest.recheckedAt &&
              `. Nothing new as of ${dateTime(latest.recheckedAt)}`}
          </p>
          {holdingsNote && (
            <p className="notice bg-warn-soft text-warn mt-3 text-sm">
              {holdingsNote}
            </p>
          )}
        </section>
      ) : (
        <section className="sheet p-5">
          <h2 className="font-semibold">No review yet</h2>
          <p className="text-muted mt-1 text-sm">
            Press Run research to get the first review of {ticker}.
          </p>
        </section>
      )}

      <div className="grid gap-x-8 gap-y-6 xl:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0">
          <nav aria-label={`${ticker} sections`} className="tabs">
            {TABS.map((t) => (
              <Link
                key={t.id}
                href={`/t/${ticker}?tab=${t.id}`}
                scroll={false}
                aria-current={tab === t.id ? "page" : undefined}
                className="tab"
              >
                <span className="sm:hidden">{t.short}</span>
                <span className="hidden sm:inline">{t.label}</span>{" "}
                {t.id === "notes" && !thesis && (
                  <span className="text-warn ml-1.5 hidden text-xs font-medium sm:inline">
                    No thesis
                  </span>
                )}
              </Link>
            ))}
          </nav>

          <div className="pt-5">
            {tab === "reasoning" && (
              <div className="space-y-8">
                {latest ? (
                  <ReasoningChain
                    update={latest}
                    thesis={thesis}
                    lastFullReviewAt={tickerRows[0]?.lastFullReviewAt}
                    links={links}
                  />
                ) : (
                  <p className="text-muted text-sm">
                    The reasoning appears here after the first review.
                  </p>
                )}
                <section className="border-line border-t pt-5">
                  <h2 className="font-semibold">Ask about this holding</h2>
                  <p className="text-muted mt-0.5 mb-2 text-sm">
                    One question, answered from the same research files by your
                    selected AI.
                  </p>
                  <AskBox ticker={ticker} />
                </section>
              </div>
            )}

            {tab === "notes" && (
              <div className="space-y-6">
                {!dossier && (
                  <p className="text-muted text-sm">
                    The research file is created on the first run.
                  </p>
                )}
                {dossier && !thesis && (
                  <section className="border-warn bg-warn-soft rounded-[5px] border p-4">
                    <h3 className="font-semibold">Why do you own {ticker}?</h3>
                    <p className="mt-1 mb-3 max-w-prose text-sm">
                      Reviews work best when they can test your reasons. Until
                      then they judge the evidence alone. A draft is a starting
                      point you can change.
                    </p>
                    <ThesisDrafter ticker={ticker} />
                  </section>
                )}
                {dossier && (
                  <>
                    {thesis && <NoteSection title="My thesis" body={thesis} />}
                    {basisNotice && (
                      <p className="text-warn text-xs">{basisNotice}</p>
                    )}
                    <NoteSection
                      title="What would break the thesis"
                      body={dossierSection(
                        dossier,
                        "What would break the thesis",
                      )}
                    />
                    <NoteSection
                      title="Key numbers to watch"
                      body={dossierSection(dossier, "Key numbers to watch")}
                    />
                    <NoteSection
                      title="Current view, kept up to date by the model"
                      body={dossierSection(dossier, "Current view")}
                      byModel
                    />
                    <NoteSection
                      title="Watch items"
                      body={dossierSection(dossier, "Watch items")}
                    />
                    <DossierEditor
                      ticker={ticker}
                      markdown={dossier}
                      hash={dossierHash(dossier)}
                    />
                  </>
                )}
              </div>
            )}

            {tab === "data" && (
              <div className="space-y-8">
                {pack && packDates(pack) && (
                  <p className="text-muted text-xs">{packDates(pack)}</p>
                )}
                {numberGroups.length > 0 ? (
                  <section className="space-y-5">
                    {numberGroups.map((group) => (
                      <div key={group.title}>
                        <h2 className="text-sm font-semibold">{group.title}</h2>
                        <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
                          {group.rows.map(([label, value]) => (
                            <div key={label}>
                              <dt className="text-muted text-xs">{label}</dt>
                              <dd className="font-medium">{value}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    ))}
                  </section>
                ) : (
                  <p className="text-muted text-sm">
                    Numbers appear after the first research run.
                  </p>
                )}

                {typeof price?.total_return_1y_pct === "number" && (
                  <p className="text-muted text-xs">
                    Total return adds cash dividends by ex-date, without
                    reinvesting them.
                  </p>
                )}
                {numberGroups.some((g) =>
                  g.rows.some(([label]) => label.startsWith("Forward P/E")),
                ) && (
                  <p className="text-muted text-xs">
                    Forward P/E uses analyst estimates, usually adjusted, while
                    trailing and median P/E use reported earnings, so a forward
                    figure far below them may not mean cheap.
                  </p>
                )}
                {warnings.length > 0 && (
                  <ul className="text-warn list-disc space-y-1 pl-4 text-xs">
                    {warnings.map((note, i) => (
                      <li key={i}>{note}</li>
                    ))}
                  </ul>
                )}
                <section>
                  <h2 className="font-semibold">SEC filings</h2>
                  {reportFilings.length === 0 ? (
                    <p className="text-muted mt-1 text-sm">
                      No filings tracked. Most funds are not in the SEC company
                      list this app uses.
                    </p>
                  ) : (
                    <ul className="divide-line border-line mt-2 divide-y border-y text-sm">
                      {reportFilings.map((f) => {
                        const sections = savedSections(f);
                        return (
                          <li key={f.accessionNo} className="py-2">
                            <div className="grid grid-cols-[3rem_5.75rem_minmax(0,1fr)_auto] items-baseline gap-x-2 sm:grid-cols-[4rem_5.75rem_minmax(0,1fr)_auto] sm:gap-x-3">
                              <span className="font-medium">{f.form}</span>
                              <span className="text-muted">
                                {dayWithYear(f.filedAt)}
                              </span>
                              <span className="min-w-0">
                                {filingSummary(f.form, f.items)}
                              </span>
                              <a
                                href={f.primaryDocUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-link whitespace-nowrap"
                              >
                                Open
                                <span className="sr-only">
                                  {" "}
                                  {f.form} from {f.filedAt} on EDGAR
                                </span>
                              </a>
                            </div>
                            {sections?.diff && (
                              <details className="mt-1">
                                <DisclosureSummary className="py-0.5 text-xs">
                                  What changed since the previous {f.form}
                                </DisclosureSummary>
                                <FilingDiff diff={sections.diff} />
                              </details>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {insiderFilings.length > 0 && (
                    <details className="mt-3 text-sm">
                      <DisclosureSummary className="py-1">
                        Insider filings, Form 4 (
                        {cappedLabel(
                          allInsiderFilings.length,
                          INSIDER_FILINGS_SHOWN,
                        )}
                        )
                      </DisclosureSummary>
                      <ul className="mt-1 space-y-1">
                        {insiderFilings.map((f) => (
                          <li key={f.accessionNo} className="flex gap-4">
                            <span className="text-muted w-24 shrink-0">
                              {dayWithYear(f.filedAt)}
                            </span>
                            <a
                              href={f.primaryDocUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-link"
                            >
                              Open on EDGAR
                            </a>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </section>
              </div>
            )}

            {tab === "history" &&
              (timeline.length === 0 ? (
                <p className="text-muted text-sm">
                  Reviews and the decisions you log appear here.
                </p>
              ) : (
                <>
                  <p className="text-muted mb-2 text-xs">
                    Reviews: {cappedLabel(history.length, REVIEW_HISTORY_SHOWN)}
                  </p>
                  <ul className="divide-line border-line divide-y border-y">
                    {timeline.map((entry) =>
                      entry.decision ? (
                        <li
                          key={entry.key}
                          className="bg-act-soft/50 flex flex-wrap items-baseline gap-x-3 px-2 py-2 text-sm"
                        >
                          <span className="w-28 shrink-0">
                            {dayWithYear(entry.decision.date)}
                          </span>
                          <strong className="font-semibold">
                            I logged: {entry.decision.actionTaken}
                          </strong>
                          {entry.decision.note && (
                            <span className="text-muted">
                              {entry.decision.note}
                            </span>
                          )}
                        </li>
                      ) : (
                        <li key={entry.key}>
                          <details>
                            <summary className="hover:bg-paper flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2 text-sm">
                              <span className="flex w-28 shrink-0 items-center gap-0.5">
                                <Chevron className="-ml-1" />
                                {dayWithYear(entry.sortDate)}
                              </span>
                              <ActionBadge
                                action={entry.review.result.action}
                              />
                              <StatusBadge
                                status={entry.review.result.status}
                              />
                              <AgreeBadge
                                opinion={secondOpinion(entry.review)}
                                rejected={checkRejected(entry.review)}
                              />
                              <ProofStrip checks={proofChecks(entry.review)} />
                              <span className="text-muted text-xs">
                                {words(entry.review.depth.toLowerCase())} review
                                by {providerLabel(entry.review.analystProvider)}
                                {entry.review.verifierProvider &&
                                  `, checked by ${providerLabel(entry.review.verifierProvider)}`}
                              </span>
                            </summary>
                            <div className="px-2 pt-2 pb-5">
                              {entry.holdingsNote && (
                                <p className="notice bg-warn-soft text-warn mb-3 text-sm">
                                  {entry.holdingsNote}
                                </p>
                              )}
                              <ReasoningChain
                                update={entry.review}
                                links={links}
                              />
                            </div>
                          </details>
                        </li>
                      ),
                    )}
                  </ul>
                </>
              ))}
          </div>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
          {position && (
            <section className="sheet p-4">
              <h2 className="text-sm font-semibold">My position</h2>
              <dl className="mt-2 space-y-1.5 text-sm">
                {(
                  [
                    ["Shares", shares(position.quantity)],
                    ["Value", usd(position.value)],
                    position.cost_basis !== null && [
                      "Cost basis",
                      usd(position.cost_basis),
                    ],
                    earnings && [
                      "Next earnings",
                      `${shortDate(earnings.date)}, ${inDays(daysBetween(today(), earnings.date))}`,
                    ],
                  ] as const
                )
                  .filter((row) => !!row)
                  .map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-3">
                      <dt className="text-muted">{label}</dt>
                      <dd className="text-right font-medium">{value}</dd>
                    </div>
                  ))}
                {position.unrealized_gain !== null && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">Gain or loss</dt>
                    <dd
                      className={`text-right font-medium ${moveColor(position.unrealized_gain)}`}
                    >
                      {signedUsd(position.unrealized_gain)}
                      {position.unrealized_gain_pct !== null &&
                        ` (${signedPct(position.unrealized_gain_pct)})`}
                    </dd>
                  </div>
                )}
              </dl>
            </section>
          )}
          <section id="log-decision" className="sheet scroll-mt-4 p-4">
            <h2 className="text-sm font-semibold">Log a decision</h2>
            <p className="text-muted mt-0.5 mb-3 text-xs">
              {decisionRows[0]
                ? `Last: ${decisionRows[0].actionTaken}, ${dayWithYear(decisionRows[0].date)}`
                : "Portchecker never trades. Record what you did so future you can see why."}
            </p>
            <DecisionForm ticker={ticker} />
          </section>
        </aside>
      </div>
    </div>
  );
}
