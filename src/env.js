import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  // Everything is optional so the app still starts on a fresh machine. The settings page
  // shows which values are missing.
  server: {
    DATABASE_PATH: z.string().default("./data/portfolio.db"),
    FMP_API_KEY: z.string().optional(),
    SEC_USER_AGENT: z
      .string()
      .optional()
      .transform((s) => (s && /@example\.com\b/i.test(s) ? undefined : s)),
    ANTHROPIC_API_KEY: z.string().optional(),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
  },
  client: {},
  runtimeEnv: {
    DATABASE_PATH: process.env.DATABASE_PATH,
    FMP_API_KEY: process.env.FMP_API_KEY,
    SEC_USER_AGENT: process.env.SEC_USER_AGENT,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    NODE_ENV: process.env.NODE_ENV,
  },
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
