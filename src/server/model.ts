import { exec, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Codex } from "@openai/codex-sdk";
import { z, type ZodType } from "zod";

import { env } from "../env.js";
import {
  type AnalystResult,
  CLAUDE_SYSTEM_PROMPT,
  CLAUDE_CODE_SYSTEM_PROMPT,
  CLAUDE_WEB_SYSTEM_PROMPT,
  FILE_TEXT_RULE,
  fullTextOmittedNote,
  SCHEMA_RETRY_INSTRUCTION,
} from "./research/prompts.ts";
import {
  claudeApiKey,
  getSettings,
  otherProvider,
  type Provider,
  providerLabel,
  type Settings,
} from "./settings.ts";

type Role = "analyst" | "verifier" | "brief" | "ask" | "research" | "test";
export type Usage = {
  /** All processed input, including cache reads and cache creation. */
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
  uncachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Historical usage whose omitted input cannot be recovered. */
  inputTokensIncomplete?: boolean;
};

/** Add billed work once; old three-counter callers remain valid. */
export function addUsage(total: Usage, delta: Usage) {
  total.inputTokens += delta.inputTokens;
  total.outputTokens += delta.outputTokens;
  total.webSearches += delta.webSearches;
  for (const key of [
    "uncachedInputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
  ] as const) {
    if (delta[key] !== undefined) total[key] = (total[key] ?? 0) + delta[key];
  }
  if (delta.inputTokensIncomplete) total.inputTokensIncomplete = true;
}

type ClaudeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number } | null;
};

function claudeUsage(counters: ClaudeUsage): Usage {
  const uncached = counters.input_tokens ?? 0;
  const read = counters.cache_read_input_tokens ?? 0;
  const creation = counters.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: uncached + read + creation,
    outputTokens: counters.output_tokens ?? 0,
    webSearches: counters.server_tool_use?.web_search_requests ?? 0,
    ...(counters.cache_read_input_tokens != null ||
    counters.cache_creation_input_tokens != null
      ? {
          uncachedInputTokens: uncached,
          ...(counters.cache_read_input_tokens != null
            ? { cacheReadInputTokens: read }
            : {}),
          ...(counters.cache_creation_input_tokens != null
            ? { cacheCreationInputTokens: creation }
            : {}),
        }
      : {}),
  };
}

type CallResult = { text: string; model: string; usage?: Usage };

export const IMPORTS_DIR = path.join("data", "imports");
// A call may take as long as it needs while it is still producing something. Only silence ends it.
// Hidden thinking sends nothing the SDK passes on, so this must outlast a full 128,000-token think.
// A dead connection fails much sooner, because the keep-alive pings stop.
const STALL_LIMIT_MS = 2 * 60 * 60_000;
const STALL_MESSAGE =
  "The model sent nothing for 2 hours, so the call was stopped.";
// A pack file can be 300 KB and a web result often passes 14,000 tokens. Codex cuts the middle out of
// larger output, by default past 10,000 tokens, and needs both this setting and the per-call request
// below to return all of it. A web call has no shell, so its instructions leave out exec_command and rg.
const CODEX_TOOL_OUTPUT_TOKENS = 100_000;
const CODEX_READ_INSTRUCTIONS = `Shell output is cut to 10,000 tokens unless you ask for more, and the cut removes the middle, so never rely on a read that shows a truncation warning. Start every exec tool input with the first line "// @exec: {\"max_output_tokens\": ${CODEX_TOOL_OUTPUT_TOKENS}}" and pass max_output_tokens: ${CODEX_TOOL_OUTPUT_TOKENS} to exec_command. Search full filing_*.txt files with rg instead of printing them whole. ${FILE_TEXT_RULE}`;
const CODEX_WEB_INSTRUCTIONS = `Start every exec tool input with the first line "// @exec: {\"max_output_tokens\": ${CODEX_TOOL_OUTPUT_TOKENS}}", because a longer result otherwise loses its middle.`;
const CLAUDE_CONNECT_TIMEOUT_MS = 15 * 60_000;
const CLAUDE_STREAM_ATTEMPTS = 3;
const CLAUDE_MAX_CONTINUATIONS = 25;
const CLAUDE_MAX_RETRY_WAIT_MS = 5 * 60_000;
// Used only if the Models API cannot say what a model allows.
const CLAUDE_FALLBACK_MAX_TOKENS = 64_000;
// Next's build traces the files the server reads, and its tracer runs os.homedir() itself wherever
// a call to it is written out. It then lists the whole home folder as an input of the build. With
// the project on another drive than the home folder, on Windows, that listing hits a folder it may
// not read and the build fails. A call made through a parameter is one the tracer cannot run, and
// the app gets the same folder when it runs.
const userHome = (find = homedir) => find();
// The database and its backups can hold a saved API key, and imports hold brokerage exports.
const PRIVATE_PATHS = [
  ".env",
  env.DATABASE_PATH,
  `${env.DATABASE_PATH}-wal`,
  `${env.DATABASE_PATH}-shm`,
  IMPORTS_DIR,
  path.join("data", "backups"),
  ...[
    ".ssh",
    ".aws",
    ".azure",
    ".claude",
    ".claude.json",
    ".gnupg",
    path.join(".config", "gh"),
    path.join(".codex", "auth.json"),
  ].map((p) => path.join(userHome(), p)),
];
const CLAUDE_MAX_CHARS = 120_000;
const CLAUDE_MIN_SECTION_CHARS = 40_000;
const CLAUDE_MAX_EVENT_CHARS = 60_000;
const CLAUDE_MAX_EXCERPT_CHARS = 30_000;
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const CLAUDE_MAX_WEB_SEARCHES = 5;

class SchemaError extends Error {}

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

type CallOptions<S extends ZodType = ZodType> = {
  workingDirectory: string;
  prompt: string;
  schema: S;
  webSearch?: boolean;
  images?: string[];
  /** What was asked, when the prompt holds a question. Claude cannot search files, so code does. */
  question?: string;
  onUsage?: (usage: Usage) => void;
  /** Ends the call when aborted: a stopped run should not pay for answers nobody will read. */
  signal?: AbortSignal;
};

/** Runs `end` when the signal aborts. Call the result to stop listening once the call is over. */
function onAbort(signal: AbortSignal | undefined, end: () => void) {
  if (signal?.aborted) end();
  signal?.addEventListener("abort", end, { once: true });
  return () => signal?.removeEventListener("abort", end);
}

const IMAGE_MEDIA_TYPES: Record<
  string,
  "image/png" | "image/jpeg" | "image/webp"
> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export async function codexStatus() {
  try {
    const { stdout, stderr } = await promisify(exec)("codex login status", {
      timeout: 15_000,
    });
    return {
      signedIn: true,
      installed: true,
      detail: `${stdout}${stderr}`.trim(),
      advice: "",
    };
  } catch (error) {
    const missing = /not recognized|not found|ENOENT/i.test(String(error));
    return {
      signedIn: false,
      installed: !missing,
      detail: missing
        ? "Codex is not installed or not on PATH."
        : "Not signed in.",
      advice: missing
        ? "Install the Codex CLI and make sure codex is on PATH for this app."
        : "Run codex login in a terminal.",
    };
  }
}

/** Leave native subscription credentials with Claude Code; never inherit API billing overrides. */
function claudeCodeEnv() {
  const filtered = { ...process.env };
  for (const name of Object.keys(filtered))
    if (
      name !== "CLAUDE_CODE_OAUTH_TOKEN" &&
      name !== "CLAUDE_CONFIG_DIR" &&
      /KEY|TOKEN|SECRET|SEC_USER_AGENT|^ANTHROPIC_|^CLAUDE_|^CLAUDECODE$|^NODE_OPTIONS$|^MAX_THINKING_TOKENS$|^MAX_STRUCTURED_OUTPUT_RETRIES$/.test(
        name,
      )
    )
      delete filtered[name];
  return filtered;
}

