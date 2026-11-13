import { dossiersRouter } from "~/server/api/routers/dossiers";
import { holdingsRouter } from "~/server/api/routers/holdings";
import { runsRouter } from "~/server/api/routers/runs";
import { settingsRouter } from "~/server/api/routers/settings";
import { tickersRouter } from "~/server/api/routers/tickers";
import { createTRPCRouter } from "~/server/api/trpc";

export const appRouter = createTRPCRouter({
  dossiers: dossiersRouter,
  holdings: holdingsRouter,
  runs: runsRouter,
  settings: settingsRouter,
  tickers: tickersRouter,
});

export type AppRouter = typeof appRouter;
