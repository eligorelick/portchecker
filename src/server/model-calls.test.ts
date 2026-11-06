import "./test-env.ts";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext, test } from "node:test";

import {
  mcpServersOff,
  readFilesForClaude,
  shrinkSectionFiles,
} from "./model.ts";
import { fullTextOmittedNote } from "./research/prompts.ts";

const url = (file: string) =>
  JSON.stringify(new URL(file, import.meta.url).href);

void test("Codex setup distinguishes a missing executable from signed-out and signed-in stubs on an isolated PATH", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "portchecker-codex-status-"));
  const bin = path.join(temp, "bin");
  const codexHome = path.join(temp, "codex-home");
  mkdirSync(bin);
  mkdirSync(codexHome);
  const script = `
    import assert from 'node:assert/strict';
    globalThis.fetch = async () => { throw new Error('Unexpected network call'); };
    const { codexStatus, setupProblems } = await import(${url("./model.ts")});
    const status = await codexStatus();
    const expected = process.env.STATUS_CASE;
    assert.equal(status.signedIn, expected === 'signed-in');
    assert.equal(status.installed, expected !== 'missing');
    const problems = await setupProblems({provider_mode:'chatgpt'});
    if (expected === 'missing') {
      assert.match(status.detail, /not installed or not on PATH/);
      assert.match(problems[0], /Install the Codex CLI/);
      assert.doesNotMatch(problems[0], /not signed in|codex login/);
    } else if (expected === 'signed-out') {
      assert.match(problems[0], /codex login/);
      assert.doesNotMatch(problems[0], /not installed/);
    } else {
      assert.match(status.detail, /Logged in using ChatGPT/);
      assert.deepEqual(problems, []);
    }
    process.stdout.write('status-complete');
  `;
  try {
    for (const status of ["missing", "signed-out", "signed-in"]) {
      if (status !== "missing") {
        const executable = path.join(
          bin,
          process.platform === "win32" ? "codex.cmd" : "codex",
        );
        const output =
          status === "signed-in" ? "Logged in using ChatGPT" : "Not logged in";
        const exit = status === "signed-in" ? 0 : 1;
        writeFileSync(
          executable,
          process.platform === "win32"
            ? `@echo off\r\necho ${output}\r\nexit /b ${exit}\r\n`
            : `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${exit}\n`,
        );
        if (process.platform !== "win32") chmodSync(executable, 0o755);
      }
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => name.toLowerCase() !== "path",
        ),
      );
      const run = spawnSync(
        process.execPath,
        ["--no-warnings", "--input-type=module", "-e", script],
        {
          cwd: temp,
          encoding: "utf8",
          timeout: 120_000,
          env: {
            ...environment,
            NODE_ENV: "test",
            PATH: bin,
            CODEX_HOME: codexHome,
            HOME: temp,
            USERPROFILE: temp,
            DATABASE_PATH: path.join(temp, "test.db"),
            STATUS_CASE: status,
          },
        },
      );
      assert.equal(run.status, 0, `${status}: ${run.stderr}`);
      assert.equal(run.stdout, "status-complete");
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

void test("app and identity child-process checks have a two-minute deadline", () => {
  for (const file of ["./app.test.ts", "./env-identity.test.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(
      source,
      /timeout:\s*120_000\b/,
      `${file} must bound its child process`,
    );
  }
});

// Each scenario runs in its own process with both real provider SDKs. Only what leaves the machine
// is replaced: Claude's HTTP calls are a stubbed fetch, and the Codex process is a stubbed spawn that
// records the arguments it was started with. The last Claude reply repeats, so a retry shows up as an
// extra request.
const harness = String.raw`
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { mock } from 'node:test';
import { z } from ${JSON.stringify(import.meta.resolve("zod"))};

const settings = {
  provider_mode: 'claude', analyst_provider: 'claude', fallback_enabled: true,
  claude_model: 'stub', claude_effort: '', codex_model: 'stub', codex_effort: 'medium',
};
mock.module(${url("./settings.ts")}, { namedExports: {
  getSettings: async () => settings,
  claudeApiKey: () => 'not-a-real-key',
  otherProvider: (p) => (p === 'claude' ? 'chatgpt' : 'claude'),
  providerLabel: (p) => (p === 'claude' ? 'Claude' : 'ChatGPT'),
} });

const codexRuns = [];
const codexFailures = [];
let codexText = '{"ok":true}';
mock.module('node:child_process', { namedExports: {
  exec: (command, options, callback) => callback(null, { stdout: 'Logged in', stderr: '' }),
  spawn: (file, args) => {
    codexRuns.push(args);
    const failure = codexFailures.shift();
    const events = failure
      ? [{ type: 'turn.failed', error: { message: failure } }]
      : [{ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: codexText } }, { type: 'turn.completed', usage: {} }];
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdout.on('end', () => child.emit('exit', 0, null));
    child.stdout.end(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return child;
  },
} });

const claudeRequests = [];
const claudeReplies = [];
globalThis.fetch = async (address, init) => {
  if (String(address).includes('/v1/models')) {
    return new Response(JSON.stringify({ id: 'stub', max_tokens: 128000, capabilities: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  claudeRequests.push(JSON.parse(init.body));
  return (claudeReplies.length > 1 ? claudeReplies.shift() : claudeReplies[0])(init);
};
const answer = (texts, stop_reason = 'end_turn', outputTokens = 50) => () => {
  const events = [{ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'stub', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1 } } }];
  texts.forEach((text, index) => events.push(
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index },
  ));
  events.push({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: outputTokens } }, { type: 'message_stop' });
  const body = events.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const claudeError = (status, type, message, extra = {}) => () =>
  new Response(JSON.stringify({ type: 'error', error: { type, message, ...extra }, request_id: 'req_011' }), { status, headers: { 'content-type': 'application/json', 'x-should-retry': 'false', 'request-id': 'req_011' } });

// Waits are skipped and the capacity wait is counted.
const realSetTimeout = globalThis.setTimeout;
const capacityWaits = [];
globalThis.setTimeout = (fn, ms, ...rest) => {
  if (ms === 60000) capacityWaits.push(ms);
  return realSetTimeout(fn, [5000, 10000, 60000].includes(ms) ? 1 : ms, ...rest);
};

const { runModel } = await import(${url("./model.ts")});
const { SCHEMA_RETRY_INSTRUCTION } = await import(${url("./research/prompts.ts")});
const schema = z.object({ ok: z.boolean() });
const call = (extra) => runModel({ role: 'test', workingDirectory: '.', prompt: 'PROMPT', schema, ...extra });
const codexConfig = (run = codexRuns.at(-1)) => run.filter((arg, i) => run[i - 1] === '--config');
const configValue = (name, run) => codexConfig(run).find((arg) => arg.startsWith(name + '='))?.slice(name.length + 1);
`;

function inChild(body: string, env: Record<string, string | undefined> = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), "portchecker-model-calls-"));
  const home = path.join(temp, "home");
  const codexHome = path.join(temp, "codex-home");
  mkdirSync(home);
  mkdirSync(codexHome);
  try {
    const run = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-test-module-mocks",
        "--input-type=module",
        "-e",
        `${harness}\n${body}\nprocess.exit(0);`,
      ],
      {
        cwd: temp,
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          DATABASE_PATH: path.join(temp, "test.db"),
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: codexHome,
          SETUP_HOME: home,
          ...env,
        },
      },
    );
    assert.equal(run.status, 0, run.stderr);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// Claude answers that the SDK must leave for this app to judge -------------------------------------

void test("an answer cut off at the token limit costs one request and says it ran out of room", () => {
  inChild(String.raw`
    claudeReplies.push(answer(['{"ok":'], 'max_tokens', 128000));
    const usage = [];
    await assert.rejects(call({ provider: 'claude', onUsage: (u) => usage.push(u) }), /ran out of room after 128000 output tokens/);
    assert.equal(claudeRequests.length, 1);
    assert.equal(usage.length, 1);

    const routed = await call({});
    assert.equal(routed.provider, 'chatgpt');
    assert.equal(routed.usedFallback, true);
    assert.match(routed.fallbackReason, /ran out of room/);
    assert.equal(claudeRequests.length, 2);
  `);
});

void test("an answer cut off by the context window costs one request", () => {
  inChild(String.raw`
    claudeReplies.push(answer(['{"ok":'], 'model_context_window_exceeded', 300));
    await assert.rejects(call({ provider: 'claude' }), /ran out of room after 300 output tokens/);
    assert.equal(claudeRequests.length, 1);
  `);
});

void test("a refusal after partial text is reported as a refusal on the first request", () => {
  inChild(String.raw`
    claudeReplies.push(answer(['I cannot help'], 'refusal', 12));
    await assert.rejects(call({ provider: 'claude' }), /Claude declined this request/);
    assert.equal(claudeRequests.length, 1);
  `);
});

