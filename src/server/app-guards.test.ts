import "./test-env.ts";

import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import nodeModule, { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";

import { TRPCError, type AnyRouter } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { z } from "zod";

const root = path.resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(path.join(tmpdir(), "portchecker-guards-"));
const originalEnv = { ...process.env };
process.env.FMP_API_KEY = "fake-fmp-guards-value";
process.env.ANTHROPIC_API_KEY = "fake-anthropic-env-guards-5678";
delete process.env.ALLOWED_HOSTS;
const network = mock.method(globalThis, "fetch", () => {
  throw new Error("Unexpected network request in guard tests.");
});
mock.timers.enable({ apis: ["Date"], now: new Date(2030, 0, 15, 12) });
// Anything a route writes relative to the working directory lands here, not in the real data folder.
process.chdir(temp);
after(() => {
  mock.timers.reset();
  network.mock.restore();
  for (const name of ["FMP_API_KEY", "ANTHROPIC_API_KEY", "ALLOWED_HOSTS"]) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
  process.chdir(root);
  client.close();
  rmSync(temp, { recursive: true, force: true });
});

// The installed Node types predate this function. It resolves the app's path alias and Next's
// entry point, which Node cannot find without a file extension.
const { registerHooks } = nodeModule as unknown as {
  registerHooks: (hooks: {
    resolve: (
      specifier: string,
      context: unknown,
      next: (specifier: string, context: unknown) => unknown,
    ) => unknown;
  }) => void;
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/server") return next("next/server.js", context);
    if (!specifier.startsWith("~/")) return next(specifier, context);
    const base = path.join(root, "src", specifier.slice(2));
    const file =
      [`${base}.ts`, `${base}.js`, path.join(base, "index.ts")].find(
        existsSync,
      ) ?? base;
    return next(pathToFileURL(file).href, context);
  },
});

const { appRouter } = await import("./api/root.ts");
const { createTRPCContext, createTRPCRouter, publicProcedure, tickerInput } =
  await import("./api/trpc.ts");
const { client } = await import("./db/index.ts");
const { today } = await import("./fmp.ts");
const { middleware } = await import("../middleware.ts");
const { NextRequest } = await import("next/server.js");

const TABLES = [
  "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
  "CREATE TABLE holdings (ticker TEXT, name TEXT, quantity REAL, cost_basis REAL, account_label TEXT, updated_at TEXT, PRIMARY KEY(ticker,account_label));",
  "CREATE TABLE tickers (ticker TEXT PRIMARY KEY, cik TEXT, sector TEXT, industry TEXT, fmp_profile_json TEXT, last_full_review_at TEXT);",
  "CREATE TABLE filings (accession_no TEXT, ticker TEXT, form TEXT, filed_at TEXT, primary_doc_url TEXT, items TEXT, sections_json TEXT, processed_at TEXT, PRIMARY KEY(accession_no,ticker));",
  "CREATE TABLE fmp_cache (ticker TEXT, endpoint TEXT, fetched_on TEXT, payload_json TEXT, PRIMARY KEY(ticker,endpoint,fetched_on));",
  "CREATE TABLE research_runs (id INTEGER PRIMARY KEY, started_at TEXT, heartbeat_at TEXT, finished_at TEXT, status TEXT, provider_mode TEXT, usage_json TEXT, log_text TEXT DEFAULT '', brief_id INTEGER);",
  "CREATE TABLE ticker_updates (id INTEGER PRIMARY KEY, run_id INTEGER, ticker TEXT, review_depth TEXT, result_json TEXT, verification_json TEXT, verified_score REAL, analyst_provider TEXT, analyst_model TEXT, verifier_provider TEXT, verifier_model TEXT, used_fallback INTEGER DEFAULT 0, revised_after_review INTEGER DEFAULT 0, created_at TEXT);",
  "CREATE TABLE briefs (id INTEGER PRIMARY KEY, run_id INTEGER, date TEXT, provider TEXT, model TEXT, result_json TEXT, markdown TEXT);",
  "CREATE TABLE decisions (id INTEGER PRIMARY KEY, ticker TEXT, date TEXT, action_taken TEXT, note TEXT, created_at TEXT);",
].join("");
await client.executeMultiple(TABLES);

