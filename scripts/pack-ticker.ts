// `pnpm pack:ticker AAPL` builds a full data pack for one ticker without calling any model.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { env } from "../src/env.js";
import { normalizeTicker, TICKER_PATTERN } from "../src/server/csv.ts";
import { edgarStats, syncFilings } from "../src/server/edgar.ts";
import {
  fetchFmpData,
  fetchMarketContext,
  fmpStats,
  today,
} from "../src/server/fmp.ts";
import { errorMessage } from "../src/server/model.ts";
import { loadPortfolioFacts, packPosition } from "../src/server/portfolio.ts";
import {
  ensureTicker,
  packDir,
  writePack,
} from "../src/server/research/pack.ts";

import { activeRun } from "../src/server/research/run.ts";

// Tickers name folders, and ".." would name the folder of every saved pack. BRK.B becomes BRK-B, as
// in a CSV import.
const ticker = normalizeTicker(process.argv[2] ?? "");
if (!TICKER_PATTERN.test(ticker)) {
  console.error("Usage: pnpm pack:ticker AAPL");
  process.exit(1);
}

try {
  if (await activeRun()) {
    console.error(
      "A research run is active. Wait until it finishes before replacing a ticker pack.",
    );
    process.exit(1);
  }

  const problems = [];
  if (!env.FMP_API_KEY) problems.push("Add FMP_API_KEY to .env.");
  if (!env.SEC_USER_AGENT) problems.push("Add SEC_USER_AGENT to .env.");
  if (problems.length) {
    console.error(problems.join(" "));
    process.exit(1);
  }

  // No price means a wrong symbol or plan, as in the daily job. This comes first because going on
  // would leave a stray ticker and dossier and wipe any pack saved earlier today.
  const fmp = await fetchFmpData(ticker);
  if (!fmp.quote) {
    console.error(
      `No market data for ${ticker}. Check the symbol and your FMP plan.`,
    );
    process.exit(1);
  }

  const row = await ensureTicker(ticker, ticker);
  if (row.cik) await syncFilings(ticker, row.cik, row.lastFullReviewAt);
  else
    console.log(
      `${ticker} has no CIK, so no filings. SEC does not list it, or its list could not be fetched.`,
    );

  // This replaces today's folder, and the review on screen still rests on these two files.
  const today_ = packDir(today(), ticker);
  const carried = ["web_research.md", "review.json"].flatMap((name) => {
    const from = [today_, `${today_}.full`]
      .map((folder) => path.join(folder, name))
      .find((file) => existsSync(file));
    return from ? [{ name, text: readFileSync(from) }] : [];
  });
  const { dir, written } = await writePack({
    ticker,
    date: today(),
    fmp,
    market: await fetchMarketContext().catch(() => null),
    position: packPosition(await loadPortfolioFacts(), ticker),
    includeFilings: true,
  });
  for (const { name, text } of carried) {
    writeFileSync(path.join(dir, name), text);
    written.push(name);
  }

  console.log(`Wrote ${dir}`);
  for (const name of written) {
    const kb = (statSync(path.join(dir, name)).size / 1024).toFixed(1);
    console.log(`  ${name} (${kb} KB)`);
  }
  console.log(`FMP HTTP calls: ${fmpStats.httpCalls}`);
  console.log(`EDGAR HTTP calls: ${edgarStats.httpCalls}`);
} catch (error) {
  console.error(`Could not build the ${ticker} pack. ${errorMessage(error)}`);
  process.exit(1);
}
process.exit(0);