void test("output that fails the schema gets the retry instruction on the same provider", () => {
  inChild(String.raw`
    claudeReplies.push(answer(['{"ok":"yes"}']), answer(['{"ok":true}']));
    const retried = await call({});
    assert.deepEqual(retried.data, { ok: true });
    assert.equal(retried.provider, 'claude');
    assert.equal(retried.usedFallback, false);
    assert.equal(claudeRequests.length, 2);
    assert.ok(!JSON.stringify(claudeRequests[0].messages).includes(SCHEMA_RETRY_INSTRUCTION));
    assert.ok(JSON.stringify(claudeRequests[1].messages).includes(SCHEMA_RETRY_INSTRUCTION));
    assert.equal(codexRuns.length, 0);
  `);
});

void test("output that fails the schema twice fails the call with no fallback", () => {
  inChild(String.raw`
    claudeReplies.push(answer(['{"ok":"yes"}']));
    await assert.rejects(call({}), /did not match the schema/);
    assert.equal(claudeRequests.length, 2);
    assert.equal(codexRuns.length, 0);
  `);
});

void test("web commentary before the JSON and JSON across two blocks both parse", () => {
  inChild(String.raw`
    claudeReplies.push(answer(['Let me search.', '{"ok":true}']), answer(['{"ok":', 'true}']));
    assert.deepEqual((await call({ provider: 'claude', webSearch: true })).data, { ok: true });
    assert.deepEqual((await call({ provider: 'claude', webSearch: true })).data, { ok: true });
    assert.equal(claudeRequests.length, 2);
  `);
});

void test("a paused web turn continues with what it has said so far", () => {
  inChild(String.raw`
    claudeReplies.push(answer(['Searching.'], 'pause_turn'), answer(['{"ok":true}']));
    assert.deepEqual((await call({ provider: 'claude', webSearch: true })).data, { ok: true });
    assert.equal(claudeRequests.length, 2);
    const sentBack = claudeRequests[1].messages.at(-1);
    assert.equal(sentBack.role, 'assistant');
    assert.ok(JSON.stringify(sentBack.content).includes('Searching.'));
  `);
});

void test("Claude is still sent the JSON schema the answer must follow", () => {
  inChild(String.raw`
    claudeReplies.push(answer(['{"ok":true}']));
    await call({ provider: 'claude' });
    const { format } = claudeRequests[0].output_config;
    assert.equal(format.type, 'json_schema');
    assert.deepEqual(format.schema.properties, { ok: { type: 'boolean' } });
    assert.equal(format.schema.additionalProperties, false);
  `);
});

// Which provider a call goes to --------------------------------------------------------------------

void test("after an analyst falls back, its checker goes to the provider that first failed", () => {
  inChild(String.raw`
    Object.assign(settings, { provider_mode: 'both', analyst_provider: 'chatgpt' });
    claudeReplies.push(answer(['{"ok":true}']));
    codexFailures.push('connection dropped');
    const analyst = await call({ role: 'analyst' });
    assert.equal(analyst.provider, 'claude');
    assert.equal(analyst.usedFallback, true);
    const checker = await call({ role: 'verifier', avoidProvider: analyst.provider });
    assert.equal(checker.provider, 'chatgpt');
    assert.equal(checker.usedFallback, false);
  `);
});

void test("the check is kept when the provider that first failed is still down", () => {
  inChild(String.raw`
    Object.assign(settings, { provider_mode: 'both', analyst_provider: 'chatgpt' });
    claudeReplies.push(answer(['{"ok":true}']));
    codexFailures.push('connection dropped');
    const checker = await call({ role: 'verifier', avoidProvider: 'claude' });
    assert.equal(codexRuns.length, 1);
    assert.equal(checker.provider, 'claude');
    assert.equal(checker.usedFallback, true);
  `);
});

void test("a normal Both day and a single provider mode route as before", () => {
  inChild(String.raw`
    Object.assign(settings, { provider_mode: 'both', analyst_provider: 'chatgpt' });
    claudeReplies.push(answer(['{"ok":true}']));
    const analyst = await call({ role: 'analyst' });
    assert.equal(analyst.provider, 'chatgpt');
    const checker = await call({ role: 'verifier', avoidProvider: analyst.provider });
    assert.equal(checker.provider, 'claude');
    assert.equal(checker.usedFallback, false);
    assert.equal((await call({ role: 'verifier' })).provider, 'claude');

    settings.provider_mode = 'chatgpt';
    const single = await call({ role: 'verifier', avoidProvider: 'chatgpt' });
    assert.equal(single.provider, 'chatgpt');
    assert.equal(single.usedFallback, false);
  `);
});

// When the first provider fails --------------------------------------------------------------------

void test("when both providers fail, the error names both failures", () => {
  inChild(String.raw`
    claudeReplies.push(claudeError(400, 'invalid_request_error', 'effort xhigh is not supported by this model'));
    codexFailures.push('Selected model is at capacity.', 'Selected model is at capacity.');
    await assert.rejects(call({ role: 'analyst' }), (error) => {
      assert.match(error.message, /^Claude failed \(.*effort xhigh is not supported by this model.*\), then ChatGPT failed \(Selected model is at capacity\.\)$/);
      assert.ok(!error.message.includes('\n'));
      return true;
    });
    assert.equal(claudeRequests.length, 1);
    assert.equal(codexRuns.length, 2);
    assert.equal(capacityWaits.length, 1);
  `);
});

void test("a fallback provider at capacity gets the same one minute wait", () => {
  inChild(String.raw`
    claudeReplies.push(claudeError(400, 'invalid_request_error', 'effort xhigh is not supported by this model'));
    codexFailures.push('Selected model is at capacity.');
    const result = await call({ role: 'analyst' });
    assert.equal(result.provider, 'chatgpt');
    assert.equal(result.usedFallback, true);
    assert.match(result.fallbackReason, /effort xhigh is not supported/);
    assert.equal(codexRuns.length, 2);
    assert.equal(capacityWaits.length, 1);
  `);
});

void test("with fallback off, the first error is passed on unchanged", () => {
  inChild(String.raw`
    settings.fallback_enabled = false;
    claudeReplies.push(claudeError(400, 'invalid_request_error', 'effort xhigh is not supported by this model'));
    await assert.rejects(call({ role: 'analyst' }), (error) => {
      assert.match(error.message, /effort xhigh is not supported/);
      assert.ok(!error.message.includes('failed ('));
      return true;
    });
    assert.equal(codexRuns.length, 0);
  `);
});

// What a failed Claude call says and counts --------------------------------------------------------

void test("a stalled call still counts the input Claude billed for, and is not retried", () => {
  inChild(String.raw`
    const wrapped = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => wrapped(fn, ms === 7200000 ? 20 : ms, ...rest);
    // The stall timer alone would not keep this process alive.
    setInterval(() => {}, 1000);
    const start = { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'stub', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50000, output_tokens: 1 } } };
    claudeReplies.push((init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message_start\ndata: ' + JSON.stringify(start) + '\n\n'));
        init.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const usage = [];
    await assert.rejects(call({ provider: 'claude', onUsage: (u) => usage.push(u) }), /The model sent nothing for 2 hours/);
    assert.equal(claudeRequests.length, 1);
    assert.deepEqual(usage, [{ inputTokens: 50000, outputTokens: 1, webSearches: 0 }]);
  `);
});

void test("a Claude API error reads as a sentence that keeps its type and request id", () => {
  inChild(String.raw`
    claudeReplies.push(claudeError(401, 'authentication_error', 'invalid x-api-key'));
    await assert.rejects(call({ provider: 'claude' }), (error) => {
      assert.equal(error.message, 'Claude error 401 (authentication_error): invalid x-api-key (request req_011)');
      return true;
    });
    assert.equal(claudeRequests.length, 1);
  `);
});

void test("an error sent in the middle of a stream has no status to show, and still gets its retries", () => {
  inChild(String.raw`
    const event = JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' }, request_id: 'req_022' });
    claudeReplies.push(() => new Response('event: error\ndata: ' + event + '\n\n', { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_022' } }));
    await assert.rejects(call({ provider: 'claude' }), (error) => {
      assert.equal(error.message, 'Claude error (overloaded_error): Overloaded (request req_022)');
      return true;
    });
    assert.equal(claudeRequests.length, 6);
    assert.equal(capacityWaits.length, 1);
  `);
});

void test("a key in an API error is gone from the message and from anything attached to it", () => {
  inChild(String.raw`
    const { inspect } = await import('node:util');
    claudeReplies.push(
      claudeError(401, 'authentication_error', 'bad key not-a-real-key was sent'),
      claudeError(400, 'invalid_request_error', 'bad header', { sent: 'not-a-real-key' }),
    );
    await assert.rejects(call({ provider: 'claude' }), (error) => {
      assert.equal(error.message, 'Claude error 401 (authentication_error): bad key [key] was sent (request req_011)');
      assert.ok(!inspect(error, { depth: 9 }).includes('not-a-real-key'));
      return true;
    });
    await assert.rejects(call({ provider: 'claude' }), (error) => {
      assert.equal(error.message, 'Claude error 400 (invalid_request_error): bad header (request req_011)');
      assert.ok(!inspect(error, { depth: 9 }).includes('not-a-real-key'));
      return true;
    });
  `);
});

