import "~/styles/globals.css";

import { type Metadata } from "next";
import { Instrument_Sans, Newsreader } from "next/font/google";

import {
  briefAndQueue,
  portfolioFacts,
  reviews,
} from "~/app/_components/page-data";
import { Sidebar } from "~/app/_components/sidebar";
import {
  claudeApiKey,
  getSettings,
  modeLabel,
  type Settings,
} from "~/server/settings";
import { heldQueue, listedActions, openCalls } from "~/server/updates";
import { TRPCReactProvider } from "~/trpc/react";

export const metadata: Metadata = {
  title: { default: "Portchecker", template: "%s · Portchecker" },
  description: "Daily research on the stocks I hold. Decision support only.",
};

// Every page reads the local database on each request.
export const dynamic = "force-dynamic";

const instrument = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument",
});
const newsreader = Newsreader({
  subsets: ["latin"],
  variable: "--font-newsreader",
  axes: ["opsz"],
});

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  let settings: Settings | null = null;
  let holdings: {
    ticker: string;
    action: string | null;
    dayPct: number | null;
  }[] = [];
  let openCount = 0;
  try {
    settings = await getSettings();
    const [facts, updates, brief] = await Promise.all([
      portfolioFacts(),
      reviews(),
      briefAndQueue(),
    ]);
    const held = new Set(facts.positions.map((p) => p.ticker));
    openCount =
      heldQueue(brief.queue, held).openCount +
      openCalls(brief.queue, updates, brief.decisions, held).length;
    const actions = listedActions(brief.queue, updates, brief.runId);
    holdings = facts.positions
      .filter((p) => p.ticker !== "CASH")
      .map((p) => ({
        ticker: p.ticker,
        action: actions.get(p.ticker) ?? null,
        dayPct: p.day_change_pct,
      }));
  } catch (error) {
    holdings = [];
    openCount = 0;
    console.error("Could not load sidebar research data", error);
  }

  const subscription = settings?.claude_auth_mode === "subscription";
  const claudeBilling = subscription
    ? "Claude uses your subscription usage limits. Check Claude Code's extra usage settings for possible charges."
    : "Claude calls are billed per token.";
  const billingNote = !settings
    ? null
    : settings.provider_mode !== "chatgpt"
      ? claudeBilling
      : settings.fallback_enabled && (subscription || claudeApiKey(settings))
        ? subscription
          ? "If ChatGPT fails, Claude uses your subscription usage limits. Check Claude Code's extra usage settings for possible charges."
          : "If ChatGPT fails, that call runs on Claude and is billed per token."
        : null;

  return (
    <html lang="en" className={`${instrument.variable} ${newsreader.variable}`}>
      <body className="font-sans">
        <TRPCReactProvider>
          <a
            href="#main"
            className="bg-sheet sr-only z-10 rounded p-2 focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
          >
            Skip to content
          </a>
          <div className="lg:flex">
            <Sidebar
              holdings={holdings}
              openCount={openCount}
              modeLabel={settings ? modeLabel(settings) : "unavailable"}
              billingNote={billingNote}
            />
            <main
              id="main"
              className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-8"
            >
              <div className="mx-auto max-w-6xl">
                {children}
                <p className="text-muted mt-10 text-xs">
                  Decision support only. Portchecker never places trades.
                </p>
              </div>
            </main>
          </div>
        </TRPCReactProvider>
      </body>
    </html>
  );
}
