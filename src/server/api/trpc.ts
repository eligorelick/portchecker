import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import { z, ZodError } from "zod";

import { normalizeTicker, TICKER_PATTERN } from "~/server/csv";
import { db } from "~/server/db";

export const createTRPCContext = () => ({ db });

const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
  // Forms print this message. Zod's own is a block of JSON and its stock limits read like code, so
  // those become sentences. Words a route chose for itself pass through.
  errorFormatter: ({ shape, error }) => {
    if (!(error.cause instanceof ZodError)) return shape;
    const sentences = error.cause.issues.map((issue) => {
      if (issue.code === "too_big" && issue.message.startsWith("Too big:")) {
        const limit = Number(issue.maximum).toLocaleString("en-US");
        if (issue.origin === "string")
          return `Keep this to ${limit} characters or fewer.`;
        if (issue.origin === "array") return `Add at most ${limit} at a time.`;
      }
      if (
        issue.code === "too_small" &&
        issue.message.startsWith("Too small:") &&
        issue.minimum === 1
      ) {
        if (issue.origin === "string") return "A required field is blank.";
        if (issue.origin === "array") return "Add at least one.";
      }
      return issue.message;
    });
    return { ...shape, message: sentences.join(" ") };
  },
});

export const createTRPCRouter = t.router;
export const publicProcedure = t.procedure;

/** Tickers name folders on disk, so every route checks them the same way. BRK.B becomes BRK-B, as in a CSV import. */
export const tickerInput = z
  .string()
  .overwrite(normalizeTicker)
  .regex(TICKER_PATTERN, "Enter a valid ticker.");
