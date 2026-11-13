import {
  allClearText,
  claimForReader,
  conclusionNote,
  groupEvidence,
  NOTE_BLOCKED,
  plainWords,
  sourceParts,
} from "./format";

import Link from "next/link";
import ReactMarkdown from "react-markdown";

import {
  ActionBadge,
  DisclosureSummary,
  StatusBadge,
  VerdictMark,
  words,
} from "~/app/_components/badges";
import { providerLabel } from "~/server/settings";
import { verifiedScore } from "~/server/research/run";
import {
  evidenceEntries,
  reviewBasisNotice,
  secondOpinion,
  sameProviderFallback,
  verificationSources,
  type EvidenceEntry,
  type UpdateView,
} from "~/server/updates";

function SourceLink({
  source,
  links,
}: {
  source: string;
  links: Record<string, string>;
}) {
  return (
    <span title={source} className="flex flex-wrap gap-x-2">
      {sourceParts(source).map((part, i) => {
        const href =
          (part.accession ? links[part.accession] : undefined) ?? part.url;
        return href && /^https?:\/\//i.test(href) ? (
          <a
            key={i}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-link break-words"
          >
            {part.label}
          </a>
        ) : (
          <span key={i} className="break-words">
            {part.label}
          </span>
        );
      })}
    </span>
  );
}

function Step({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="relative pb-7 pl-5 last:pb-0">
      <span
        aria-hidden
        className="bg-act ring-paper absolute top-[0.4rem] left-[-5px] h-2 w-2 rounded-full ring-2"
      />
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-1.5">{children}</div>
    </li>
  );
}

function EvidenceRow({
  entry,
  links,
}: {
  entry: EvidenceEntry;
  links: Record<string, string>;
}) {
  return (
    <li className="py-2.5">
      <p className="model-text">{claimForReader(entry.claim)}</p>
      <div className="text-muted mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <VerdictMark verdict={entry.check?.verdict ?? null} />
        <SourceLink source={entry.source} links={links} />
        {entry.link_not_in_files && (
          <span className="text-warn">Link not in the research files</span>
        )}
        {entry.date && <span>{entry.date}</span>}
      </div>
      {entry.check?.note && (
        <p className="text-muted mt-1 text-xs">
          Second check: {plainWords(entry.check.note)}
        </p>
      )}
    </li>
  );
}

