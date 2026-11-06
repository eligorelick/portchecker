"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { api } from "~/trpc/react";
import { dossierHasUnsavedChanges, plainWords, sourceParts } from "./format";

export function DossierEditor({
  ticker,
  markdown,
  hash,
}: {
  ticker: string;
  markdown: string;
  hash: string;
}) {
  const router = useRouter();
  const save = api.dossiers.save.useMutation();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(markdown);
  const [expectedHash, setExpectedHash] = useState(hash);
  const [unsavedCopy, setUnsavedCopy] = useState<string | null>(null);

  if (!editing) {
    return (
      <button
        className="btn"
        onClick={() => {
          setText(markdown);
          setExpectedHash(hash);
          setUnsavedCopy(null);
          save.reset();
          setEditing(true);
        }}
      >
        Edit as text
      </button>
    );
  }
  return (
    <div className="space-y-2">
      <textarea
        aria-label={`Dossier for ${ticker}`}
        className="field h-96 font-mono text-sm"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {save.error?.data?.code === "CONFLICT" && (
        <div className="notice bg-warn-soft text-warn text-sm">
          The file changed since you opened it. A research run may have updated
          Current view. Your unsaved text is still above; copy it before
          merging.
          <button
            className="btn mt-2"
            onClick={() => {
              setUnsavedCopy(text);
              router.refresh();
            }}
          >
            Reload latest and keep my text below
          </button>
        </div>
      )}
      {unsavedCopy !== null && (
        <div className="space-y-2">
          <p className="text-sm">Latest saved file (your text stays below):</p>
          <textarea
            readOnly
            aria-label="Latest saved dossier"
            className="field h-48 font-mono text-sm"
            value={markdown}
          />
          <button
            className="btn"
            onClick={() => {
              setText(markdown);
              setExpectedHash(hash);
              save.reset();
            }}
          >
            Use this version to merge my edits
          </button>
        </div>
      )}
      {unsavedCopy !== null && (
        <label className="block text-sm">
          Your unsaved text (copy before closing)
          <textarea
            readOnly
            className="field h-48 font-mono text-sm"
            value={unsavedCopy}
          />
        </label>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="btn btn-primary"
          disabled={save.isPending}
          onClick={async () => {
            try {
              await save.mutateAsync({ ticker, markdown: text, expectedHash });
              setUnsavedCopy(null);
              setEditing(false);
              router.refresh();
            } catch {
              // Shown below through save.error.
            }
          }}
        >
          {save.isPending ? "Saving" : "Save changes"}
        </button>
        <button
          className="btn"
          onClick={() => {
            if (
              !dossierHasUnsavedChanges(text, markdown, unsavedCopy) ||
              window.confirm("Discard your unsaved changes to this dossier?")
            )
              setEditing(false);
          }}
        >
          Cancel
        </button>
        {save.error && (
          <span className="text-bad text-sm">{save.error.message}</span>
        )}
      </div>
    </div>
  );
}

const bullets = (lines: string[]) => lines.map((l) => `- ${l}`).join("\n");

/** A draft thesis that I edit and accept. The model never writes these sections itself. */
export function ThesisDrafter({ ticker }: { ticker: string }) {
  const router = useRouter();
  const draft = api.tickers.draftThesis.useMutation();
  const accept = api.tickers.acceptThesis.useMutation();
  const [thesis, setThesis] = useState("");
  const [breakConditions, setBreakConditions] = useState("");
  const [numbersToWatch, setNumbersToWatch] = useState("");
  const [drafter, setDrafter] = useState("");
  const [ready, setReady] = useState(false);

  if (!ready) {
    return (
      <div className="space-y-2">
        <button
          className="btn btn-primary"
          disabled={draft.isPending}
          onClick={async () => {
            try {
              const d = await draft.mutateAsync({ ticker });
              setThesis(bullets(d.thesis));
              setBreakConditions(bullets(d.break_conditions));
              // These go stale, and a saved note should say when they were true.
              setNumbersToWatch(
                `As of ${new Date().toLocaleDateString("en-CA")}:\n\n${bullets(d.numbers_to_watch)}`,
              );
              setDrafter(
                `${d.provider === "claude" ? "Claude" : "ChatGPT"} (${d.model})${d.usedFallback ? ", fallback used" : ""}`,
              );
              setReady(true);
            } catch {
              // Shown below through draft.error.
            }
          }}
        >
          {draft.isPending
            ? "Drafting from the research files"
            : "Draft a thesis for me"}
        </button>
        {draft.error && (
          <p className="text-bad text-sm">{draft.error.message}</p>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-muted text-sm">
        {drafter} wrote this draft from the research files, and no second check
        ran, so confirm any number you keep. Change anything that is not your
        view. Nothing is saved until you accept it.
        {draft.data?.claudeUsage && ` ${draft.data.claudeUsage}`}
      </p>
      {(
        [
          ["Thesis", thesis, setThesis],
          ["What would break the thesis", breakConditions, setBreakConditions],
          ["Key numbers to watch", numbersToWatch, setNumbersToWatch],
        ] as const
      ).map(([label, value, set]) => (
        <label key={label} className="block text-sm font-medium">
          {label}
          <textarea
            className="field mt-1 h-36 text-sm font-normal"
            value={value}
            onChange={(e) => set(e.target.value)}
          />
        </label>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="btn btn-primary"
          disabled={accept.isPending || !thesis.trim()}
          onClick={async () => {
            try {
              await accept.mutateAsync({
                ticker,
                thesis,
                breakConditions,
                numbersToWatch,
              });
              setReady(false);
              router.refresh();
            } catch {
              // Shown below through accept.error.
            }
          }}
        >
          Save as my thesis
        </button>
        <button
          className="btn"
          onClick={() => {
            if (
              window.confirm(
                "Discard this draft? Getting another one takes a new model call.",
              )
            )
              setReady(false);
          }}
        >
          Discard draft
        </button>
        {accept.error && (
          <span className="text-bad text-sm">{accept.error.message}</span>
        )}
      </div>
    </div>
  );
}

export function AskBox({ ticker }: { ticker: string }) {
  const ask = api.tickers.ask.useMutation();
  const [question, setQuestion] = useState("");
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (question.trim()) ask.mutate({ ticker, question });
      }}
    >
      <textarea
        aria-label={`Question about ${ticker}`}
        className="field h-20"
        placeholder={`What would have to be true for ${ticker} to be worth adding to?`}
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
      />
      <button
        className="btn"
        type="submit"
        disabled={ask.isPending || !question.trim()}
      >
        {ask.isPending ? "Reading the research files" : "Ask"}
      </button>
      {ask.error && <p className="text-bad text-sm">{ask.error.message}</p>}
      {ask.data && (
        <div className="space-y-2 pt-2 text-sm" aria-live="polite">
          <p className="model-text max-w-prose whitespace-pre-wrap">
            {plainWords(ask.data.answer)}
          </p>
          {ask.data.evidence.length > 0 && (
            <ul className="text-muted list-disc space-y-1 pl-4 text-xs">
              {ask.data.evidence.map((item, i) => (
                <li key={i}>
                  {plainWords(item.claim)} (
                  {sourceParts(item.source)
                    .map((part) => part.label)
                    .join("; ")}
                  )
                </li>
              ))}
            </ul>
          )}
          <p className="text-muted text-xs">
            Answered by {ask.data.provider === "claude" ? "Claude" : "ChatGPT"}{" "}
            ({ask.data.model}){ask.data.usedFallback && ", fallback used"}. No
            second check ran, so confirm any number you keep. Not saved.
            {ask.data.claudeUsage && ` ${ask.data.claudeUsage}`}
          </p>
        </div>
      )}
    </form>
  );
}

const QUICK_ACTIONS = ["Held", "Added", "Trimmed", "Sold"];

export function DecisionForm({ ticker }: { ticker: string }) {
  const router = useRouter();
  const add = api.tickers.addDecision.useMutation();
  const [date, setDate] = useState(() =>
    new Date().toLocaleDateString("en-CA"),
  );
  const [action, setAction] = useState("");
  const [note, setNote] = useState("");
  const [logged, setLogged] = useState("");
  return (
    <form
      className="space-y-3 text-sm"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await add.mutateAsync({ ticker, date, actionTaken: action, note });
          setLogged(action);
          setAction("");
          setNote("");
          router.refresh();
        } catch {
          // Shown below through add.error.
        }
      }}
    >
      <div className="flex flex-wrap gap-1.5">
        {QUICK_ACTIONS.map((quick) => (
          <button
            key={quick}
            type="button"
            aria-pressed={action === quick}
            className={`btn btn-small ${action === quick ? "border-act bg-act-soft" : ""}`}
            onClick={() => {
              setAction(quick);
              setLogged("");
            }}
          >
            {quick}
          </button>
        ))}
      </div>
      <label className="block font-medium">
        What I did
        <input
          className="field mt-1 font-normal"
          placeholder="Bought 5 shares"
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setLogged("");
          }}
        />
      </label>
      <label className="block font-medium">
        Why <span className="text-muted font-normal">(optional)</span>
        <input
          className="field mt-1 font-normal"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <label className="block font-medium">
        Date
        <input
          type="date"
          required
          max={new Date().toLocaleDateString("en-CA")}
          className="field mt-1 font-normal"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      <button
        className="btn btn-primary w-full"
        type="submit"
        disabled={!action.trim() || add.isPending}
      >
        Log decision
      </button>
      {logged && (
        <p className="text-ok" aria-live="polite">
          ✓ Logged: {logged}
        </p>
      )}
      {add.error && <p className="text-bad">{add.error.message}</p>}
    </form>
  );
}