/** One request the way the browser sends it, so the error reaches the formatter the page reads. */
async function post(router: AnyRouter, name: string, input: unknown) {
  const res = await fetchRequestHandler({
    endpoint: "/api/trpc",
    req: new Request(`http://127.0.0.1:3000/api/trpc/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: input }),
    }),
    router,
    createContext: createTRPCContext,
  });
  const body = (await res.json()) as {
    error?: { json: { message: string; data: { code: string } } };
  };
  return {
    status: res.status,
    message: body.error?.json.message,
    code: body.error?.json.data.code,
  };
}

void test("the hand form stores BRK.B under the name a CSV import gives it", async () => {
  const res = await post(appRouter, "holdings.upsert", {
    ticker: "brk.b",
    quantity: 1,
    costBasis: null,
  });
  assert.equal(res.status, 200, res.message);
  const stored = await client.execute(
    "SELECT ticker FROM holdings WHERE quantity = 1",
  );
  assert.deepEqual(
    stored.rows.map((r) => r.ticker),
    ["BRK-B"],
  );
});

void test("every route reads a ticker the same way", () => {
  for (const [typed, stored] of [
    ["brk/b", "BRK-B"],
    ["BF.B", "BF-B"],
    [" aapl ", "AAPL"],
    ["BRK-B", "BRK-B"],
    ["VOO", "VOO"],
  ] as const) {
    assert.equal(tickerInput.parse(typed), stored);
  }
});

void test("a ticker that cannot name a folder comes back as one plain sentence", async () => {
  for (const ticker of ["../x", "..", "", "1A"]) {
    const res = await post(appRouter, "holdings.upsert", {
      ticker,
      quantity: 2,
      costBasis: null,
    });
    assert.equal(res.status, 400);
    assert.equal(res.message, "Enter a valid ticker.");
  }
  const stored = await client.execute(
    "SELECT ticker FROM holdings WHERE quantity = 2",
  );
  assert.equal(stored.rows.length, 0);
});

void test("the limits on real form fields read as sentences, not as code", async () => {
  const tooLong = await post(appRouter, "tickers.ask", {
    ticker: "ZZTEST",
    question: "x".repeat(2001),
  });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.message ?? "", /2,000 characters/);

  const blankModel = await post(appRouter, "settings.save", {
    provider_mode: "claude",
    analyst_provider: "claude",
    fallback_enabled: false,
    codex_model: "",
    codex_effort: "high",
    claude_model: "   ",
    claude_effort: "",
  });
  assert.equal(blankModel.status, 400);
  for (const { message } of [tooLong, blankModel]) {
    assert.doesNotMatch(message ?? "", /[{[]|expected|>=|<=/);
    assert.ok(message);
  }
});

void test("screenshot limits say which files to choose before any model runs", async () => {
  const none = await post(appRouter, "holdings.parseScreenshots", {
    images: [],
  });
  assert.equal(none.status, 400);
  assert.equal(none.message, "Choose at least one screenshot.");
  const many = await post(appRouter, "holdings.parseScreenshots", {
    images: Array.from({ length: 13 }, () => ({
      name: "screen.png",
      dataUrl: "",
    })),
  });
  assert.equal(many.status, 400);
  assert.equal(many.message, "Choose at most 12 screenshots at a time.");
});

void test("zod's stock limits become sentences and a route's own words stay", async () => {
  const router = createTRPCRouter({
    blank: publicProcedure
      .input(z.object({ text: z.string().min(1) }))
      .mutation(() => "ok"),
    long: publicProcedure
      .input(z.object({ text: z.string().max(2000) }))
      .mutation(() => "ok"),
    none: publicProcedure
      .input(z.object({ list: z.array(z.string()).min(1) }))
      .mutation(() => "ok"),
    many: publicProcedure
      .input(z.object({ list: z.array(z.string()).max(12) }))
      .mutation(() => "ok"),
    own: publicProcedure
      .input(z.object({ text: z.string().max(1, "Keep it short.") }))
      .mutation(() => "ok"),
    both: publicProcedure
      .input(
        z.object({
          a: z.string().min(1, "Enter a."),
          b: z.string().min(1, "Enter b."),
        }),
      )
      .mutation(() => "ok"),
  });
  const message = async (name: string, input: unknown) =>
    (await post(router, name, input)).message;
  assert.equal(
    await message("blank", { text: "" }),
    "A required field is blank.",
  );
  assert.equal(
    await message("long", { text: "x".repeat(2001) }),
    "Keep this to 2,000 characters or fewer.",
  );
  assert.equal(await message("none", { list: [] }), "Add at least one.");
  assert.equal(
    await message("many", { list: Array(13).fill("x") }),
    "Add at most 12 at a time.",
  );
  assert.equal(await message("own", { text: "xx" }), "Keep it short.");
  assert.equal(await message("both", { a: "", b: "" }), "Enter a. Enter b.");
});

void test("an error that is not a validation keeps its text and its code", async () => {
  const router = createTRPCRouter({
    boom: publicProcedure.mutation(() => {
      throw new Error("The model is at capacity.");
    }),
    conflict: publicProcedure.mutation(() => {
      throw new TRPCError({ code: "CONFLICT", message: "Changed elsewhere." });
    }),
  });
  const boom = await post(router, "boom", {});
  assert.equal(boom.status, 500);
  assert.equal(boom.message, "The model is at capacity.");
  const conflict = await post(router, "conflict", {});
  assert.equal(conflict.status, 409);
  assert.equal(conflict.code, "CONFLICT");
  assert.equal(conflict.message, "Changed elsewhere.");
});

function request(host: string, method = "GET", origin?: string) {
  return new NextRequest(`http://${host}/`, {
    method,
    headers: { host, ...(origin ? { origin } : {}) },
  });
}

void test("no other site can frame the app, and pages load images only from the app", () => {
  for (const req of [
    request("127.0.0.1:3000"),
    request("localhost:3000"),
    request("127.0.0.1:3000", "POST", "http://127.0.0.1:3000"),
  ]) {
    const res = middleware(req);
    assert.equal(res.headers.get("x-middleware-next"), "1");
    assert.equal(
      res.headers.get("content-security-policy"),
      "frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'",
    );
  }
});

void test("every response says how to treat it, and none names the framework", async () => {
  const { default: nextConfig } = (await import(
    pathToFileURL(path.join(root, "next.config.js")).href
  )) as {
    default: {
      poweredByHeader?: boolean;
      headers?: () => Promise<
        { source: string; headers: { key: string; value: string }[] }[]
      >;
    };
  };
  assert.equal(nextConfig.poweredByHeader, false);
  // The middleware skips static files, so these are set where every path gets them.
  assert.deepEqual(await nextConfig.headers?.(), [
    {
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "same-origin" },
      ],
    },
  ]);
});