void test("the readable message keeps the capacity wait, and a spend cap still stops at once", () => {
  inChild(String.raw`
    claudeReplies.push(claudeError(529, 'overloaded_error', 'Try again soon'));
    await assert.rejects(call({ provider: 'claude' }), /overloaded_error/);
    assert.equal(claudeRequests.length, 6);
    assert.equal(capacityWaits.length, 1);

    claudeRequests.length = 0;
    capacityWaits.length = 0;
    claudeReplies.length = 0;
    claudeReplies.push(claudeError(429, 'rate_limit_error', 'over the monthly limit', { details: { error_code: 'enforced_spend_limit_reached' } }));
    await assert.rejects(call({ provider: 'claude' }), /Claude error 429 \(rate_limit_error\): over the monthly limit/);
    assert.equal(claudeRequests.length, 1);
    assert.equal(capacityWaits.length, 0);
  `);
});

void test("a dropped connection and a body with no message keep the SDK's own words", () => {
  inChild(String.raw`
    const wrapped = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => wrapped(fn, ms <= 10000 ? 1 : ms, ...rest);
    claudeReplies.push(() => { throw new TypeError('fetch failed'); });
    await assert.rejects(call({ provider: 'claude' }), (error) => {
      assert.equal(error.message, 'Connection error.');
      return true;
    });

    claudeReplies.length = 0;
    claudeReplies.push(() => new Response('<html>Bad gateway</html>', { status: 400, headers: { 'x-should-retry': 'false' } }));
    await assert.rejects(call({ provider: 'claude' }), (error) => {
      assert.equal(error.message, '400 <html>Bad gateway</html>');
      return true;
    });
  `);
});

// What Claude is sent ------------------------------------------------------------------------------

const FILING_NAME = "filing_10-K_2026-02-06_1.txt";
const HEADCOUNT =
  "As of the end of the fiscal year the company employed approximately 42,000 people across 38 countries.";
const FILING = [
  "We design chips for data centers and sell them through a small group of partners.",
  "Our largest supplier manufactures most of our wafers under long-term agreements.",
  HEADCOUNT,
  "Competition in our markets is intense and new entrants appear each year.",
].join("\n\n");

