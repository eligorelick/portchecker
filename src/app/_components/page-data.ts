import { cache } from "react";

import { loadPortfolioFacts } from "~/server/portfolio";
import { latestUpdates, loadBrief } from "~/server/updates";
import { keyNumbers, type readPack } from "~/server/research/pack";
import { dayWithYear, signedPct } from "./format";

export { proofChecks } from "~/server/research/run";

// The layout and the page both need these. Caching shares one read per request, since
// latestUpdates parses stored reviews.
export const portfolioFacts = cache(loadPortfolioFacts);
export const reviews = cache(latestUpdates);
export const briefAndQueue = cache(loadBrief);

/** Presentation only: stored figures and the models' research files stay unchanged. */
export function tickerNumbers(pack: NonNullable<ReturnType<typeof readPack>>) {
  const groups = keyNumbers(pack);
  const income = pack.income_statement_quarterly?.[0];
  for (const group of groups) {
    if (
      group.title.startsWith("Latest quarter") &&
      typeof income?.date === "string"
    )
      group.title += `, ended ${dayWithYear(income.date, null)}`;
  }
  const price = pack.price_summary;
  if (
    typeof price?.price_return_1y_pct === "number" ||
    typeof price?.total_return_1y_pct === "number"
  ) {
    let group = groups.find((g) => g.title === "Price");
    if (!group) {
      group = { title: "Price", rows: [] };
      groups.unshift(group);
    }
    if (typeof price.price_return_1y_pct === "number") {
      group.rows = group.rows.filter(([label]) => label !== "1-year return");
      group.rows.push([
        "1-year price return",
        signedPct(price.price_return_1y_pct),
      ]);
    }
    if (typeof price.total_return_1y_pct === "number")
      group.rows.push([
        "1-year total return",
        signedPct(price.total_return_1y_pct),
      ]);
  }
  const pe = pack.valuation_and_growth?.valuation?.pe_ttm_from_quarterly_eps;
  if (typeof pe === "number") {
    const group = groups.find((g) => g.title.startsWith("Valuation"));
    if (group) group.rows.push(["P/E from quarterly EPS", pe.toFixed(2)]);
    else
      groups.push({
        title: "Valuation",
        rows: [["P/E from quarterly EPS", pe.toFixed(2)]],
      });
  }
  return groups;
}