void test("a page on another site cannot make the API run with a GET", async () => {
  const get = (path: string, site?: string) =>
    middleware(
      new NextRequest(`http://127.0.0.1:3000${path}`, {
        headers: {
          host: "127.0.0.1:3000",
          ...(site ? { "sec-fetch-site": site } : {}),
        },
      }),
    );
  // An <img> or a script tag elsewhere sends no Origin on a GET, but the browser says where it is from.
  for (const site of ["cross-site", "same-site"]) {
    const refused = get("/api/trpc/settings.codexStatus", site);
    assert.equal(refused.status, 403);
    assert.match(await refused.text(), /Cross-site requests/);
  }
  // The app's own requests, an address typed by hand, and tools that are not browsers still pass.
  for (const site of ["same-origin", "none", undefined])
    assert.equal(get("/api/trpc/settings.codexStatus", site).status, 200);
  // Following a link from another site to a page is ordinary navigation.
  assert.equal(get("/holdings", "cross-site").status, 200);
});

void test("the host and origin checks still refuse before anything else", async () => {
  const foreign = middleware(request("evil.example"));
  assert.equal(foreign.status, 403);
  assert.match(await foreign.text(), /does not accept requests/);

  for (const origin of ["https://evil.example", "null"]) {
    const crossSite = middleware(request("127.0.0.1:3000", "POST", origin));
    assert.equal(crossSite.status, 403);
    assert.match(await crossSite.text(), /Cross-site/);
  }

  process.env.ALLOWED_HOSTS = "mac.local";
  try {
    assert.equal(middleware(request("mac.local:3000")).status, 200);
  } finally {
    delete process.env.ALLOWED_HOSTS;
  }
});

