"use client";

import "~/styles/globals.css";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="font-sans">
        <main className="mx-auto max-w-xl px-4 py-6 sm:px-6">
          <section role="alert" className="sheet space-y-3 p-4 sm:p-6">
            <h1 className="text-xl font-semibold">
              Portchecker could not load
            </h1>
            <p className="text-sm">
              Try again. If the problem continues, check the terminal running
              the app for the full error.
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
        </main>
      </body>
    </html>
  );
}
