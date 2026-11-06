import { rmSync } from "node:fs";

import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  createTRPCRouter,
  publicProcedure,
  tickerInput as ticker,
} from "~/server/api/trpc";
import { decisions, tickers } from "~/server/db/schema";
import {
  replaceableSection,
  readDossier,
  replaceSection,
  saveDossier,
  thesisText,
} from "~/server/dossier";
import { today } from "~/server/fmp";
import { errorMessage, runModel, type Usage } from "~/server/model";
import {
  buildResearchContext,
  requestFullReview,
} from "~/server/research/pack";
import {
  askPrompt,
  askSchema,
  TEMPLATE_HINTS,
  thesisDraftPrompt,
  thesisDraftSchema,
} from "~/server/research/prompts";
import { tickerHistory } from "~/server/updates";

async function inResearchFiles<T>(
  symbol: string,
  work: (dir: string) => Promise<T>,
) {
  const dir = buildResearchContext(symbol);
  if (!dir) {
    throw new Error(
      `No research files for ${symbol} yet. Run the research job first.`,
    );
  }
  try {
    return await work(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Left for the next call to sweep. A locked folder must not lose the answer.
    }
  }
}

/** What Claude billed for one call, including a failed attempt before ChatGPT took over. */
function claudeSpend() {
  let input = 0;
  let output = 0;
  const line = () =>
    input + output > 0
      ? `Claude usage: ${input.toLocaleString()} tokens in, ${output.toLocaleString()} out.`
      : "";
  return {
    onUsage: (usage: Usage) => {
      input += usage.inputTokens;
      output += usage.outputTokens;
    },
    line,
    failed: (error: unknown) =>
      new Error([errorMessage(error), line()].filter(Boolean).join(" ")),
  };
}

/** Adds to a section, since a note I wrote while the thesis was blank must survive accepting one. */
function addToSection(markdown: string, title: string, text: string) {
  const existing = replaceableSection(markdown, title);
  const mine = existing && !TEMPLATE_HINTS.has(existing) ? existing : null;
  return replaceSection(
    markdown,
    title,
    mine && text.trim() ? `${mine}\n\n${text}` : (mine ?? text),
  );
}

export const tickersRouter = createTRPCRouter({
  detail: publicProcedure
    .input(z.object({ ticker }))
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .select()
        .from(tickers)
        .where(eq(tickers.ticker, input.ticker));
      return row ?? null;
    }),

  history: publicProcedure
    .input(z.object({ ticker }))
    .query(({ input }) => tickerHistory(input.ticker)),

  // One model call over the latest pack folder. The answer is shown, not stored.
  ask: publicProcedure
    .input(
      z.object({
        ticker,
        question: z
          .string()
          .trim()
          .min(1, "Enter a question.")
          .max(2000, "Keep the question to 2,000 characters or fewer."),
      }),
    )
    .mutation(async ({ input }) => {
      const spend = claudeSpend();
      const answer = await inResearchFiles(input.ticker, (workingDirectory) =>
        runModel({
          role: "ask",
          workingDirectory,
          prompt: askPrompt(input.ticker, input.question),
          question: input.question,
          schema: askSchema,
          onUsage: spend.onUsage,
        }),
      ).catch((error: unknown) => {
        throw spend.failed(error);
      });
      return {
        ...answer.data,
        provider: answer.provider,
        model: answer.model,
        usedFallback: answer.usedFallback,
        claudeUsage: spend.line(),
      };
    }),

  // A model's draft for me to read. Nothing is written until I accept it.
  draftThesis: publicProcedure
    .input(z.object({ ticker }))
    .mutation(async ({ input }) => {
      const spend = claudeSpend();
      const draft = await inResearchFiles(input.ticker, (workingDirectory) =>
        runModel({
          role: "ask",
          workingDirectory,
          prompt: thesisDraftPrompt(input.ticker),
          schema: thesisDraftSchema,
          onUsage: spend.onUsage,
        }),
      ).catch((error: unknown) => {
        throw spend.failed(error);
      });
      if (!draft.data.thesis.some((line) => line.trim())) {
        throw spend.failed(
          new Error("The model returned an empty draft. Try again."),
        );
      }
      return {
        ...draft.data,
        provider: draft.provider,
        model: draft.model,
        usedFallback: draft.usedFallback,
        claudeUsage: spend.line(),
      };
    }),

  acceptThesis: publicProcedure
    .input(
      z.object({
        ticker,
        thesis: z.string(),
        breakConditions: z.string(),
        numbersToWatch: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      let markdown = readDossier(input.ticker);
      if (markdown === null) throw new Error("This ticker has no dossier yet.");
      if (!input.thesis.trim()) throw new Error("The thesis is empty.");
      if (thesisText(markdown)) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "A thesis was saved since this draft was made, so it was not replaced. Reload the page.",
        });
      }
      markdown = replaceSection(markdown, "Thesis", input.thesis);
      markdown = addToSection(
        markdown,
        "What would break the thesis",
        input.breakConditions,
      );
      markdown = addToSection(
        markdown,
        "Key numbers to watch",
        input.numbersToWatch,
      );
      saveDossier(input.ticker, markdown);
      await requestFullReview(input.ticker);
    }),

  addDecision: publicProcedure
    .input(
      z.object({
        ticker,
        date: z.iso
          .date("Enter a valid decision date (YYYY-MM-DD).")
          .refine(
            (day) => day <= today(),
            "A decision cannot be in the future.",
          )
          .default(today),
        actionTaken: z.string().trim().min(1, "Choose an action."),
        note: z.string().trim().default(""),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .insert(decisions)
        .values({ ...input, createdAt: new Date().toISOString() });
    }),
});