export async function claudeCodeStatus() {
  try {
    const { stdout } = await promisify(exec)("claude auth status --json", {
      env: claudeCodeEnv(),
      windowsHide: true,
      timeout: 15_000,
    });
    const status = JSON.parse(stdout) as {
      loggedIn?: boolean;
      authMethod?: string;
    };
    const signedIn =
      status.loggedIn === true &&
      (status.authMethod === "claude.ai" ||
        status.authMethod === "oauth_token");
    return {
      installed: true,
      signedIn,
      detail: signedIn
        ? "Claude subscription is signed in."
        : "Claude subscription is not signed in.",
      advice: signedIn
        ? ""
        : "Run claude auth login in a terminal and choose your Claude subscription.",
    };
  } catch (error) {
    const installed = !/not recognized|not found|ENOENT/i.test(String(error));
    return {
      installed,
      signedIn: false,
      detail: installed
        ? "Could not confirm Claude subscription sign-in."
        : "Claude Code is not installed or not on PATH.",
      advice: installed
        ? "Run claude auth login in a terminal and choose your Claude subscription."
        : "Install Claude Code, then run claude auth login in a terminal.",
    };
  }
}

/** The models this Codex sign-in can pick, with the efforts each one accepts. */
export async function listCodexModels() {
  const { stdout } = await promisify(exec)("codex debug models", {
    timeout: 30_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const catalog = JSON.parse(stdout) as {
    models: {
      slug: string;
      display_name?: string;
      visibility?: string;
      supported_reasoning_levels?: { effort: string }[];
    }[];
  };
  return catalog.models
    .filter((model) => model.visibility === "list")
    .map((model) => ({
      id: model.slug,
      name: model.display_name ?? model.slug,
      efforts: (model.supported_reasoning_levels ?? []).map((l) => l.effort),
    }));
}

/** Runs `onStall` if `touch` is not called again within the limit. */
export function stallTimer(limitMs: number, onStall: () => void) {
  let timer: ReturnType<typeof setTimeout>;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(onStall, limitMs);
    timer.unref?.();
  };
  touch();
  return { touch, stop: () => clearTimeout(timer) };
}

type ClaudeModelFacts = {
  maxTokens: number;
  adaptiveThinking: boolean;
  dynamicFiltering: boolean;
};
const claudeModelFacts = new Map<string, ClaudeModelFacts>();

/**
 * What a model allows, from the Models API, because the dropdown offers older models too.
 * maxTokens: thinking and the answer share this cap, so anything lower can cut off the JSON. Output
 * is billed by what is actually written and the rate limit ignores this value, so the full
 * allowance costs nothing extra.
 */
export async function claudeFacts(client: Anthropic, model: string) {
  const known = claudeModelFacts.get(model);
  if (known) return known;
  const facts: ClaudeModelFacts = {
    maxTokens: CLAUDE_FALLBACK_MAX_TOKENS,
    adaptiveThinking: false,
    dynamicFiltering: true,
  };
  try {
    const info = await client.models.retrieve(model);
    facts.maxTokens = info.max_tokens ?? facts.maxTokens;
    facts.adaptiveThinking =
      info.capabilities?.thinking?.types?.adaptive?.supported ?? false;
    facts.dynamicFiltering =
      info.capabilities?.code_execution?.supported ?? true;
    // Only an answer is remembered, so one failed lookup cannot change the rest of the process.
    claudeModelFacts.set(model, facts);
  } catch {
    // The call itself will report a bad model name or key.
  }
  return facts;
}

/** A dropped connection or an overload can happen after the SDK's own retries no longer apply. */
function streamCanRetry(error: unknown) {
  if (error instanceof Anthropic.APIError) {
    const status = error.status as number | undefined;
    return (
      status === undefined ||
      status === 408 ||
      status === 409 ||
      status === 429 ||
      status >= 500
    );
  }
  return error instanceof Anthropic.AnthropicError;
}

/** How long to wait before retrying a failed stream, or null when waiting cannot help. */
function streamRetryDelayMs(error: unknown, attempt: number) {
  const fallback = 5_000 * attempt;
  if (!(error instanceof Anthropic.APIError)) return fallback;
  // A monthly spend cap looks like a rate limit, but retrying fails until the month turns over.
  if (
    JSON.stringify(error.error ?? "").includes("enforced_spend_limit_reached")
  ) {
    return null;
  }
  const headers = error.headers as Headers | undefined;
  const retryAfter = Number(headers?.get("retry-after"));
  if (!Number.isFinite(retryAfter) || retryAfter <= 0) return fallback;
  const wait = retryAfter * 1000;
  return wait > CLAUDE_MAX_RETRY_WAIT_MS ? null : Math.max(wait, fallback);
}

async function streamClaude(
  client: Anthropic,
  request: Anthropic.Messages.MessageStreamParams,
  onUsage?: (usage: Usage) => void,
  signal?: AbortSignal,
) {
  for (let attempt = 1; ; attempt++) {
    let stalled = false;
    const stream = client.messages.stream(request);
    const stall = stallTimer(STALL_LIMIT_MS, () => {
      stalled = true;
      stream.abort();
    });
    const ignoreStop = onAbort(signal, () => stream.abort());
    stream.on("streamEvent", stall.touch);
    try {
      return await stream.finalMessage();
    } catch (error) {
      // A dropped or stalled stream was still billed for what it produced.
      const partial = stream.currentMessage?.usage;
      if (partial) {
        onUsage?.(claudeUsage(partial));
      }
      if (stalled) throw new Error(STALL_MESSAGE);
      // An aborted stream reads as a dropped connection, which would otherwise be tried again.
      if (signal?.aborted) throw error;
      const delay = streamCanRetry(error)
        ? streamRetryDelayMs(error, attempt)
        : null;
      if (attempt >= CLAUDE_STREAM_ATTEMPTS || delay === null) throw error;
      await new Promise((r) => setTimeout(r, delay));
    } finally {
      stall.stop();
      ignoreStop();
    }
  }
}

async function providerReady(provider: Provider, settings: Settings) {
  if (provider === "claude")
    return settings.claude_auth_mode === "subscription"
      ? (await claudeCodeStatus()).signedIn
      : claudeApiKey(settings) !== "";
  return (await codexStatus()).signedIn;
}

/** The providers a mode needs, with a plain reason for each one that is not ready. */
export async function setupProblems(settings: Settings) {
  const needed: Provider[] =
    settings.provider_mode === "both"
      ? ["chatgpt", "claude"]
      : [settings.provider_mode];
  const problems: string[] = [];
  for (const provider of needed) {
    if (provider === "claude") {
      if (settings.claude_auth_mode === "subscription") {
        const status = await claudeCodeStatus();
        if (!status.signedIn)
          problems.push(`${status.detail} ${status.advice}`);
      } else if (!claudeApiKey(settings))
        problems.push(
          "Claude needs an API key. Add one in Settings or set ANTHROPIC_API_KEY in .env.",
        );
    } else {
      const status = await codexStatus();
      if (!status.signedIn)
        problems.push(
          `${status.installed ? "ChatGPT is not signed in." : status.detail} ${status.advice}`,
        );
    }
  }
  return problems;
}

function routeProvider(
  role: Role,
  settings: Settings,
  avoid?: Provider,
): Provider {
  if (settings.provider_mode !== "both") return settings.provider_mode;
  if (avoid) return otherProvider(avoid);
  return role === "verifier"
    ? otherProvider(settings.analyst_provider)
    : settings.analyst_provider;
}

/**
 * Turns off the MCP servers in a Codex config.toml, since a model can call them and a real run tried
 * to fetch URLs through one. This takes one inline table: a dotted override breaks on a quoted name,
 * and an empty table changes nothing. A name that is not a real server stops Codex starting, so only
 * table heads are read, and a server written any way but as its own [mcp_servers.x] table stays on.
 */
export function mcpServersOff(toml: string) {
  const names = [
    ...toml.matchAll(
      /^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([\w-]+))\s*\]/gm,
    ),
  ].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
  if (!names.length) return [];
  const off = [...new Set(names)].map(
    (name) => `${JSON.stringify(name)}={enabled=false}`,
  );
  return [`mcp_servers={${off.join(",")}}`];
}

