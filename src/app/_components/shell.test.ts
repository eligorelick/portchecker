import "../../server/test-env.ts";

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import nodeModule, {
  type LoadFnOutput,
  type LoadHookContext,
  type ResolveFnOutput,
  type ResolveHookContext,
} from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import type { Settings } from "../../server/settings.ts";
import type { PortfolioFacts } from "../../server/portfolio.ts";
import type { QueueItem } from "../../server/queue.ts";
import type { UpdateView } from "../../server/updates.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const scratch = mkdtempSync(path.join(tmpdir(), "portchecker-shell-"));
const actual = (file: string) =>
  JSON.stringify(pathToFileURL(path.join(root, "src", file)).href);

const saved = {
  provider_mode: "chatgpt" as const,
  analyst_provider: "chatgpt" as const,
  fallback_enabled: true,
  codex_model: "",
  claude_model: "claude-sonnet-5-5",
  codex_effort: "medium" as const,
  claude_effort: "" as const,
  claude_auth_mode: "api" as "api" | "subscription",
};
const fixture = {
  settings: {
    ...saved,
    provider_mode: "chatgpt",
    keyLast4: null as string | null,
    keySource: null as "env" | "settings" | null,
    fmpKeySet: false,
    secUserAgentSet: false,
    lastRun: null,
  } as Omit<Settings, "anthropic_api_key"> & {
    keyLast4: string | null;
    keySource: "env" | "settings" | null;
    fmpKeySet: boolean;
    secUserAgentSet: boolean;
    lastRun: null | {
      startedAt: string;
      status: string;
      failedOrSkipped: number;
      providerMode: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        webSearches?: number;
        uncachedInputTokens?: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
        inputTokensIncomplete?: boolean;
      } | null;
    };
  },
  run: null as Record<string, unknown> | null,
  modelError: false,
  emptyDraft: false,
  modelUsage: true,
  modelOk: true,
  codex: {
    signedIn: false,
    installed: true,
    detail: "Not signed in.",
    advice: "Run codex login in a terminal.",
  },
  claudeCode: {
    signedIn: false,
    installed: true,
    detail: "Claude Code is not signed in with a subscription.",
    advice: "Run claude auth login in a terminal.",
  },
  facts: null as PortfolioFacts | null,
  updates: new Map<string, UpdateView>(),
  queue: [] as QueueItem[],
  openCount: 0,
  history: [] as UpdateView[],
  dossier: "# AAA\n\n## Thesis\n\nMy thesis",
  importState: [] as unknown[],
  importCursor: 0,
  importRows: [] as Record<string, unknown>[],
  importFiles: [] as string[],
  importParse: async (_csv: string): Promise<unknown> => ({}),
  importRead: async (_name: string): Promise<unknown> => ({}),
  importScreenshots: async (): Promise<unknown> => ({}),
  imports: [] as { csv: string; fileName: string }[],
  settingsInteractive: false,
  settingsState: [] as unknown[],
  settingsCursor: 0,
  settingsSave: async (_input: unknown): Promise<void> => undefined,
};
(globalThis as unknown as { shellFixture: typeof fixture }).shellFixture =
  fixture;