function packFolder(t: TestContext, files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "portchecker-pack-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const excerptsIn = (sent: string) =>
  sent.slice(
    sent.indexOf("=== FILE: claim_excerpts.md ===\n") + 32,
    sent.indexOf("\n\n=== NOTE ==="),
  );

void test("a question brings in the filing passage that answers it, with no saved review", (t) => {
  const dir = packFolder(t, { "pack.json": "{}", [FILING_NAME]: FILING });
  const sent = readFilesForClaude(
    dir,
    "How many people does the company employ?",
  );
  assert.ok(sent.includes(HEADCOUNT));
  assert.ok(
    sent.indexOf("=== FILE: claim_excerpts.md ===") <
      sent.indexOf("=== NOTE ==="),
  );
});

void test("with no question, what is sent is what the review alone picks", (t) => {
  const bare = packFolder(t, { "pack.json": "{}", [FILING_NAME]: FILING });
  assert.equal(
    readFilesForClaude(bare),
    `=== FILE: pack.json ===\n{}\n\n${fullTextOmittedNote([FILING_NAME], false)}`,
  );
  // The review says nothing about staff, so the headcount stays out however the filing is searched.
  const reviewed = packFolder(t, {
    "pack.json": "{}",
    "review.json": JSON.stringify({
      what_changed: ["Our largest supplier manufactures most of our wafers."],
    }),
    [FILING_NAME]: FILING,
  });
  const sent = readFilesForClaude(reviewed);
  assert.ok(excerptsIn(sent).includes("Our largest supplier"));
  assert.ok(!sent.includes(HEADCOUNT));
});

void test("a question and a review both get their passages, the question's first", (t) => {
  const dir = packFolder(t, {
    "pack.json": "{}",
    "review.json": JSON.stringify({
      what_changed: ["Our largest supplier manufactures most of our wafers."],
    }),
    // A long line between them, so neither passage takes in the other as its lead-in.
    [FILING_NAME]: [
      "Our largest supplier manufactures most of our wafers under long-term agreements.",
      "Plain words about nothing in particular ".repeat(10),
      HEADCOUNT,
    ].join("\n\n"),
  });
  const excerpts = excerptsIn(
    readFilesForClaude(dir, "How many people does the company employ?"),
  );
  assert.ok(excerpts.includes(HEADCOUNT));
  assert.ok(excerpts.includes("Our largest supplier"));
  assert.ok(excerpts.indexOf(HEADCOUNT) < excerpts.indexOf("Our largest"));
});

void test("the question gets room first and the review's passages cannot push past the limit", (t) => {
  // Letters only, so each line has a word of its own for the search to find.
  const word = (i: number) =>
    `zq${i.toString(26).replace(/\d/g, (d) => "qrstuvwxyz".charAt(Number(d)))}`;
  const lines = Array.from(
    { length: 900 },
    (_, i) =>
      `The ${word(i)} widget licensing revenue increased strongly across every northern partner during the reported period.`,
  );
  const dir = packFolder(t, {
    "pack.json": "{}",
    "review.json": JSON.stringify({ what_changed: lines }),
    [FILING_NAME]: [...lines, HEADCOUNT].join("\n\n"),
  });
  const excerpts = excerptsIn(
    readFilesForClaude(dir, "How many people does the company employ?"),
  );
  assert.ok(excerpts.includes(HEADCOUNT));
  assert.ok(excerpts.length > 25_000, `${excerpts.length}`);
  assert.ok(excerpts.length <= 30_004, `${excerpts.length}`);
});

const sectionFile = (...sections: [string, number][]) => ({
  name: "filing_sections_20-F_2026-02-04_1.md",
  text: `# 20-F filed 2026-02-04\n\nSource: edgar:x\n\n${sections
    .map(([title, chars]) => `## ${title}\n\n${"x".repeat(chars)}\n\n`)
    .join("")}`,
});
const sectionChars = (text: string, title: string) =>
  text.split(`## ${title}\n\n`)[1]?.split("## ")[0]?.length ?? -1;

void test("a long MD&A leaves an annual report exhibit its heading and a share of the room", () => {
  const file = sectionFile(
    ["Risk Factors", 6_000],
    ["MD&A", 40_000],
    ["Annual report exhibit", 60_000],
  );
  const [kept] = shrinkSectionFiles([file], 40_000);
  assert.ok(kept);
  assert.ok(kept.text.length <= 40_000, `${kept.text.length}`);
  assert.ok(sectionChars(kept.text, "Risk Factors") > 6_000);
  assert.ok(sectionChars(kept.text, "Annual report exhibit") > 8_000);
  assert.ok(sectionChars(kept.text, "MD&A") > 20_000);
});

void test("an exhibit that needs less than its share leaves the rest to MD&A", () => {
  const file = sectionFile(
    ["Risk Factors", 6_000],
    ["MD&A", 40_000],
    ["Annual report exhibit", 3_000],
  );
  const [kept] = shrinkSectionFiles([file], 40_000);
  assert.ok(kept);
  assert.ok(kept.text.length <= 40_000, `${kept.text.length}`);
  assert.ok(
    kept.text.length > 39_950,
    `no room goes unused: ${kept.text.length}`,
  );
  assert.equal(sectionChars(kept.text, "Annual report exhibit"), 3_002);
});

void test("a file with one main section is cut as it always was", () => {
  const file = sectionFile(["Risk Factors", 6_000], ["MD&A", 40_000]);
  const [kept] = shrinkSectionFiles([file], 40_000);
  assert.ok(kept);
  const truncated = "\n[truncated]\n\n";
  const fits = 40_000 - file.text.indexOf("## MD&A") - truncated.length;
  assert.equal(
    kept.text,
    `${file.text.slice(0, file.text.indexOf("## MD&A") + fits)}${truncated}`,
  );
});

// The ticker page's two model calls ----------------------------------------------------------------

const tickerRoutes = String.raw`
  import { registerHooks } from 'node:module';
  import { pathToFileURL } from 'node:url';
  const src = ${JSON.stringify(path.resolve(import.meta.dirname, ".."))};
  registerHooks({ resolve(specifier, context, next) {
    if (!specifier.startsWith('~/')) return next(specifier, context);
    const base = path.join(src, specifier.slice(2));
    const file = [base + '.ts', base + '.js', path.join(base, 'index.ts')].find(fs.existsSync);
    return next(pathToFileURL(file).href, context);
  } });
  fs.mkdirSync('data/packs/2026-11-05/AAA', { recursive: true });
  fs.writeFileSync('data/packs/2026-11-05/AAA/pack.json', '{}');
  fs.writeFileSync('data/packs/2026-11-05/AAA/filing_10-K_2026-02-06_1.txt', 'We sell chips to partners worldwide.\n\nAt year end the company employed approximately 42,000 people across 38 countries.\n');
  const { tickersRouter } = await import(${url("./api/routers/tickers.ts")});
  const routes = tickersRouter.createCaller({});
  const question = 'How many people does the company employ?';
  const asked = () => routes.ask({ ticker: 'AAA', question });
  const answered = '{"answer":"42,000","evidence":[]}';
  const drafted = '{"thesis":["A reason to own it."],"break_conditions":[],"numbers_to_watch":[]}';
  const used = (input, output) => 'Claude usage: ' + input.toLocaleString() + ' tokens in, ' + output.toLocaleString() + ' out.';
  const sentText = (i) => claudeRequests[i].messages[0].content.at(-1).text;
`;

void test("Ask on Claude searches the filings for the question, and a thesis draft does not", () => {
  inChild(String.raw`
    ${tickerRoutes}
    claudeReplies.push(answer([answered]), answer([drafted]));
    assert.equal((await asked()).answer, '42,000');
    assert.ok(sentText(0).includes('employed approximately 42,000'));
    await routes.draftThesis({ ticker: 'AAA' });
    assert.ok(!sentText(1).includes('employed approximately 42,000'));
  `);
});

void test("Ask reports the Claude tokens it spent, and adds up a schema retry", () => {
  inChild(String.raw`
    ${tickerRoutes}
    claudeReplies.push(answer([answered]));
    assert.equal((await asked()).claudeUsage, used(1000, 50));

    claudeReplies.length = 0;
    claudeReplies.push(answer(['{"answer":1}'], 'end_turn', 7), answer([answered], 'end_turn', 50));
    assert.equal((await asked()).claudeUsage, used(2000, 57));
  `);
});

void test("Ask reports what Claude cost even when ChatGPT gave the answer", () => {
  inChild(String.raw`
    ${tickerRoutes}
    codexText = answered;
    claudeReplies.push(answer(['I cannot help'], 'refusal', 12));
    const result = await asked();
    assert.equal(result.provider, 'chatgpt');
    assert.equal(result.usedFallback, true);
    assert.equal(result.claudeUsage, used(1000, 12));
  `);
});

void test("a plain ChatGPT Ask has no usage to report", () => {
  inChild(String.raw`
    ${tickerRoutes}
    settings.provider_mode = 'chatgpt';
    codexText = answered;
    const result = await asked();
    assert.equal(result.provider, 'chatgpt');
    assert.equal(result.claudeUsage, '');
    assert.equal(claudeRequests.length, 0);
  `);
});

void test("a thesis draft reports the Claude tokens it spent", () => {
  inChild(String.raw`
    ${tickerRoutes}
    claudeReplies.push(answer([drafted]));
    assert.equal((await routes.draftThesis({ ticker: 'AAA' })).claudeUsage, used(1000, 50));
  `);
});

// What a Codex call is allowed to reach ------------------------------------------------------------

void test("server names are read from every way a config writes them, and nothing else", () => {
  const off = mcpServersOff(
    [
      "# a note",
      "#[mcp_servers.commented]",
      "[mcp_servers.a]",
      'command = "x"',
      "[mcp_servers.a.env]",
      'Z = "[mcp_servers.inside_a_value]"',
      '[mcp_servers."b c"]',
      'url = "u"',
      "[mcp_servers.'d e']",
      "  [mcp_servers.f-1] # a note",
      "[profiles.x.mcp_servers.other]",
      "[mcp_servers_not.g]",
    ].join("\r\n"),
  );
  assert.deepEqual(off, [
    'mcp_servers={"a"={enabled=false},"b c"={enabled=false},"d e"={enabled=false},"f-1"={enabled=false}}',
  ]);
});

void test("a config with no servers adds no override, since an empty table would do nothing", () => {
  assert.deepEqual(mcpServersOff(""), []);
  assert.deepEqual(
    mcpServersOff('model = "x"\n[features]\nplugins = true\n'),
    [],
  );
});

void test("every Codex call turns off the servers in the user's config, as it stands now", () => {
  inChild(String.raw`
    const config = path.join(process.env.CODEX_HOME, 'config.toml');
    const override = () => configValue('mcp_servers');
    fs.writeFileSync(config, '[mcp_servers.a]\ncommand="x"\n[mcp_servers.a.env]\nZ="1"\n[mcp_servers."b c"]\nurl="u"\n#[mcp_servers.x]\n');

    await call({ provider: 'chatgpt' });
    assert.equal(override(), '{"a"={enabled=false},"b c"={enabled=false}}');
    await call({ provider: 'chatgpt', webSearch: true });
    assert.equal(override(), '{"a"={enabled=false},"b c"={enabled=false}}');

    // A name left over from an old config would stop Codex starting, so nothing may be remembered.
    fs.writeFileSync(config, '[mcp_servers.a]\ncommand="x"\n');
    await call({ provider: 'chatgpt' });
    assert.equal(override(), '{"a"={enabled=false}}');

    fs.rmSync(config);
    assert.deepEqual(await call({ provider: 'chatgpt' }).then((r) => r.data), { ok: true });
    assert.equal(override(), undefined);
  `);
});

void test("with no CODEX_HOME the servers are read from .codex in the home folder", () => {
  inChild(
    String.raw`
      assert.equal(process.env.CODEX_HOME, undefined);
      fs.mkdirSync(path.join(process.env.SETUP_HOME, '.codex'));
      fs.writeFileSync(path.join(process.env.SETUP_HOME, '.codex', 'config.toml'), '[mcp_servers.a]\ncommand="x"\n');
      await call({ provider: 'chatgpt' });
      assert.equal(configValue('mcp_servers'), '{"a"={enabled=false}}');
    `,
    { CODEX_HOME: undefined },
  );
});

void test("database backups and other tools' credentials are denied when they exist, and only then", () => {
  inChild(String.raw`
    const home = process.env.SETUP_HOME;
    fs.mkdirSync('data/backups/before-trades', { recursive: true });
    fs.mkdirSync('data/imports', { recursive: true });
    for (const folder of ['.ssh', '.claude', '.azure']) fs.mkdirSync(path.join(home, folder));
    fs.writeFileSync(path.join(home, '.claude.json'), '{}');
    await call({ provider: 'chatgpt' });
    const rules = configValue('permissions.pack.filesystem');
    const denied = (file) => '"' + path.resolve(file).replaceAll('\\', '/') + '"="deny"';
    for (const file of ['data/backups', 'data/imports', ...['.ssh', '.claude', '.claude.json', '.azure'].map((f) => path.join(home, f))]) {
      assert.ok(rules.includes(denied(file)), file + ' should be denied in ' + rules);
    }
    // Codex creates an empty folder at a denied path that does not exist.
    assert.ok(!rules.includes('.gnupg'));
    assert.ok(!rules.includes('.aws'));
    assert.match(rules, /":root"="read"/);
  `);
});

void test("shell commands lose anything named like a secret, on file and web calls", () => {
  inChild(String.raw`
    const expected = '["*KEY*", "*TOKEN*", "*SECRET*", "SEC_USER_AGENT"]';
    await call({ provider: 'chatgpt' });
    assert.equal(configValue('shell_environment_policy.exclude'), expected);
    await call({ provider: 'chatgpt', webSearch: true });
    assert.equal(configValue('shell_environment_policy.exclude'), expected);
  `);
});

void test("web calls ask for whole results, without mentioning tools they do not have", () => {
  inChild(String.raw`
    const instructions = () => JSON.parse(configValue('developer_instructions'));
    await call({ provider: 'chatgpt', webSearch: true });
    assert.match(instructions(), /@exec: \{"max_output_tokens": 100000\}/);
    assert.doesNotMatch(instructions(), /exec_command|\brg\b/);
    assert.equal(configValue('tool_output_token_limit'), '100000');

    await call({ provider: 'chatgpt' });
    assert.match(instructions(), /@exec: \{"max_output_tokens": 100000\}/);
    assert.match(instructions(), /exec_command/);
    assert.equal(configValue('tool_output_token_limit'), '100000');
  `);
});

void test("a web call still has no shell and a file call still has no web", () => {
  inChild(String.raw`
    await call({ provider: 'chatgpt', webSearch: true });
    assert.equal(configValue('features.shell_tool'), 'false');
    assert.equal(configValue('features.unified_exec'), 'false');
    assert.equal(configValue('web_search'), '"live"');
    assert.equal(configValue('features.plugins'), 'false');
    await call({ provider: 'chatgpt' });
    assert.equal(configValue('features.shell_tool'), 'true');
    assert.equal(configValue('web_search'), '"disabled"');
    assert.equal(configValue('sandbox_workspace_write.network_access'), 'false');
    assert.equal(configValue('default_permissions'), '"pack"');
  `);
});

// Isolated SDK doubles expose stream retry decisions without SDK retries masking them.
const runtimeHarness = String.raw`
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { z } from __ZOD__;
process.chdir(__TEMP__);
const unexpectedNetwork = [];
globalThis.fetch = async () => { unexpectedNetwork.push('fetch'); throw new Error('Unexpected network call'); };
globalThis.state = { responses: [], requests: [], usage: [], codexOptions: null, threadOptions: null, codexEvents: null, codexInput: null, ready: true, codexMessage: '{"ok":true}', execOut: 'ready', delays: [] };
const state = globalThis.state;
state.claudeAuth={loggedIn:true,authMethod:'claude.ai'};
const settings = { provider_mode: 'claude', analyst_provider: 'claude', fallback_enabled: true, claude_model: 'stub', claude_effort: '', codex_model: 'stub', codex_effort: 'high', anthropic_api_key: 'fake-claude-key' };
globalThis.settings = settings;
mock.module(__SETTINGS__, { namedExports: { getSettings: async () => ({ ...settings }), claudeApiKey: (s) => s.anthropic_api_key, otherProvider: (p) => (p === 'claude' ? 'chatgpt' : 'claude'), providerLabel: (p) => (p === 'claude' ? 'Claude' : 'ChatGPT') } });
mock.module('node:child_process', { namedExports: {
  exec: (command, options, callback) => {
    if(command === 'claude auth status --json') {
      state.cliAuthOptions = options;
      return callback(null, {stdout:JSON.stringify(state.claudeAuth ?? {loggedIn:false,authMethod:'none'}),stderr:''});
    }
    assert.ok(['codex login status', 'codex debug models'].includes(command), command);
    return state.ready ? callback(null, { stdout: state.execOut, stderr: '' }) : callback(new Error(state.execError ?? 'not signed in'));
  },
  spawn: (command,args,options) => {
    if(!state.cliResponses)throw new Error('Unexpected provider process');
    assert.ok(state.cliResponses?.length,'No stubbed CLI reply remains');
    const reply=state.cliResponses.shift();
    const request={command,args,options};
    (state.cliRequests ??= []).push(request);
    const child=new EventEmitter();
    child.stdout=new PassThrough(); child.stderr=new PassThrough();
    child.kill=()=>{queueMicrotask(()=>child.emit('close',143));return true;};
    child.stdin={on(){return this;},end(input){
      request.input=input;
      queueMicrotask(()=>{
        if(reply.error){child.emit('error',new Error(reply.error));return;}
        const output=(reply.events??[]).map(e=>JSON.stringify(e)).join('\n')+'\n';
        const midpoint=Math.floor(output.length/2);
        child.stdout.emit('data',Buffer.from(output.slice(0,midpoint)));
        child.stdout.emit('data',Buffer.from(output.slice(midpoint)));
        if(reply.stderr)child.stderr.emit('data',Buffer.from(reply.stderr));
        if(!reply.hang)child.emit('close',reply.code??0);
      });
    }};
    return child;
  }
} });
const AnthropicError = class extends Error {};
const APIError = class extends AnthropicError {
  constructor(status, error, retryAfter) {
    super('api error');
    this.status = status;
    this.error = error;
    this.headers = new Headers(retryAfter ? { 'retry-after': retryAfter } : {});
  }
};
class FakeAnthropic {
  static AnthropicError = AnthropicError;
  static APIError = APIError;
  models = { retrieve: async () => ({ max_tokens: 128000 }), list: async function* () { yield* state.claudeModels ?? []; } };
  messages = {
    stream: (request) => {
      state.requests.push(request);
      assert.ok(state.responses.length, 'No stubbed Claude reply remains');
      const reply = state.responses.shift();
      let rejectHang;
      return {
        on() { return this; },
        abort() { rejectHang?.(new Error('Request was aborted.')); },
        get currentMessage() { return reply?.partial; },
        finalMessage: async () => {
          if (reply?.hang) return new Promise((_, reject) => { rejectHang = reject; });
          if (reply instanceof Error) throw reply;
          if (reply?.fails) throw reply.fails;
          return reply;
        },
      };
    },
  };
}
mock.module(__SDK__, { defaultExport: FakeAnthropic });
mock.module(__CODEX__, {
  namedExports: {
    Codex: class {
      constructor(options) { state.codexOptions = options; }
      startThread(options) {
        state.threadOptions = options;
        return {
          runStreamed: async (input, options) => {
            state.codexInput = input;
            return {
              events: (async function* () {
                if (state.codexHang) await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
                for (const e of state.codexEvents ?? [{ type: 'item.completed', item: { type: 'agent_message', text: state.codexMessage } }, { type: 'turn.completed', usage: {} }]) yield e;
              })(),
            };
          },
        };
      }
    },
  },
});
// Retry waits are recorded and skipped. The two-hour stall timer keeps its real length.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  if (ms < 3_600_000) state.delays.push(ms);
  return realSetTimeout(fn, ms < 3_600_000 || state.stallNow ? 0 : ms, ...args);
};
const { runModel, retryIfAtCapacity, setupProblems, codexStatus, claudeCodeStatus, listClaudeModels, listCodexModels, readFilesForClaude } = await import(__MODEL__);
const text = (t, stop_reason = 'end_turn', extra = {}) => ({ usage: { input_tokens: 10, output_tokens: 2 }, content: [{ type: 'text', text: t }], model: 'stub', stop_reason, ...extra });
const schema = z.object({ ok: z.boolean() });
const base = { role: 'analyst', workingDirectory: '.', prompt: 'p', schema, onUsage: (u) => state.usage.push(u) };
const claudeOnly = { ...base, provider: 'claude' };
const chatgptOnly = { ...base, provider: 'chatgpt' };
`;

function runtimeScenario(name: string, body: string) {
  void test(name, () => {
    const temp = mkdtempSync(path.join(tmpdir(), "portchecker-runtime-"));
    const home = path.join(temp, "home");
    const codexHome = path.join(temp, "codex-home");
    mkdirSync(home);
    mkdirSync(codexHome);
    const script = runtimeHarness
      .replace("__ZOD__", JSON.stringify(import.meta.resolve("zod")))
      .replace("__TEMP__", JSON.stringify(temp))
      .replace(
        "__SETTINGS__",
        JSON.stringify(new URL("./settings.ts", import.meta.url).href),
      )
      .replace(
        "__SDK__",
        JSON.stringify(import.meta.resolve("@anthropic-ai/sdk")),
      )
      .replace(
        "__CODEX__",
        JSON.stringify(import.meta.resolve("@openai/codex-sdk")),
      )
      .replace(
        "__MODEL__",
        JSON.stringify(new URL("./model.ts", import.meta.url).href),
      );
    try {
      const run = spawnSync(
        process.execPath,
        [
          "--no-warnings",
          "--experimental-test-module-mocks",
          "--input-type=module",
          "-e",
          script +
            body +
            '\nassert.deepEqual(unexpectedNetwork, []); process.stdout.write(\"runtime-complete\");',
        ],
        {
          cwd: temp,
          encoding: "utf8",
          timeout: 120_000,
          env: {
            ...process.env,
            DATABASE_PATH: path.join(temp, "test.db"),
            HOME: home,
            USERPROFILE: home,
            CODEX_HOME: codexHome,
            ANTHROPIC_API_KEY: "fake-env-key",
            OPENAI_API_KEY: "",
            FMP_API_KEY: "fake-fmp-key",
          },
        },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(
        run.stdout,
        "runtime-complete",
        "the scenario must reach its last assertion",
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}

runtimeScenario(
  "subscription readiness requires native Claude login and needs no API key",
  String.raw`
settings.claude_auth_mode='subscription'; settings.anthropic_api_key='';
state.claudeAuth={loggedIn:true,authMethod:'claude.ai',subscriptionType:'max',email:'private@example.test'};
assert.equal((await claudeCodeStatus()).signedIn,true);
assert.doesNotMatch(JSON.stringify(await claudeCodeStatus()),/private@example/);
assert.deepEqual(await setupProblems(settings),[]);
assert.equal(state.cliAuthOptions.env.ANTHROPIC_API_KEY,undefined);
assert.ok((await listClaudeModels(settings)).some(m=>m.id==='claude-opus-5-5'));
state.claudeAuth={loggedIn:true,authMethod:'api_key'};
assert.equal((await claudeCodeStatus()).signedIn,false);
assert.match((await setupProblems(settings))[0],/claude auth login/);
`,
);

runtimeScenario(
  "subscription calls stream structured JSON with read-only tools and no API credentials",
  String.raw`
settings.claude_auth_mode='subscription'; settings.claude_model='claude-opus-5-5'; settings.claude_effort='xhigh'; settings.fallback_enabled=false;
process.env.ANTHROPIC_AUTH_TOKEN='fake-bearer'; process.env.ANTHROPIC_BASE_URL='https://wrong.invalid'; process.env.CLAUDE_CODE_USE_BEDROCK='1';
state.cliResponses=[{events:[{type:'result',is_error:false,structured_output:{ok:true},usage:{input_tokens:21,output_tokens:8},modelUsage:{'claude-opus-5-5':{}}}]}];
const answer=await runModel(claudeOnly);
assert.deepEqual(answer.data,{ok:true});
assert.match(answer.model,/claude-opus-5-5.*xhigh.*subscription/);
assert.deepEqual(answer.usage,{inputTokens:21,outputTokens:8,webSearches:0});
assert.equal(state.requests.length,0);
const r=state.cliRequests[0];
for(const flag of ['--safe-mode','--restricted','--strict-mcp-config','--no-session-persistence'])assert.ok(r.args.includes(flag),flag);
assert.equal(r.args[r.args.indexOf('--permission-prompts')+1],'none');
assert.equal(r.args[r.args.indexOf('--tools')+1],'Read,Grep,Glob');
assert.equal(r.args[r.args.indexOf('--model')+1],'claude-opus-5-5');
assert.equal(r.args[r.args.indexOf('--effort')+1],'xhigh');
assert.ok(!r.args.includes('--bare'));
for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK','FMP_API_KEY'])assert.equal(r.options.env[key],undefined,key);
assert.equal(r.options.shell,false);
assert.equal(r.options.windowsHide,true);
assert.match(JSON.parse(r.input).message.content.at(-1).text,/p/);
`,
);

runtimeScenario(
  "subscription web and image calls preserve inputs without mixing file and web tools",
  String.raw`
settings.claude_auth_mode='subscription'; settings.fallback_enabled=false;
const reply=()=>({events:[{type:'result',is_error:false,structured_output:{ok:true}}]});
state.cliResponses=[reply(),reply()];
await runModel({...claudeOnly,webSearch:true});
assert.equal(state.cliRequests[0].args[state.cliRequests[0].args.indexOf('--tools')+1],'WebSearch,WebFetch');
fs.writeFileSync('picture.png',Buffer.from([1,2,3]));
await runModel({...claudeOnly,images:['picture.png']});
const content=JSON.parse(state.cliRequests[1].input).message.content;
assert.equal(content[0].type,'image');assert.equal(content[0].source.data,'AQID');
assert.equal(content[0].source.media_type,'image/png');
assert.equal(state.requests.length,0);
`,
);

runtimeScenario(
  "subscription schema retry stays on the CLI and twice-invalid output never falls back",
  String.raw`
settings.claude_auth_mode='subscription';
const reply=data=>({events:[{type:'result',is_error:false,structured_output:data}]});
state.cliResponses=[reply({ok:'wrong'}),reply({ok:true})];
assert.deepEqual((await runModel(claudeOnly)).data,{ok:true});
assert.equal(state.cliRequests.length,2);
state.cliResponses=[reply({ok:'wrong'}),reply({ok:'still wrong'})];
await assert.rejects(runModel(claudeOnly),/did not match the schema/);
assert.equal(state.codexOptions,null);assert.equal(state.requests.length,0);
`,
);

runtimeScenario(
  "subscription failures, omitted structured output and cut-off answers cannot save a result",
  String.raw`
settings.claude_auth_mode='subscription'; settings.fallback_enabled=false;
for(const response of [
 {events:[{type:'result',is_error:true,result:'Subscription limit reached.'}],code:1},
 {events:[{type:'result',is_error:false,result:'{"ok":true}'}]},
 {events:[{type:'result',is_error:false,structured_output:{ok:true},stop_reason:'max_tokens'}]},
 {error:'CLI unavailable'}
]){state.cliResponses=[response];await assert.rejects(runModel(claudeOnly));}
assert.equal(state.requests.length,0);
`,
);

runtimeScenario(
  "subscription usage includes partial deltas and all model calls without double counting",
  String.raw`
settings.claude_auth_mode='subscription';settings.fallback_enabled=false;
state.cliResponses=[{events:[
 {type:'stream_event',event:{type:'message_start',message:{id:'m1',usage:{input_tokens:17,output_tokens:1}}}},
 {type:'stream_event',event:{type:'message_delta',usage:{output_tokens:11}}},
 {type:'assistant',message:{id:'m1',usage:{input_tokens:17,output_tokens:1}}}
],code:1}];
await assert.rejects(runModel(claudeOnly));
assert.deepEqual(state.usage.pop(),{inputTokens:17,outputTokens:11,webSearches:0});
state.cliResponses=[{events:[{type:'result',is_error:false,structured_output:{ok:true},usage:{input_tokens:10,output_tokens:5},modelUsage:{'claude-opus-5-5':{inputTokens:30,outputTokens:15}}}]}];
const result=await runModel(claudeOnly);
assert.deepEqual(result.usage,{inputTokens:30,outputTokens:15,webSearches:0});
assert.deepEqual(state.usage.pop(),result.usage);
`,
);

runtimeScenario(
  "cached input: final per-model and aggregate totals include every input category once",
  String.raw`
settings.claude_auth_mode='subscription'; settings.fallback_enabled=false;
const expected={inputTokens:157,outputTokens:11,webSearches:0,uncachedInputTokens:17,cacheReadInputTokens:100,cacheCreationInputTokens:40};
for(const counters of [
 {usage:{input_tokens:17,cache_read_input_tokens:100,cache_creation_input_tokens:40,output_tokens:11}},
 {usage:{input_tokens:1,output_tokens:2},modelUsage:{'claude-opus-5-5':{inputTokens:17,cacheReadInputTokens:100,cacheCreationInputTokens:40,outputTokens:11}}},
 {modelUsage:{first:{inputTokens:10,cacheReadInputTokens:60,cacheCreationInputTokens:25,outputTokens:6},second:{inputTokens:7,cacheReadInputTokens:40,cacheCreationInputTokens:15,outputTokens:5}}}
]) {
 state.cliResponses=[{events:[{type:'result',is_error:false,structured_output:{ok:true},...counters}]}];
 const result=await runModel(claudeOnly);
 assert.deepEqual(result.usage,expected);
 assert.deepEqual(state.usage.pop(),expected);
}
state.cliResponses=[{events:[{type:'result',is_error:false,structured_output:{ok:true},modelUsage:{stub:{cacheReadInputTokens:100,cacheCreationInputTokens:40}}}]}];
assert.deepEqual((await runModel(claudeOnly)).usage,{inputTokens:140,outputTokens:0,webSearches:0,uncachedInputTokens:0,cacheReadInputTokens:100,cacheCreationInputTokens:40});
assert.equal(state.usage.pop().inputTokens,140);
`,
);

runtimeScenario(
  "cached input: partial deltas, duplicate snapshots and placeholders never lower or duplicate counters",
  String.raw`
settings.claude_auth_mode='subscription'; settings.fallback_enabled=false;
const events=[
 {type:'stream_event',event:{type:'message_start',message:{id:'m1',usage:{input_tokens:17,cache_read_input_tokens:20,cache_creation_input_tokens:10,output_tokens:1}}}},
 {type:'stream_event',event:{type:'message_delta',usage:{cache_read_input_tokens:100,cache_creation_input_tokens:40,output_tokens:11}}},
 {type:'stream_event',event:{type:'message_delta',usage:{cache_read_input_tokens:100,cache_creation_input_tokens:40,output_tokens:11}}},
 {type:'assistant',message:{id:'m1',usage:{input_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:0}}}
];
const expected={inputTokens:157,outputTokens:11,webSearches:0,uncachedInputTokens:17,cacheReadInputTokens:100,cacheCreationInputTokens:40};
state.cliResponses=[{events,code:1,stderr:'Connection lost'}];
await assert.rejects(runModel(claudeOnly),/Connection lost/);
assert.deepEqual(state.usage.pop(),expected);
// A smaller or incomplete final aggregate cannot replace known billed work.
for(const final of [{usage:{input_tokens:0,output_tokens:0}},{modelUsage:{stub:{outputTokens:1}}}]) {
 state.cliResponses=[{events:[...events,{type:'result',is_error:false,structured_output:{ok:true},...final}]}];
 assert.deepEqual((await runModel(claudeOnly)).usage,expected);
 assert.deepEqual(state.usage.pop(),expected);
}
// The final aggregate is another snapshot, not another message.
state.cliResponses=[{events:[...events,{type:'result',is_error:false,structured_output:{ok:true},usage:{input_tokens:17,cache_read_input_tokens:100,cache_creation_input_tokens:40,output_tokens:11}}]}];
assert.deepEqual((await runModel(claudeOnly)).usage,expected);
assert.deepEqual(state.usage.pop(),expected);
`,
);

runtimeScenario(
  "cached input: separate partial messages and stalled streams retain their full totals",
  String.raw`
settings.claude_auth_mode='subscription'; settings.fallback_enabled=false;
const events=[
 {type:'stream_event',event:{type:'message_start',message:{id:'one',usage:{input_tokens:10,cache_read_input_tokens:60,cache_creation_input_tokens:25,output_tokens:1}}}},
 {type:'stream_event',event:{type:'message_delta',usage:{output_tokens:6}}},
 {type:'assistant',message:{id:'one',usage:{input_tokens:10,cache_read_input_tokens:60,cache_creation_input_tokens:25,output_tokens:6}}},
 {type:'stream_event',event:{type:'message_start',message:{id:'two',usage:{input_tokens:7,cache_read_input_tokens:40,cache_creation_input_tokens:15,output_tokens:1}}}},
 {type:'stream_event',event:{type:'message_delta',usage:{output_tokens:5}}}
];
state.cliResponses=[{events,code:1}];
await assert.rejects(runModel(claudeOnly));
const expected={inputTokens:157,outputTokens:11,webSearches:0,uncachedInputTokens:17,cacheReadInputTokens:100,cacheCreationInputTokens:40};
assert.deepEqual(state.usage.pop(),expected);
const keepAlive=setInterval(()=>{},1000); state.stallNow=true;
try {
 state.cliResponses=[{events,hang:true}];
 await assert.rejects(runModel(claudeOnly),/sent nothing for 2 hours/);
 assert.deepEqual(state.usage.pop(),expected);
} finally {clearInterval(keepAlive);}
`,
);

runtimeScenario(
  "cached input: API continuations, stream retries and schema retries use the same total definition",
  String.raw`
const counters={input_tokens:17,cache_read_input_tokens:100,cache_creation_input_tokens:40,output_tokens:11};
const expected={inputTokens:157,outputTokens:11,webSearches:0,uncachedInputTokens:17,cacheReadInputTokens:100,cacheCreationInputTokens:40};
state.responses=[text('{"ok":true}','end_turn',{usage:counters})];
assert.deepEqual((await runModel(claudeOnly)).usage,expected);
assert.deepEqual(state.usage.pop(),expected);
state.responses=[text('continue','pause_turn',{usage:counters}),text('{"ok":true}','end_turn',{usage:counters})];
const twice={...expected,inputTokens:314,outputTokens:22,uncachedInputTokens:34,cacheReadInputTokens:200,cacheCreationInputTokens:80};
assert.deepEqual((await runModel(claudeOnly)).usage,twice);
assert.equal(state.usage.splice(0).length,2);
state.responses=[{fails:new APIError(500,{error:{}}),partial:{usage:counters}},text('{"ok":true}','end_turn',{usage:counters})];
assert.deepEqual((await runModel(claudeOnly)).usage,twice);
assert.deepEqual(state.usage.splice(0),[expected,expected]);
state.responses=[text('invalid','end_turn',{usage:counters}),text('{"ok":true}','end_turn',{usage:counters})];
assert.deepEqual((await runModel(claudeOnly)).usage,twice);
assert.deepEqual(state.usage.splice(0),[expected,expected]);
`,
);

runtimeScenario(
  "cached input: capacity retries and fallback preserve failed billed work without replaying callbacks",
  String.raw`
settings.claude_auth_mode='subscription';
const usage={input_tokens:17,cache_read_input_tokens:100,cache_creation_input_tokens:40,output_tokens:11};
const failed=result=>({events:[{type:'result',is_error:true,result,usage}],code:1});
const success={events:[{type:'result',is_error:false,structured_output:{ok:true},usage}]};
const expected={inputTokens:157,outputTokens:11,webSearches:0,uncachedInputTokens:17,cacheReadInputTokens:100,cacheCreationInputTokens:40};
state.cliResponses=[failed('Overloaded'),success];
assert.deepEqual((await runModel(claudeOnly)).usage,{...expected,inputTokens:314,outputTokens:22,uncachedInputTokens:34,cacheReadInputTokens:200,cacheCreationInputTokens:80});
assert.deepEqual(state.usage.splice(0),[expected,expected]);
state.cliResponses=[{events:[{type:'result',is_error:false,structured_output:{ok:'wrong'},usage}]},success];
assert.deepEqual((await runModel(claudeOnly)).usage,{...expected,inputTokens:314,outputTokens:22,uncachedInputTokens:34,cacheReadInputTokens:200,cacheCreationInputTokens:80});
assert.deepEqual(state.usage.splice(0),[expected,expected]);
state.cliResponses=[failed('Connection lost')];
const result=await runModel(base);
assert.equal(result.provider,'chatgpt'); assert.equal(result.usedFallback,true);
assert.deepEqual(result.usage,expected);
assert.deepEqual(state.usage.splice(0),[expected]);
`,
);

runtimeScenario(
  "subscription failed and silent calls retain partial usage and the existing silence limit",
  String.raw`
settings.claude_auth_mode='subscription'; settings.fallback_enabled=false;
state.cliResponses=[{events:[{type:'assistant',message:{usage:{input_tokens:7,output_tokens:3}}}],code:1,stderr:'Connection lost'}];
await assert.rejects(runModel(claudeOnly),/Connection lost|failed|result/);
assert.ok(state.usage.some(u=>u.inputTokens===7&&u.outputTokens===3));
const keepAlive=setInterval(()=>{},1000);state.stallNow=true;
state.cliResponses=[{hang:true}];
await assert.rejects(runModel(claudeOnly),/sent nothing for 2 hours/);
clearInterval(keepAlive);
`,
);

runtimeScenario(
  "a silent model is stopped and the error says why, on both providers",
  String.raw`
// The stall timer is unref'd, so something has to hold the process open while it fires.
const keepAlive = setInterval(() => {}, 1000);
state.stallNow = true;
state.responses.push({ hang: true });
await assert.rejects(runModel(claudeOnly), /sent nothing for 2 hours/);
state.codexHang = true;
await assert.rejects(runModel(chatgptOnly), /sent nothing for 2 hours/);
clearInterval(keepAlive);
`,
);

runtimeScenario(
  "codex: a failed turn fails, and only an agent message is the answer",
  String.raw`
state.codexEvents = [{ type: 'turn.failed', error: { message: 'rate limited upstream' } }];
await assert.rejects(runModel(chatgptOnly), /rate limited upstream/);
state.codexEvents = [
  { type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } },
  { type: 'item.completed', item: { type: 'reasoning', text: 'thinking aloud' } },
  { type: 'turn.completed', usage: {} },
];
assert.deepEqual((await runModel(chatgptOnly)).data, { ok: true });
`,
);

runtimeScenario(
  "codex status: a missing CLI reads differently from a missing sign-in",
  String.raw`
state.ready = false;
assert.equal((await codexStatus()).detail, 'Not signed in.');
assert.equal((await codexStatus()).signedIn, false);
for (const message of ["'codex' is not recognized as an internal or external command", 'codex: command not found', 'spawn codex ENOENT']) {
  state.execError = message;
  const status = await codexStatus();
  assert.equal(status.detail, 'Codex is not installed or not on PATH.', message);
  assert.equal(status.installed, false);
  assert.match(status.advice, /Install the Codex CLI/);
  settings.provider_mode = 'chatgpt';
  const problems = await setupProblems(settings);
  assert.match(problems[0], /not installed or not on PATH/);
  assert.doesNotMatch(problems[0], /not signed in|codex login/);
}
state.execError = null;
settings.provider_mode = 'chatgpt';
assert.match((await setupProblems(settings))[0], /codex login/);
settings.provider_mode = 'both';
settings.anthropic_api_key = '';
assert.equal((await setupProblems(settings)).length, 2);
state.ready = true;
settings.anthropic_api_key = 'k';
assert.deepEqual(await setupProblems(settings), []);
assert.equal((await codexStatus()).installed, true);
`,
);

runtimeScenario(
  "routing: in Both mode only the verifier goes to the other provider",
  String.raw`
settings.provider_mode = 'both';
settings.analyst_provider = 'chatgpt';
state.responses = [text('{"ok":true}')];
assert.equal((await runModel({ ...base, role: 'verifier' })).provider, 'claude');
assert.equal((await runModel({ ...base, role: 'analyst' })).provider, 'chatgpt');
assert.equal((await runModel({ ...base, role: 'brief' })).provider, 'chatgpt');
for (const role of ['ask', 'research', 'test']) {
  assert.equal((await runModel({ ...base, role })).provider, 'chatgpt');
}
settings.analyst_provider = 'claude';
for (const role of ['analyst', 'brief', 'ask', 'research', 'test']) {
  state.responses = [text('{"ok":true}')];
  assert.equal((await runModel({ ...base, role })).provider, 'claude');
}
assert.equal((await runModel({ ...base, role: 'verifier' })).provider, 'chatgpt');
`,
);

runtimeScenario(
  "fallback: it is off when disabled, off when the other provider is not ready, and never for bad JSON",
  String.raw`
const down = () => new APIError(400, { error: { type: 'invalid_request_error' } });
settings.fallback_enabled = false;
state.responses = [down()];
await assert.rejects(runModel(base));
assert.equal(state.threadOptions, null, 'the other provider was not called');
settings.fallback_enabled = true;
state.ready = false;
state.responses = [down()];
await assert.rejects(runModel(base));
assert.equal(state.threadOptions, null);
state.ready = true;
state.responses = [text('{"wrong":1}'), text('{"wrong":2}')];
await assert.rejects(runModel(base), /did not match the schema/);
assert.equal(state.threadOptions, null, 'schema failures do not fall back');
state.responses = [down()];
await assert.rejects(runModel({ ...base, provider: 'claude' }));
assert.equal(state.threadOptions, null, 'a test of one provider does not fall back');
state.responses = [down()];
const fell = await runModel(base);
assert.equal(fell.usedFallback, true);
assert.equal(fell.provider, 'chatgpt');
`,
);

runtimeScenario(
  "a failed ChatGPT call cannot bill Claude when its key is missing or fallback is disabled",
  String.raw`
settings.provider_mode = 'chatgpt';
state.codexEvents = [{ type: 'turn.failed', error: { message: 'provider unavailable' } }];
settings.anthropic_api_key = '';
await assert.rejects(runModel(base), /provider unavailable/);
assert.equal(state.requests.length, 0);
settings.anthropic_api_key = 'fake-claude-key';
settings.fallback_enabled = false;
await assert.rejects(runModel(base), /provider unavailable/);
assert.equal(state.requests.length, 0);
settings.fallback_enabled = true;
state.responses = [text('{"ok":true}')];
const fallback = await runModel(base);
assert.equal(fallback.provider, 'claude');
assert.equal(fallback.usedFallback, true);
assert.equal(fallback.fallbackReason, 'provider unavailable');
assert.equal(state.requests.length, 1);
`,
);

runtimeScenario(
  "provider doubles reject unplanned HTTP, process and stream requests",
  String.raw`
await assert.rejects(globalThis.fetch('https://example.invalid'), /Unexpected network call/);
assert.deepEqual(unexpectedNetwork, ['fetch']);
unexpectedNetwork.length = 0;
const { spawn } = await import('node:child_process');
assert.throws(() => spawn('unexpected-provider'), /Unexpected provider process/);
assert.throws(() => new FakeAnthropic().messages.stream({}), /No stubbed Claude reply remains/);
`,
);

runtimeScenario(
  "schema retry: a transport failure does not retry, and the retry says what was wrong",
  String.raw`
state.responses = [text('not json'), text('{"ok":true}')];
assert.deepEqual((await runModel(claudeOnly)).data, { ok: true });
assert.equal(state.requests.length, 2);
assert.doesNotMatch(state.requests[0].messages[0].content.at(-1).text, /Return only/i);
assert.notEqual(state.requests[1].messages[0].content.at(-1).text, state.requests[0].messages[0].content.at(-1).text);
state.requests.length = 0;
state.responses = [new APIError(400, { error: {} })];
await assert.rejects(runModel(claudeOnly));
assert.equal(state.requests.length, 1);
`,
);

runtimeScenario(
  "stream retry: the retryable statuses retry, up to three tries, and others do not",
  String.raw`
const tries = async (...replies) => {
  state.requests.length = 0;
  state.delays.length = 0;
  state.responses = replies;
  await runModel(claudeOnly).catch(() => undefined);
  return { requests: state.requests.length, delays: [...state.delays] };
};
const ok = text('{"ok":true}');
for (const status of [408, 409, 429, 500, 503]) {
  assert.deepEqual(await tries(new APIError(status, { error: {} }), ok), { requests: 2, delays: [5000] }, String(status));
}
assert.equal((await tries(new APIError(undefined, { error: {} }), ok)).requests, 2, 'a dropped connection has no status');
assert.equal((await tries(new AnthropicError('stream ended'), ok)).requests, 2);
for (const reply of [new APIError(400, { error: {} }), new APIError(401, { error: {} }), new Error('a bug of ours')]) {
  assert.equal((await tries(reply, ok)).requests, 1, reply.message);
}
const busy = () => new APIError(529, { error: {} });
assert.deepEqual(await tries(busy(), busy(), busy(), busy()), { requests: 3, delays: [5000, 10000] });
`,
);

runtimeScenario(
  "stream retry: retry-after is honoured, floored, and refused past five minutes",
  String.raw`
const after = (value) => new APIError(429, { error: {} }, value);
const tries = async (...replies) => {
  state.requests.length = 0;
  state.delays.length = 0;
  state.responses = replies;
  await runModel(claudeOnly).catch(() => undefined);
  return { requests: state.requests.length, delays: [...state.delays] };
};
const ok = text('{"ok":true}');
assert.deepEqual(await tries(after('30'), ok), { requests: 2, delays: [30000] });
assert.deepEqual(await tries(after('2'), ok), { requests: 2, delays: [5000] });
assert.deepEqual(await tries(after('soon'), ok), { requests: 2, delays: [5000] });
assert.equal((await tries(after('301'), ok)).requests, 1);
`,
);

runtimeScenario(
  "a key in a provider's error never reaches the log",
  String.raw`
state.responses = [new Error('failed with fake-claude-key in the header')];
await assert.rejects(runModel(claudeOnly), (e) => !e.message.includes('fake-claude-key') && e.message.includes('[key]'));
`,
);

runtimeScenario(
  "claude: cut-off answers, refusals and billed partial streams",
  String.raw`
state.responses = [text('{"ok":true}', 'model_context_window_exceeded')];
await assert.rejects(runModel(claudeOnly), /ran out of room/);
state.responses = [text('{"ok":true}', 'max_tokens')];
await assert.rejects(runModel(claudeOnly), /ran out of room/);
state.responses = [text('{"ok":true}', 'refusal')];
await assert.rejects(runModel(claudeOnly), /declined/);
state.usage.length = 0;
state.responses = [{ fails: new APIError(400, { error: {} }), partial: { usage: { input_tokens: 7, output_tokens: 3 } } }];
await assert.rejects(runModel(claudeOnly));
assert.deepEqual(state.usage, [{ inputTokens: 7, outputTokens: 3, webSearches: 0 }]);
`,
);

runtimeScenario(
  "claude: commentary before the JSON is dropped, and JSON across blocks is joined",
  String.raw`
const blocks = (...texts) => ({ ...text(''), content: texts.map((t) => ({ type: 'text', text: t })) });
state.responses = [blocks('Here is what I found. ', '{"ok":true}')];
assert.deepEqual((await runModel(claudeOnly)).data, { ok: true });
state.responses = [blocks('{"ok":', 'true}')];
assert.deepEqual((await runModel(claudeOnly)).data, { ok: true });
`,
);

runtimeScenario(
  "claude: web search caps its uses, uses its own prompt and reads no files",
  String.raw`
fs.writeFileSync('pack.json', '{"sentinel":"PACK_SENTINEL"}');
state.responses = [text('{"ok":true}')];
await runModel({ ...claudeOnly, webSearch: true });
const web = state.requests.at(-1);
assert.equal(web.tools[0].max_uses, 5);
assert.doesNotMatch(web.messages[0].content.at(-1).text, /PACK_SENTINEL/);
state.responses = [text('{"ok":true}')];
await runModel(claudeOnly);
const plain = state.requests.at(-1);
assert.match(plain.messages[0].content.at(-1).text, /PACK_SENTINEL/);
assert.notEqual(web.system, plain.system);
assert.equal(plain.tools, undefined);
`,
);

runtimeScenario(
  "claude: effort goes in the request and the model label",
  String.raw`
settings.claude_effort = 'high';
state.responses = [text('{"ok":true}')];
const result = await runModel(claudeOnly);
assert.equal(state.requests.at(-1).output_config.effort, 'high');
assert.equal(result.model, 'stub, high effort');
settings.claude_effort = '';
state.responses = [text('{"ok":true}')];
const plain = await runModel(claudeOnly);
assert.equal(state.requests.at(-1).output_config.effort, undefined);
assert.equal(plain.model, 'stub');
`,
);

runtimeScenario(
  "capacity: overloaded and at capacity both wait once",
  String.raw`
for (const message of ['Overloaded', 'Selected model is at capacity.']) {
  let calls = 0;
  const value = await retryIfAtCapacity(async () => {
    if (++calls === 1) throw new Error(message);
    return 'done';
  }, 1);
  assert.equal(value, 'done');
  assert.equal(calls, 2);
}
`,
);

runtimeScenario(
  "codex models: only listed models are offered, with their efforts",
  String.raw`
state.execOut = JSON.stringify({ models: [
  { slug: 'a', display_name: 'A', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] },
  { slug: 'hidden', visibility: 'hide' },
] });
assert.deepEqual(await listCodexModels(), [{ id: 'a', name: 'A', efforts: ['high'] }]);
`,
);

runtimeScenario(
  "claude models: only the efforts the model accepts are offered",
  String.raw`
state.claudeModels = [
  { id: 'a', capabilities: { effort: { supported: true, low: { supported: true }, high: { supported: false } } } },
  { id: 'b', capabilities: { effort: { supported: false, low: { supported: true } } } },
  { id: 'c' },
];
assert.deepEqual(await listClaudeModels(settings), [
  { id: 'a', efforts: ['low'] },
  { id: 'b', efforts: [] },
  { id: 'c', efforts: [] },
]);
`,
);