async function callCodex(
  { workingDirectory, prompt, schema, webSearch, images, signal }: CallOptions,
  settings: Settings,
): Promise<CallResult> {
  const outputSchema = { ...z.toJSONSchema(schema), $schema: undefined };
  const codexConfig = path.join(
    process.env.CODEX_HOME || path.join(userHome(), ".codex"),
    "config.toml",
  );
  // The Codex CLI loads the user's own config, so these overrides keep an analysis to the pack
  // files: no repo AGENTS.md (the pack sits inside this repo), no plugins, MCP servers or skills read
  // from elsewhere, no sub-agents, no turn-ended notifier.
  const codex = new Codex({
    // This profile makes the call read-only as well, so never also pass sandboxMode: that flag
    // overrides the profile and would silently drop the deny rules.
    // Models read web pages and filings, so a page could try to give them instructions. A call that
    // can search the web has no shell, so it cannot read files, and a call that can read files has
    // no web or network, so it cannot send them anywhere. Common secrets are denied as well.
    configOverrides: [
      `permissions.pack.filesystem={${[
        '":root"="read"',
        // Codex creates an empty folder at a denied path that does not exist, which would turn a
        // future .env or database file into a folder.
        ...PRIVATE_PATHS.filter((f) => existsSync(f)).map(
          (f) => `"${path.resolve(f).replaceAll("\\", "/")}"="deny"`,
        ),
      ].join(",")}}`,
      // Read on every call, since a server removed from the config must not stay named here.
      ...(existsSync(codexConfig)
        ? mcpServersOff(readFileSync(codexConfig, "utf8"))
        : []),
    ],
    config: {
      default_permissions: "pack",
      project_doc_max_bytes: 0,
      notify: [],
      tool_output_token_limit: CODEX_TOOL_OUTPUT_TOKENS,
      developer_instructions: webSearch
        ? CODEX_WEB_INSTRUCTIONS
        : CODEX_READ_INSTRUCTIONS,
      // A shell command would otherwise inherit the API keys and the owner's name and email in .env.
      shell_environment_policy: {
        exclude: ["*KEY*", "*TOKEN*", "*SECRET*", "SEC_USER_AGENT"],
      },
      features: {
        apps: false,
        browser_use: false,
        computer_use: false,
        goals: false,
        image_generation: false,
        in_app_browser: false,
        memories: false,
        multi_agent: false,
        plugins: false,
        skill_search: false,
        tool_suggest: false,
        shell_tool: !webSearch,
        unified_exec: !webSearch,
      },
    },
  });
  const thread = codex.startThread({
    workingDirectory: path.resolve(workingDirectory),
    skipGitRepoCheck: true,
    approvalPolicy: "never",
    webSearchMode: webSearch ? "live" : "disabled",
    networkAccessEnabled: false,
    modelReasoningEffort: settings.codex_effort,
    ...(settings.codex_model ? { model: settings.codex_model } : {}),
  });
  const input = images?.length
    ? [
        { type: "text" as const, text: prompt },
        ...images.map((file) => ({
          type: "local_image" as const,
          path: path.resolve(file),
        })),
      ]
    : prompt;
  const controller = new AbortController();
  let stalled = false;
  const stall = stallTimer(STALL_LIMIT_MS, () => {
    stalled = true;
    controller.abort();
  });
  const ignoreStop = onAbort(signal, () => controller.abort());
  let text = "";
  try {
    const { events } = await thread.runStreamed(input, {
      outputSchema,
      signal: controller.signal,
    });
    for await (const event of events) {
      stall.touch();
      if (event.type === "item.completed") {
        if (event.item.type === "agent_message") text = event.item.text;
      } else if (event.type === "turn.failed") {
        throw new Error(event.error.message);
      }
    }
  } catch (error) {
    throw stalled ? new Error(STALL_MESSAGE) : error;
  } finally {
    stall.stop();
    ignoreStop();
  }
  return {
    text,
    model: `${settings.codex_model || "Codex default"}, ${settings.codex_effort} effort`,
  };
}

// Pretty-printed JSON is for people; compact JSON says the same in far fewer tokens.
function compactIfJson(name: string, text: string) {
  return name.endsWith(".json") ? JSON.stringify(JSON.parse(text)) : text;
}

type PackFile = { name: string; text: string };

const TRUNCATED = "\n[truncated]\n\n";
const cutTo = (text: string, limit: number) =>
  text.length <= limit
    ? text
    : `${text.slice(0, Math.max(limit - TRUNCATED.length, 0))}${TRUNCATED}`;
const charsIn = (files: PackFile[]) =>
  files.reduce((sum, f) => sum + f.text.length, 0);
const filedKey = (name: string) =>
  `${/_(\d{4}-\d{2}-\d{2})_/.exec(name)?.[1] ?? ""} ${name}`;
const byNewestFiled = (a: PackFile, b: PackFile) =>
  filedKey(b.name).localeCompare(filedKey(a.name));

/** Rewrites files newest filed date first, and returns them in the order they came. */
function rewriteNewestFirst(
  files: PackFile[],
  rewrite: (file: PackFile, position: number) => string,
) {
  const newest = [...files].sort(byNewestFiled);
  const texts = new Map(newest.map((f, i) => [f.name, rewrite(f, i)]));
  return files.map((f) => ({
    name: f.name,
    text: texts.get(f.name) ?? f.text,
  }));
}