void test("only exact local or explicitly allowed hosts can reach the app", () => {
  const check = (host?: string) =>
    middleware(
      new NextRequest("http://127.0.0.1:3000/", {
        headers: host === undefined ? {} : { host },
      }),
    ).status;
  for (const host of [
    "127.0.0.1:3000",
    "localhost:3000",
    "[::1]:3000",
    "localhost",
  ])
    assert.equal(check(host), 200, host);
  for (const host of [
    "evil.example",
    "evil.localhost:3000",
    "localhost.:3000",
    "0.0.0.0:3000",
    undefined,
  ])
    assert.equal(check(host), 403, String(host));
  process.env.ALLOWED_HOSTS = " home.lan , other.lan ";
  try {
    assert.equal(check("home.lan:3000"), 200);
    assert.equal(check("other.lan"), 200);
    assert.equal(check("evil.home.lan"), 403);
  } finally {
    delete process.env.ALLOWED_HOSTS;
  }
});

void test("every write method refuses foreign, opaque, malformed and different-port origins", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const origin of [
      "https://evil.example",
      "null",
      "http://127.0.0.1:5173",
      "not a url",
    ])
      assert.equal(
        middleware(request("127.0.0.1:3000", method, origin)).status,
        403,
        `${method}: ${origin}`,
      );
    assert.equal(
      middleware(request("127.0.0.1:3000", method, "http://127.0.0.1:3000"))
        .status,
      200,
    );
    assert.equal(middleware(request("127.0.0.1:3000", method)).status, 200);
  }
  for (const method of ["GET", "HEAD"])
    assert.equal(
      middleware(request("localhost:3000", method, "https://evil.example"))
        .status,
      200,
    );
  process.env.ALLOWED_HOSTS = "home.lan";
  try {
    assert.equal(
      middleware(request("home.lan:3000", "POST", "http://home.lan:3000"))
        .status,
      200,
    );
    assert.equal(
      middleware(request("home.lan:3000", "POST", "http://localhost:3000"))
        .status,
      403,
    );
  } finally {
    delete process.env.ALLOWED_HOSTS;
  }
});

void test("GET cannot delete a holding, while the same input sent by POST can", async () => {
  const { GET, POST } = await import("../app/api/trpc/[trpc]/route.ts");
  await client.execute(
    "INSERT INTO holdings (ticker, quantity, account_label) VALUES ('ZZGUARD', 3, '')",
  );
  const input = { json: { ticker: "ZZGUARD", accountLabel: "" } };
  const url = "http://127.0.0.1:3000/api/trpc/holdings.delete";
  // This expected protocol error is normally logged by the route.
  const errorLog = mock.method(console, "error", () => undefined);
  try {
    const response = await GET(
      new NextRequest(
        `${url}?input=${encodeURIComponent(JSON.stringify(input))}`,
      ),
    );
    assert.equal(response.status, 405);
    assert.equal(
      (await client.execute("SELECT * FROM holdings WHERE ticker='ZZGUARD'"))
        .rows.length,
      1,
    );
    const posted = await POST(
      new NextRequest(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
    assert.equal(posted.status, 200);
    assert.equal(
      (await client.execute("SELECT * FROM holdings WHERE ticker='ZZGUARD'"))
        .rows.length,
      0,
    );
  } finally {
    errorLog.mock.restore();
  }
});

void test("the settings response masks saved and environment keys and saving keeps, replaces or clears the saved key", async () => {
  const { saveSettings, getSettings } = await import("./settings.ts");
  const caller = appRouter.createCaller(createTRPCContext());
  const secret = "fake-anthropic-saved-guards-1234";
  const input = {
    provider_mode: "claude" as const,
    analyst_provider: "claude" as const,
    fallback_enabled: false,
    codex_model: "",
    codex_effort: "medium" as const,
    claude_model: "fake-model",
    claude_effort: "" as const,
  };
  await saveSettings({ ...input, anthropic_api_key: secret });
  try {
    const shown = await caller.settings.get();
    assert.equal(Object.hasOwn(shown, "anthropic_api_key"), false);
    assert.equal(shown.keyLast4, "1234");
    assert.equal(shown.keySource, "settings");
    assert.equal(shown.fmpKeySet, true);
    assert.doesNotMatch(JSON.stringify(shown), /fake-anthropic|fake-fmp/);
    await caller.settings.save(input);
    assert.equal((await getSettings()).anthropic_api_key, secret);
    await caller.settings.save({
      ...input,
      anthropic_api_key: "fake-replacement-9012",
    });
    assert.equal(
      (await getSettings()).anthropic_api_key,
      "fake-replacement-9012",
    );
    await caller.settings.save({
      ...input,
      clear_key: true,
      anthropic_api_key: "fake-must-not-be-saved",
    });
    assert.equal((await getSettings()).anthropic_api_key, "");
    const cleared = await caller.settings.get();
    assert.equal(cleared.keyLast4, "5678");
    assert.equal(cleared.keySource, "env");
    assert.equal(Object.hasOwn(cleared, "anthropic_api_key"), false);
    const originalExec = childProcess.exec;
    // A wrapper made by mock.method keeps exec's custom promisifier and would run the real CLI.
    childProcess.exec = (() => {
      throw new Error("Fake sign-in failure");
    }) as unknown as typeof childProcess.exec;
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        caller.settings.save({
          ...input,
          provider_mode: "both",
          claude_model: "refused",
        }),
        /ChatGPT is not signed in/,
      );
      assert.equal((await getSettings()).claude_model, input.claude_model);
    } finally {
      childProcess.exec = originalExec;
      syncBuiltinESMExports();
    }
  } finally {
    await client.execute("DELETE FROM settings");
  }
});