/** Problems stay on screen. Claims that checked out fold away, since they are read only on demand. */
function Evidence({
  update,
  links,
}: {
  update: UpdateView;
  links: Record<string, string>;
}) {
  const entries = evidenceEntries(update);
  if (entries.length === 0) {
    return <p className="text-muted text-sm">No evidence listed.</p>;
  }
  if (!update.verification) {
    return (
      <ul className="divide-line divide-y">
        {entries.map((entry, i) => (
          <EvidenceRow key={i} entry={entry} links={links} />
        ))}
      </ul>
    );
  }
  const { flagged, clean } = groupEvidence(entries);
  return (
    <>
      {flagged.length === 0 ? (
        <p className="text-ok text-sm">
          {allClearText(verificationSources(update.verification)?.web ?? 0)}
        </p>
      ) : (
        <>
          <p className="text-warn text-sm font-medium">
            {flagged.length} of {entries.length} claims need a look.
          </p>
          <ul className="divide-line divide-y">
            {flagged.map((entry, i) => (
              <EvidenceRow key={i} entry={entry} links={links} />
            ))}
          </ul>
        </>
      )}
      {clean.length > 0 && (
        <details className="mt-2">
          <DisclosureSummary className="py-1 text-sm">
            Show {clean.length} {flagged.length ? "other " : ""}
            {clean.length === 1 ? "claim" : "claims"} and where they came from
          </DisclosureSummary>
          <ul className="divide-line mt-1 divide-y">
            {clean.map((entry, i) => (
              <EvidenceRow key={i} entry={entry} links={links} />
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function ModelList({ lines }: { lines: string[] }) {
  return (
    <ul className="model-text model-list">
      {lines.map((line, i) => (
        <li key={i}>{plainWords(line)}</li>
      ))}
    </ul>
  );
}

export function ReasoningChain({
  update,
  thesis,
  lastFullReviewAt,
  links,
}: {
  update: UpdateView;
  thesis?: string | null;
  lastFullReviewAt?: string | null;
  links: Record<string, string>;
}) {
  const { result, verification } = update;
  const isFund = result.is_fund;
  const opinion = secondOpinion(update);
  const sources = verificationSources(verification);
  const score = verifiedScore(verification, result.evidence);
  const disagree =
    opinion === "disagree" || opinion === "second_pass_disagrees";
  const basisNotice = reviewBasisNotice(
    thesis ?? null,
    update.thesisAtReview,
    lastFullReviewAt,
  );
  const conclusion = verification
    ? conclusionNote(verification.conclusion_supported, disagree)
    : null;

  return (
    <ol className="border-line ml-1 border-l-2 text-sm">
      {result.local_correction && (
        <Step title="Local correction">
          <ModelList lines={result.local_correction.notes} />
          <p className="text-muted mt-1 text-xs">
            The original model checks are retained; these amendments were not
            reviewed by another model.
          </p>
        </Step>
      )}
      {thesis !== undefined && (
        <Step title="My thesis">
          {thesis ? (
            <div className="prose-dossier max-w-prose">
              <ReactMarkdown disallowedElements={NOTE_BLOCKED}>
                {thesis}
              </ReactMarkdown>
              {basisNotice && (
                <p className="text-warn mt-1 text-xs">{basisNotice}</p>
              )}
            </div>
          ) : (
            <p className="text-warn max-w-prose">
              No thesis yet, so this review judged the evidence alone.{" "}
              <Link
                href={`/t/${update.ticker}?tab=notes`}
                className="text-link"
              >
                Add one
              </Link>
            </p>
          )}
        </Step>
      )}

      <Step title="What's new">
        {result.what_changed.length ? (
          <div className="max-w-prose">
            <ModelList lines={result.what_changed} />
          </div>
        ) : (
          <p className="text-muted">Nothing new.</p>
        )}
      </Step>

      <Step title="Evidence">
        {sources && (
          <p className="text-muted mb-2 text-xs">
            Verified score:{" "}
            {score === null ? "unavailable" : `${Math.round(score * 100)}%`}.
            Verified checks cited: filings {sources.filing}, vendor data{" "}
            {sources.vendor}, web summaries {sources.web}
            {sources.other > 0 && `, other ${sources.other}`}. A check can cite
            more than one.
          </p>
        )}
        {sources && sources.web > sources.filing + sources.vendor && (
          <p className="text-warn mb-2 text-xs">
            This call rests mainly on web summaries: model-written summaries of
            sources rather than the documents themselves.
          </p>
        )}
        <div className="max-w-prose">
          <Evidence update={update} links={links} />
        </div>
      </Step>

      <Step title="Conclusion">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <ActionBadge action={result.action} />
          <StatusBadge status={result.status} />
          <span className="text-muted text-xs">
            Analyst confidence {Math.round(result.confidence * 100)}%
          </span>
        </div>
        {update.previousAction && update.previousAction !== result.action && (
          <p className="text-warn mt-1 text-xs">
            Changed from {words(update.previousAction)} at the previous review.
          </p>
        )}
        <p className="model-text mt-2 max-w-prose">
          {plainWords(result.reasoning)}
        </p>
        <dl className="model-text mt-2 max-w-prose space-y-1.5">
          <div>
            <dt className="text-muted inline font-sans text-sm">
              {isFund ? "Role: " : "Business: "}
            </dt>
            <dd className="inline">{plainWords(result.business_view)}</dd>
          </div>
          <div>
            <dt className="text-muted inline font-sans text-sm">
              {isFund ? "Cost and performance: " : "Valuation: "}
            </dt>
            <dd className="inline">{plainWords(result.valuation_view)}</dd>
          </div>
        </dl>
        <p className="text-muted mt-2 text-xs">
          Analyzed by {providerLabel(update.analystProvider)} (
          {update.analystModel}).{" "}
          {update.verifierProvider ? (
            <>
              Checked by {providerLabel(update.verifierProvider)} (
              {update.verifierModel}).
            </>
          ) : (
            "Not checked, since nothing new turned up."
          )}
          {update.usedFallback && (
            <strong className="text-warn"> Fallback used.</strong>
          )}
          {sameProviderFallback(update) && (
            <strong className="text-warn">
              {" "}
              A fallback meant one provider checked its own work.
            </strong>
          )}
          {update.revisedAfterReview && (
            <strong className="text-ink"> Revised after the check.</strong>
          )}
        </p>
      </Step>

      {verification && (
        <Step title="Second check">
          {disagree ? (
            <div className="border-bad bg-bad-soft max-w-prose rounded-[5px] border p-3">
              <p className="text-bad font-semibold">
                ≠{" "}
                {opinion === "disagree"
                  ? "Models disagree"
                  : "The second check disagrees"}
              </p>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-muted text-xs">Analyst says</p>
                  <div className="mt-0.5">
                    <ActionBadge action={result.action} />
                  </div>
                  <p className="model-text mt-1">
                    {plainWords(result.headline)}
                  </p>
                </div>
                <div>
                  <p className="text-muted text-xs">Second check says</p>
                  <div className="mt-0.5">
                    <ActionBadge action={verification.independent_action} />
                  </div>
                  <p className="model-text mt-1">
                    {plainWords(verification.independent_reason)}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <p className="model-text max-w-prose">
              <ActionBadge action={verification.independent_action} />{" "}
              {plainWords(verification.independent_reason)}
            </p>
          )}
          {conclusion && (
            <p className={`mt-2 ${conclusion.tone}`}>{conclusion.text}</p>
          )}
          {verification.concerns.length > 0 && (
            <div className="mt-1.5 max-w-prose">
              <ModelList lines={verification.concerns} />
            </div>
          )}
          {update.firstPass && (
            <details className="mt-2">
              <DisclosureSummary className="py-1">
                What the first check caught
              </DisclosureSummary>
              <div className="mt-1 max-w-prose">
                <p className="text-muted">
                  The analyst rewrote this review after the check objected to
                  the first version.
                  {update.firstPass.action &&
                    update.firstPass.action !== result.action &&
                    ` The first version suggested ${words(update.firstPass.action)}.`}
                </p>
                <ul className="model-text model-list mt-1">
                  {update.firstPass.contradicted.map((c, i) => (
                    <li key={`c${i}`}>
                      {claimForReader(plainWords(c.claim))} (
                      {plainWords(c.note)})
                    </li>
                  ))}
                  {update.firstPass.concerns.map((line, i) => (
                    <li key={i}>{plainWords(line)}</li>
                  ))}
                </ul>
              </div>
            </details>
          )}
        </Step>
      )}

      {result.evidence_against.length > 0 && (
        <Step title="The case against">
          <div className="max-w-prose">
            <ModelList lines={result.evidence_against} />
          </div>
        </Step>
      )}

      <Step title="What to watch">
        {!!result.condition_warnings?.length && (
          <div className="notice bg-warn-soft text-warn mb-2">
            <ModelList lines={result.condition_warnings} />
          </div>
        )}
        <p className="model-text max-w-prose">
          {plainWords(result.next_proof_point)}
        </p>
        {result.would_change_my_mind.length > 0 && (
          <>
            <h4 className="text-muted mt-3 text-xs font-medium">
              What would change my mind
            </h4>
            <div className="mt-1 max-w-prose">
              <ModelList lines={result.would_change_my_mind} />
            </div>
          </>
        )}
      </Step>
    </ol>
  );
}