// MD&A is short and holds the numbers a claim rests on, so it gets most of a file's allowance ahead
// of the long Risk Factors. A foreign filer's annual report exhibit is its MD&A. The header names the
// source, so it is never cut.
function shrinkSectionFile(text: string, limit: number) {
  if (text.length <= limit) return text;
  const [first = "", ...rest] = text.split(/(?=^## )/m);
  const hasHeader = rest.length > 0 && !first.startsWith("## ");
  const header = hasHeader ? first : "";
  const parts = (hasHeader ? rest : [first, ...rest]).map((part) => ({
    text: part,
    main: /^## (?:MD&A|Filing text|Annual report exhibit)/.test(part),
  }));
  const chars = (main: boolean) =>
    parts.reduce((n, p) => (p.main === main ? n + p.text.length : n), 0);
  const room = limit - header.length;
  // Room the Risk Factors cannot use goes to MD&A, and the reverse, rather than going unsent.
  let mainLeft = Math.max(Math.floor(limit * 0.75), room - chars(false));
  let otherLeft = room - Math.min(mainLeft, chars(true));
  // MD&A must not take all the room from an annual report exhibit after it, which can hold the real
  // risks. Each later section keeps a quarter of the room, or what it needs if that is less.
  const share = Math.floor(mainLeft / 4);
  const needs = (part: { text: string }) => Math.min(part.text.length, share);
  let heldBack = parts.reduce((n, p) => (p.main ? n + needs(p) : n), 0);
  const kept = parts.map((part) => {
    if (part.main) heldBack -= needs(part);
    const piece = cutTo(part.text, part.main ? mainLeft - heldBack : otherLeft);
    if (part.main) mainLeft -= piece.length;
    else otherLeft -= piece.length;
    return piece;
  });
  return `${header}${kept.join("")}`;
}

/**
 * The newest filing gets up to 60% of room and the others share the rest. Room a file cannot use
 * goes to the files that can, so nothing is cut while room is left over.
 */
export function shrinkSectionFiles(files: PackFile[], room: number) {
  let left = room;
  let later = charsIn(files);
  return rewriteNewestFirst(files, (f, i) => {
    later -= f.text.length;
    const share = i === 0 ? room * 0.6 : left / (files.length - i);
    const text = shrinkSectionFile(
      f.text,
      Math.floor(Math.max(share, left - later)),
    );
    left -= text.length;
    return text;
  });
}

/** New 8-K and 6-K files share one cap, newest first. Each always keeps its header lines. */
export function capEventFiles(
  files: PackFile[],
  maxChars = CLAUDE_MAX_EVENT_CHARS,
) {
  let left = maxChars;
  return rewriteNewestFirst(files, (f) => {
    const header = /^[\s\S]*?^Items:.*\n/m.exec(f.text)?.[0] ?? "";
    const text =
      f.text.length <= left
        ? f.text
        : `${header}${cutTo(f.text.slice(header.length), left - header.length)}`;
    left = Math.max(left - text.length, 0);
    return text;
  });
}

// Claim excerpts: passages of the full filings that best match a review's claims, chosen by code.

type Figure = { value: number; decimals: number; unit: string; money: boolean };
type Token = { weight: number; word?: string; figure?: Figure };
type Row = {
  file: string;
  line: number;
  text: string;
  words: Set<string>;
  figures: Figure[];
};
type ReviewClaims = Partial<Omit<AnalystResult, "evidence">> & {
  evidence?: { claim: string; source?: string }[];
};

const FIGURE =
  /(\$?)\(?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(\s?%|\s(?:trillion|billion|million)\b|[BM]\b)?/g;
const WORD = /[A-Z]{2,}(?![a-z])|[A-Z]?[a-z]+/g;
const UNIT_SCALE: Record<string, number> = { t: 1e12, b: 1e9, m: 1e6 };
const STOP_WORDS = new Set(
  "about after against all also among an and any are as at be been before being between billion both but by can could did do does down during each either for from had has have he her his how if in into is it its just may million more most much must no nor not of on one only or other our out over own previously rather same she should since so some such than that the their them then there these they this those through to under until up upon us very versus was we were what when where which while who whom why will with within would you".split(
    " ",
  ),
);
// A figure outweighs the rarest word, and a bare day, count or year says little by itself.
const FIGURE_WEIGHT = 3;
const WEAK_FIGURE_WEIGHT = 1.5;
const MAX_WORD_WEIGHT = 2.5;

const stem = (word: string) =>
  word.toLowerCase().replace(/(?<=[a-z]{3})(?:ing|ers|er|ed|es|ly|e|s)$/, "");
// Words and the pairs they form. A pair such as "disclosure controls" says far more than either word.
const wordsIn = (text: string) => {
  const words = (text.match(WORD) ?? [])
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w.toLowerCase()))
    .map(stem);
  return words.flatMap((w, i) => (i > 0 ? [w, `${words[i - 1]} ${w}`] : [w]));
};
const figuresIn = (text: string): Figure[] =>
  [...text.matchAll(FIGURE)].map(([, dollar, digits = "", unit = ""]) => {
    const plain = digits.replaceAll(",", "");
    return {
      value: Number(plain),
      decimals: plain.split(".")[1]?.length ?? 0,
      unit: unit.trim().slice(0, 1).toLowerCase(),
      money: dollar === "$",
    };
  });
// Page numbers and item numbers do not make a line a table row.
const isTableFigure = (f: Figure) =>
  f.money || f.unit !== "" || f.value >= 1_000;
const isStrong = (t: Token) => t.weight === FIGURE_WEIGHT;
const isPair = (t: Token) => t.word?.includes(" ");
const weightOfAll = (tokens: Token[]) =>
  tokens.reduce((sum, t) => sum + t.weight, 0);
const weightOfNeedles = (needles: { weight: number }[]) =>
  needles.reduce((sum, n) => sum + n.weight, 0);

// Filings round across units: $24.1 billion is 24,072 in a table in millions, and 62.9 can be 62,853.
function sameFigure(claim: Figure, seen: Figure, wholeDollars = false) {
  const half = 0.5 * 10 ** -claim.decimals;
  const near = (amount: number, scale: number) =>
    Math.abs(amount - claim.value * scale) <= half * scale * 1.000001;
  if (claim.unit === "%" || seen.unit === "%") {
    return claim.unit === seen.unit && near(seen.value, 1);
  }
  if (!claim.unit && near(seen.value, 1)) return true;
  const scale =
    UNIT_SCALE[claim.unit] ?? (claim.decimals > 0 && !claim.money ? 1e9 : 0);
  if (!scale) return false;
  // With no unit written, a filing's figure can be in dollars, thousands or millions.
  const seenScale = UNIT_SCALE[seen.unit];
  const scales = seenScale ? [seenScale] : wholeDollars ? [1] : [1, 1e3, 1e6];
  return scales.some((s) => near(seen.value * s, scale));
}

// html-to-text gives one paragraph or table row per line, but some filers put each table cell on
// its own line, so runs of short lines become one row. A claim is matched against one sentence at a
// time, because words scattered across a long paragraph prove nothing.
function rowsOf(file: string, text: string): Row[] {
  const lines: string[] = [];
  let lastShort = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || /^-+$/.test(line)) continue;
    const short = line.length <= 60 && !/[.;:]$/.test(line);
    const last = lines[lines.length - 1];
    if (short && lastShort && last !== undefined) {
      lines[lines.length - 1] = `${last} ${line}`;
    } else lines.push(line);
    lastShort = short;
  }
  const pieces = lines.flatMap((line, lineNo) =>
    line
      .split(/(?<=[a-z0-9)”"][.;])\s+(?=[A-Z“"$(0-9•])/)
      .flatMap((s) =>
        s.length <= 700 ? [s] : (s.match(/[\s\S]{1,690}(?:\s|$)/g) ?? [s]),
      )
      .map((piece) => ({ lineNo, piece: piece.trim() })),
  );
  const own = pieces.map((p) => wordsIn(p.piece));
  return pieces.map(({ lineNo, piece }, i) => {
    const figures = figuresIn(piece);
    const words = new Set(own[i]);
    // A table row needs the short lines above it to say what it is about.
    if (
      figures.filter(isTableFigure).length >= 2 &&
      pieces[i - 1]?.lineNo !== lineNo
    ) {
      for (let k = i - 1, used = 0; k >= 0; k--) {
        used += pieces[k]?.piece.length ?? 0;
        if (used > 250) break;
        for (const word of own[k] ?? []) words.add(word);
      }
    }
    return { file, line: lineNo, text: piece, words, figures };
  });
}

function tokensOf(sentence: string, rarity: Map<string, number>): Token[] {
  // Form names, quarter labels and pack field names are not figures or words to look up.
  const clean = sentence.replace(
    /\S*_\S*|\b(?:10-[KQ]|8-K|6-K|20-F|40-F|Q[1-4]|FY\s?\d+)\b/gi,
    " ",
  );
  return [
    ...figuresIn(clean).map((figure) => {
      const { value, unit, money, decimals } = figure;
      const bare = !unit && !money && !decimals;
      const weak = bare && (value < 1_000 || (value > 1_900 && value < 2_100));
      return { figure, weight: weak ? WEAK_FIGURE_WEIGHT : FIGURE_WEIGHT };
    }),
    ...[...new Set(wordsIn(clean))]
      .map((word) => ({
        word,
        weight: Math.min(rarity.get(word) ?? 0, MAX_WORD_WEIGHT),
      }))
      .filter((t) => t.weight >= 1),
  ];
}

function rowHas(row: Row, { figure, word }: Token) {
  return figure
    ? row.figures.some((seen) => sameFigure(figure, seen))
    : row.words.has(word ?? "");
}

/**
 * The row adding the most of `missing`, if it is a good match for the whole claim. A figure needs a
 * word beside it, and words alone need a rare pair or most of the claim. `strict` is for claims that
 * name no filing, which are likelier to be about something the filings do not cover.
 */
function bestRow(
  rows: Row[],
  tokens: Token[],
  missing: Token[],
  strict: boolean,
) {
  const singles = weightOfAll(tokens.filter((t) => !isPair(t)));
  let best: Row | undefined;
  let bestRank = 0;
  for (const row of rows) {
    const fresh = weightOfAll(missing.filter((t) => rowHas(row, t)));
    if (fresh < 3) continue;
    const matched = tokens.filter((t) => rowHas(row, t));
    const total = weightOfAll(matched);
    if (total < 5 || fresh + total <= bestRank) continue;
    const figures = matched.filter(isStrong).length;
    const words = matched.filter((t) => t.word && !isPair(t)).length;
    const pairs = matched.filter((t) => isPair(t) && t.weight >= 2).length;
    const share = weightOfAll(matched.filter((t) => !isPair(t))) / singles;
    // In a table full of numbers, a figure or two can match by chance.
    const crowded = row.figures.length > 16;
    const good =
      (words >= (strict ? 5 : 3) && share >= 0.5) ||
      (total >= (strict ? 7 : 6) &&
        ((figures >= 1 && (pairs >= 1 || (!crowded && words >= 1))) ||
          (pairs >= 1 && share >= (strict ? 0.5 : 0.15))));
    if (!good) continue;
    best = row;
    bestRank = fresh + total;
  }
  return best;
}

