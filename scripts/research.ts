// `pnpm research` runs the daily job once. Cron, launchd, Task Scheduler and "Run now" call this.
import { runResearch } from "../src/server/research/run.ts";
import { normalizeTicker } from "../src/server/csv.ts";

// `pnpm research CME VOO` reviews only those tickers.
const ok = await runResearch(process.argv.slice(2).map(normalizeTicker));
process.exit(ok ? 0 : 1);
