import { env } from "../env.js";
import { db } from "./db/index.ts";
import { settings as settingsTable } from "./db/schema.ts";

export type Provider = "chatgpt" | "claude";
export type ProviderMode = Provider | "both";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type CodexEffort = ClaudeEffort | "ultra";

export type Settings = {
  provider_mode: ProviderMode;
  analyst_provider: Provider;
  fallback_enabled: boolean;
  codex_model: string;
  codex_effort: CodexEffort;
  claude_model: string;
  /** Blank leaves it to the model's own default. */
  claude_effort: ClaudeEffort | "";
  claude_auth_mode?: "api" | "subscription";
  anthropic_api_key: string;
};

const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";

export async function getSettings(): Promise<Settings> {
  const rows = await db.select().from(settingsTable);
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  return {
    provider_mode: (stored.get("provider_mode") ?? "chatgpt") as ProviderMode,
    analyst_provider: (stored.get("analyst_provider") ?? "chatgpt") as Provider,
    fallback_enabled: (stored.get("fallback_enabled") ?? "true") === "true",
    codex_model: stored.get("codex_model") ?? "",
    codex_effort: (stored.get("codex_effort") ?? "medium") as CodexEffort,
    claude_effort: (stored.get("claude_effort") ?? "") as ClaudeEffort | "",
    claude_auth_mode:
      stored.get("claude_auth_mode") === "subscription"
        ? "subscription"
        : "api",
    claude_model: stored.get("claude_model") ?? DEFAULT_CLAUDE_MODEL,
    anthropic_api_key: stored.get("anthropic_api_key") ?? "",
  };
}

export async function saveSettings(patch: Partial<Settings>) {
  for (const [key, raw] of Object.entries(patch)) {
    if (raw === undefined) continue;
    const value = String(raw);
    await db
      .insert(settingsTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value } });
  }
}

// The settings value wins over the environment variable.
export function claudeApiKey(s: Settings) {
  return s.anthropic_api_key || env.ANTHROPIC_API_KEY || "";
}

export function otherProvider(p: Provider): Provider {
  return p === "chatgpt" ? "claude" : "chatgpt";
}

export function providerLabel(p: string | null | undefined) {
  if (p === "chatgpt") return "ChatGPT";
  if (p === "claude") return "Claude";
  return p ?? "";
}

export function modeLabel(s: Settings) {
  if (s.provider_mode !== "both") return providerLabel(s.provider_mode);
  return `${providerLabel(s.analyst_provider)} · checked by ${providerLabel(
    otherProvider(s.analyst_provider),
  )}`;
}