const isHeading = (row: Row) =>
  row.text.length <= 120 &&
  !/[.;:]$/.test(row.text) &&
  !row.figures.some(isTableFigure);

/** A row with its short lead-in and the rest of its paragraph, or for a heading what it introduces. */
function passageOf(
  allRows: Row[],
  chosen: Row,
  roomAfter = 600,
  leadIn?: number,
) {
  const rows = allRows.filter((r) => r.file === chosen.file);
  const heading = isHeading(chosen);
  // A contents page lists a heading before the section does, so a heading means its last use.
  const row = heading
    ? (rows.filter((r) => r.text.includes(chosen.text)).pop() ?? chosen)
    : chosen;
  let start = rows.indexOf(row);
  let end = start + 1;
  let room = (heading ? 1_600 : roomAfter) - row.text.length;
  for (let next = rows[end]; next; next = rows[++end]) {
    const follows = next.line === row.line || (heading && !isHeading(next));
    if (!follows || next.text.length >= room) break;
    room -= next.text.length + 1;
  }
  let lead = leadIn ?? (row.figures.length >= 2 ? 250 : 120);
  for (let prior = rows[start - 1]; prior; prior = rows[--start - 1]) {
    if (prior.text.length >= lead) break;
    lead -= prior.text.length + 1;
  }
  return rows
    .slice(start, end)
    .map((r) => r.text)
    .join("\n");
}

function claimsOf(review: ReviewClaims) {
  return [
    ...(review.evidence ?? []).map((e) => ({
      text: e.claim,
      filing: /\d{10}-\d{2}-\d{6}/.exec(e.source ?? "")?.[0],
    })),
    ...[
      ...(review.what_changed ?? []),
      review.reasoning ?? "",
      review.business_view ?? "",
      review.valuation_view ?? "",
      ...(review.evidence_against ?? []),
      ...(review.would_change_my_mind ?? []),
      review.next_proof_point ?? "",
      review.dossier_current_view ?? "",
    ].map((text) => ({ text, filing: undefined })),
  ];
}

const sentencesOfClaim = (text: string) =>
  text.split(/(?<=[.;!?])\s+|\n+|,\s+(?=(?:and|but|while|versus)\s)/);

function whatWasSent(delivered: string) {
  // Compact JSON is one huge line. Its figures count anywhere, but its words prove nothing about a
  // claim, and a rounded figure such as $2.5 billion can land on any big number by chance.
  const isBlob = (line: string) => line.length > 5_000;
  const lines = delivered.split("\n");
  const blobFigures = lines.filter(isBlob).flatMap(figuresIn);
  const inBlob = ({ figure }: Token) =>
    figure !== undefined &&
    (0.5 * 10 ** -figure.decimals) / figure.value <= 0.005 &&
    blobFigures.some((seen) => sameFigure(figure, seen, true));
  return {
    sent: rowsOf("", lines.filter((l) => !isBlob(l)).join("\n")),
    inBlob,
  };
}

/**
 * Verbatim passages for the claims the text being sent cannot support. Numbers and rare words pick
 * them, and a weak match is left out, since no passage is better than a misleading one.
 */
export function claimExcerpts(
  review: ReviewClaims,
  fullTexts: PackFile[],
  delivered: string,
  maxChars = CLAUDE_MAX_EXCERPT_CHARS,
) {
  const rows = [...fullTexts]
    .sort(byNewestFiled)
    .flatMap((f) => rowsOf(f.name, f.text));
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const word of row.words) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const rarity = new Map(
    [...counts].map(([word, n]) => [word, Math.log10(rows.length / n)]),
  );

  const { sent, inBlob } = whatWasSent(delivered);
  const sentTexts = new Set(sent.map((r) => r.text));
  const unsent = rows.filter((r) => !sentTexts.has(r.text));

  const passages: string[] = [];
  let used = 0;
  for (const { text, filing } of claimsOf(review)) {
    // A claim that names its filing is checked against that filing before any other.
    const cited = filing ? unsent.filter((r) => r.file.includes(filing)) : [];
    for (const sentence of sentencesOfClaim(text)) {
      const tokens = tokensOf(sentence, rarity);
      // A claim whose numbers are all in the JSON being sent rests on that data, not on a filing,
      // unless it cites one: then the same number in the JSON can be another metric entirely.
      const strong = tokens.filter(isStrong);
      if (!filing && strong.length && strong.every(inBlob)) continue;
      let missing = filing
        ? tokens
        : tokens.filter((t) => !isStrong(t) || !inBlob(t));
      for (let pick = 0; pick < 2; pick++) {
        const row = bestRow(sent, tokens, missing, false);
        if (!row) break;
        missing = missing.filter((t) => !rowHas(row, t));
      }
      let sentenceChars = 0;
      for (let pick = 0; pick < 2 && sentenceChars < 1_500; pick++) {
        const row =
          bestRow(cited, tokens, missing, false) ??
          bestRow(unsent, tokens, missing, true);
        if (!row) break;
        missing = missing.filter((t) => !rowHas(row, t));
        const body = passageOf(rows, row);
        const passage = `[${row.file}]\n${body}`;
        sentenceChars += passage.length;
        if (passages.some((p) => p.includes(row.text))) continue;
        if (used + passage.length + 2 > maxChars) continue;
        passages.push(passage);
        used += passage.length + 2;
        sent.push(...rowsOf("", body));
      }
    }
  }
  return passages.join("\n\n");
}

const MONTH =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DATE = new RegExp(
  `\\b(?:(\\d{1,2})\\s+(${MONTH})\\.?,?\\s+(20\\d{2})|(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2}))\\b`,
  "gi",
);
/** January 1, 2027 and 1 January, 2027 are one date. */
const datesIn = (text: string) =>
  [...text.matchAll(DATE)].map(([, d1, m1, y1, m2, d2, y2]) =>
    [y1 ?? y2, (m1 ?? m2)?.slice(0, 3).toLowerCase(), Number(d1 ?? d2)].join(
      "-",
    ),
  );

const CLOSEST_MIN_COVERAGE = 0.3;
const CLOSEST_MIN_WORDS = 2;
const CLOSEST_MAX_EXACT = 3;
const RARE_FIGURE_ROWS = 3;
const CLOSEST_ROOM_AFTER = 900;
const CLOSEST_LEAD = 300;
const CLOSEST_HEADING =
  "Closest passages found by a looser search. These may not support any claim, so read each one before relying on it.";

type Needle = { weight: number; has: (row: Row) => boolean; exact: boolean };

/**
 * The nearest passage for each claim sentence that nothing sent so far covers, where `claimExcerpts`
 * found no match it could vouch for. Without this, facts a filing plainly states came back unverified
 * because they were never sent: a word a filing uses everywhere, such as a trust's custodian, cannot
 * pick out a passage by rarity. The strongest matches get the room first.
 */
