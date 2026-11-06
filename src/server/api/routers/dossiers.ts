import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  createTRPCRouter,
  publicProcedure,
  tickerInput as ticker,
} from "~/server/api/trpc";
import {
  dossierHash,
  readDossier,
  reviewBasis,
  saveDossier,
} from "~/server/dossier";
import { settings, tickers } from "~/server/db/schema";

export const dossiersRouter = createTRPCRouter({
  get: publicProcedure.input(z.object({ ticker })).query(({ input }) => {
    const markdown = readDossier(input.ticker);
    return { markdown, hash: dossierHash(markdown ?? "") };
  }),

  save: publicProcedure
    .input(
      z.object({
        ticker,
        markdown: z.string(),
        expectedHash: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const before = readDossier(input.ticker) ?? "";
      if (
        input.expectedHash !== undefined &&
        dossierHash(before) !== input.expectedHash
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "This dossier changed since you opened it. Reload it before saving.",
        });
      }
      saveDossier(input.ticker, input.markdown);
      // A review judged against the old thesis or break conditions says nothing about the new ones.
      if (reviewBasis(before) !== reviewBasis(input.markdown)) {
        // Keep a request generation in existing settings so an older job cannot clear it.
        const generation = randomUUID();
        await ctx.db.batch([
          ctx.db
            .insert(settings)
            .values({
              key: `review_request:${input.ticker}`,
              value: generation,
            })
            .onConflictDoUpdate({
              target: settings.key,
              set: { value: generation },
            }),
          ctx.db
            .update(tickers)
            .set({ lastFullReviewAt: null })
            .where(eq(tickers.ticker, input.ticker)),
        ]);
      }
    }),
});
