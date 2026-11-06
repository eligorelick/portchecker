import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { briefs } from "~/server/db/schema";

export const briefsRouter = createTRPCRouter({
  latest: publicProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.db
      .select()
      .from(briefs)
      .orderBy(desc(briefs.id))
      .limit(1);
    return row ?? null;
  }),

  byDate: publicProcedure
    .input(z.object({ date: z.string() }))
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .select()
        .from(briefs)
        .where(eq(briefs.date, input.date))
        .orderBy(desc(briefs.id))
        .limit(1);
      return row ?? null;
    }),
});