export function closestPassages(
  review: ReviewClaims,
  fullTexts: PackFile[],
  delivered: string,
  maxChars: number,
) {
  if (maxChars <= 0) return "";
  const rows = [...fullTexts]
    .sort(byNewestFiled)
    .flatMap((f) => rowsOf(f.name, f.text));
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const word of row.words) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const dates = new Map(rows.map((r) => [r, new Set(datesIn(r.text))]));
  const { sent, inBlob } = whatWasSent(delivered);
  const sentTexts = new Set(sent.map((r) => r.text));
  const unsent = rows.filter((r) => !sentTexts.has(r.text));

  const needlesOf = (sentence: string): Needle[] => {
    const words = new Set(wordsIn(sentence).filter((w) => !w.includes(" ")));
    return [
      ...[...words].map((word) => {
        const seen = counts.get(word);
        return {
          // A word the filings never use cannot be found. It still shows how much of the claim is left.
          weight: seen
            ? Math.max(Math.log10((rows.length + 1) / (seen + 1)), 0.1)
            : 1,
          has: (row: Row) => row.words.has(word),
          exact: false,
        };
      }),
      ...tokensOf(sentence, new Map())
        .filter((t) => isStrong(t) && !inBlob(t))
        .map(({ figure }) => ({
          weight: FIGURE_WEIGHT,
          // A table headed "in billions" writes $108.5 billion as a plain 108.5.
          has: (row: Row) =>
            figure !== undefined &&
            row.figures.some(
              (seen) =>
                sameFigure(figure, seen) ||
                (figure.decimals > 0 && seen.value === figure.value),
            ),
          exact: true,
        })),
      ...datesIn(sentence).map((date) => ({
        weight: FIGURE_WEIGHT,
        has: (row: Row) => dates.get(row)?.has(date) ?? false,
        exact: true,
      })),
    ];
  };
  const best = (from: Row[], needles: Needle[]) => {
    let row: Row | undefined;
    let weight = 0;
    for (const candidate of from) {
      const w = weightOfNeedles(needles.filter((n) => n.has(candidate)));
      // On a tie, a filing's later use wins: its contents page comes before the section itself.
      if (w > weight || (w === weight && candidate.file === row?.file)) {
        row = candidate;
        weight = w;
      }
    }
    return { row, weight };
  };

  const picks: { row: Row; coverage: number }[] = [];
  for (const { text, filing } of claimsOf(review)) {
    for (const sentence of sentencesOfClaim(text)) {
      const strong = tokensOf(sentence, new Map()).filter(isStrong);
      if (!filing && strong.length && strong.every(inBlob)) continue;
      const needles = needlesOf(sentence);
      const total = weightOfNeedles(needles);
      if (!total) continue;
      const { row, weight } = best(unsent, needles);
      // What was sent already says at least this much, so another passage adds nothing.
      const closeEnough =
        row !== undefined &&
        weight > best(sent, needles).weight &&
        needles.filter((n) => !n.exact && n.has(row)).length >=
          CLOSEST_MIN_WORDS &&
        weight / total >= CLOSEST_MIN_COVERAGE;
      if (closeEnough) picks.push({ row, coverage: weight / total });

      // A number or date that nothing sent contains is looked up even when the words were covered.
      const unfound = needles.filter(
        (n) =>
          n.exact &&
          !(closeEnough && n.has(row)) &&
          !sent.some((r) => n.has(r)),
      );
      for (const needle of unfound.slice(0, CLOSEST_MAX_EXACT)) {
        const holders = unsent.filter((r) => needle.has(r));
        const holder = best(holders, needles);
        if (!holder.row) continue;
        const { row: found } = holder;
        // A figure this rare can stand alone, even in a table with no word of the claim beside it.
        const rare = holders.length <= RARE_FIGURE_ROWS;
        if (rare || needles.some((n) => !n.exact && n.has(found)))
          picks.push({ row: found, coverage: holder.weight / total });
      }
    }
  }

  const passages: string[] = [];
  let used = CLOSEST_HEADING.length + 2;
  picks.sort((a, b) => b.coverage - a.coverage);
  for (const { row } of picks) {
    if (passages.some((p) => p.includes(row.text))) continue;
    const body = passageOf(rows, row, CLOSEST_ROOM_AFTER, CLOSEST_LEAD);
    const passage = `[${row.file}]\n${body}`;
    if (used + passage.length + 2 > maxChars) continue;
    passages.push(passage);
    used += passage.length + 2;
  }
  return passages.length ? [CLOSEST_HEADING, ...passages].join("\n\n") : "";
}

// The Messages API has no file access, so the working directory goes into the prompt. Everything
// a claim could rest on stays whole; only the long filing sections and the event files give way to
// the character cap. The full filings stay out, apart from passages matching a review's claims or
// the question being asked.
export function readFilesForClaude(
  workingDirectory: string,
  question?: string,
) {
  const wanted =
    /^(dossier\.md|pack\.json|review\.json|web_research\.md|portfolio_facts\.json|ticker_results\.json|filing_sections_.*|filing_diff_.*|new_8k_.*)$/;
  const entries = readdirSync(workingDirectory, { withFileTypes: true }).filter(
    (f) => f.isFile(),
  );
  const files = entries
    .filter((f) => wanted.test(f.name))
    .map((f) => ({
      name: f.name,
      text: compactIfJson(
        f.name,
        readFileSync(path.join(workingDirectory, f.name), "utf8"),
      ),
    }));

  const isSections = (f: PackFile) => f.name.startsWith("filing_sections_");
  const isEvent = (f: PackFile) => f.name.startsWith("new_8k_");
  const events = capEventFiles(files.filter(isEvent));
  const fixed =
    charsIn(files.filter((f) => !isSections(f) && !isEvent(f))) +
    charsIn(events);
  const room = Math.max(CLAUDE_MAX_CHARS - fixed, CLAUDE_MIN_SECTION_CHARS);
  const sections = shrinkSectionFiles(files.filter(isSections), room);
  const cut = new Map([...events, ...sections].map((f) => [f.name, f.text]));
  for (const f of files) f.text = cut.get(f.name) ?? f.text;

  const blocks = files.map(
    (f) => `=== FILE: ${f.name} ===\n${f.text.replace(/^[ \t]*={3,}/gm, "==")}`,
  );
  const omitted = entries
    .map((f) => f.name)
    .filter((name) => /^filing_[^/]*\.txt$/.test(name));
  if (!omitted.length) return blocks.join("\n\n");

  // A changes file lists removed sentences too, which no longer support anything.
  const fullTexts = omitted
    .filter((name) => !name.startsWith("filing_changes_"))
    .map((name) => ({
      name,
      text: readFileSync(path.join(workingDirectory, name), "utf8"),
    }));
  // A question gets the room first. Nothing counts as already sent for it, because a passage sent for
  // the review only looks like an answer: NVDA's "4,700 employees in the region" is not its headcount.
  const asked = question
    ? closestPassages(
        { what_changed: [question] },
        fullTexts,
        "",
        CLAUDE_MAX_EXCERPT_CHARS,
      )
    : "";
  // The review and the dossier's current view make the claims, so they cannot support them.
  const review = files.find((f) => f.name === "review.json");
  let excerpts = asked;
  if (review) {
    const claims = JSON.parse(review.text) as ReviewClaims;
    const room = CLAUDE_MAX_EXCERPT_CHARS - asked.length;
    const support = files.filter(
      (f) => f !== review && f.name !== "dossier.md",
    );
    const matched = claimExcerpts(
      claims,
      fullTexts,
      support.map((f) => f.text).join("\n"),
      room,
    );
    // A diff's lone sentence can match a claim and still leave out what surrounds it.
    const closest = closestPassages(
      claims,
      fullTexts,
      [
        ...support
          .filter((f) => !f.name.startsWith("filing_diff_"))
          .map((f) => f.text),
        matched,
      ].join("\n"),
      room - matched.length,
    );
    excerpts = [asked, matched, closest].filter(Boolean).join("\n\n");
  }
  if (excerpts)
    blocks.push(
      `=== FILE: claim_excerpts.md ===\n${excerpts.replace(/^[ \t]*={3,}/gm, "==")}`,
    );
  blocks.push(
    fullTextOmittedNote(omitted, excerpts !== "", question !== undefined),
  );
  return blocks.join("\n\n");
}

