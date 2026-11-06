"use client";

export default function PageError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section role="alert" className="sheet space-y-3 p-4">
      <h1 className="text-xl font-semibold">This page could not load</h1>
      <p className="text-sm">
        Try again. If you just updated the app, back up <code>data/</code> and
        run <code>pnpm db:push</code> (see Backup, restore and updates in the
        README). The terminal running the app has the full error.
      </p>
      {error.digest && (
        <p className="text-muted text-sm break-words">
          Reference: {error.digest}
        </p>
      )}
      <button className="btn" onClick={() => window.location.reload()}>
        Try again
      </button>
    </section>
  );
}