void test("a failed settings write never repeats the key it was saving", async () => {
  const { saveSettings } = await import("./settings.ts");
  const secret = "fake-anthropic-failed-write-4321";
  // The database driver's own error quotes the statement's parameters, the key among them.
  await client.execute(
    "CREATE TRIGGER refuse_key BEFORE INSERT ON settings WHEN NEW.key = 'anthropic_api_key' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END",
  );
  try {
    await assert.rejects(
      saveSettings({ claude_model: "fake-model", anthropic_api_key: secret }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^Could not save settings\./);
        assert.doesNotMatch(inspect(error, { depth: 9 }), /fake-anthropic/);
        return true;
      },
    );
  } finally {
    await client.execute("DROP TRIGGER refuse_key");
    await client.execute("DELETE FROM settings");
  }
});

void test("an omitted or undefined authentication mode keeps subscription readiness when an old client saves", async () => {
  const { saveSettings, getSettings } = await import("./settings.ts");
  const caller = appRouter.createCaller(createTRPCContext());
  await saveSettings({
    provider_mode: "claude",
    claude_auth_mode: "subscription",
    claude_model: "saved-model",
    anthropic_api_key: "fake-retained-api-key",
  });
  const originalExec = childProcess.exec;
  // Readiness is the only CLI boundary. This never starts a process or a model call.
  childProcess.exec = (() => {
    throw new Error("Fake subscription sign-in failure");
  }) as unknown as typeof childProcess.exec;
  syncBuiltinESMExports();
  try {
    for (const mode of [{}, { claude_auth_mode: undefined }]) {
      await assert.rejects(
        caller.settings.save({
          provider_mode: "claude",
          analyst_provider: "chatgpt",
          fallback_enabled: false,
          codex_model: "",
          codex_effort: "medium",
          claude_model: "must-not-save",
          claude_effort: "",
          ...mode,
        }),
        /Could not confirm Claude subscription sign-in/,
      );
      assert.equal((await getSettings()).claude_model, "saved-model");
      assert.equal((await getSettings()).claude_auth_mode, "subscription");
    }
  } finally {
    childProcess.exec = originalExec;
    syncBuiltinESMExports();
    await client.execute("DELETE FROM settings");
  }
});

void test("launch problems redact every known key and generic credential format before reaching the browser", async () => {
  const { saveSettings } = await import("./settings.ts");
  const caller = appRouter.createCaller(createTRPCContext());
  const saved = "fake-saved-launch-value";
  await saveSettings({ anthropic_api_key: saved });
  mkdirSync("data", { recursive: true });
  const fakeSecrets = [
    saved,
    "fake-fmp-guards-value",
    "fake-anthropic-env-guards-5678",
    "sk-fake-generic-provider-value",
    "fake-bearer-value",
    "fake-token-value",
    "fake-password-value",
    "fake-query-value",
  ];
  writeFileSync(
    "data/last-run.log",
    `Could not start: ${saved} ${saved} fake-fmp-guards-value fake-anthropic-env-guards-5678 sk-fake-generic-provider-value Bearer fake-bearer-value token=fake-token-value password:fake-password-value https://example.invalid/?api_key=fake-query-value&safe=kept`,
  );
  try {
    const problem = await caller.runs.launchProblem();
    assert.ok(problem);
    assert.match(problem, /Could not start:/);
    assert.match(problem, /\[key\]/);
    assert.match(problem, /safe=kept/);
    for (const secret of fakeSecrets)
      assert.equal(problem.includes(secret), false, secret);
  } finally {
    await client.execute("DELETE FROM settings");
    rmSync("data/last-run.log");
  }
});