async function callClaude(
  {
    workingDirectory,
    prompt,
    schema,
    webSearch,
    images,
    question,
    onUsage,
    signal,
  }: CallOptions,
  settings: Settings,
): Promise<CallResult> {
  const client = new Anthropic({
    apiKey: claudeApiKey(settings),
    timeout: CLAUDE_CONNECT_TIMEOUT_MS,
  });
  const files = webSearch ? "" : readFilesForClaude(workingDirectory, question);
  const text = files ? `${files}\n\n${prompt}` : prompt;
  const content: Anthropic.ContentBlockParam[] = [
    ...(images ?? []).map((file) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type:
          IMAGE_MEDIA_TYPES[path.extname(file).toLowerCase()] ?? "image/png",
        data: readFileSync(file).toString("base64"),
      },
    })),
    { type: "text", text },
  ];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content }];
  const usage: Usage = { inputTokens: 0, outputTokens: 0, webSearches: 0 };
  const facts = await claudeFacts(client, settings.claude_model);
  let container: string | undefined;

  // Web search can pause a long turn; sending the turn back lets it finish.
  for (let attempt = 0; attempt < CLAUDE_MAX_CONTINUATIONS; attempt++) {
    const response = await streamClaude(
      client,
      {
        model: settings.claude_model,
        max_tokens: facts.maxTokens,
        // Claude 5 models think by default, but older ones skip thinking unless asked.
        ...(facts.adaptiveThinking
          ? { thinking: { type: "adaptive" as const } }
          : {}),
        ...(container ? { container } : {}),
        system: webSearch ? CLAUDE_WEB_SYSTEM_PROMPT : CLAUDE_SYSTEM_PROMPT,
        messages,
        output_config: {
          // The schema alone: with zodOutputFormat's parser, the SDK throws on a cut-off, refused or
          // off-schema answer before stop_reason below can be read, and the stream retry pays for it.
          format: {
            type: "json_schema",
            schema: zodOutputFormat(schema).schema,
          },
          ...(settings.claude_effort ? { effort: settings.claude_effort } : {}),
        },
        ...(webSearch
          ? {
              tools: [
                {
                  type: "web_search_20260209" as const,
                  name: "web_search" as const,
                  max_uses: CLAUDE_MAX_WEB_SEARCHES,
                  ...(facts.dynamicFiltering
                    ? {}
                    : { allowed_callers: ["direct" as const] }),
                },
              ],
            }
          : {}),
      },
      onUsage,
      signal,
    );
    const billed = claudeUsage(response.usage);
    onUsage?.(billed);
    addUsage(usage, billed);
    if (response.stop_reason === "refusal") {
      throw new Error("Claude declined this request.");
    }
    // A cut-off answer must never pass as a complete one, and the same cap would only cut it again.
    if (
      response.stop_reason === "max_tokens" ||
      response.stop_reason === "model_context_window_exceeded"
    ) {
      throw new Error(
        `Claude ran out of room after ${response.usage.output_tokens} output tokens, so its cut-off answer was discarded. Lower its effort in Settings, or choose a model with more room.`,
      );
    }
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      // Dynamic filtering runs in a container, and a new one would lose the turn's earlier work.
      container = response.container?.id ?? container;
      continue;
    }
    // With web search, commentary can come before the JSON, so prefer the last text block.
    const texts = response.content.flatMap((block) =>
      block.type === "text" ? [block.text] : [],
    );
    const last = texts[texts.length - 1] ?? "";
    let text = texts.join("");
    try {
      JSON.parse(last);
      text = last;
    } catch {
      // The JSON spans several blocks, so the joined text is the answer.
    }
    return {
      text,
      model: settings.claude_effort
        ? `${response.model}, ${settings.claude_effort} effort`
        : response.model,
      usage,
    };
  }
  throw new Error("Claude did not finish after several continuations.");
}

type ClaudeCodeMessage = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  stop_reason?: string;
  structured_output?: unknown;
  result?: string;
  usage?: ClaudeUsage;
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    }
  >;
  message?: {
    id?: string;
    usage?: ClaudeCodeMessage["usage"];
    content?: { type?: string; name?: string; id?: string }[];
  };
  event?: {
    type?: string;
    message?: ClaudeCodeMessage["message"];
    usage?: ClaudeCodeMessage["usage"];
    delta?: { stop_reason?: string };
  };
};

