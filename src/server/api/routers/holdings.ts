import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import {
  createTRPCRouter,
  publicProcedure,
  tickerInput,
} from "~/server/api/trpc";
import {
  isMoneyMarketTicker,
  parsePositionsCsv,
  screenshotPositionsToCsv,
} from "~/server/csv";
import { IMPORTS_DIR, runModel } from "~/server/model";
import {
  MAX_SCREENSHOTS,
  screenshotExtension,
  screenshotFallbackNotes,
} from "~/server/queue";
import { SCREENSHOT_PROMPT, screenshotSchema } from "~/server/research/prompts";
import { holdings } from "~/server/db/schema";
import { cacheMissingHoldingQuotes } from "~/server/fmp";

const holdingKey = z.object({
  ticker: tickerInput,
  accountLabel: z.string().trim().default(""),
});

export const holdingsRouter = createTRPCRouter({
  list: publicProcedure.query(({ ctx }) =>
    ctx.db.select().from(holdings).orderBy(asc(holdings.ticker)),
  ),

  // CSV files already sitting in data/imports, newest name first.
  importFiles: publicProcedure.query(() => {
    mkdirSync(IMPORTS_DIR, { recursive: true });
    return readdirSync(IMPORTS_DIR)
      .filter((f) => f.toLowerCase().endsWith(".csv"))
      .sort()
      .reverse();
  }),

  readImportFile: publicProcedure
    .input(z.object({ name: z.string() }))
    .mutation(({ input }) => {
      // basename keeps the read inside data/imports.
      const file = path.join(IMPORTS_DIR, path.basename(input.name));
      return { csv: readFileSync(file, "utf8") };
    }),

  parseCsv: publicProcedure
    .input(z.object({ csv: z.string() }))
    .mutation(({ input }) => parsePositionsCsv(input.csv)),

  // A model reads the screenshots. The result becomes CSV text, so it goes through the same
  // parser, preview and confirm step as a Schwab export.
  parseScreenshots: publicProcedure
    .input(
      z.object({
        images: z
          .array(
            z.object({
              // The browser's picker is the only other check, and a request need not come from it.
              name: z
                .string()
                .refine(
                  (name) => screenshotExtension(name) !== null,
                  "Screenshots must be PNG, JPEG or WebP images.",
                ),
              dataUrl: z.string(),
            }),
          )
          .min(1, "Choose at least one screenshot.")
          .max(
            MAX_SCREENSHOTS,
            `Choose at most ${MAX_SCREENSHOTS} screenshots at a time.`,
          ),
      }),
    )
    .mutation(async ({ input }) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dir = path.join(IMPORTS_DIR, `screenshots-${stamp}`);
      mkdirSync(dir, { recursive: true });
      const files = input.images.map((image, i) => {
        const ext = screenshotExtension(image.name) ?? ".png";
        const data = image.dataUrl.slice(image.dataUrl.indexOf(",") + 1);
        const file = path.join(dir, `${i + 1}${ext}`);
        writeFileSync(file, Buffer.from(data, "base64"));
        return file;
      });
      const result = await runModel({
        role: "ask",
        workingDirectory: dir,
        prompt: SCREENSHOT_PROMPT,
        schema: screenshotSchema,
        images: files,
      });
      const { csv, notes } = screenshotPositionsToCsv(result.data);
      return {
        csv,
        notes: [
          ...notes,
          ...screenshotFallbackNotes(result.usedFallback, result.provider),
        ],
        fileName: `positions-from-screenshots-${stamp}.csv`,
      };
    }),

  // Replaces every holding with the rows in the CSV. Called after the preview is confirmed.
  import: publicProcedure
    .input(z.object({ csv: z.string(), fileName: z.string().default("") }))
    .mutation(async ({ ctx, input }) => {
      const parsed = parsePositionsCsv(input.csv);
      if (parsed.error) throw new Error(parsed.error);

      const now = new Date().toISOString();
      const values = parsed.rows.map((r) => ({
        ticker: r.ticker,
        name: r.name,
        quantity: r.quantity,
        costBasis: r.costBasis,
        accountLabel: r.accountLabel,
        updatedAt: now,
      }));
      // Archive before replacing holdings: a disk error must leave the database unchanged.
      mkdirSync(IMPORTS_DIR, { recursive: true });
      const name = path.basename(input.fileName) || "positions.csv";
      const extension = path.extname(name);
      const stem = path.basename(name, extension);
      let archived = path.join(IMPORTS_DIR, name);
      let suffix = 1;
      while (
        existsSync(archived) &&
        readFileSync(archived, "utf8") !== input.csv
      ) {
        archived = path.join(IMPORTS_DIR, `${stem}-${suffix++}${extension}`);
      }
      if (!existsSync(archived))
        writeFileSync(archived, input.csv, { flag: "wx" });
      await ctx.db.batch([
        ctx.db.delete(holdings).where(eq(holdings.ticker, holdings.ticker)),
        ctx.db.insert(holdings).values(values),
      ]);
      await cacheMissingHoldingQuotes(values.map((row) => row.ticker));
      return { imported: values.length };
    }),

  upsert: publicProcedure
    .input(
      holdingKey.extend({
        name: z.string().trim().default(""),
        quantity: z.number(),
        costBasis: z.number().nullable(),
        // The add form sets this. A row's own Save does not, since replacing is what it is for.
        adding: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input: { adding, ...input } }) => {
      if (input.ticker !== "CASH" && input.quantity === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Enter a nonzero number of shares, or delete the position.",
        });
      }
      // An import counts these as cash. Stored as a stock, one needs a price and a review, and it
      // leaves cash at 0% and concentration overstated.
      if (isMoneyMarketTicker(input.ticker)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${input.ticker} is a money market fund, which counts as cash. Enter its dollar value under ticker CASH.`,
        });
      }
      const sameTicker = adding
        ? await ctx.db
            .select({ accountLabel: holdings.accountLabel })
            .from(holdings)
            .where(eq(holdings.ticker, input.ticker))
        : [];
      if (sameTicker.some((h) => h.accountLabel === input.accountLabel)) {
        const account = input.accountLabel ? ` in ${input.accountLabel}` : "";
        throw new TRPCError({
          code: "CONFLICT",
          message: `${input.ticker} is already listed${account}. Change its row above, or give this one a different account.`,
        });
      }
      const updatedAt = new Date().toISOString();
      await ctx.db
        .insert(holdings)
        .values({ ...input, updatedAt })
        .onConflictDoUpdate({
          target: [holdings.ticker, holdings.accountLabel],
          set: {
            name: input.name,
            quantity: input.quantity,
            costBasis: input.costBasis,
            updatedAt,
          },
        });
      await cacheMissingHoldingQuotes([input.ticker]);
      return { ticker: input.ticker, otherRows: sameTicker.length };
    }),

  delete: publicProcedure.input(holdingKey).mutation(async ({ ctx, input }) => {
    await ctx.db
      .delete(holdings)
      .where(
        and(
          eq(holdings.ticker, input.ticker),
          eq(holdings.accountLabel, input.accountLabel),
        ),
      );
  }),
});