void test("an active research run and a repeated click cannot launch another process", async () => {
  let spawned = 0;
  const launch = mock.method(childProcess, "spawn", () => {
    spawned++;
    return {
      on() {
        return this;
      },
      unref() {
        return this;
      },
    } as unknown as ReturnType<typeof childProcess.spawn>;
  });
  syncBuiltinESMExports();
  const caller = appRouter.createCaller(createTRPCContext());
  const now = new Date().toISOString();
  await client.execute({
    sql: "INSERT INTO research_runs (id, started_at, heartbeat_at, status, provider_mode) VALUES (9001, ?, ?, 'running', 'chatgpt')",
    args: [now, now],
  });
  try {
    assert.deepEqual(await caller.runs.start(), { started: false });
    assert.equal(spawned, 0);
    await client.execute("DELETE FROM research_runs WHERE id=9001");
    mock.timers.tick(6000);
    assert.deepEqual(await caller.runs.start(), { started: true });
    assert.deepEqual(await caller.runs.start(), { started: false });
    assert.equal(spawned, 1);
  } finally {
    await client.execute("DELETE FROM research_runs WHERE id=9001");
    launch.mock.restore();
    syncBuiltinESMExports();
  }
});

void test("import reads stay in the imports folder and an invalid CSV leaves holdings unchanged", async () => {
  const caller = appRouter.createCaller(createTRPCContext());
  mkdirSync("data/imports", { recursive: true });
  writeFileSync("data/outside.csv", "outside sentinel");
  writeFileSync("data/imports/outside.csv", "inside sentinel");
  for (const name of [
    "outside.csv",
    path.join("..", "outside.csv"),
    path.resolve("data/outside.csv"),
  ])
    assert.deepEqual(await caller.holdings.readImportFile({ name }), {
      csv: "inside sentinel",
    });
  const before = (
    await client.execute(
      "SELECT * FROM holdings ORDER BY ticker, account_label",
    )
  ).rows;
  await assert.rejects(
    caller.holdings.import({ csv: "hello,world" }),
    /No positions found/,
  );
  assert.deepEqual(
    (
      await client.execute(
        "SELECT * FROM holdings ORDER BY ticker, account_label",
      )
    ).rows,
    before,
  );
});

void test("git ignores local data and operational records without hiding source files", (t) => {
  const ignored = (file: string) =>
    spawnSync("git", ["check-ignore", "--no-index", "-q", file], {
      cwd: root,
      timeout: 120_000,
    }).status;
  const probe = ignored("src/server/db/schema.ts");
  if (probe !== 0 && probe !== 1) {
    t.skip("not a git checkout");
    return;
  }
  for (const file of [
    "foo.db",
    "other/x.db",
    "a.db-wal",
    "a.db-shm",
    "db.sqlite",
    "a.sqlite",
    "prisma/db.sqlite-journal",
    "other/portfolio.sqlite3",
    "other/portfolio.sqlite3-wal",
    "other/portfolio.sqlite3-shm",
    "other/portfolio.sqlite3-journal",
    "data/portfolio.db",
    "backups/source-copy.ts",
    "research-output.log",
    "docs/PLAN.md",
    "docs/PROGRESS.md",
    "docs/AUDIT-FIX-PLAN.md",
    "docs/REPORT-FIX-PLAN.md",
    "docs/CLAUDE-SUBSCRIPTION-PLAN.md",
  ]) {
    assert.equal(ignored(file), 0, `${file} should be ignored`);
  }
  for (const file of [
    "src/server/db/schema.ts",
    "src/server/db/index.ts",
    "drizzle.config.ts",
    "AGENTS.md",
    "README.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "docs/public-guide.md",
  ]) {
    assert.equal(ignored(file), 1, `${file} should not be ignored`);
  }
});

