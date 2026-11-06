import { mkdirSync } from "node:fs";

import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { env } from "~/env";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { runFailures } from "~/server/api/routers/runs";
import {
  claudeCodeStatus,
  codexStatus,
  errorMessage,
  listClaudeModels,
  listCodexModels,
  runModel,
  setupProblems,
  type Usage,
} from "~/server/model";
import { packDir } from "~/server/research/pack";
import { TEST_PROMPT, testSchema } from "~/server/research/prompts";
import { latestRun } from "~/server/research/run";
import { claudeApiKey, getSettings, saveSettings } from "~/server/settings";

export const settingsRouter = createTRPCRouter({
  // The full key never leaves the server: the browser only gets its last 4 characters.
  get: publicProcedure.query(async () => {
    const stored = await getSettings();
    const { anthropic_api_key, ...settings } = stored;
    const key = claudeApiKey(stored);
    const lastRun = await latestRun();
    return {
      ...settings,
      keyLast4: key ? key.slice(-4) : null,
      keySource: anthropic_api_key
        ? ("settings" as const)
        : env.ANTHROPIC_API_KEY
          ? ("env" as const)
          : null,
      fmpKeySet: !!env.FMP_API_KEY,
      secUserAgentSet: !!env.SEC_USER_AGENT,
      lastRun: lastRun
        ? {
            startedAt: lastRun.startedAt,
            status: lastRun.status,
            failedOrSkipped: runFailures(lastRun.message),
            providerMode: lastRun.providerMode,
            usage: lastRun.usageJson
              ? (JSON.parse(lastRun.usageJson) as Omit<Usage, "webSearches"> & {
                  webSearches?: number;
                })
              : null,
          }
        : null,
    };
  }),

  save: publicProcedure
    .input(
      z.object({
        provider_mode: z.enum(["chatgpt", "claude", "both"]),
        analyst_provider: z.enum(["chatgpt", "claude"]),
        fallback_enabled: z.boolean(),
        codex_model: z.string().trim(),
        codex_effort: z.enum([
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
          "ultra",
        ]),
        claude_model: z.string().trim().min(1, "Choose a Claude model."),
        claude_auth_mode: z.enum(["api", "subscription"]).optional(),
        claude_effort: z.enum(["", "low", "medium", "high", "xhigh", "max"]),
        // Blank keeps the saved key. clear_key removes it.
        anthropic_api_key: z.string().trim().default(""),
        clear_key: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const { anthropic_api_key, clear_key, claude_auth_mode, ...fields } =
        input;
      // An older client's absent/undefined field must keep the saved authentication mode.
      const rest = claude_auth_mode ? { ...fields, claude_auth_mode } : fields;
      const keyPatch = clear_key
        ? { anthropic_api_key: "" }
        : anthropic_api_key
          ? { anthropic_api_key }
          : {};
      const candidate = { ...(await getSettings()), ...rest, ...keyPatch };
      const problems = await setupProblems(candidate);
      if (problems.length) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: problems.join(" "),
        });
      }
      await saveSettings({ ...rest, ...keyPatch });
    }),

  // A tiny call to one provider, using saved settings. Skips routing and fallback.
  test: publicProcedure
    .input(z.object({ provider: z.enum(["chatgpt", "claude"]) }))
    .mutation(async ({ input }) => {
      const dir = packDir("_test");
      mkdirSync(dir, { recursive: true });
      const started = Date.now();
      try {
        const result = await runModel({
          role: "test",
          provider: input.provider,
          workingDirectory: dir,
          prompt: TEST_PROMPT,
          schema: testSchema,
        });
        const ok = testSchema.parse(result.data).ok;
        return {
          ok,
          model: result.model,
          seconds: (Date.now() - started) / 1000,
          error: ok
            ? null
            : "The provider replied but did not confirm the test.",
        };
      } catch (error) {
        return {
          ok: false,
          model: null,
          seconds: (Date.now() - started) / 1000,
          error: errorMessage(error),
        };
      }
    }),

  claudeModels: publicProcedure.query(async () => {
    const settings = await getSettings();
    if (settings.claude_auth_mode !== "subscription" && !claudeApiKey(settings))
      return { models: [], error: "No API key." };
    try {
      return { models: await listClaudeModels(settings), error: null };
    } catch {
      return { models: [], error: "Could not load the model list." };
    }
  }),

  codexModels: publicProcedure.query(async () => {
    try {
      return { models: await listCodexModels(), error: null };
    } catch {
      return { models: [], error: "Could not load the model list." };
    }
  }),

  codexStatus: publicProcedure.query(() => codexStatus()),
  claudeCodeStatus: publicProcedure.query(() => claudeCodeStatus()),
});
