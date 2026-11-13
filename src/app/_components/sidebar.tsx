"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { Provider, ProviderMode, Settings } from "~/server/settings";
import { api } from "~/trpc/react";

import { words } from "./badges";
import { dateTime, signedPct } from "./format";

type SidebarHolding = {
  ticker: string;
  action: string | null;
  dayPct: number | null;
};

// Only persisted form fields can reset a draft. Run usage and credential metadata may refetch.
type SavedSettings = Omit<Settings, "anthropic_api_key">;
export function settingsFields(settings: SavedSettings) {
  return {
    provider_mode: settings.provider_mode,
    analyst_provider: settings.analyst_provider,
    fallback_enabled: settings.fallback_enabled,
    codex_model: settings.codex_model,
    claude_model: settings.claude_model,
    codex_effort: settings.codex_effort,
    claude_effort: settings.claude_effort,
    claude_auth_mode: settings.claude_auth_mode ?? "api",
  };
}

export function keyRemovalInput(settings: SavedSettings, confirmed: boolean) {
  return confirmed
    ? { ...settingsFields(settings), anthropic_api_key: "", clear_key: true }
    : null;
}

export const providerName = (provider: string) =>
  provider === "chatgpt" ? "ChatGPT" : "Claude";

export function roleOf(
  provider: Provider,
  mode: ProviderMode,
  analyst: Provider,
  fallback: boolean,
  ready: boolean,
) {
  if (mode === "both")
    return provider === analyst ? "Analyzes each stock" : "Checks the work";
  if (mode === provider) return "Does all the research";
  if (!fallback) return "Not used";
  if (ready) return `Backup if ${providerName(mode)} fails`;
  return provider === "claude"
    ? "No backup: needs a key"
    : "No backup: not signed in";
}

export function settingsTestKey(
  provider: Provider,
  settings: SavedSettings,
  credential = "",
) {
  return provider === "chatgpt"
    ? JSON.stringify([settings.codex_model, settings.codex_effort])
    : JSON.stringify([
        settings.claude_model,
        settings.claude_effort,
        settings.claude_auth_mode ?? "api",
        credential,
      ]);
}

export const runShouldReload = (
  before: string | undefined,
  after: string | undefined,
) =>
  before !== undefined &&
  after !== undefined &&
  before !== after &&
  !after.endsWith("|running");

export function claudeUseLine(json: string | null | undefined) {
  try {
    const usage = JSON.parse(json ?? "null") as {
      inputTokens?: unknown;
      outputTokens?: unknown;
      webSearches?: unknown;
    } | null;
    const input = usage?.inputTokens;
    const output = usage?.outputTokens;
    const searches = usage?.webSearches ?? 0;
    if (
      typeof input !== "number" ||
      !Number.isFinite(input) ||
      input < 0 ||
      typeof output !== "number" ||
      !Number.isFinite(output) ||
      output < 0 ||
      typeof searches !== "number" ||
      !Number.isFinite(searches) ||
      searches < 0 ||
      input + output + searches === 0
    )
      return null;
    return `${input.toLocaleString("en-US")} Claude tokens in, ${output.toLocaleString("en-US")} out, ${searches} web ${searches === 1 ? "search" : "searches"}`;
  } catch {
    return null;
  }
}