// `pnpm pack:ticker`, run as a real process with every fetch answered here so that nothing can
// reach a vendor. fmp is "quote" for a working symbol, "empty" for one the vendor does not know, or
// a status. sec is "ok" or a status.
const FETCH_STUB = `
  import { mock } from "node:test";
  mock.timers.enable({ apis: ["Date"], now: new Date(2030, 0, 15, 12) });
  const answer = (body) => new Response(JSON.stringify(body), { status: 200 });
  const fmp = process.env.STUB_FMP;
  const sec = process.env.STUB_SEC;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname.endsWith("sec.gov")) {
      if (sec !== "ok") return new Response("", { status: Number(sec) });
      if (url.pathname.endsWith("company_tickers.json"))
        return answer({ 0: { cik_str: 1, ticker: "BRK-B" } });
      const recent = { accessionNumber: [], form: [], filingDate: [], primaryDocument: [], items: [] };
      return answer({ filings: { recent, files: [] } });
    }
    if (url.hostname !== "financialmodelingprep.com")
      throw new Error("Unexpected request to " + url.hostname);
    if (fmp !== "quote" && fmp !== "empty")
      return new Response("", { status: Number(fmp) });
    if (fmp === "quote" && url.pathname.endsWith("/quote"))
      return answer([{ symbol: url.searchParams.get("symbol"), price: 100 }]);
    return answer([]);
  };
`;

