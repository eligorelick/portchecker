import "./test-env.ts";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// Resolve modules before leaving the checkout. The child can only call fake SDKs and reads a fake home.
const harness = String.raw`
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { z } from __ZOD__;
const home = path.join(process.cwd(), 'home');
mkdirSync(home);
process.env.CODEX_HOME = path.join(home, '.codex');
mkdirSync(process.env.CODEX_HOME);
const settings = {
  provider_mode: 'chatgpt', analyst_provider: 'chatgpt', fallback_enabled: false,
  codex_model: 'fake-codex-model', codex_effort: 'high',
  claude_model: 'fake-claude-model', claude_effort: '',
  anthropic_api_key: 'fake-provider-key-value',
};
const state = { calls: [], error: null };
globalThis.sandboxState = state;
globalThis.sandboxSettings = settings;
globalThis.fetch = () => { throw new Error('Unexpected network request.'); };
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@openai/codex-sdk') return { url: 'test:codex', shortCircuit: true };
    if (specifier === '@anthropic-ai/sdk') return { url: 'test:anthropic', shortCircuit: true };
    if (specifier === 'node:os') return { url: 'test:os', shortCircuit: true };
    if (specifier === 'node:child_process') return { url: 'test:child', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    const sources = {
      'test:codex': 'export class Codex { constructor(options) { this.options = options; } startThread(thread) { const state = globalThis.sandboxState; state.calls.push({ options: this.options, thread }); return { runStreamed: async () => { if (state.error) throw state.error; return { events: (async function* () { yield { type: "item.completed", item: { type: "agent_message", text: "{\\"ok\\":true}" } }; yield { type: "turn.completed", usage: {} }; })() }; } }; } }',
      'test:anthropic': 'export default class Anthropic { static APIError = class extends Error {}; constructor() { throw new Error("Unexpected Claude call."); } }',
      'test:os': 'export const homedir = () => ' + JSON.stringify(home) + ';',
      'test:child': 'export const exec = () => { throw new Error("Unexpected process launch."); }; export const spawn = exec;',
      [__SETTINGS__]: 'export const getSettings = async () => ({ ...globalThis.sandboxSettings }); export const claudeApiKey = s => s.anthropic_api_key; export const otherProvider = p => p === "chatgpt" ? "claude" : "chatgpt"; export const providerLabel = p => p;',
    };
    if (Object.hasOwn(sources, url)) return { format: 'module', shortCircuit: true, source: sources[url] };
    return next(url, context);
  },
});
const { runModel } = await import(__MODEL__);
const base = { role: 'test', provider: 'chatgpt', workingDirectory: '.', prompt: 'Fake test prompt', schema: z.object({ ok: z.boolean() }) };
`;