// Keep the real components, routers and database. Only Next's browser context and external
// provider calls are replaced; no server, CLI process, network request or real data is used.
const modules: Record<string, string> = {
  "next/navigation":
    "export const usePathname = () => '/settings'; export const useRouter = () => ({ refresh() {} }); export const notFound = () => {const error = new Error('Not found'); error.digest = 'NEXT_HTTP_ERROR_FALLBACK;404'; throw error;};",
  "next/link":
    "export default function Link({children, scroll, ...props}) { return {$$typeof: Symbol.for('react.transitional.element'), type:'a', key:null, props:{...props,children}, _owner:null}; }",
  "next/font/google":
    "export const Instrument_Sans = () => ({variable:'instrument'}); export const Newsreader = () => ({variable:'newsreader'});",
  "~/app/_components/page-data":
    "const f = globalThis.shellFixture; export const portfolioFacts = async () => f.facts ?? ({positions:[]}); export const reviews = async () => f.updates; export const briefAndQueue = async () => ({openCount:f.openCount,queue:f.queue,decisions:[],runId:null});",
  "shell-import:react": `export * from ${JSON.stringify(import.meta.resolve("react"))}; export const useMemo=fn=>fn(); export function useState(initial) {const f=globalThis.shellFixture; const i=f.importCursor++; if(!(i in f.importState)) f.importState[i]=typeof initial==='function'?initial():initial; return [f.importState[i], value=>{f.importState[i]=typeof value==='function'?value(f.importState[i]):value;}];}`,
  "shell-settings:react": `import * as React from ${JSON.stringify(import.meta.resolve("react"))}; export * from ${JSON.stringify(import.meta.resolve("react"))}; export function useState(initial) {const f=globalThis.shellFixture; if(!f.settingsInteractive) return React.useState(initial); const i=f.settingsCursor++; if(!(i in f.settingsState)) f.settingsState[i]=typeof initial==='function'?initial():initial; return [f.settingsState[i], value=>{f.settingsState[i]=typeof value==='function'?value(f.settingsState[i]):value;}];}`,
  "shell-ticker:data": `export {portfolioFacts,briefAndQueue} from '~/app/_components/page-data'; export {proofChecks} from ${actual("server/research/run.ts")}; export {tickerNumbers} from ${actual("app/_components/page-data.ts")};`,
  "shell-ticker:updates": `export * from ${actual("server/updates.ts")}; export const tickerHistory=async()=>globalThis.shellFixture.history; export const filingLinks=async()=>({});`,
  "shell-ticker:dossier": `export * from ${actual("server/dossier.ts")}; export const readDossier=()=>globalThis.shellFixture.dossier;`,
  "~/trpc/react": `
    const f = globalThis.shellFixture;
    const query = data => ({data, isLoading:false, error:null});
    const mutation = () => ({isPending:false, error:null, reset() {}});
    export const api = {
      useUtils: () => ({settings:{invalidate:async () => {}},holdings:{invalidate:async () => {}}}),
      holdings:{
        list:{useQuery:()=>query(f.importRows)},importFiles:{useQuery:()=>query(f.importFiles)},
        parseCsv:{useMutation:()=>({...mutation(),mutateAsync:({csv})=>f.importParse(csv)})},readImportFile:{useMutation:()=>({...mutation(),mutateAsync:({name})=>f.importRead(name)})},
        import:{useMutation:()=>({...mutation(),mutateAsync:async input=>{f.imports.push(input);return {imported:1}}})},parseScreenshots:{useMutation:()=>({...mutation(),mutateAsync:()=>f.importScreenshots()})},
        upsert:{useMutation:mutation},delete:{useMutation:mutation}
      },
      dossiers:{save:{useMutation:mutation}},
      tickers:{draftThesis:{useMutation:mutation},acceptThesis:{useMutation:mutation},ask:{useMutation:mutation},addDecision:{useMutation:mutation}},
      settings:{
        get:{useQuery:() => query(f.settings)},
        codexStatus:{useQuery:() => query(f.codex)},
        claudeCodeStatus:{useQuery:() => query(f.claudeCode)},
        claudeModels:{useQuery:() => query({models:[],error:'Could not load the model list.'})},
        codexModels:{useQuery:() => query({models:[],error:'Could not load the model list.'})},
        save:{useMutation:()=>({...mutation(),mutateAsync:input=>f.settingsSave(input)})}, test:{useMutation:mutation}
      },
      runs:{status:{useQuery:() => query(f.run)},start:{useMutation:mutation},stop:{useMutation:mutation},launchProblem:{useQuery:() => query(null)}}
    };
    export const TRPCReactProvider = ({children}) => children;
  `,
  "~/server/model": `
    export {addUsage} from ${actual("server/model.ts")};
    export const errorMessage = error => error instanceof Error ? error.message : String(error);
    export const setupProblems = async () => [];
    export const codexStatus = async () => ({signedIn:false, detail:'Not signed in'});
    export const claudeCodeStatus = async () => globalThis.shellFixture.claudeCode;
    export const listClaudeModels = async settings => settings.claude_auth_mode === 'subscription' ? [{id:'claude-opus-5-5',name:'Claude Opus 5.5',efforts:['low','medium','high','xhigh','max']}] : [];
    export const listCodexModels = async () => [];
    export async function runModel(options) {
      const f = globalThis.shellFixture;
      if(f.modelUsage) options.onUsage?.({inputTokens:123,outputTokens:45,webSearches:0});
      if(f.modelError) throw new Error('The model did not return valid JSON.');
      if(options.role==='test') return {data:options.schema.parse({ok:f.modelOk}),provider:'chatgpt',model:'test',usedFallback:false};
      return {data:{thesis:f.emptyDraft ? [] : ['A thesis'],break_conditions:[],key_numbers:[]},provider:'claude',model:'test',usedFallback:false};
    }
  `,
  "~/server/research/pack": `
    export * from ${actual("server/research/pack.ts")};
    export const buildResearchContext = () => ${JSON.stringify(path.join(scratch, "context"))};
    export const requestFullReview = async () => {};
    export const packDir = () => ${JSON.stringify(path.join(scratch, "test"))};
  `,
  "~/server/research/run": `export {proofChecks,verifiedScore} from ${actual("server/research/run.ts")}; export const latestRun = async () => globalThis.shellFixture.run; export const activeRun = async () => null; export const stopRun = async () => false;`,
  "shell-test:env": `export const env = {DATABASE_PATH:${JSON.stringify(process.env.DATABASE_PATH)},NODE_ENV:'test'};`,
};
// The installed Node types predate synchronous module hooks.
type Resolve = (
  specifier: string,
  context: ResolveHookContext,
) => ResolveFnOutput;
type Load = (url: string, context: LoadHookContext) => LoadFnOutput;
const { registerHooks } = nodeModule as unknown as {
  registerHooks: (hooks: {
    resolve: (
      specifier: string,
      context: ResolveHookContext,
      next: Resolve,
    ) => ResolveFnOutput;
    load: (url: string, context: LoadHookContext, next: Load) => LoadFnOutput;
  }) => { deregister: () => void };
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const parent = decodeURIComponent(context.parentURL ?? "");
    if (specifier === "react" && parent.endsWith("/src/app/import/page.tsx"))
      return { url: "shell-test:shell-import:react", shortCircuit: true };
    if (specifier === "react" && parent.endsWith("/src/app/settings/page.tsx"))
      return { url: "shell-test:shell-settings:react", shortCircuit: true };
    if (parent.endsWith("/src/app/t/[ticker]/page.tsx")) {
      const boundary: Record<string, string> = {
        "~/app/_components/page-data": "shell-ticker:data",
        "~/server/updates": "shell-ticker:updates",
        "~/server/dossier": "shell-ticker:dossier",
      };
      if (boundary[specifier])
        return { url: `shell-test:${boundary[specifier]}`, shortCircuit: true };
    }
    if (specifier in modules)
      return { url: `shell-test:${specifier}`, shortCircuit: true };
    if (specifier === "~/styles/globals.css")
      return { url: "shell-test:css", shortCircuit: true };
    let resolved = specifier;
    if (specifier.startsWith("~/")) {
      const base = path.join(root, "src", specifier.slice(2));
      const file = [
        base + ".ts",
        base + ".tsx",
        base + ".js",
        path.join(base, "index.ts"),
      ].find(existsSync);
      if (file) resolved = pathToFileURL(file).href;
    }
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      const file = [
        base + ".ts",
        base + ".tsx",
        path.join(base, "index.ts"),
      ].find(existsSync);
      if (file) resolved = pathToFileURL(file).href;
    }
    const result = next(resolved, context);
    if (result.url === pathToFileURL(path.join(root, "src/env.js")).href)
      return { url: "shell-test:shell-test:env", shortCircuit: true };
    return result;
  },
  load(url, context, next) {
    if (url === "shell-test:css")
      return { format: "module", source: "", shortCircuit: true };
    if (url.startsWith("shell-test:"))
      return {
        format: "module",
        source: modules[url.slice(11)]!,
        shortCircuit: true,
      };
    if (url.endsWith(".tsx"))
      return {
        format: "module",
        source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
          compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
          },
        }).outputText,
        shortCircuit: true,
      };
    return next(url, context);
  },
});

// Dynamic imports let the hooks isolate all server dependencies before they are evaluated.
const shell = await import("./sidebar.tsx");
const { default: SettingsPage } = await import("../settings/page.tsx");
const { default: RootLayout, metadata } = await import("../layout.tsx");
const { default: ImportPage } = await import("../import/page.tsx");
const { default: TickerPage } = await import("../t/[ticker]/page.tsx");
const { QuoteWarning } = await import("./badges.tsx");
const { computePortfolioFacts } = await import("../../server/portfolio.ts");
const { tickersRouter } = await import("../../server/api/routers/tickers.ts");
const { settingsRouter } = await import("../../server/api/routers/settings.ts");
const { runFailures, runsRouter } =
  await import("../../server/api/routers/runs.ts");
const { db, client } = await import("../../server/db/index.ts");
const { saveSettings } = await import("../../server/settings.ts");
await client.executeMultiple(`
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE decisions (id INTEGER PRIMARY KEY, ticker TEXT, date TEXT, action_taken TEXT, note TEXT, created_at TEXT);
  CREATE TABLE holdings (ticker TEXT, name TEXT, quantity REAL, cost_basis REAL, account_label TEXT, updated_at TEXT);
  CREATE TABLE tickers (ticker TEXT, last_full_review_at TEXT);
`);
after(() => {
  client.close();
  hooks.deregister();
  for (const name of readdirSync(scratch)) unlinkSync(path.join(scratch, name));
  rmdirSync(scratch);
});

void test("decision dates reject blank, malformed, impossible and future days before storing them", async () => {
  const caller = tickersRouter.createCaller({ db });
  for (const date of ["", "garbage", "2026-02-30", "11/05/2026", "2099-01-01"])
    await assert.rejects(
      caller.addDecision({ ticker: "AAA", date, actionTaken: "hold" }),
      /date|future|YYYY-MM-DD/i,
    );
  const day = new Date().toLocaleDateString("en-CA");
  await caller.addDecision({ ticker: "AAA", date: day, actionTaken: "hold" });
  await caller.addDecision({ ticker: "AAA", actionTaken: "hold" });
  const rows = await client.execute("SELECT date FROM decisions");
  assert.deepEqual(
    rows.rows.map((row) => row.date),
    [day, day],
  );
});