/** Runs in its own process, because Windows will not delete a database this process has opened. */
function tickerRows(cwd: string, statements = "") {
  const run = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
      import { createClient } from ${JSON.stringify(import.meta.resolve("@libsql/client"))};
      const db = createClient({ url: "file:test.db" });
      await db.executeMultiple(${JSON.stringify(statements)});
      const { rows } = await db.execute("SELECT ticker FROM tickers");
      console.log(JSON.stringify(rows.map((r) => r.ticker)));
      db.close();
      `,
    ],
    { cwd, encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout) as string[];
}

function packFolder(name: string, seed = "") {
  const cwd = path.join(temp, name);
  mkdirSync(path.join(cwd, "data"), { recursive: true });
  writeFileSync(path.join(cwd, "stub.mjs"), FETCH_STUB);
  tickerRows(cwd, TABLES + seed);
  return cwd;
}

function packTicker(
  cwd: string,
  ticker: string | null,
  vendor: { fmp: string; sec: string },
  keys = {
    FMP_API_KEY: "fake-fmp-value",
    SEC_USER_AGENT: "Portchecker tests contact@portchecker.test",
  },
) {
  return spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      pathToFileURL(path.join(cwd, "stub.mjs")).href,
      path.join(root, "scripts/pack-ticker.ts"),
      ...(ticker === null ? [] : [ticker]),
    ],
    {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        ...keys,
        DATABASE_PATH: path.join(cwd, "test.db"),
        STUB_FMP: vendor.fmp,
        STUB_SEC: vendor.sec,
      },
    },
  );
}

/** One message and no stack trace, since a person reads this at a terminal. */
function assertOneLine(stderr: string) {
  assert.equal(stderr.trim().split("\n").length, 1, stderr);
  assert.doesNotMatch(stderr, /^\s+at /m);
}

const GOOD = { fmp: "quote", sec: "ok" };

void test("pack:ticker refuses '..' and leaves every saved pack alone", () => {
  const cwd = packFolder("dots");
  const keep = path.join(cwd, "data/packs/2026-01-01/KEEP");
  mkdirSync(keep, { recursive: true });
  writeFileSync(path.join(keep, "x"), "saved");

  for (const ticker of ["..", "../..", null]) {
    const run = packTicker(cwd, ticker, GOOD);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /Usage: pnpm pack:ticker AAPL/);
    assertOneLine(run.stderr);
  }

  assert.equal(readFileSync(path.join(keep, "x"), "utf8"), "saved");
  assert.deepEqual(readdirSync(path.join(cwd, "data/packs")), ["2026-01-01"]);
  assert.equal(existsSync(path.join(cwd, "data/dossiers")), false);
  assert.deepEqual(tickerRows(cwd), []);
});

void test("pack:ticker files BRK.B under BRK-B, as a CSV import does", () => {
  const cwd = packFolder("share-class");
  const run = packTicker(cwd, "brk.b", GOOD);
  assert.equal(run.status, 0, run.stderr);
  const dir = path.join(cwd, "data/packs", today());
  assert.deepEqual(readdirSync(dir), ["BRK-B"]);
  const pack = JSON.parse(
    readFileSync(path.join(dir, "BRK-B/pack.json"), "utf8"),
  ) as { quote: { price: number } };
  assert.equal(pack.quote.price, 100);
  assert.ok(existsSync(path.join(cwd, "data/dossiers/BRK-B.md")));
  assert.deepEqual(tickerRows(cwd), ["BRK-B"]);
});

void test("pack:ticker names missing setup in one line and creates nothing", () => {
  const cwd = packFolder("setup");
  const none = packTicker(cwd, "AAPL", GOOD, {
    FMP_API_KEY: "",
    SEC_USER_AGENT: "",
  });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /Add FMP_API_KEY.*Add SEC_USER_AGENT/);
  assertOneLine(none.stderr);

  const noSec = packTicker(cwd, "AAPL", GOOD, {
    FMP_API_KEY: "fake-fmp-value",
    SEC_USER_AGENT: "",
  });
  assert.equal(noSec.status, 1);
  assert.match(noSec.stderr, /Add SEC_USER_AGENT/);
  assert.doesNotMatch(noSec.stderr, /no CIK|FMP_API_KEY/);
  assertOneLine(noSec.stderr);

  assert.equal(existsSync(path.join(cwd, "data/dossiers")), false);
  assert.equal(existsSync(path.join(cwd, "data/packs")), false);
  assert.deepEqual(tickerRows(cwd), []);
});

void test("pack:ticker reports an active run ahead of missing setup", () => {
  const cwd = packFolder(
    "active",
    `INSERT INTO research_runs (status, started_at, heartbeat_at) VALUES ('running', '${new Date().toISOString()}', '${new Date().toISOString()}');`,
  );
  const run = packTicker(cwd, "AAPL", GOOD, {
    FMP_API_KEY: "",
    SEC_USER_AGENT: "",
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /research run is active/);
  assert.doesNotMatch(run.stderr, /FMP_API_KEY/);
});

void test("pack:ticker on a symbol the vendor does not know leaves nothing behind", () => {
  const cwd = packFolder("typo");
  const earlier = path.join(cwd, "data/packs", today(), "AAPLL");
  mkdirSync(earlier, { recursive: true });
  writeFileSync(path.join(earlier, "pack.json"), '{"earlier":true}');

  const run = packTicker(cwd, "AAPLL", { fmp: "empty", sec: "ok" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /No market data for AAPLL/);
  assertOneLine(run.stderr);
  assert.doesNotMatch(run.stdout, /Wrote/);
  assert.equal(existsSync(path.join(cwd, "data/dossiers/AAPLL.md")), false);
  assert.equal(
    readFileSync(path.join(earlier, "pack.json"), "utf8"),
    '{"earlier":true}',
  );
  assert.deepEqual(tickerRows(cwd), []);
});

void test("a pack:ticker that fails on a vendor keeps the pack saved earlier today", () => {
  // This ticker's CIK is known, so SEC's own answer decides the case.
  const known = `INSERT INTO tickers (ticker, cik) VALUES ('AAPL', '320193');`;
  for (const [name, vendor, expected] of [
    ["plan", { fmp: "403", sec: "ok" }, /AAPL/],
    ["down", { fmp: "500", sec: "ok" }, /Could not build the AAPL pack\./],
    ["sec", { fmp: "quote", sec: "403" }, /Could not build the AAPL pack\./],
  ] as const) {
    const cwd = packFolder(name, known);
    const dir = path.join(cwd, "data/packs", today(), "AAPL");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "pack.json"), '{"earlier":true}');

    const run = packTicker(cwd, "AAPL", vendor);
    assert.equal(run.status, 1, `${name}: ${run.stdout}`);
    assert.match(run.stderr, expected);
    assertOneLine(run.stderr);
    assert.doesNotMatch(run.stderr, /fake-fmp-value/);
    assert.equal(
      readFileSync(path.join(dir, "pack.json"), "utf8"),
      '{"earlier":true}',
      name,
    );
  }
});

void test("pack:ticker does not claim SEC has no such company when SEC could not answer", () => {
  const cwd = packFolder("seclist");
  const run = packTicker(cwd, "VOO", { fmp: "quote", sec: "403" });
  // A fund has no CIK and a pack is still useful without filings, so this is not a failure.
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /VOO has no CIK, so no filings/);
  assert.match(run.stdout, /or its list could not be fetched/);
  assert.match(run.stdout, /Wrote /);
});
