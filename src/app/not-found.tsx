import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <section className="sheet max-w-xl space-y-3 p-4 sm:p-6">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-muted text-sm">
        This page is unavailable. Choose Today for your latest research, or
        Holdings to find a stock you own.
      </p>
      <div className="flex flex-wrap gap-3">
        <Link href="/" className="btn">
          Today
        </Link>
        <Link href="/holdings" className="btn">
          Holdings
        </Link>
      </div>
    </section>
  );
}