export function Sidebar({
  holdings,
  openCount,
  modeLabel,
  billingNote,
}: {
  holdings: SidebarHolding[];
  openCount: number;
  modeLabel: string;
  billingNote: string | null;
}) {
  const pathname = usePathname();
  const links = [
    { href: "/", label: "Today", active: pathname === "/", count: openCount },
    {
      href: "/holdings",
      label: "Holdings",
      active: pathname === "/holdings" || pathname === "/import",
      count: 0,
    },
    {
      href: "/settings",
      label: "Settings",
      active: pathname === "/settings",
      count: 0,
    },
  ];

  return (
    <aside className="rail bg-rail text-rail-text lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-60 lg:shrink-0 lg:flex-col">
      <Link
        href="/"
        className="block px-4 pt-4 pb-1 font-semibold tracking-tight"
      >
        Portchecker
      </Link>

      <nav
        aria-label="Main"
        className="flex gap-1 px-2 pt-2 pb-2 lg:flex-col lg:pb-3"
      >
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            aria-current={link.active ? "page" : undefined}
            className={`flex min-h-10 flex-1 items-center justify-between gap-2 rounded-[5px] px-3 text-sm font-medium lg:flex-none ${
              link.active
                ? "bg-rail-raised text-white"
                : "hover:bg-rail-raised/60"
            }`}
          >
            {link.label}
            {link.count > 0 && (
              <span
                className="bg-amber text-ink rounded-full px-1.5 text-xs font-semibold"
                aria-label={`${link.count} to look at`}
              >
                {link.count}
              </span>
            )}
          </Link>
        ))}
      </nav>

      {holdings.length > 0 && (
        <nav
          aria-label="Your holdings"
          className="border-rail-raised hidden min-h-0 flex-1 overflow-y-auto border-t px-2 py-2 lg:block"
        >
          <ul>
            {holdings.map((h) => {
              const href = `/t/${h.ticker}`;
              const active = pathname === href;
              return (
                <li key={h.ticker}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={`grid min-h-7 grid-cols-[3.25rem_1fr_auto] items-center gap-1 rounded-[3px] px-3 text-[0.8125rem] ${
                      active
                        ? "bg-rail-raised text-white"
                        : "hover:bg-rail-raised/60"
                    }`}
                  >
                    <span className="truncate font-medium">{h.ticker}</span>
                    <span className="text-amber truncate text-xs font-medium">
                      {h.action && h.action !== "hold" && words(h.action)}
                    </span>
                    <span
                      className={`text-xs ${
                        h.dayPct == null || h.dayPct === 0
                          ? "text-rail-muted"
                          : h.dayPct > 0
                            ? "text-rail-up"
                            : "text-rail-down"
                      }`}
                    >
                      {signedPct(h.dayPct)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      )}

      <div className="border-rail-raised mt-auto space-y-3 border-t px-4 py-3">
        <RunNow billingNote={billingNote} />
        <Link
          href="/settings"
          className="text-rail-muted hover:text-rail-text hidden text-xs lg:block"
        >
          AI: {modeLabel}
        </Link>
      </div>
    </aside>
  );
}

const railButton =
  "btn border-rail-muted bg-transparent text-rail-text hover:border-rail-text hover:bg-rail-raised";

/** Lives in the sidebar, so a run can be started and followed from any page. */
function RunNow({ billingNote }: { billingNote: string | null }) {
  const router = useRouter();
  const [requestedAfter, setRequestedAfter] = useState<number | null>(null);
  const [launchTimedOut, setLaunchTimedOut] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const start = api.runs.start.useMutation();
  const stop = api.runs.stop.useMutation();
  const status = api.runs.status.useQuery(undefined, {
    refetchInterval: (query) =>
      query.state.data?.status === "stopping"
        ? 2000
        : query.state.data?.status === "running" || requestedAfter !== null
          ? 5000
          : false,
  });
  const launchProblem = api.runs.launchProblem.useQuery(undefined, {
    enabled: launchTimedOut,
  });
  const run = status.data;
  useEffect(() => {
    if (requestedAfter === null || launchTimedOut) return;
    const timer = setTimeout(() => setLaunchTimedOut(true), 20_000);
    return () => clearTimeout(timer);
  }, [requestedAfter, launchTimedOut]);

  // A newer run row means the script has started.
  useEffect(() => {
    if (requestedAfter !== null && (run?.id ?? 0) > requestedAfter) {
      setRequestedAfter(null);
      setLaunchTimedOut(false);
      router.refresh();
    }
  }, [run?.id, requestedAfter, router]);

  // Also catch scheduled runs that started and finished while this page was idle.
  const runKey =
    run === undefined ? undefined : run ? `${run.id}|${run.status}` : "none";
  const lastKey = useRef(runKey);
  useEffect(() => {
    if (runShouldReload(lastKey.current, runKey)) {
      router.refresh();
    }
    lastKey.current = runKey;
  }, [runKey, router]);

  const running = run?.status === "running";
  // A question left open when one run ends must not greet the next run.
  useEffect(() => {
    if (!running) setConfirmingStop(false);
  }, [running]);
  const starting = requestedAfter !== null && !launchTimedOut;
  const use = claudeUseLine(run?.usageJson);
  const lastMinutes =
    run?.status === "finished" && run.finishedAt
      ? Math.max(
          1,
          Math.round(
            (new Date(run.finishedAt).getTime() -
              new Date(run.startedAt).getTime()) /
              60_000,
          ),
        )
      : null;

  if (running || starting) {
    const progress = run?.progress;
    const label = !running
      ? "Starting research"
      : progress && progress.done < progress.total
        ? `Reviewing, ${progress.done} of ${progress.total} done`
        : "Research is running";
    return (
      <div className="space-y-1.5" aria-live="polite">
        <p className="text-sm font-medium">{label}</p>
        {progress && (
          <div
            role="progressbar"
            aria-label="Research progress"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
            className="bg-rail-raised h-1 overflow-hidden rounded-full"
          >
            <div
              className="bg-amber h-full rounded-full"
              style={{
                width: `${(progress.done / Math.max(progress.total, 1)) * 100}%`,
              }}
            />
          </div>
        )}
        {running && (
          <p className="text-rail-muted truncate text-xs" title={run.lastLine}>
            {run.message}
          </p>
        )}
        <p className="text-rail-muted text-xs">
          It keeps going if you close this page or the app.
        </p>
        {running &&
          (confirmingStop ? (
            <div className="space-y-2">
              <p className="text-sm">
                Stop this run?
                <span className="text-rail-muted">
                  {" "}
                  Reviews that have finished stay saved. Reviews still in
                  progress are dropped, and no brief is written.
                </span>
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  className="btn btn-small border-amber bg-amber text-ink hover:border-amber hover:bg-amber"
                  disabled={stop.isPending}
                  onClick={async () => {
                    try {
                      await stop.mutateAsync();
                    } catch {
                      // Shown below through stop.error.
                    }
                    setConfirmingStop(false);
                    await status.refetch();
                  }}
                >
                  Stop it
                </button>
                <button
                  autoFocus
                  className={`${railButton} btn-small`}
                  onClick={() => setConfirmingStop(false)}
                >
                  Keep going
                </button>
              </div>
            </div>
          ) : (
            <button
              className={`${railButton} btn-small lg:w-full`}
              onClick={() => setConfirmingStop(true)}
            >
              Stop research
            </button>
          ))}
        {stop.error && (
          <p role="alert" className="text-rail-down text-xs">
            {stop.error.message}
          </p>
        )}
      </div>
    );
  }

  // The stopped run may still be writing its research files, so the next one is not offered yet.
  if (run?.status === "stopping") {
    return (
      <div className="space-y-1.5" aria-live="polite">
        <p className="text-sm font-medium">Stopping the run</p>
        <p className="text-rail-muted text-xs">
          Its AI calls are being ended. This takes a few seconds.
        </p>
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="space-y-2">
        <p className="text-sm">
          Start a new research run?
          {lastMinutes !== null && (
            <span className="text-rail-muted">
              {" "}
              The last one took {lastMinutes}{" "}
              {lastMinutes === 1 ? "minute" : "minutes"}.
            </span>
          )}
          {use && <span className="text-rail-muted"> It used {use}.</span>}
          {billingNote && <span className="text-amber"> {billingNote}</span>}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <button
            className="btn btn-small border-amber bg-amber text-ink hover:border-amber hover:bg-amber"
            disabled={start.isPending}
            onClick={async () => {
              const after = run?.id ?? 0;
              try {
                const started = await start.mutateAsync();
                if (started.started) {
                  setLaunchTimedOut(false);
                  setRequestedAfter(after);
                }
              } catch {
                // Shown below through start.error.
              }
              setConfirming(false);
              await status.refetch();
            }}
          >
            Start
          </button>
          <button
            autoFocus
            className={`${railButton} btn-small`}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 lg:block lg:space-y-2">
      <div className="min-w-0">
        {run?.status === "finished" && (
          <p className="text-rail-muted text-xs">
            Last run finished {dateTime(run.finishedAt ?? run.startedAt)}
            {run.failedOrSkipped > 0 && (
              <span className="text-rail-down">
                {" "}
                {run.failedOrSkipped} failed or skipped.
              </span>
            )}
          </p>
        )}
        {run?.status === "stopped" && (
          <p
            className="text-rail-muted line-clamp-4 text-xs"
            title={run.lastLine}
          >
            {run.message}
          </p>
        )}
        {run?.status === "failed" && (
          <p
            className="text-rail-down line-clamp-4 text-xs"
            title={run.lastLine}
          >
            The last run failed. {run.message}
          </p>
        )}
        {run?.status === "failed_setup" && (
          <p className="text-rail-down text-xs">
            <span className="line-clamp-4" title={run.message}>
              {run.message}
            </span>{" "}
            <Link href="/settings" className="underline">
              Open settings
            </Link>
          </p>
        )}
        {launchTimedOut && (
          <p className="text-rail-down text-xs">
            Research did not start within 20 seconds.{" "}
            {launchProblem.data ?? "Try again or check the run log."}
          </p>
        )}
        {status.error && (
          <p className="text-rail-down text-xs">
            Could not load run status.{" "}
            <button className="underline" onClick={() => void status.refetch()}>
              Retry
            </button>
          </p>
        )}
        {start.error && (
          <p role="alert" className="text-rail-down text-xs">
            {start.error.message}
          </p>
        )}
      </div>
      <button
        className={`${railButton} shrink-0 lg:w-full`}
        onClick={() => setConfirming(true)}
      >
        Run research
      </button>
    </div>
  );
}