function scenario(name: string, body: string) {
  void test(name, () => {
    const temp = mkdtempSync(path.join(tmpdir(), "portchecker-model-sandbox-"));
    const script = harness
      .replace("__ZOD__", JSON.stringify(import.meta.resolve("zod")))
      .replace(
        "__SETTINGS__",
        JSON.stringify(new URL("./settings.ts", import.meta.url).href),
      )
      .replace(
        "__MODEL__",
        JSON.stringify(new URL("./model.ts", import.meta.url).href),
      );
    try {
      const result = spawnSync(
        process.execPath,
        ["--no-warnings", "--input-type=module", "--eval", script + body],
        {
          cwd: temp,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            DATABASE_PATH: path.join(temp, "fake.db"),
            ANTHROPIC_API_KEY: "",
            FMP_API_KEY: "",
            NODE_ENV: "test",
          },
        },
      );
      assert.equal(
        result.status,
        0,
        `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}

scenario(
  "Codex web calls disable both shell tools and file calls disable web and network access",
  String.raw`
for (const webSearch of [true, false]) {
  assert.deepEqual((await runModel({ ...base, webSearch })).data, { ok: true });
  const { options, thread } = state.calls.at(-1);
  assert.equal(thread.webSearchMode, webSearch ? 'live' : 'disabled');
  assert.equal(thread.networkAccessEnabled, false);
  assert.equal(thread.approvalPolicy, 'never');
  assert.equal(thread.workingDirectory, process.cwd());
  assert.equal(options.config.features.shell_tool, !webSearch);
  assert.equal(options.config.features.unified_exec, !webSearch);
  assert.equal(options.config.default_permissions, 'pack');
  assert.equal(Object.hasOwn(thread, 'sandboxMode'), false, 'a sandbox flag would override the deny profile');
}
`,
);

scenario(
  "Codex ignores project instructions, disables external tools and excludes credentials from shell environments",
  String.raw`
await runModel(base);
const { config } = state.calls[0].options;
assert.equal(config.project_doc_max_bytes, 0);
assert.deepEqual(config.notify, []);
for (const feature of ['apps', 'browser_use', 'computer_use', 'goals', 'image_generation', 'in_app_browser', 'memories', 'multi_agent', 'plugins', 'skill_search', 'tool_suggest'])
  assert.equal(config.features[feature], false, feature);
assert.deepEqual(config.shell_environment_policy.exclude, ['*KEY*', '*TOKEN*', '*SECRET*', 'SEC_USER_AGENT']);
`,
);

scenario(
  "Codex denies existing secrets without creating deny rules for missing files",
  String.raw`
writeFileSync('.env', 'FAKE_VALUE=not-a-real-secret');
writeFileSync(process.env.DATABASE_PATH, 'fake database');
writeFileSync(process.env.DATABASE_PATH + '-wal', 'fake journal');
mkdirSync('data/imports', { recursive: true });
writeFileSync(path.join(home, '.codex/auth.json'), '{}');
await runModel(base);
const rules = state.calls[0].options.configOverrides[0];
const rule = (file) => JSON.stringify(path.resolve(file).replaceAll('\\', '/')) + '="deny"';
assert.ok(rules.includes('\":root\"=\"read\"'), rules);
for (const file of ['.env', process.env.DATABASE_PATH, process.env.DATABASE_PATH + '-wal', 'data/imports', path.join(home, '.codex/auth.json')])
  assert.ok(rules.includes(rule(file)), file);
for (const file of [process.env.DATABASE_PATH + '-shm', 'data/backups', path.join(home, '.ssh')])
  assert.equal(rules.includes(rule(file)), false, file);
`,
);

scenario(
  "Codex rereads MCP configuration on each call and disables every configured server",
  String.raw`
const configFile = path.join(process.env.CODEX_HOME, 'config.toml');
writeFileSync(configFile, '[mcp_servers.local]\ncommand="fake"\n[mcp_servers."name.with.dots"]\ncommand="fake"');
await runModel(base);
assert.ok(state.calls[0].options.configOverrides.includes('mcp_servers={"local"={enabled=false},"name.with.dots"={enabled=false}}'));
writeFileSync(configFile, '[mcp_servers.replacement]\ncommand="fake"');
await runModel(base);
assert.ok(state.calls[1].options.configOverrides.includes('mcp_servers={"replacement"={enabled=false}}'));
assert.equal(state.calls[1].options.configOverrides.some(v => v.includes('name.with.dots')), false);
rmSync(configFile);
await runModel(base);
assert.equal(state.calls[2].options.configOverrides.length, 1);
`,
);

scenario(
  "provider errors replace every occurrence of the fake configured key and drop the original cause",
  String.raw`
state.error = new Error('Provider failed with fake-provider-key-value; repeated fake-provider-key-value', { cause: new Error('fake-provider-key-value') });
await assert.rejects(runModel(base), error => {
  assert.equal(error.message, 'Provider failed with [key]; repeated [key]');
  assert.equal(error.cause, undefined);
  assert.equal(String(error.stack).includes(settings.anthropic_api_key), false);
  return true;
});
state.error = new Error('Ordinary provider failure.');
await assert.rejects(runModel(base), error => error === state.error);
`,
);