async function callClaudeCode(
  {
    workingDirectory,
    prompt,
    schema,
    webSearch,
    images,
    onUsage,
    signal,
  }: CallOptions,
  settings: Settings,
): Promise<CallResult> {
  const status = await claudeCodeStatus();
  if (!status.signedIn) throw new Error(`${status.detail} ${status.advice}`);
  signal?.throwIfAborted();
  const tools = webSearch ? "WebSearch,WebFetch" : "Read,Grep,Glob";
  const args = [
    "--print",
    "--safe-mode",
    "--restricted",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--no-session-persistence",
    "--no-chrome",
    "--tools",
    tools,
    "--allowedTools",
    tools,
    "--settings",
    JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
    "--model",
    settings.claude_model,
    ...(settings.claude_effort ? ["--effort", settings.claude_effort] : []),
    "--system-prompt",
    webSearch ? CLAUDE_WEB_SYSTEM_PROMPT : CLAUDE_CODE_SYSTEM_PROMPT,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--json-schema",
    JSON.stringify({ ...z.toJSONSchema(schema), $schema: undefined }),
  ];
  const content = [
    ...(images ?? []).map((file) => ({
      type: "image",
      source: {
        type: "base64",
        media_type:
          IMAGE_MEDIA_TYPES[path.extname(file).toLowerCase()] ?? "image/png",
        data: readFileSync(file).toString("base64"),
      },
    })),
    { type: "text", text: prompt },
  ];
  let child: ReturnType<typeof spawn> | undefined;
  let ignoreStop: (() => void) | undefined;
  let stalled = false;
  let final: ClaudeCodeMessage | undefined;
  let messageId = "message";
  let lastStopReason: string | undefined;
  const partial = new Map<string, NonNullable<ClaudeCodeMessage["usage"]>>();
  const recordUsage = (
    id: string,
    next: NonNullable<ClaudeCodeMessage["usage"]>,
  ) => {
    const previous = partial.get(id);
    const counters = { ...previous, ...next };
    for (const key of [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
    ] as const) {
      if (previous?.[key] != null || next[key] != null)
        counters[key] = Math.max(previous?.[key] ?? 0, next[key] ?? 0);
    }
    partial.set(id, counters);
  };
  const searches = new Set<string>();
  const usageSoFar = (): Usage => {
    const snapshots: ClaudeUsage[][] = [
      [...partial.values()],
      final?.usage ? [final.usage] : [],
      Object.values(final?.modelUsage ?? {}).map((model) => ({
        input_tokens: model.inputTokens,
        output_tokens: model.outputTokens,
        cache_read_input_tokens: model.cacheReadInputTokens,
        cache_creation_input_tokens: model.cacheCreationInputTokens,
      })),
    ];
    // Each source summarizes the same calls. Retain the highest known category,
    // rather than adding the final aggregate to already streamed messages.
    const known: ClaudeUsage = { input_tokens: 0, output_tokens: 0 };
    let webSearches = searches.size;
    for (const rows of snapshots) {
      for (const key of [
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
      ] as const) {
        if (rows.some((row) => row[key] != null))
          known[key] = Math.max(
            known[key] ?? 0,
            rows.reduce((sum, row) => sum + (row[key] ?? 0), 0),
          );
      }
      webSearches = Math.max(
        webSearches,
        rows.reduce(
          (sum, row) => sum + (row.server_tool_use?.web_search_requests ?? 0),
          0,
        ),
      );
    }
    return { ...claudeUsage(known), webSearches };
  };
  const stall = stallTimer(STALL_LIMIT_MS, () => {
    stalled = true;
    child?.kill();
  });
  try {
    const result = await new Promise<ClaudeCodeMessage>((resolve, reject) => {
      const running = spawn("claude", args, {
        cwd: path.resolve(workingDirectory),
        shell: false,
        windowsHide: true,
        env: {
          ...claudeCodeEnv(),
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: "128000",
          CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: "100000",
          MAX_STRUCTURED_OUTPUT_RETRIES: "2",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child = running;
      ignoreStop = onAbort(signal, () => running.kill());
      let stderr = "";
      let protocolError: Error | undefined;
      const lines = createInterface({ input: running.stdout });
      lines.on("line", (line) => {
        if (!line.trim()) return;
        stall.touch();
        try {
          const event = JSON.parse(line) as ClaudeCodeMessage;
          if (!event || typeof event !== "object") throw new Error();
          if (event.type === "result") final = event;
          if (event.type === "stream_event" && event.event) {
            const delta = event.event;
            if (delta.type === "message_start" && delta.message) {
              messageId = delta.message.id ?? "message";
              lastStopReason = undefined;
              if (delta.message.usage)
                recordUsage(messageId, delta.message.usage);
            } else if (delta.type === "message_delta") {
              if (delta.usage) recordUsage(messageId, delta.usage);
              if (delta.delta?.stop_reason)
                lastStopReason = delta.delta.stop_reason;
            }
          }
          if (event.type === "assistant" && event.message) {
            if (event.message.usage)
              recordUsage(event.message.id ?? "message", event.message.usage);
            for (const block of event.message.content ?? [])
              if (block.type === "tool_use" && block.name === "WebSearch")
                searches.add(block.id ?? String(searches.size));
          }
        } catch {
          protocolError = new Error(
            "Claude Code returned an invalid JSON stream.",
          );
        }
      });
      running.stdout.on("data", () => stall.touch());
      running.stderr.on("data", (chunk: Buffer) => {
        stall.touch();
        stderr = (stderr + chunk.toString()).slice(-8000);
      });
      running.on("error", reject);
      running.on("close", (code) => {
        lines.close();
        if (stalled) return reject(new Error(STALL_MESSAGE));
        if (protocolError) return reject(protocolError);
        if (final?.subtype === "error_max_structured_output_retries")
          return reject(
            new SchemaError(
              "Claude Code's output did not match the schema after its retry.",
            ),
          );
        if (code !== 0 || final?.is_error)
          return reject(
            new Error(
              final?.result ||
                stderr.trim() ||
                "Claude Code failed without a result.",
            ),
          );
        if (!final || !("structured_output" in final))
          return reject(
            new Error("Claude Code returned no structured result."),
          );
        if (
          (final.stop_reason ?? lastStopReason) === "max_tokens" ||
          (final.stop_reason ?? lastStopReason) ===
            "model_context_window_exceeded"
        )
          return reject(
            new Error(
              "Claude Code ran out of room, so its cut-off answer was discarded.",
            ),
          );
        resolve(final);
      });
      running.stdin.on("error", () => undefined);
      running.stdin.end(
        JSON.stringify({
          type: "user",
          session_id: "default",
          parent_tool_use_id: null,
          message: { role: "user", content },
        }) + "\n",
      );
    });
    const models = Object.keys(result.modelUsage ?? {});
    return {
      text: JSON.stringify(result.structured_output),
      model: `${models.join(", ") || settings.claude_model}${settings.claude_effort ? `, ${settings.claude_effort} effort` : ""}, Claude subscription`,
      usage: usageSoFar(),
    };
  } finally {
    stall.stop();
    ignoreStop?.();
    const usage = usageSoFar();
    if (usage.inputTokens || usage.outputTokens || usage.webSearches)
      onUsage?.(usage);
  }
}

/** The API's own words, since the SDK's message is its whole JSON reply. A mid-stream error has no status. */
function readableError(error: unknown) {
  if (!(error instanceof Anthropic.APIError)) return errorMessage(error);
  const body = error.error as
    { error?: { type?: string; message?: string } } | undefined;
  const detail = body?.error?.message;
  if (!detail) return error.message;
  const status = error.status as number | undefined;
  const code = status ? ` ${status}` : "";
  const type = body?.error?.type ? ` (${body.error.type})` : "";
  const request = error.requestID ? ` (request ${error.requestID})` : "";
  return `Claude error${code}${type}: ${detail}${request}`;
}

async function callProvider(
  provider: Provider,
  options: CallOptions,
  settings: Settings,
): Promise<CallResult> {
  // Also turns away the retry and the second attempt of a call that was stopped.
  options.signal?.throwIfAborted();
  try {
    switch (provider) {
      case "chatgpt":
        return await callCodex(options, settings);
      case "claude":
        return settings.claude_auth_mode === "subscription"
          ? await callClaudeCode(options, settings)
          : await callClaude(options, settings);
    }
  } catch (error) {
    // Provider errors reach the run log and the browser, so a key must never survive in their text.
    // No cause goes on the new error, since the original could still hold the key.
    const key = claudeApiKey(settings);
    const readable = readableError(error);
    const message = key ? readable.replaceAll(key, "[key]") : readable;
    if (message !== errorMessage(error)) throw new Error(message);
    throw error;
  }
}

function parseOutput<S extends ZodType>(text: string, schema: S): z.infer<S> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SchemaError("The model did not return valid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new SchemaError(
      `The model's JSON did not match the schema: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

// Output that fails the schema gets one retry on the same provider, then fails.
async function callValidated<S extends ZodType>(
  provider: Provider,
  options: CallOptions<S>,
  settings: Settings,
) {
  const first = await callProvider(provider, options, settings);
  try {
    return { ...first, data: parseOutput(first.text, options.schema) };
  } catch (error) {
    if (!(error instanceof SchemaError)) throw error;
    const second = await callProvider(
      provider,
      {
        ...options,
        prompt: `${options.prompt}\n\n${SCHEMA_RETRY_INSTRUCTION}`,
      },
      settings,
    );
    const usage = first.usage ? { ...first.usage } : second.usage;
    if (first.usage && second.usage && usage) addUsage(usage, second.usage);
    return { ...second, usage, data: parseOutput(second.text, options.schema) };
  }
}

type RunModelResult<T> = {
  data: T;
  provider: Provider;
  model: string;
  usedFallback: boolean;
  fallbackReason?: string;
  usage?: Usage;
};

export type RunModelOptions<S extends ZodType> = CallOptions<S> & {
  role: Role;
  provider?: Provider;
  /** In Both mode, go to the other provider first, so a check is not the analyst checking itself. */
  avoidProvider?: Provider;
};

const CAPACITY_WAIT_MS = 60_000;

/** A model at capacity is usually back within a minute, which beats paying the other provider. */
export async function retryIfAtCapacity<T>(
  call: () => Promise<T>,
  waitMs = CAPACITY_WAIT_MS,
) {
  try {
    return await call();
  } catch (error) {
    if (!/at capacity|overloaded/i.test(errorMessage(error))) throw error;
    await new Promise((r) => setTimeout(r, waitMs));
    return call();
  }
}

/**
 * The only place any model is called. Set `provider` to test one provider directly: that skips
 * routing and fallback.
 */
export async function runModel<S extends ZodType>(
  opts: RunModelOptions<S>,
): Promise<RunModelResult<z.infer<S>>> {
  const settings = await getSettings();
  const chosen =
    opts.provider ?? routeProvider(opts.role, settings, opts.avoidProvider);
  const billed: Usage = { inputTokens: 0, outputTokens: 0, webSearches: 0 };
  let reportedUsage = false;
  const options = {
    ...opts,
    onUsage: (delta: Usage) => {
      reportedUsage = true;
      addUsage(billed, delta);
      opts.onUsage?.(delta);
    },
  };

  try {
    const { data, model, usage } = await retryIfAtCapacity(() =>
      callValidated(chosen, options, settings),
    );
    return {
      data,
      provider: chosen,
      model,
      usage: reportedUsage ? billed : usage,
      usedFallback: false,
    };
  } catch (error) {
    // Fallback is for a provider that failed, not for output that failed the schema.
    if (error instanceof SchemaError || opts.provider || opts.signal?.aborted)
      throw error;
    const other = otherProvider(chosen);
    if (!settings.fallback_enabled || !(await providerReady(other, settings))) {
      throw error;
    }
    const { data, model, usage } = await retryIfAtCapacity(() =>
      callValidated(other, options, settings),
    ).catch((second: unknown) => {
      throw new Error(
        `${providerLabel(chosen)} failed (${errorMessage(error)}), then ${providerLabel(other)} failed (${errorMessage(second)})`,
        { cause: second },
      );
    });
    return {
      data,
      provider: other,
      model,
      usage: reportedUsage ? billed : usage,
      usedFallback: true,
      fallbackReason: errorMessage(error),
    };
  }
}

export async function listClaudeModels(settings: Settings) {
  // Claude Code has no command that lists the models a subscription may use, so unlike the two
  // lists below this one is written out and needs a line when a model is released.
  if (settings.claude_auth_mode === "subscription")
    return [
      "claude-fable-5-2",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-fable-5-1",
    ].map((id) => ({ id, efforts: [...CLAUDE_EFFORTS] }));
  const client = new Anthropic({ apiKey: claudeApiKey(settings) });
  const models: { id: string; efforts: string[] }[] = [];
  for await (const model of client.models.list()) {
    const effort = model.capabilities?.effort;
    models.push({
      id: model.id,
      efforts: effort?.supported
        ? CLAUDE_EFFORTS.filter((level) => effort[level]?.supported)
        : [],
    });
  }
  return models;
}