void test("blank settings and decision fields identify the field to fix", async () => {
  await assert.rejects(
    settingsRouter.createCaller({ db }).save({ ...saved, claude_model: " " }),
    /Choose a Claude model/,
  );
  const caller = tickersRouter.createCaller({ db });
  await assert.rejects(
    caller.ask({ ticker: "AAA", question: " " }),
    /Enter a question/,
  );
  await assert.rejects(
    caller.addDecision({ ticker: "AAA", actionTaken: " " }),
    /Choose an action/,
  );
});

void test("the provider test fails when its validated response says false", async () => {
  fixture.modelOk = false;
  try {
    const result = await settingsRouter
      .createCaller({ db })
      .test({ provider: "chatgpt" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /did not confirm/i);
    fixture.modelOk = true;
    assert.equal(
      (await settingsRouter.createCaller({ db }).test({ provider: "chatgpt" }))
        .ok,
      true,
    );
  } finally {
    fixture.modelOk = true;
    rmdirSync(path.join(scratch, "test"));
  }
});

type ImportElement = {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
};
function importElements(node: unknown): ImportElement[] {
  if (Array.isArray(node)) return node.flatMap(importElements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ImportElement;
  return [element, ...importElements(element.props.children)];
}
const importTree = () => {
  fixture.importCursor = 0;
  return ImportPage();
};
async function pickCsv(name: string, text: () => Promise<string>) {
  const input = importElements(importTree()).find(
    (e) => e.type === "input" && e.props.accept === ".csv,text/csv",
  )!;
  await (input.props.onChange as (event: unknown) => Promise<void>)({
    target: { files: [{ name, text }], value: name },
  });
}
const parsedCsv = (await import("../../server/csv.ts")).parsePositionsCsv;

void test("the real import preview names known basis changes and account basis losses", async () => {
  fixture.importState = [];
  fixture.importParse = async (csv) => parsedCsv(csv);
  fixture.importRows = [
    {
      ticker: "AAA",
      name: "Example",
      quantity: 10,
      costBasis: 100,
      accountLabel: "Old",
    },
  ];
  try {
    await pickCsv(
      "basis.csv",
      async () => "Symbol,Quantity,Cost Basis\nAAA,10,1000",
    );
    fixture.importCursor = 0;
    let html = renderToStaticMarkup(createElement(ImportPage));
    assert.match(html, /1 with cost basis changes/);
    assert.match(html, /Total cost basis.*\$100\.00.*\$1,000\.00/s);
    assert.doesNotMatch(html, /1 unchanged/);
    fixture.importRows = [
      {
        ticker: "AAA",
        name: "Example",
        quantity: 10,
        costBasis: 1000,
        accountLabel: "Taxable",
      },
      {
        ticker: "AAA",
        name: "Example",
        quantity: 5,
        costBasis: null,
        accountLabel: "IRA",
      },
    ];
    await pickCsv(
      "accounts.csv",
      async () =>
        "Positions for account Taxable as of today\nSymbol,Quantity,Cost Basis\nAAA,10,--\nPositions for account IRA as of today\nSymbol,Quantity,Cost Basis\nAAA,5,400",
    );
    fixture.importCursor = 0;
    html = renderToStaticMarkup(createElement(ImportPage));
    assert.match(html, /Cost basis will be cleared for: AAA/);
  } finally {
    fixture.importState = [];
    fixture.importRows = [];
  }
});

void test("an earlier file read cannot replace or submit over the latest import selection", async () => {
  fixture.importState = [];
  fixture.imports = [];
  fixture.importParse = async (csv) => parsedCsv(csv);
  let finish!: (csv: string) => void;
  const slow = new Promise<string>((resolve) => {
    finish = resolve;
  });
  try {
    const first = pickCsv("a.csv", () => slow);
    await pickCsv("b.csv", async () => "Symbol,Quantity\nBBB,20");
    finish("Symbol,Quantity\nAAA,10");
    await first;
    const preview = fixture.importState[0] as { fileName: string };
    assert.equal(preview.fileName, "b.csv");
    const button = importElements(importTree()).find(
      (e) =>
        e.type === "button" &&
        JSON.stringify(e.props.children).includes("Replace my holdings"),
    )!;
    await (button.props.onClick as () => Promise<void>)();
    assert.deepEqual(fixture.imports, [
      { csv: "Symbol,Quantity\nBBB,20", fileName: "b.csv" },
    ]);
  } finally {
    fixture.importState = [];
    fixture.importRows = [];
  }
});

void test("a delayed saved-file read cannot replace a newer CSV selection", async () => {
  fixture.importState = [];
  fixture.importFiles = ["saved.csv"];
  fixture.importParse = async (csv) => parsedCsv(csv);
  let finish!: (value: unknown) => void;
  fixture.importRead = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  try {
    const saved = importElements(importTree()).find(
      (e) => e.type === "button" && e.props.children === "saved.csv",
    )!;
    const pending = (saved.props.onClick as () => Promise<void>)();
    await pickCsv("b.csv", async () => "Symbol,Quantity\nBBB,20");
    finish({ csv: "Symbol,Quantity\nAAA,10" });
    await pending;
    assert.equal(
      (fixture.importState[0] as { fileName: string }).fileName,
      "b.csv",
    );
  } finally {
    fixture.importState = [];
    fixture.importFiles = [];
  }
});

void test("obsolete screenshot reads and responses cannot replace a newer CSV selection", async (t) => {
  const readers: { onload: (() => void) | null; result: string }[] = [];
  class ImageReader {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    result = "data:image/png;base64,test";
    readAsDataURL() {
      readers.push(this);
    }
  }
  const globals = globalThis as unknown as { FileReader?: unknown };
  const previous = globals.FileReader;
  globals.FileReader = ImageReader;
  t.after(() => {
    if (previous === undefined) delete globals.FileReader;
    else globals.FileReader = previous;
  });
  fixture.importParse = async (csv) => parsedCsv(csv);
  for (const delayResponse of [false, true]) {
    fixture.importState = [];
    let calls = 0;
    let finish!: (value: unknown) => void;
    fixture.importScreenshots = () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const input = importElements(importTree()).find(
      (e) => e.type === "input" && e.props.accept === ".png,.jpg,.jpeg,.webp",
    )!;
    const pending = (input.props.onChange as (event: unknown) => Promise<void>)(
      { target: { files: [{ name: "a.png" }], value: "a.png" } },
    );
    if (delayResponse) {
      readers.at(-1)!.onload!();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(calls, 1);
    }
    await pickCsv("b.csv", async () => "Symbol,Quantity\nBBB,20");
    if (delayResponse)
      finish({ csv: "Symbol,Quantity\nAAA,10", fileName: "a.csv", notes: [] });
    else readers.at(-1)!.onload!();
    await pending;
    assert.equal(
      (fixture.importState[0] as { fileName: string }).fileName,
      "b.csv",
    );
    assert.equal(calls, delayResponse ? 1 : 0);
  }
  fixture.importState = [];
});

void test("failed Ask and thesis calls report usage already incurred", async () => {
  const caller = tickersRouter.createCaller({ db });
  fixture.modelError = true;
  try {
    for (const call of [
      () => caller.ask({ ticker: "AAA", question: "What changed?" }),
      () => caller.draftThesis({ ticker: "AAA" }),
    ])
      await assert.rejects(
        call(),
        /valid JSON.*Claude usage: 123 tokens in, 45 out/s,
      );
    fixture.modelError = false;
    fixture.emptyDraft = true;
    await assert.rejects(
      caller.draftThesis({ ticker: "AAA" }),
      /empty draft.*Claude usage: 123 tokens in, 45 out/s,
    );
    fixture.modelError = true;
    fixture.modelUsage = false;
    await assert.rejects(
      caller.ask({ ticker: "AAA", question: "What changed?" }),
      (error) =>
        error instanceof Error && !error.message.includes("Claude usage"),
    );
  } finally {
    fixture.modelError = false;
    fixture.emptyDraft = false;
    fixture.modelUsage = true;
  }
});

void test("layout keeps navigation available when settings cannot be read", async (t) => {
  await client.execute("ALTER TABLE settings RENAME TO unavailable_settings");
  t.mock.method(console, "error", () => undefined);
  try {
    const html = renderToStaticMarkup(
      await RootLayout({ children: createElement("p", null, "Page") }),
    );
    assert.match(html, /aria-label="Main"/);
    assert.match(html, /AI: unavailable/);
    assert.match(
      html,
      /Decision support only\. Portchecker never places trades/,
    );
  } finally {
    await client.execute("ALTER TABLE unavailable_settings RENAME TO settings");
  }
});

void test("layout exposes a page title template and the shared decision-support footer", async () => {
  assert.deepEqual(metadata.title, {
    default: "Portchecker",
    template: "%s · Portchecker",
  });
  const html = renderToStaticMarkup(
    await RootLayout({ children: createElement("p", null, "Page") }),
  );
  assert.match(html, /Decision support only\. Portchecker never places trades/);
});

void test("settings describes unavailable fallback and explains model-list failures", () => {
  fixture.settings = { ...fixture.settings, keyLast4: null, keySource: null };
  const html = renderToStaticMarkup(createElement(SettingsPage));
  assert.match(html, /No backup: needs a key/);
  assert.doesNotMatch(html, /Backup if ChatGPT fails/);
  fixture.settings = {
    ...fixture.settings,
    keyLast4: "fake",
    keySource: "env",
  };
  const withKey = renderToStaticMarkup(createElement(SettingsPage));
  assert.match(withKey, /Could not load the model list/);
  assert.match(withKey, /From .env, ends in fake/);
  assert.match(withKey, /Claude key is set in .env/);
  assert.match(withKey, /role="status"/);
});

void test("sidebar counts completed reviews without implying they all succeeded", () => {
  fixture.run = {
    id: 17,
    status: "running",
    progress: { done: 0, total: 19 },
    message: "Preparing",
    lastLine: "Preparing",
  };
  const html = renderToStaticMarkup(
    createElement(shell.Sidebar, {
      holdings: [],
      openCount: 0,
      modeLabel: "ChatGPT",
      billingNote: null,
    }),
  );
  assert.match(html, /Reviewing, 0 of 19 done/);
  fixture.run = null;
});

void test("a run in progress can be stopped from the sidebar, and a stopped run says what was kept", () => {
  const sidebar = () =>
    renderToStaticMarkup(
      createElement(shell.Sidebar, {
        holdings: [],
        openCount: 0,
        modeLabel: "ChatGPT",
        billingNote: null,
      }),
    );
  try {
    fixture.run = {
      id: 17,
      status: "running",
      progress: { done: 2, total: 19 },
      message: "AAA: analyzing.",
      lastLine: "10:00:00 AAA: analyzing.",
    };
    const running = sidebar();
    assert.match(running, /<button[^>]*>Stop research<\/button>/);
    assert.match(running, /keeps going if you close this page or the app/);
    assert.doesNotMatch(running, /Run research/);

    const kept =
      "Stopped at your request. 2 reviews finished before the stop and are saved. No brief was written.";
    fixture.run = {
      id: 17,
      status: "stopped",
      startedAt: "2026-11-05T12:00:00Z",
      finishedAt: "2026-11-05T12:10:00Z",
      providerMode: "chatgpt",
      message: kept,
      lastLine: `10:10:00 ${kept}`,
      failedOrSkipped: 0,
      usageJson: null,
    };
    const stopped = sidebar();
    assert.ok(stopped.includes(kept));
    assert.match(stopped, /<button[^>]*>Run research<\/button>/);
    assert.doesNotMatch(stopped, /Stop research|The last run failed/);
  } finally {
    fixture.run = null;
  }
});

void test("finished run failures remain visible in the sidebar and settings response", async () => {
  fixture.run = {
    id: 17,
    status: "finished",
    startedAt: "2026-11-05T12:00:00Z",
    finishedAt: "2026-11-05T12:30:00Z",
    providerMode: "chatgpt",
    message:
      "Finished. 2 reviewed, 17 failed or skipped. Kept the existing brief.",
    failedOrSkipped: 17,
    usageJson: null,
  };
  try {
    const html = renderToStaticMarkup(
      createElement(shell.Sidebar, {
        holdings: [],
        openCount: 0,
        modeLabel: "ChatGPT",
        billingNote: null,
      }),
    );
    assert.match(html, /17 failed or skipped/);
    const result = await settingsRouter.createCaller({ db }).get();
    assert.equal(result.lastRun?.failedOrSkipped, 17);
    assert.equal(
      (await runsRouter.createCaller({ db }).status())?.failedOrSkipped,
      17,
    );
    for (const [message, expected] of [
      ["Finished. 19 reviewed, 0 failed or skipped.", 0],
      ["Finished. 18 reviewed, 1 failed or skipped.", 1],
      [
        "Finished. 2 reviewed, 17 failed or skipped. Kept the existing brief.",
        17,
      ],
      ["Starting research", 0],
      ["", 0],
    ] as const)
      assert.equal(runFailures(message), expected);
  } finally {
    fixture.run = null;
  }
});

void test("Settings labels incomplete historical input and preserves cache breakdown through its router", async () => {
  const previous = fixture.settings;
  const previousRun = fixture.run;
  const usage = {
    inputTokens: 157,
    outputTokens: 11,
    webSearches: 2,
    uncachedInputTokens: 17,
    cacheReadInputTokens: 100,
    cacheCreationInputTokens: 40,
    inputTokensIncomplete: true,
  };
  try {
    fixture.run = {
      id: 17,
      startedAt: "2026-11-05T12:00:00Z",
      status: "finished",
      providerMode: "both",
      message: "Finished. 22 reviewed, 0 failed or skipped.",
      usageJson: JSON.stringify(usage),
    };
    const response = await settingsRouter.createCaller({ db }).get();
    assert.deepEqual(response.lastRun?.usage, usage);
    fixture.settings = { ...previous, lastRun: response.lastRun };
    const html = renderToStaticMarkup(createElement(SettingsPage));
    assert.match(html, /[Aa]t least 157 tokens in/);
    assert.match(html, /[Ii]ncomplete[^<]*cached input/i);
    assert.match(html, /17 uncached/);
    assert.match(html, /100 cache read/);
    assert.match(html, /40 cache creation/);
    assert.match(html, /11 out, 2 web searches/);
  } finally {
    fixture.settings = previous;
    fixture.run = previousRun;
  }
});

void test("Settings keeps old usage compatible and never shows incomplete zero input as None", () => {
  const previous = fixture.settings;
  try {
    const lastRun = {
      startedAt: "2026-11-05T12:00:00Z",
      status: "finished",
      providerMode: "claude",
      failedOrSkipped: 0,
      usage: { inputTokens: 17, outputTokens: 11 },
    };
    fixture.settings = { ...previous, lastRun };
    let html = renderToStaticMarkup(createElement(SettingsPage));
    assert.match(html, /17 tokens in, 11 out, 0 web searches/);
    assert.doesNotMatch(html, /[Aa]t least 17|[Ii]ncomplete[^<]*cached input/i);
    fixture.settings = {
      ...previous,
      lastRun: {
        ...lastRun,
        usage: { inputTokens: 0, outputTokens: 0, inputTokensIncomplete: true },
      },
    };
    html = renderToStaticMarkup(createElement(SettingsPage));
    assert.match(html, /[Aa]t least 0 tokens in/);
    assert.match(html, /[Ii]ncomplete[^<]*cached input/i);
    fixture.settings = {
      ...previous,
      lastRun: {
        ...lastRun,
        usage: { inputTokens: 0, outputTokens: 0, webSearches: 1 },
      },
    };
    assert.match(
      renderToStaticMarkup(createElement(SettingsPage)),
      /0 tokens in, 0 out, 1 web searches/,
    );
  } finally {
    fixture.settings = previous;
  }
});

void test("page failure panel offers a reload and a safe diagnostic reference", async () => {
  const { default: PageError } = await import("../error.tsx");
  const error = Object.assign(new Error("private provider response"), {
    digest: "reference-123",
  });
  const html = renderToStaticMarkup(
    createElement(PageError, { error, reset: () => undefined }),
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /Try again/);
  assert.match(html, /reference-123/);
  assert.doesNotMatch(html, /private provider response|last-run.log/);
});

void test("settings draft identity excludes run usage and key metadata but includes saved form fields", () => {
  const before = shell.settingsFields(fixture.settings);
  const refreshed = {
    ...fixture.settings,
    lastRun: { usage: { inputTokens: 999 } },
    keyLast4: "next",
    keySource: "settings" as const,
  };
  const after = shell.settingsFields(refreshed);
  assert.deepEqual(before, after);
  assert.deepEqual(before, saved);
  assert.notDeepEqual(
    before,
    shell.settingsFields({ ...saved, provider_mode: "both" }),
  );
});

void test("provider test results depend on saved models, effort and credentials", () => {
  const initial = shell.settingsTestKey("claude", saved, "1234|0");
  assert.notEqual(initial, shell.settingsTestKey("claude", saved, "5678|1"));
  assert.notEqual(initial, shell.settingsTestKey("claude", saved, "1234|1"));
  assert.notEqual(
    initial,
    shell.settingsTestKey(
      "claude",
      { ...saved, claude_auth_mode: "subscription" },
      "1234|0",
    ),
  );
  assert.notEqual(
    initial,
    shell.settingsTestKey(
      "claude",
      { ...saved, claude_model: "another-model" },
      "1234|0",
    ),
  );
  assert.notEqual(
    initial,
    shell.settingsTestKey(
      "claude",
      { ...saved, claude_effort: "high" },
      "1234|0",
    ),
  );
  assert.equal(
    initial,
    shell.settingsTestKey(
      "claude",
      { ...saved, fallback_enabled: false },
      "1234|0",
    ),
  );
  const codex = shell.settingsTestKey("chatgpt", saved);
  assert.notEqual(
    codex,
    shell.settingsTestKey("chatgpt", {
      ...saved,
      codex_model: "another-model",
    }),
  );
  assert.notEqual(
    codex,
    shell.settingsTestKey("chatgpt", { ...saved, codex_effort: "max" }),
  );
});

void test("subscription mode participates in draft identity and confirmed key removal", () => {
  const subscription = { ...saved, claude_auth_mode: "subscription" as const };
  assert.notDeepEqual(
    shell.settingsFields(saved),
    shell.settingsFields(subscription),
  );
  assert.equal(
    shell.keyRemovalInput(subscription, true)?.claude_auth_mode,
    "subscription",
  );
});

void test("Settings uses native Claude readiness rather than a saved API key in subscription mode", () => {
  const previous = fixture.settings;
  const previousCode = fixture.claudeCode;
  try {
    fixture.settings = {
      ...previous,
      claude_auth_mode: "subscription",
      keyLast4: "fake",
      keySource: "settings",
    };
    let html = renderToStaticMarkup(createElement(SettingsPage));
    assert.match(html, /Claude subscription/);
    assert.match(html, /Anthropic API/);
    assert.match(html, /claude auth login/);
    assert.match(html, /No backup: not signed in/);
    assert.doesNotMatch(html, /Backup if ChatGPT fails/);
    assert.match(html, /Saved API keys are not used/);
    assert.doesNotMatch(html, /thinking is billed as output/);
    fixture.claudeCode = {
      installed: true,
      signedIn: true,
      detail: "Claude subscription is signed in.",
      advice: "",
    };
    fixture.settings = { ...fixture.settings, keyLast4: null, keySource: null };
    html = renderToStaticMarkup(createElement(SettingsPage));
    assert.match(html, /Claude subscription is signed in/);
    assert.match(html, /Backup if ChatGPT fails/);
    assert.match(html, /subscription usage limits/);
    assert.doesNotMatch(html, /No backup: needs a key/);
    fixture.claudeCode = {
      installed: false,
      signedIn: false,
      detail: "Claude Code is not installed or not on PATH.",
      advice:
        "Install Claude Code and make sure claude is on PATH for this app.",
    };
    html = renderToStaticMarkup(createElement(SettingsPage));
    assert.match(html, /Install Claude Code/);
    assert.match(html, /No backup: Claude Code is unavailable/);
  } finally {
    fixture.settings = previous;
    fixture.claudeCode = previousCode;
  }
});

void test("settings router preserves subscription mode for old clients and lists subscription models without a key", async () => {
  const caller = settingsRouter.createCaller({ db });
  await caller.save({
    ...saved,
    claude_auth_mode: "subscription",
    anthropic_api_key: "fake-retained-1234",
  });
  assert.equal((await caller.get()).claude_auth_mode, "subscription");
  const { claude_auth_mode: _mode, ...oldClient } = saved;
  await caller.save({ ...oldClient, clear_key: true });
  const redacted = await caller.get();
  assert.equal(redacted.claude_auth_mode, "subscription");
  assert.equal(redacted.keyLast4, null);
  assert.equal("anthropic_api_key" in redacted, false);
  assert.deepEqual(
    (await caller.claudeModels()).models.map((model) => model.id),
    ["claude-opus-5-5"],
  );
  assert.deepEqual(await caller.claudeCodeStatus(), fixture.claudeCode);
  await caller.save({ ...saved, anthropic_api_key: "" });
  assert.equal((await caller.claudeModels()).error, "No API key.");
});

void test("Settings saves subscription selection and preserves unrelated drafts while removing a saved key", async () => {
  const previous = fixture.settings;
  const caller = settingsRouter.createCaller({ db });
  let pending = Promise.resolve();
  const tree = () => {
    // Apply render-time synchronization, as React does when the saved fields change.
    let result;
    for (let i = 0; i < 2; i++) {
      fixture.settingsCursor = 0;
      result = SettingsPage();
    }
    return importElements(result);
  };
  const change = (element: ImportElement, value: string) =>
    (element.props.onChange as (event: unknown) => void)({ target: { value } });
  const click = async (elements: ImportElement[], label: string) => {
    const button = elements.find(
      (element) =>
        element.type === "button" &&
        JSON.stringify(element.props.children).includes(label),
    );
    assert.ok(button, `Missing ${label}`);
    await (button.props.onClick as () => Promise<void>)();
    await pending;
  };
  fixture.settingsInteractive = true;
  fixture.settingsState = [];
  try {
    await caller.save({ ...saved, anthropic_api_key: "fake-preserved-1234" });
    fixture.settings = {
      ...previous,
      ...saved,
      keyLast4: "1234",
      keySource: "settings",
    };
    fixture.settingsSave = (input) =>
      (pending = (async () => {
        await caller.save(input as Parameters<typeof caller.save>[0]);
        const response = await caller.get();
        fixture.settings = {
          ...fixture.settings,
          ...shell.settingsFields(response),
          keyLast4: response.keyLast4,
          keySource: response.keySource,
        };
      })());
    let elements = tree();
    const initialModel = elements.find(
      (element) =>
        element.type === "input" &&
        element.props.placeholder === "Codex default",
    )!;
    change(initialModel, "saved-chatgpt-model");
    const access = elements.filter(
      (element) =>
        element.type === "input" && element.props.name === "claude-access",
    );
    assert.equal(access.length, 2);
    change(access[0]!, "subscription");
    elements = tree();
    assert.equal(
      elements.find(
        (element) =>
          element.type === "input" &&
          element.props.placeholder === "Codex default",
      )?.props.value,
      "saved-chatgpt-model",
    );
    const tests = elements.filter(
      (element) => element.props.provider === "claude",
    );
    assert.equal(tests[0]?.props.blocked, true);
    await click(elements, "Save changes");
    assert.equal((await caller.get()).claude_auth_mode, "subscription");
    elements = tree();
    assert.equal(
      elements.find((element) => element.props.provider === "claude")?.props
        .blocked,
      false,
    );

    const codexModel = elements.find(
      (element) =>
        element.type === "input" &&
        element.props.placeholder === "Codex default",
    )!;
    change(codexModel, "unsaved-chatgpt-model");
    // A status/credential metadata refresh must not discard the model draft.
    fixture.settings = { ...fixture.settings, keyLast4: "1234" };
    elements = tree();
    await click(elements, "Remove saved key");
    elements = tree();
    await click(elements, "Remove key ending in");
    const response = await caller.get();
    assert.equal(response.claude_auth_mode, "subscription");
    assert.equal(response.keyLast4, null);
    assert.equal(response.codex_model, "saved-chatgpt-model");
    elements = tree();
    assert.equal(
      elements.find(
        (element) =>
          element.type === "input" &&
          element.props.placeholder === "Codex default",
      )?.props.value,
      "unsaved-chatgpt-model",
    );
    assert.equal(
      elements.find(
        (element) =>
          element.type === "input" && element.props.name === "claude-access",
      )?.props.checked,
      true,
    );
  } finally {
    fixture.settings = previous;
    fixture.settingsInteractive = false;
    fixture.settingsState = [];
    fixture.settingsSave = async () => undefined;
    await caller.save({ ...saved, anthropic_api_key: "" });
  }
});

void test("key removal requires confirmation and sends saved fields without unrelated edits", () => {
  const persisted = { ...fixture.settings, provider_mode: "chatgpt" as const };
  assert.equal(shell.keyRemovalInput(persisted, false), null);
  const input = shell.keyRemovalInput(persisted, true);
  assert.deepEqual(input, { ...saved, anthropic_api_key: "", clear_key: true });
  assert.equal(input?.provider_mode, "chatgpt");
  assert.equal("lastRun" in input, false);
  assert.equal("keyLast4" in input, false);
});

void test("Both mode explains self-checking only while fallback is enabled", () => {
  const previous = fixture.settings;
  try {
    fixture.settings = {
      ...previous,
      provider_mode: "both",
      fallback_enabled: true,
    };
    assert.match(
      renderToStaticMarkup(createElement(SettingsPage)),
      /checking its own work/,
    );
    fixture.settings = { ...fixture.settings, fallback_enabled: false };
    assert.doesNotMatch(
      renderToStaticMarkup(createElement(SettingsPage)),
      /checking its own work/,
    );
  } finally {
    fixture.settings = previous;
  }
});

void test("Settings gives installation advice for missing Codex and login advice only for an installed CLI", () => {
  const previous = fixture.codex;
  const previousSettings = fixture.settings;
  try {
    fixture.codex = {
      signedIn: false,
      installed: false,
      detail: "Codex is not installed or not on PATH.",
      advice:
        "Install the Codex CLI and make sure codex is on PATH for this app.",
    };
    let html = renderToStaticMarkup(createElement(SettingsPage));
    assert.match(html, /Codex is not installed or not on PATH/);
    assert.match(html, /Install the Codex CLI/);
    assert.doesNotMatch(
      html,
      /ChatGPT is not signed in|Run <code>codex login<\/code>|Run codex login/,
    );
    fixture.settings = { ...previousSettings, provider_mode: "claude" };
    html = renderToStaticMarkup(createElement(SettingsPage));
    assert.match(
      html,
      /Codex is not installed or not on PATH[^<]*Claude mode does not need/,
    );
    assert.doesNotMatch(html, /No backup: not signed in/);
    fixture.settings = previousSettings;
    fixture.codex = previous;
    html = renderToStaticMarkup(createElement(SettingsPage));
    assert.match(html, /Not signed in/);
    assert.match(html, /Run (?:<code>)?codex login/);
    fixture.codex = {
      signedIn: true,
      installed: true,
      detail: "Logged in using ChatGPT",
      advice: "",
    };
    html = renderToStaticMarkup(createElement(SettingsPage));
    assert.match(html, /ChatGPT is signed in/);
    assert.match(html, /Logged in using ChatGPT/);
    assert.doesNotMatch(html, /Install the Codex CLI|Run codex login/);
  } finally {
    fixture.codex = previous;
    fixture.settings = previousSettings;
  }
});

void test("provider roles only promise a backup when that provider is ready", () => {
  const cases = [
    ["claude", "both", "chatgpt", true, false, "Checks the work"],
    ["claude", "both", "claude", true, true, "Analyzes each stock"],
    ["chatgpt", "chatgpt", "chatgpt", false, true, "Does all the research"],
    ["claude", "chatgpt", "chatgpt", false, true, "Not used"],
    ["claude", "chatgpt", "chatgpt", true, true, "Backup if ChatGPT fails"],
    ["claude", "chatgpt", "chatgpt", true, false, "No backup: needs a key"],
    ["chatgpt", "claude", "claude", true, false, "No backup: not signed in"],
  ] as const;
  for (const [provider, mode, analyst, fallback, ready, expected] of cases)
    assert.equal(
      shell.roleOf(provider, mode, analyst, fallback, ready),
      expected,
    );
});

void test("server pages reload for completed runs including ones never seen running", () => {
  const cases = [
    [undefined, "17|finished", false],
    ["17|finished", "17|finished", false],
    ["17|running", "17|finished", true],
    ["17|running", "17|failed", true],
    ["16|finished", "17|finished", true],
    ["16|finished", "17|failed_setup", true],
    ["16|finished", "17|running", false],
    ["17|running", "17|running", false],
    ["none", "1|finished", true],
    ["none", "none", false],
    ["17|finished", undefined, false],
  ] as const;
  for (const [before, after, expected] of cases)
    assert.equal(
      shell.runShouldReload(before, after),
      expected,
      `${before} -> ${after}`,
    );
});

void test("confirmation usage formats tokens and searches while ignoring missing or malformed usage", () => {
  assert.equal(
    shell.claudeUseLine(
      '{"inputTokens":1342953,"outputTokens":296461,"webSearches":10}',
    ),
    "1,342,953 Claude tokens in, 296,461 out, 10 web searches",
  );
  assert.equal(
    shell.claudeUseLine('{"inputTokens":0,"outputTokens":0,"webSearches":1}'),
    "0 Claude tokens in, 0 out, 1 web search",
  );
  for (const json of [
    null,
    undefined,
    "{}",
    "broken",
    '{"inputTokens":0,"outputTokens":0}',
    '{"inputTokens":-1,"outputTokens":1}',
    '{"inputTokens":"5","outputTokens":2}',
  ])
    assert.equal(shell.claudeUseLine(json), null);
});

void test("run confirmation billing includes configured Claude fallback", async () => {
  function findSidebar(
    node: React.ReactNode,
  ): React.ReactElement<{ billingNote: string | null }> | undefined {
    if (Array.isArray(node)) return node.map(findSidebar).find(Boolean);
    if (
      !node ||
      typeof node !== "object" ||
      !("type" in node) ||
      !("props" in node)
    )
      return;
    const element = node as React.ReactElement<{
      children?: React.ReactNode;
      billingNote: string | null;
    }>;
    if (element.type === shell.Sidebar) return element;
    return findSidebar(element.props.children);
  }
  const cases = [
    ["claude", false, "", "api", "Claude calls are billed per token."],
    ["both", false, "", "api", "Claude calls are billed per token."],
    [
      "chatgpt",
      true,
      "fake-for-test",
      "api",
      "If ChatGPT fails, that call runs on Claude and is billed per token.",
    ],
    ["chatgpt", false, "fake-for-test", "api", null],
    ["chatgpt", true, "", "api", null],
    [
      "claude",
      false,
      "fake-for-test",
      "subscription",
      "Claude uses your subscription usage limits. Check Claude Code's extra usage settings for possible charges.",
    ],
    [
      "both",
      false,
      "",
      "subscription",
      "Claude uses your subscription usage limits. Check Claude Code's extra usage settings for possible charges.",
    ],
    [
      "chatgpt",
      true,
      "fake-for-test",
      "subscription",
      "If ChatGPT fails, Claude uses your subscription usage limits. Check Claude Code's extra usage settings for possible charges.",
    ],
    ["chatgpt", false, "fake-for-test", "subscription", null],
  ] as const;
  for (const [mode, fallback, credential, auth, expected] of cases) {
    await saveSettings({
      ...saved,
      provider_mode: mode,
      fallback_enabled: fallback,
      anthropic_api_key: credential,
      claude_auth_mode: auth,
    });
    assert.equal(
      findSidebar(await RootLayout({ children: null }))?.props.billingNote,
      expected,
    );
  }
  const environment = (await import("../../env.js")).env;
  Object.assign(environment, { ANTHROPIC_API_KEY: "fake-environment-only" });
  try {
    await saveSettings({ ...saved, anthropic_api_key: "" });
    assert.equal(
      findSidebar(await RootLayout({ children: null }))?.props.billingNote,
      "If ChatGPT fails, that call runs on Claude and is billed per token.",
    );
  } finally {
    Object.assign(environment, { ANTHROPIC_API_KEY: undefined });
  }
});

const sampleReview = (ticker = "AAA"): UpdateView => ({
  id: 1,
  runId: 1,
  ticker,
  depth: "FULL",
  createdAt: "2026-11-05T12:00:00Z",
  result: {
    ticker,
    status: "watch",
    headline: "Saved research",
    what_changed: [],
    evidence: [],
    action: "review",
    confidence: 0.7,
    business_view: "Steady business",
    valuation_view: "Fair price",
    evidence_against: [],
    next_proof_point: "Next report",
    reasoning: "Check the next report",
    would_change_my_mind: [],
    dossier_current_view: null,
  },
  verification: null,
  firstPass: null,
  verifiedScore: null,
  analystProvider: "chatgpt",
  analystModel: "test",
  verifierProvider: null,
  verifierModel: null,
  usedFallback: false,
  revisedAfterReview: false,
  recheckedAt: null,
  thesisAtReview: "My thesis",
  previousAction: null,
  providerMode: "chatgpt",
  quotePricedAt: null,
});

function sampleFacts() {
  return computePortfolioFacts(
    [{ ticker: "AAA", name: "Example", quantity: 2.0769, costBasis: 30 }],
    new Map([
      [
        "AAA",
        {
          price: 10,
          change: 1,
          changePercentage: 10,
          quote_date: "2026-11-04",
        },
      ],
    ]),
    new Map(),
    "2026-11-05",
  );
}

const renderTicker = async () =>
  renderToStaticMarkup(
    await TickerPage({
      params: Promise.resolve({ ticker: "AAA" }),
      searchParams: Promise.resolve({ tab: "history" }),
    }),
  );

void test("import preview keeps fractional shares in incoming and previous quantities", () => {
  fixture.importRows = [
    {
      ticker: "AAA",
      name: "Example",
      quantity: 1.1837,
      costBasis: 30,
      accountLabel: "",
      updatedAt: "2026-11-05",
    },
  ];
  fixture.importState = [
    {
      rows: [
        {
          ticker: "AAA",
          name: "Example",
          quantity: 2.0769,
          costBasis: 30,
          marketValue: 20.769,
          accountLabel: "",
        },
      ],
      notes: [],
      skipped: [],
      error: null,
      csv: "unused",
      fileName: "positions.csv",
    },
  ];
  fixture.importCursor = 0;
  try {
    const html = renderToStaticMarkup(createElement(ImportPage));
    assert.match(html, /<td[^>]*>2\.0769<\/td>/);
    assert.match(html, /Was<!-- --> <!-- -->1\.1837|Was 1\.1837/);
    assert.doesNotMatch(html, />2\.077<|Was 1\.184/);
  } finally {
    fixture.importRows = [];
    fixture.importState = [];
    fixture.importCursor = 0;
  }
});

void test("sidebar attention count excludes removed holdings and retains unqueued current calls", async () => {
  fixture.facts = sampleFacts();
  fixture.facts.positions.push({
    ...fixture.facts.positions[0]!,
    ticker: "BBB",
  });
  fixture.queue = [
    {
      ticker: "AAA",
      action: "review",
      urgency: null,
      sizeHint: null,
      why: null,
      reasoning: null,
      decision: null,
    },
    {
      ticker: "OLD",
      action: "sell",
      urgency: null,
      sizeHint: null,
      why: null,
      reasoning: null,
      decision: null,
    },
  ];
  fixture.openCount = 2;
  fixture.updates = new Map([["BBB", sampleReview("BBB")]]);
  try {
    const html = renderToStaticMarkup(await RootLayout({ children: null }));
    assert.match(html, /aria-label="2 to look at"/);
    assert.doesNotMatch(html, /aria-label="3 to look at"/);
    assert.equal(fixture.queue.length, 2);
  } finally {
    fixture.facts = null;
    fixture.queue = [];
    fixture.openCount = 0;
    fixture.updates = new Map();
  }
});

void test("removed holdings retain saved reviews with a historical notice", async () => {
  fixture.facts = computePortfolioFacts([], new Map(), new Map());
  fixture.history = [sampleReview()];
  try {
    const html = await renderTicker();
    assert.match(html, /Historical research/);
    assert.match(html, /not in your current holdings/);
    assert.match(html, /Saved research/);
    assert.doesNotMatch(html, /My position/);
    fixture.facts = sampleFacts();
    await client.execute(
      "INSERT INTO holdings VALUES ('AAA','Example',2.0769,30,'','2026-11-05')",
    );
    assert.doesNotMatch(await renderTicker(), /Historical research/);
  } finally {
    await client.execute("DELETE FROM holdings");
    fixture.facts = null;
    fixture.history = [];
  }
});

void test("unknown ticker keeps the not-found signal and offers themed navigation", async () => {
  fixture.facts = computePortfolioFacts([], new Map(), new Map());
  fixture.dossier = "";
  try {
    await assert.rejects(
      renderTicker(),
      (error: unknown) =>
        !!error &&
        typeof error === "object" &&
        "digest" in error &&
        error.digest === "NEXT_HTTP_ERROR_FALLBACK;404",
    );
    assert.ok(
      existsSync(path.join(root, "src/app/not-found.tsx")),
      "Missing shared not-found page",
    );
    const { default: NotFound } = await import("../not-found.tsx");
    const html = renderToStaticMarkup(createElement(NotFound));
    assert.match(html, /<h1[^>]*>[^<]*not found/i);
    assert.match(html, /href="\/"[^>]*>Today</);
    assert.match(html, /href="\/holdings"[^>]*>Holdings</);
    assert.match(html, /sheet/);
  } finally {
    fixture.facts = null;
    fixture.dossier = "# AAA\n\n## Thesis\n\nMy thesis";
  }
});

void test("quote-date warnings explain included values and excluded day changes plainly", () => {
  const facts = sampleFacts();
  facts.quote_dates.stale = ["AAA"];
  facts.day_change_left_out = ["BBB"];
  const html = renderToStaticMarkup(createElement(QuoteWarning, { facts }));
  assert.match(html, /Prices for AAA/);
  assert.match(html, /earlier sessions/);
  assert.match(html, /still included in the portfolio value/);
  assert.match(html, /day&#x27;s total leaves out[^<]*BBB/);
  assert.doesNotMatch(html, /Cached quotes|mixed dates|Values remain visible/);
});

void test("position labels describe a loss as well as a gain", async () => {
  fixture.facts = sampleFacts();
  try {
    const html = await renderTicker();
    assert.match(html, /Gain or loss/);
    assert.match(html, /−\$9 \(−30\.77%\)/);
    fixture.facts.positions[0]!.unrealized_gain = 9.23;
    assert.match(await renderTicker(), /Gain or loss/);
  } finally {
    fixture.facts = null;
  }
});

void test("client import and settings routes supply distinct titles without changing their content", async () => {
  for (const [route, title] of [
    ["import", "Update holdings"],
    ["settings", "Settings"],
  ] as const) {
    assert.ok(
      existsSync(path.join(root, `src/app/${route}/layout.tsx`)),
      `Missing ${route} title layout`,
    );
    const layout = (await import(`../${route}/layout.tsx`)) as {
      metadata: { title: string };
      default: (props: { children: React.ReactNode }) => React.ReactNode;
    };
    assert.equal(layout.metadata.title, title);
    assert.equal(
      renderToStaticMarkup(
        layout.default({ children: createElement("p", null, "Existing page") }),
      ),
      "<p>Existing page</p>",
    );
  }
});

void test("database initialization can fail before the root layout's guarded reads", async () => {
  const environment = (await import("../../env.js")).env;
  const originalPath = environment.DATABASE_PATH;
  const globalDb = globalThis as unknown as {
    client: typeof client | undefined;
  };
  const originalClient = globalDb.client;
  const blocked = path.join(scratch, "unavailable");
  writeFileSync(blocked, "A file cannot be a database directory.");
  Object.assign(environment, {
    DATABASE_PATH: path.join(blocked, "portfolio.db"),
  });
  globalDb.client = undefined;
  try {
    await assert.rejects(
      import(
        `${pathToFileURL(path.join(root, "src/server/db/index.ts")).href}?unavailable`
      ),
      /EEXIST|ENOTDIR/,
    );
  } finally {
    Object.assign(environment, { DATABASE_PATH: originalPath });
    globalDb.client = originalClient;
  }
});

void test("root failure fallback renders independently with a reload and safe reference", async () => {
  assert.ok(
    existsSync(path.join(root, "src/app/global-error.tsx")),
    "Missing root error fallback",
  );
  const { default: GlobalError } = await import("../global-error.tsx");
  const error = Object.assign(new Error("private database path"), {
    digest: "reference-456",
  });
  const tree = GlobalError({ error, reset: () => undefined });
  const html = renderToStaticMarkup(tree);
  assert.match(html, /<html lang="en"/);
  assert.match(html, /<body/);
  assert.match(html, /role="alert"/);
  assert.match(html, /Try again/);
  assert.match(html, /reference-456/);
  assert.doesNotMatch(html, /private database path/);
  const pending: React.ReactNode[] = [tree];
  let reload: (() => void) | undefined;
  while (pending.length) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      pending.push(...(node as React.ReactNode[]));
      continue;
    }
    if (!node || typeof node !== "object" || !("props" in node)) continue;
    const element = node as React.ReactElement<{
      children?: React.ReactNode;
      onClick?: () => void;
    }>;
    if (element.type === "button") reload = element.props.onClick;
    pending.push(element.props.children);
  }
  assert.ok(reload);
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let reloads = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        reload: () => {
          reloads++;
        },
      },
    },
  });
  try {
    reload();
    assert.equal(reloads, 1);
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
