import "../../server/test-env.ts";

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import nodeModule, {
  type LoadFnOutput,
  type LoadHookContext,
  type ResolveFnOutput,
  type ResolveHookContext,
} from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createElement } from "react";
import "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import ts from "typescript";
import type { UpdateView } from "../../server/updates.ts";
import type { PortfolioFacts } from "../../server/portfolio.ts";
import type { QueueItem } from "../../server/queue.ts";
import * as format from "./format.ts";
import {
  dayMoveLabel,
  EFFORT_LEVELS,
  effortsFor,
  groupEvidence,
} from "./format.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const fixture = {
  state: [] as unknown[],
  cursor: 0,
  refreshes: 0,
  save: {
    isPending: false,
    error: null as { data: { code: string }; message: string } | null,
    reset() {
      this.error = null;
    },
    mutateAsync: async () => undefined,
  },
  ask: { data: null as unknown, isPending: false, error: null },
};
(globalThis as unknown as { uiFixture: typeof fixture }).uiFixture = fixture;
const tickerFixture = {
  facts: null as PortfolioFacts | null,
  history: [] as UpdateView[],
  dossier: "# AAA\n\n## Thesis\n\nMy thesis",
  pack: null as Record<string, unknown> | null,
  filings: [] as Record<string, unknown>[],
  decisions: [] as Record<string, unknown>[],
};
Object.assign(globalThis, { uiTickerFixture: tickerFixture });
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
// Compile the real UI without starting Next. Only its Link boundary and environment are replaced.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (
      decodeURIComponent(context.parentURL ?? "").endsWith(
        "/src/app/t/[ticker]/page.tsx",
      )
    ) {
      const boundary: Record<string, string> = {
        "~/app/_components/page-data": "data",
        "~/server/updates": "updates",
        "~/server/db": "db",
        "~/server/dossier": "dossier",
        "~/server/research/pack": "pack",
      };
      if (boundary[specifier])
        return { url: `ui-ticker:${boundary[specifier]}`, shortCircuit: true };
    }
    if (
      specifier === "react" &&
      context.parentURL?.endsWith("/ticker-tools.tsx")
    )
      return { url: "ui-test:state", shortCircuit: true };
    if (specifier === "next/navigation")
      return { url: "ui-test:navigation", shortCircuit: true };
    if (specifier === "~/trpc/react")
      return { url: "ui-test:api", shortCircuit: true };
    if (specifier === "next/link")
      return { url: "ui-test:link", shortCircuit: true };
    let resolved = specifier;
    if (
      specifier.startsWith("~/") ||
      (specifier.startsWith(".") && context.parentURL?.startsWith("file:"))
    ) {
      const base = specifier.startsWith("~/")
        ? path.join(root, "src", specifier.slice(2))
        : fileURLToPath(new URL(specifier, context.parentURL));
      if (base === path.join(root, "src/env.js"))
        return { url: "ui-test:env", shortCircuit: true };
      const file = [
        base,
        base + ".ts",
        base + ".tsx",
        path.join(base, "index.ts"),
      ].find((file) => /\.[cm]?[jt]sx?$/.test(file) && existsSync(file));
      if (file) resolved = pathToFileURL(file).href;
    }
    return next(resolved, context);
  },
  load(url, context, next) {
    const actual = (file: string) =>
      JSON.stringify(pathToFileURL(path.join(root, "src", file)).href);
    const tickerModules: Record<string, string> = {
      "ui-ticker:data": `export const portfolioFacts=async()=>globalThis.uiTickerFixture.facts; export const briefAndQueue=async()=>({queue:[],runId:null}); export {proofChecks,tickerNumbers} from ${actual("app/_components/page-data.ts")};`,
      "ui-ticker:updates": `export * from ${actual("server/updates.ts")}; export const tickerHistory=async()=>globalThis.uiTickerFixture.history; export const filingLinks=async()=>({});`,
      "ui-ticker:dossier": `export * from ${actual("server/dossier.ts")}; export const readDossier=()=>globalThis.uiTickerFixture.dossier;`,
      "ui-ticker:pack": `export * from ${actual("server/research/pack.ts")}; export const readPack=()=>globalThis.uiTickerFixture.pack;`,
      "ui-ticker:db": `const f=globalThis.uiTickerFixture; export const db={select:()=>({from:table=>{const name=table[Symbol.for('drizzle:Name')]; const rows=name==='filings'?f.filings:name==='decisions'?f.decisions:name==='holdings'?[{ticker:'AAA'}]:[{lastFullReviewAt:'2026-11-05'}]; const query={where:()=>query,orderBy:()=>query,then:resolve=>Promise.resolve(rows).then(resolve)}; return query;}})};`,
    };
    if (tickerModules[url])
      return {
        format: "module",
        source: tickerModules[url],
        shortCircuit: true,
      };
    const clientModules: Record<string, string> = {
      "ui-test:state": `export function useState(initial) { const f = globalThis.uiFixture; const i = f.cursor++; if (!(i in f.state)) f.state[i] = typeof initial === 'function' ? initial() : initial; return [f.state[i], value => {f.state[i] = typeof value === 'function' ? value(f.state[i]) : value;}]; }`,
      "ui-test:navigation": `export const useRouter = () => ({refresh() {globalThis.uiFixture.refreshes++;}}); export const notFound = () => {throw new Error('Not found');};`,
      "ui-test:api": `const f = globalThis.uiFixture; const empty = {isPending:false, error:null, reset(){}, mutateAsync:async()=>({})}; export const api = {dossiers:{save:{useMutation:()=>f.save}},tickers:{draftThesis:{useMutation:()=>empty},acceptThesis:{useMutation:()=>empty},ask:{useMutation:()=>f.ask},addDecision:{useMutation:()=>empty}}};`,
    };
    if (clientModules[url])
      return {
        format: "module",
        source: clientModules[url],
        shortCircuit: true,
      };
    if (url === "ui-test:link")
      return {
        format: "module",
        source:
          "export default function Link(props) { return {$$typeof:Symbol.for('react.transitional.element'),type:'a',key:null,props,_owner:null}; }",
        shortCircuit: true,
      };
    if (url === "ui-test:env")
      return {
        format: "module",
        source: `export const env = {DATABASE_PATH:${JSON.stringify(process.env.DATABASE_PATH)},NODE_ENV:'test'};`,
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
const { AgreeBadge, ProofStrip } = await import("./badges.tsx");
const { ReasoningChain } = await import("./reasoning-chain.tsx");
const run = await import("../../server/research/run.ts");
const { client } = await import("../../server/db/index.ts");
const { reviewBasisNotice } = await import("../../server/updates.ts");
const pageData = await import("./page-data.ts");
const tools = await import("./ticker-tools.tsx");
const tickerPage = await import("../t/[ticker]/page.tsx");
async function renderTicker(tab = "reasoning") {
  return renderToStaticMarkup(
    await tickerPage.default({
      params: Promise.resolve({ ticker: "AAA" }),
      searchParams: Promise.resolve({ tab }),
    }),
  );
}
async function resetTicker() {
  const { computePortfolioFacts } = await import("../../server/portfolio.ts");
  const position = {
    ticker: "AAA",
    name: "Example",
    quantity: 2.0769,
    costBasis: null,
  };
  const facts = computePortfolioFacts(
    [position],
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
  Object.assign(tickerFixture, {
    facts,
    history: [review()],
    pack: null,
    filings: [],
    decisions: [],
    dossier: "# AAA\n\n## Thesis\n\nMy thesis",
  });
}

type Element = {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
};
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
const renderTool = (component: () => unknown) => {
  fixture.cursor = 0;
  return component();
};
const click = async (tree: unknown, label: string) => {
  const button = elements(tree).find(
    (e) => e.type === "button" && e.props.children === label,
  );
  assert.ok(button, `Missing button: ${label}`);
  await (button.props.onClick as () => void | Promise<void>)();
};
after(() => {
  client.close();
  hooks.deregister();
});

const review = (): UpdateView => ({
  id: 1,
  runId: 1,
  ticker: "AAA",
  depth: "FULL",
  createdAt: "2026-11-05T12:00:00Z",
  result: {
    ticker: "AAA",
    status: "no_change",
    headline: "Steady",
    what_changed: [],
    evidence: [],
    action: "hold",
    confidence: 0.7,
    business_view: "Steady business",
    valuation_view: "Fair price",
    evidence_against: [],
    next_proof_point: "Next report",
    reasoning: "Steady",
    would_change_my_mind: [],
    dossier_current_view: null,
  },
  verification: {
    ticker: "AAA",
    checks: [],
    conclusion_supported: true,
    concerns: [],
    independent_action: "hold",
    independent_reason: "Steady",
  },
  firstPass: null,
  verifiedScore: 1,
  analystProvider: "chatgpt",
  analystModel: "test",
  verifierProvider: "claude",
  verifierModel: "test",
  usedFallback: false,
  revisedAfterReview: false,
  recheckedAt: null,
  thesisAtReview: "My thesis",
  previousAction: null,
  providerMode: "both",
  quotePricedAt: null,
});
const renderReview = (update: UpdateView, extra = {}) =>
  renderToStaticMarkup(
    createElement(ReasoningChain, { update, links: {}, ...extra }),
  );

// Queue and page regressions use the real components with offline data boundaries.
const queueRules = await import("../../server/queue.ts");
const updateRules = await import("../../server/updates.ts");
const portfolioRules = await import("../../server/portfolio.ts");
const pageFixture = {
  facts: portfolioRules.computePortfolioFacts(
    [],
    new Map(),
    new Map(),
  ) as PortfolioFacts & {
    holdings_updated_at?: string | null;
    holdings_latest_updated_at?: string | null;
  },
  updates: new Map<string, UpdateView>(),
  brief: null as Record<string, unknown> | null,
  queue: [] as QueueItem[],
  openCount: 0,
  provider: "chatgpt",
  runId: 1 as number | null,
  briefReadyAt: "2026-11-05T15:00:00Z" as string | null,
  decisions: [] as {
    ticker: string;
    date: string;
    actionTaken: string;
    note: string;
  }[],
};
Object.assign(globalThis, { portcheckerPageFixture: pageFixture });
const pageHooks = registerHooks({
  resolve(specifier, context, next) {
    const page = /\/src\/app\/(?:holdings\/)?page\.tsx$/.test(
      context.parentURL ?? "",
    );
    if (specifier === "next/navigation")
      return { url: "ui-page:navigation", shortCircuit: true };
    if (page && specifier === "~/app/_components/page-data")
      return { url: "ui-page:data", shortCircuit: true };
    if (page && specifier === "~/server/dossier")
      return { url: "ui-page:dossier", shortCircuit: true };
    if (page && specifier === "~/server/db")
      return { url: "ui-page:db", shortCircuit: true };
    if (page && specifier === "~/app/_components/ticker-tools")
      return { url: "ui-page:decision", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    const sources: Record<string, string> = {
      "ui-page:navigation":
        "export const useRouter = () => ({push(){},refresh(){}});",
      "ui-page:data": `export const portfolioFacts=async()=>globalThis.portcheckerPageFixture.facts; export const reviews=async()=>globalThis.portcheckerPageFixture.updates; export const briefAndQueue=async()=>globalThis.portcheckerPageFixture; export {proofChecks} from ${JSON.stringify(pathToFileURL(path.join(root, "src/server/research/run.ts")).href)};`,
      "ui-page:dossier": "export const readThesis = () => null;",
      "ui-page:db":
        "export const db={select:()=>({from:()=>({where:async()=>[]})})};",
      "ui-page:decision": "export const DecisionForm=()=>null;",
    };
    if (sources[url])
      return { format: "module", source: sources[url], shortCircuit: true };
    return next(url, context);
  },
});
const todayPage = await import("../page.tsx");
const holdingsPage = await import("../holdings/page.tsx");
await client.executeMultiple(
  "CREATE TABLE IF NOT EXISTS filings (accession_no TEXT,primary_doc_url TEXT);",
);
after(() => pageHooks.deregister());

void test("rejected conclusions suppress agreement but retain a different second opinion", () => {
  for (const opinion of [
    "agree",
    "disagree",
    "second_pass_disagrees",
    null,
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(AgreeBadge, { opinion, rejected: true }),
    );
    assert.match(html, /Final check rejected/);
    assert.match(html, /text-bad/);
    assert.doesNotMatch(html, /Models agree/);
    if (opinion === "disagree") assert.match(html, /Models disagree/);
    if (opinion === "second_pass_disagrees")
      assert.match(html, /Second check disagrees/);
  }
  assert.match(
    renderToStaticMarkup(createElement(AgreeBadge, { opinion: "agree" })),
    /Models agree/,
  );
});

void test("only an explicitly rejected verification flags a conclusion", () => {
  assert.equal(
    format.checkRejected?.({ verification: { conclusion_supported: false } }),
    true,
  );
  assert.equal(
    format.checkRejected?.({ verification: { conclusion_supported: true } }),
    false,
  );
  assert.equal(format.checkRejected?.({ verification: null }), false);
  assert.equal(format.checkRejected?.({ verification: {} }), false);
});

void test("a supported conclusion with a different action describes the disagreement without a green tick", () => {
  assert.deepEqual(format.conclusionNote?.(true, true), {
    tone: "text-warn",
    text: "The second check accepts the facts behind this conclusion, but would act differently.",
  });
  assert.deepEqual(format.conclusionNote?.(true, false), {
    tone: "text-ok",
    text: "✓ The evidence supports this conclusion.",
  });
  assert.deepEqual(format.conclusionNote?.(false, true), {
    tone: "text-bad font-medium",
    text: "✗ The evidence does not support this conclusion.",
  });
  const update = review();
  update.verification!.independent_action = "add";
  const html = renderReview(update);
  assert.match(
    html,
    /accepts the facts behind this conclusion, but would act differently/,
  );
  assert.doesNotMatch(html, /✓ The evidence supports this conclusion/);
});

void test("all-clear wording distinguishes saved web summaries from source documents", () => {
  assert.equal(
    format.allClearText?.(0),
    "✓ The second check confirmed all listed claims against the research files.",
  );
  assert.match(
    format.allClearText?.(15) ?? "",
    /research files\. 15 cite web summaries/,
  );
  assert.match(format.allClearText?.(1) ?? "", /1 cites web summaries/);
  const update = review();
  update.verification!.checks = [
    {
      claim: "Mandate unchanged",
      verdict: "verified",
      note: "Found",
      source: "news:https://example.com/fund",
    },
  ];
  const html = renderReview(update);
  assert.match(html, /1 cites web summaries/);
  assert.match(html, /This call rests mainly on web summaries/);
});

void test("an evidence all-clear describes listed claims without assuring unchecked prose", () => {
  const update = review();
  update.result.what_changed = [
    "Price is 100",
    "Revenue collapsed 90% during Q3.",
  ];
  update.result.evidence = [
    { claim: "Price is 100", source: "fmp:quote", date: "2026-11-05" },
  ];
  update.verification!.checks = [
    {
      claim: "Price is 100",
      verdict: "verified",
      source: "fmp:quote",
      note: "Found",
    },
  ];
  const html = renderReview(update);
  assert.match(html, /Revenue collapsed 90% during Q3/);
  assert.match(
    html,
    /✓ The second check confirmed all listed claims against the research files/,
  );
  assert.doesNotMatch(html, /found every claim/);
  update.result.evidence.push({
    claim: "Debt is 50",
    source: "fmp:quote",
    date: "2026-11-05",
  });
  assert.doesNotMatch(
    renderReview(update),
    /✓ The second check confirmed all listed claims/,
  );
});

void test("claim labels and rendered evidence preserve full URLs and figures", () => {
  for (const url of [
    "https://example.com/revenue_q3?source_type=report#cash_flow_1",
    "https://example.com/next_proof_point?what_changed=1#evidence_against",
  ]) {
    const claim = `next_proof_point: See ${url}; revenue is 30.99.`;
    assert.equal(
      format.claimForReader(claim),
      `What to watch: See ${url}; revenue is 30.99.`,
    );
    const update = review();
    update.result.evidence = [
      { claim, source: "fmp:quote", date: "2026-11-05" },
    ];
    const html = renderReview(update);
    assert.ok(html.includes(url));
    assert.match(html, /What to watch: See/);
    assert.match(html, /30\.99/);
  }
});

void test("joined citations accept optional separator whitespace and keep semicolons inside URLs", () => {
  for (const space of ["", " ", "\n"]) {
    const source = `news:https://example.com/article;${space}file:pack.json`;
    assert.deepEqual(
      format.sourceParts(source).map((p) => [p.url, p.label]),
      [
        ["https://example.com/article", "News article"],
        [undefined, "Research data"],
      ],
    );
    const update = review();
    update.result.evidence = [
      { claim: "Revenue grew", source, date: "2026-11-05" },
    ];
    const html = renderReview(update);
    assert.match(html, /href="https:\/\/example.com\/article"/);
    assert.match(html, /Research data/);
  }
  assert.equal(
    format.sourceParts("news:https://example.com/a;b?x=1;y=2")[0]?.url,
    "https://example.com/a;b?x=1;y=2",
  );
});

void test("all reasoning prose uses reader words while retaining the stored review", () => {
  const update = review();
  Object.assign(update.result, {
    reasoning: "my_position in pack.json shows 10 shares.",
    business_view: "income_statement_quarterly shows sales growth.",
    valuation_view: "key_metrics_ttm in pack.json gives the valuation.",
    next_proof_point: "Watch revenue_yoy_pct in pack.json.",
    headline: "my_position in pack.json is steady.",
  });
  update.verification!.independent_action = "add";
  const saved = JSON.stringify(update);
  const html = renderReview(update);
  assert.doesNotMatch(
    html,
    /my_position|pack\.json|income_statement_quarterly|key_metrics_ttm|revenue_yoy_pct/,
  );
  for (const text of [
    "my position",
    "10 shares",
    "income statement quarterly",
    "key metrics ttm",
    "revenue yoy pct",
  ])
    assert.ok(html.includes(text), text);
  assert.equal(JSON.stringify(update), saved);
});

void test("historical review percentages use the same claims as the proof strip", () => {
  const update = review();
  update.verifiedScore = 0.9091;
  update.verification!.checks = Array.from({ length: 21 }, (_, i) => ({
    claim: `Price is ${100 + i}`,
    verdict: i < 20 ? ("verified" as const) : ("unverified" as const),
    note: "Found",
    source: "fmp:quote",
  }));
  const html = renderToStaticMarkup(
    createElement(
      "div",
      null,
      createElement(ProofStrip, { checks: run.proofChecks(update) }),
      createElement(ReasoningChain, { update, links: {} }),
    ),
  );
  assert.match(html, /20 of 21 claims verified/);
  assert.match(html, /Verified score: 95%/);
  assert.equal(update.verifiedScore, 0.9091);
});

void test("loaded historical rows render reconciled scores without rewriting saved audit rows", async () => {
  const update = review();
  update.verification!.checks = Array.from({ length: 21 }, (_, i) => ({
    claim: `Price is ${100 + i}`,
    verdict: i < 20 ? ("verified" as const) : ("unverified" as const),
    note: "Found",
    source: "fmp:quote",
  }));
  await client.executeMultiple(
    "CREATE TABLE IF NOT EXISTS research_runs (id INTEGER PRIMARY KEY, provider_mode TEXT); CREATE TABLE IF NOT EXISTS ticker_updates (id INTEGER PRIMARY KEY, run_id INTEGER, ticker TEXT, review_depth TEXT, result_json TEXT, verification_json TEXT, verified_score REAL, analyst_provider TEXT, analyst_model TEXT, verifier_provider TEXT, verifier_model TEXT, used_fallback INTEGER, revised_after_review INTEGER, created_at TEXT);",
  );
  await client.execute({
    sql: "INSERT INTO ticker_updates VALUES (79,16,'MSFT','FULL',?,?,0.9091,'chatgpt','test','claude','test',0,0,'2026-11-04T22:00:00Z')",
    args: [JSON.stringify(update.result), JSON.stringify(update.verification)],
  });
  try {
    const [loaded] = await updateRules.tickerHistory("MSFT");
    assert.ok(loaded);
    assert.match(renderReview(loaded), /Verified score: 95%/);
    assert.equal(
      (
        await client.execute(
          "SELECT verified_score FROM ticker_updates WHERE id=79",
        )
      ).rows[0]?.verified_score,
      0.9091,
    );
  } finally {
    await client.execute("DELETE FROM ticker_updates WHERE id=79");
  }
});

void test("claim labels become readable without changing ordinary reasoning prose", () => {
  for (const [input, expected] of [
    ["evidence_against[2]: Cash", "Case against: Cash"],
    ["reasoning: Hold", "Reasoning: Hold"],
    ["The reasoning: Hold", "The reasoning: Hold"],
    [
      "(evidence_against / dossier_current_view).",
      "(Case against / Current view).",
    ],
    ["new_filings is empty", "new filings is empty"],
    ["what_changed[0]: Growth", "What's new: Growth"],
  ])
    assert.equal(format.claimForReader?.(input!), expected);
  const update = review();
  update.verification!.checks = [
    {
      claim: "evidence_against[2]: Cash",
      verdict: "unverified",
      note: "fund_info.expenseRatio 0.03",
      source: "file:pack.json",
    },
  ];
  const html = renderReview(update);
  assert.match(html, /Case against: Cash/);
  assert.doesNotMatch(html, /evidence_against/);
  assert.match(html, /fund info expenseRatio 0\.03/);
});

void test("joined citations preserve each source link and reader-facing label", () => {
  const source =
    "news:https://a.com/x; edgar:0001628280-26-069805; file:pack.json (fund_info, fmp:dividends)";
  const parts = format.sourceParts?.(source);
  assert.deepEqual(
    parts?.map((part) => part.label),
    ["News article", "EDGAR 0001628280-26-069805", "Research data"],
  );
  assert.equal(parts?.[0]?.url, "https://a.com/x");
  assert.equal(parts?.[1]?.accession, "0001628280-26-069805");
  assert.equal(
    format.sourceParts?.(
      "file:filing_event_2026-11-04_0000804328-26-000127.txt",
    )[0]?.accession,
    "0000804328-26-000127",
  );
  for (const [input, label] of [
    ["fmp:ratios", "FMP ratios"],
    ["unknown", "unknown"],
    ["dossier", "My research file"],
    ["file:web_research.md", "Web research"],
    ["file:claim_excerpts.md", "Filing excerpts"],
    ["file:filing_sections_10-Q_2026-07-30.md", "10-Q, 2026-07-30"],
    ["https://www.sec.gov/Archives/edgar/data/example", "SEC filing"],
  ])
    assert.equal(format.sourceParts?.(input!)[0]?.label, label);
  assert.equal(format.sourceParts?.("javascript:alert(1)")[0]?.url, undefined);
  const update = review();
  update.result.evidence = [{ claim: "Stable", source, date: "2026-11-05" }];
  const html = renderToStaticMarkup(
    createElement(ReasoningChain, {
      update,
      links: { "0001628280-26-069805": "https://www.sec.gov/Archives/filing" },
    }),
  );
  assert.match(html, /href="https:\/\/a.com\/x"/);
  assert.match(html, /href="https:\/\/www.sec.gov\/Archives\/filing"/);
  assert.match(html, /Research data/);
  assert.doesNotMatch(html, /href="[^"]*;/);
});

void test("proof counts include unchecked evidence without calling it unverified", () => {
  const update = review();
  update.result.evidence = ["Revenue grew", "Debt fell", "Margin steady"].map(
    (claim) => ({ claim, source: "file:pack.json", date: "2026-11-05" }),
  );
  update.verification!.checks = [
    {
      claim: "Revenue grew",
      verdict: "verified",
      note: "Found",
      source: "file:pack.json",
    },
    {
      claim: "Debt fell",
      verdict: "unverified",
      note: "Missing",
      source: "file:pack.json",
    },
  ];
  const checks = run.proofChecks?.(update);
  assert.deepEqual(
    checks?.map((check) => check.verdict),
    ["verified", "unverified", "not_checked"],
  );
  assert.equal(
    run.verifiedScore(update.verification, update.result.evidence),
    0.3333,
  );
  const html = renderToStaticMarkup(
    createElement(ProofStrip, { checks, size: "large" }),
  );
  assert.match(
    html,
    /1 of 3 claims verified, 1 could not be found, 1 not checked/,
  );
  assert.match(html, /Not checked: Margin steady/);
  assert.equal(run.proofChecks?.({ ...update, verification: null }), null);
});

void test("proof tick titles use the same readable claim labels as evidence", () => {
  const html = renderToStaticMarkup(
    createElement(ProofStrip, {
      checks: [{ claim: "dossier_current_view: Stable", verdict: "verified" }],
      size: "large",
    }),
  );
  assert.match(html, /title="Verified: Current view: Stable"/);
  assert.doesNotMatch(html, /dossier_current_view/);
});

void test("the reasoning notice includes a full review requested by break-condition edits", () => {
  const update = review();
  const expected = reviewBasisNotice("My thesis", "My thesis", null)!;
  assert.match(
    renderReview(update, { thesis: "My thesis", lastFullReviewAt: null }),
    new RegExp(expected.replaceAll(".", "\\.")),
  );
  assert.doesNotMatch(
    renderReview(update, {
      thesis: "My thesis",
      lastFullReviewAt: "2026-11-05",
    }),
    /next research run/i,
  );
  assert.match(
    renderReview(update, { thesis: "New thesis" }),
    /before this version of your thesis/,
  );
});

void test("saved unconfirmed claims use readable labels and never show a cut-off figure", () => {
  const view =
    "Still steady.\n\nThe second check could not confirm:\n\n- dossier_current_view: The company's unrestricted cash was $2.2 b...\n- evidence_against[0]: A complete claim.";
  const text = format.currentViewForReader?.(view) ?? "";
  assert.match(
    text,
    /Current view: The company\x27s unrestricted cash was\.\.\./,
  );
  assert.match(text, /Case against: A complete claim\./);
  assert.doesNotMatch(text, /\$2\.2|dossier_current_view|evidence_against/);
  assert.equal(
    format.currentViewForReader?.("A full view with $2.2 billion."),
    "A full view with $2.2 billion.",
  );
});

void test("an unknown saved source link stays clickable with its warning beside it", () => {
  const update = review();
  update.result.evidence = [
    {
      claim: "Stable",
      source: "news:https://example.com/mistyped",
      date: "2026-11-05",
    },
  ];
  Object.assign(update.result.evidence[0]!, { link_not_in_files: true });
  const html = renderReview(update);
  assert.match(html, /href="https:\/\/example.com\/mistyped"/);
  assert.match(html, /Link not in the research files/);
});

void test("fund reviews label their role and costs while older reviews keep company labels", () => {
  const update = review();
  const older = renderReview(update);
  assert.match(older, /Business: /);
  assert.match(older, /Valuation: /);
  Object.assign(update.result, { is_fund: true });
  const html = renderReview(update);
  assert.match(html, /Role: /);
  assert.match(html, /Cost and performance: /);
  assert.doesNotMatch(html, />Business: | >Valuation: /);
});

void test("effort choices follow the selected model", () => {
  const models = [
    { id: "a", efforts: ["low", "medium", "ultra"] },
    { id: "b", efforts: ["low", "medium"] },
    { id: "none", efforts: [] },
  ];
  assert.deepEqual(effortsFor("a", models), ["low", "medium", "ultra"]);
  assert.deepEqual(effortsFor("none", models), []);
  assert.deepEqual(effortsFor("typed-name", models), EFFORT_LEVELS);
  assert.deepEqual(effortsFor("", models.slice(0, 2)), ["low", "medium"]);
  assert.deepEqual(effortsFor("", []), EFFORT_LEVELS);
});

void test("only matching verified evidence folds away", () => {
  const entries = [
    null,
    { verdict: "unverified" },
    { verdict: "contradicted" },
    { verdict: "verified" },
  ].map((check) => ({ check }));
  const grouped = groupEvidence(entries);
  assert.deepEqual(grouped.flagged, entries.slice(0, 3));
  assert.deepEqual(grouped.clean, entries.slice(3));
  assert.deepEqual(groupEvidence([]), { flagged: [], clean: [] });
});

void test("day move labels tolerate older facts and identify cached sessions", () => {
  assert.equal(dayMoveLabel(undefined, "2026-11-04"), "Today");
  assert.equal(
    dayMoveLabel(
      { newest: "2026-11-04", oldest: "2026-11-04", stale: [] },
      "2026-11-04",
    ),
    "Today",
  );
  assert.equal(
    dayMoveLabel(
      { newest: "2026-11-03", oldest: "2026-11-02", stale: ["TEST"] },
      "2026-11-04",
    ),
    "Last session (Nov 3)",
  );
  assert.equal(
    dayMoveLabel({ newest: null, oldest: null, stale: [] }, "2026-11-04"),
    "Last session (date unavailable)",
  );
});

void test("ticker moves name the quote session and tolerate an unknown date", () => {
  assert.equal(format.dayMoveWhen?.("2026-11-05", "2026-11-05"), "today");
  assert.equal(format.dayMoveWhen?.("2026-11-04", "2026-11-05"), "on Nov 4");
  assert.equal(format.dayMoveWhen?.(null, "2026-11-05"), "last session");
});

void test("historical dates include their year and malformed saved dates stay readable", () => {
  assert.equal(format.dayWithYear?.("2026-10-30", "2026-11-05"), "Oct 30");
  assert.equal(
    format.dayWithYear?.("2025-10-31", "2026-11-05"),
    "Oct 31, 2025",
  );
  for (const day of ["", "bad", "2026-02-30", "2026-13-01"]) {
    assert.equal(format.shortDate(day), "no date");
    assert.equal(format.dayWithYear?.(day, "2026-11-05"), "no date");
  }
});

void test("fractional shares keep imported precision without floating point noise", () => {
  assert.equal(format.shares?.(2.0769), "2.0769");
  assert.equal(format.shares?.(1000.5), "1,000.5");
  assert.equal(format.shares?.(1.1 + 2.2), "3.3");
  assert.equal(format.shares?.(9), "9");
});

void test("filing changes keep literal evidence while replacing inaccessible file pointers", () => {
  assert.deepEqual(
    format.diffLines?.(
      "## Risk factors\n\n### Added\n+ We may *not* comply_with 1. rules.\n(none)\nNot compared: section missing from a filing.\n[12 less important changes are left out here; see filing_changes_10-Q.txt]",
    ),
    [
      { kind: "head", text: "Risk factors" },
      { kind: "subhead", text: "Added" },
      { kind: "plain", text: "+ We may *not* comply_with 1. rules." },
      { kind: "plain", text: "(none)" },
      { kind: "plain", text: "Not compared: section missing from a filing." },
      { kind: "plain", text: "[12 less important changes are not shown]" },
    ],
  );
});

void test("research dates distinguish the price time from the saved research date", () => {
  assert.equal(
    format.packDates?.({
      quote: { as_of_et: "Nov 4, 2026, 4:00 PM ET" },
      generated_on: "2026-11-05",
    }),
    "Prices as of Nov 4, 2026, 4:00 PM ET. Research file from Nov 5, 2026.",
  );
  assert.equal(
    format.packDates?.({ generated_on: "2026-11-05" }),
    "Research file from Nov 5, 2026.",
  );
  assert.equal(format.packDates?.({ quote: { as_of_et: 0 } }), "");
});

void test("research dates say when returns stop a session before the quote", () => {
  const at = (hourUtc: number, day = 12) => ({
    as_of_et: "the quote time",
    timestamp: Date.UTC(2026, 10, day, hourUtc) / 1000,
  });
  // 11:00 ET on Thursday Nov 12, while the daily history ends at Wednesday's close.
  assert.equal(
    format.packDates({
      quote: at(16),
      price_summary: { latest_date: "2026-11-11" },
      generated_on: "2026-11-12",
    }),
    "Prices as of the quote time. Returns, highs and lows use closing prices through Nov 11, 2026. Research file from Nov 12, 2026.",
  );
  const quiet = "Prices as of the quote time.";
  // The same session, including an 8 PM ET quote that is already Nov 13 in UTC and in Tokyo.
  for (const quote of [at(16), at(21), at(1, 13)]) {
    assert.equal(
      format.packDates({ quote, price_summary: { latest_date: "2026-11-12" } }),
      quiet,
    );
  }
  // Nothing to compare: no quote time, no history, or a date that is not one.
  for (const pack of [
    {
      quote: { as_of_et: "the quote time" },
      price_summary: { latest_date: "2026-11-11" },
    },
    { quote: at(16), price_summary: null },
    { quote: at(16), price_summary: { latest_date: "undefined" } },
  ]) {
    assert.equal(format.packDates(pack), quiet);
  }
});

void test("ticker numbers date fiscal quarters and use signed return precision", () => {
  const pack = {
    income_statement_quarterly: [
      { period: "Q4", fiscalYear: 2026, date: "2026-09-27", revenue: 10 },
    ],
    price_summary: { price_return_1y_pct: -5.35, total_return_1y_pct: 13.15 },
  };
  const groups = pageData.tickerNumbers?.(pack);
  assert.equal(
    groups?.find((g) => g.title.startsWith("Latest quarter"))?.title,
    "Latest quarter, Q4 2026, ended Sep 27, 2026",
  );
  const rows = groups?.find((g) => g.title === "Price")?.rows;
  assert.deepEqual(
    rows?.filter(([label]) => label.startsWith("1-year")),
    [
      ["1-year price return", "−5.35%"],
      ["1-year total return", "+13.15%"],
    ],
  );
  delete (pack.income_statement_quarterly[0] as { date?: string }).date;
  assert.equal(
    pageData
      .tickerNumbers?.(pack)
      .find((g) => g.title.startsWith("Latest quarter"))?.title,
    "Latest quarter, Q4 2026",
  );
});

void test("limited lists say when older entries may be omitted", () => {
  assert.equal(format.cappedLabel?.(293, 20), "latest 20");
  assert.equal(format.cappedLabel?.(20, 20), "latest 20");
  assert.equal(format.cappedLabel?.(19, 20), "19");
  assert.equal(format.cappedLabel?.(30, 30), "latest 30");
});

void test("unrealized gains disclose partial cost basis coverage and exclude cash", async () => {
  assert.equal(format.gainLabel?.(19, 19), "Unrealized gain");
  assert.equal(
    format.gainLabel?.(12, 19),
    "Unrealized gain, 12 of 19 holdings",
  );
  assert.equal(format.gainLabel?.(0, 19), null);
  const { computePortfolioFacts } = await import("../../server/portfolio.ts");
  const { PortfolioSummary } = await import("./badges.tsx");
  const facts = computePortfolioFacts(
    [
      { ticker: "AAA", name: "A", quantity: 2, costBasis: 10 },
      { ticker: "BBB", name: "B", quantity: 1, costBasis: null },
      { ticker: "CASH", name: "Cash", quantity: 100, costBasis: 100 },
    ],
    new Map([
      ["AAA", { price: 10, previousClose: 9, date: "2026-11-05" }],
      ["BBB", { price: 10, previousClose: 9, date: "2026-11-05" }],
    ]),
    new Map(),
  );
  const html = renderToStaticMarkup(createElement(PortfolioSummary, { facts }));
  assert.match(html, /Unrealized gain, 1 of 2 holdings/);
  assert.match(html, /\+\$10/);
});

void test("quote warnings disclose excluded day changes even when quote dates match", async () => {
  const { computePortfolioFacts } = await import("../../server/portfolio.ts");
  const { QuoteWarning } = await import("./badges.tsx");
  const facts = computePortfolioFacts(
    [{ ticker: "AAA", name: "A", quantity: 1, costBasis: null }],
    new Map([["AAA", { price: 10, date: "2026-11-05" }]]),
    new Map(),
    "2026-11-05",
  );
  assert.deepEqual(facts.day_change_left_out, ["AAA"]);
  const html = renderToStaticMarkup(createElement(QuoteWarning, { facts }));
  assert.match(html, /The day&#x27;s total leaves out AAA\./);
  assert.doesNotMatch(html, /Prices for/);
  facts.quote_dates.stale = ["AAA"];
  assert.match(
    renderToStaticMarkup(createElement(QuoteWarning, { facts })),
    /Prices for AAA are from earlier sessions/,
  );
});

void test("notes cannot load images and model notes cannot create live links", () => {
  const text =
    "![chart](https://example.com/inline.png)\n\n![chart][ref]\n\n[ref]: https://example.com/reference.png\n\n[edgar](https://example.com/filing)\n\n**Bold**\n\n- List item";
  for (const blocked of [format.NOTE_BLOCKED, format.MODEL_TEXT_BLOCKED]) {
    const html = renderToStaticMarkup(
      createElement(
        ReactMarkdown,
        {
          disallowedElements: blocked,
          unwrapDisallowed: true,
        },
        text,
      ),
    );
    assert.doesNotMatch(html, /<img|preload/);
    assert.match(html, /<strong>Bold<\/strong>/);
    assert.match(html, /<li>List item<\/li>/);
    assert.match(html, /edgar/);
    if (blocked === format.MODEL_TEXT_BLOCKED)
      assert.doesNotMatch(html, /href=/);
    else assert.match(html, /href="https:\/\/example.com\/filing"/);
  }
  for (const file of ["reasoning-chain.tsx", "../t/[ticker]/page.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const tag of source.matchAll(/<ReactMarkdown\b[^>]*>/g))
      assert.match(tag[0], /disallowedElements=/);
  }
});

void test("check notes and reasons translate internal terms without changing sources or stored text", () => {
  const update = review();
  update.verification!.checks = [
    {
      claim: "Stable",
      verdict: "unverified",
      note: "valuation_and_growth in pack.json; web_research.md",
      source: "file:pack.json#valuation_and_growth",
    },
  ];
  update.verification!.independent_reason =
    "See web_research.md and review.json";
  update.verification!.concerns = ["Check income_statement_quarterly"];
  const html = renderReview(update);
  assert.match(html, /valuation and growth in research data; web research/);
  assert.match(html, /See web research and the review/);
  assert.match(html, /Check income statement quarterly/);
  assert.match(html, /title="file:pack.json#valuation_and_growth"/);
  assert.equal(
    update.verification!.checks[0]!.note,
    "valuation_and_growth in pack.json; web_research.md",
  );
});

void test("source labels identify research sections and preserve legacy citations", () => {
  assert.equal(format.sourceParts("file:pack.json")[0]?.label, "Research data");
  assert.equal(
    format.sourceParts("file:pack.json#valuation_and_growth")[0]?.label,
    "Research data: valuation and growth",
  );
  assert.equal(
    format.sourceParts("file:web_research.md")[0]?.label,
    "Web research",
  );
  assert.equal(format.sourceParts("fmp:ratios")[0]?.label, "FMP ratios");
});

void test("research warnings use reader labels for internal measures", () => {
  const note =
    "freeCashFlowYieldTTM in key_metrics_ttm differs from evToEBITDATTM in key_metrics_annual; revenue_yoy_pct in income_statement_quarterly and valuation_and_growth. Figures 13.15% and $23.85B.";
  const text = format.dataNoteForReader?.(note) ?? "";
  assert.doesNotMatch(text, /_|freeCashFlowYieldTTM|evToEBITDATTM/);
  assert.match(text, /free cash flow yield/);
  assert.match(text, /13\.15% and \$23\.85B/);
  assert.equal(note.includes("key_metrics_ttm"), true);
});

void test("quiet research status and same-provider disagreement use unambiguous labels", async () => {
  const { statusLabel } = await import("./badges.tsx");
  assert.equal(statusLabel("no_change"), "No material change");
  assert.equal(statusLabel("watch"), "On watch");
  assert.match(
    renderToStaticMarkup(
      createElement(AgreeBadge, { opinion: "second_pass_disagrees" }),
    ),
    /Second check disagrees/,
  );
  const update = review();
  update.verifierProvider = update.analystProvider;
  update.verification!.independent_action = "add";
  assert.match(renderReview(update), /Second check<\/h3>/);
  assert.match(renderReview(update), /The second check disagrees/);
  assert.match(renderReview(update), /Analyst confidence 70%/);
});

void test("dossier reopening clears old conflict panels and cancel preserves edits until confirmed", async () => {
  const originalWindow = globalThis.window;
  const confirmations: string[] = [];
  let confirmed = false;
  globalThis.window = {
    confirm: (message: string) => {
      confirmations.push(message);
      return confirmed;
    },
  } as unknown as Window & typeof globalThis;
  const props = { ticker: "AAA", markdown: "Saved", hash: "v1" };
  const render = () => renderTool(() => tools.DossierEditor(props));
  fixture.state = [];
  try {
    await click(render(), "Edit as text");
    await click(render(), "Cancel");
    assert.equal(confirmations.length, 0);
    await click(render(), "Edit as text");
    const textarea = elements(render()).find((e) => e.type === "textarea")!;
    (textarea.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: "My edits" },
    });
    fixture.save.error = { data: { code: "CONFLICT" }, message: "Conflict" };
    await click(render(), "Reload latest and keep my text below");
    props.markdown = "Newest";
    props.hash = "v2";
    await click(render(), "Use this version to merge my edits");
    await click(render(), "Cancel");
    assert.equal(
      elements(render()).filter((e) => e.type === "textarea").length,
      3,
    );
    assert.equal(confirmations.length, 1);
    await click(render(), "Save changes");
    await click(render(), "Edit as text");
    assert.equal(
      elements(render()).filter((e) => e.type === "textarea").length,
      1,
    );
    const changed = elements(render()).find((e) => e.type === "textarea")!;
    (changed.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: "Keep me" },
    });
    await click(render(), "Cancel");
    assert.equal(
      elements(render()).find((e) => e.type === "textarea")?.props.value,
      "Keep me",
    );
    confirmed = true;
    await click(render(), "Cancel");
    assert.equal(
      elements(render()).filter((e) => e.type === "textarea").length,
      0,
    );
  } finally {
    globalThis.window = originalWindow;
  }
});

void test("discarding a thesis draft requires confirmation", async () => {
  const originalWindow = globalThis.window;
  let confirmed = false;
  globalThis.window = { confirm: () => confirmed } as unknown as Window &
    typeof globalThis;
  const render = () => renderTool(() => tools.ThesisDrafter({ ticker: "AAA" }));
  fixture.state = ["My thesis", "Break", "Numbers", "ChatGPT", true];
  try {
    await click(render(), "Discard draft");
    assert.equal(
      elements(render()).filter((e) => e.type === "textarea").length,
      3,
    );
    confirmed = true;
    await click(render(), "Discard draft");
    assert.equal(
      elements(render()).filter((e) => e.type === "textarea").length,
      0,
    );
  } finally {
    globalThis.window = originalWindow;
  }
});

void test("ask answers disclose the missing second check and label each citation", () => {
  fixture.state = [];
  fixture.ask.data = {
    answer: "Steady",
    evidence: [
      {
        claim: "Stable",
        source: "file:pack.json#valuation_and_growth; file:web_research.md",
      },
    ],
    provider: "chatgpt",
    model: "test",
    usedFallback: true,
  };
  const tree = renderTool(() => tools.AskBox({ ticker: "AAA" }));
  const html = renderToStaticMarkup(tree as React.ReactNode);
  assert.match(
    html,
    /No second check ran, so confirm any number you keep\. Not saved\./,
  );
  assert.match(html, /Research data: valuation and growth; Web research/);
  assert.match(html, /fallback used/);
});

void test("decision dates require a value and cannot go beyond the local date", () => {
  fixture.state = [];
  const tree = renderTool(() => tools.DecisionForm({ ticker: "AAA" }));
  const input = elements(tree).find(
    (e) => e.type === "input" && e.props.type === "date",
  )!;
  assert.equal(input.props.required, true);
  assert.equal(input.props.max, new Date().toLocaleDateString("en-CA"));
});

void test("ticker headers date their move, preserve fractional shares and leave confidence in the conclusion", async () => {
  await resetTicker();
  let html = await renderTicker();
  assert.match(html, /\+10\.00%<\/span> on Nov 4/);
  assert.match(html, />2\.0769<\/dd>/);
  assert.equal((html.match(/Analyst confidence/g) ?? []).length, 1);
  assert.match(html, /Research status/);
  tickerFixture.facts!.positions[0]!.day_change_pct = null;
  html = await renderTicker();
  assert.doesNotMatch(html, /<\/span> on Nov 4/);
  tickerFixture.facts!.positions[0]!.price = null;
  assert.match(await renderTicker(), /No price yet/);
});

void test("ticker numbers show research dates and plain filing changes with honest list limits", async () => {
  await resetTicker();
  tickerFixture.pack = {
    generated_on: "2026-11-05",
    quote: { price: 173.19, as_of_et: "Nov 4, 2026, 4:00 PM ET" },
    income_statement_quarterly: [
      { period: "Q4", fiscalYear: 2026, date: "2026-09-27", revenue: 10 },
    ],
    valuation_and_growth: {
      growth: { revenue_basis: "reported" },
      valuation: { forward_pe: 12 },
    },
    data_notes: ["valuation_and_growth uses freeCashFlowYieldTTM."],
  };
  tickerFixture.filings = [
    {
      accessionNo: "report",
      form: "10-Q",
      filedAt: "2025-10-31",
      primaryDocUrl: "https://www.sec.gov/report",
      items: null,
      sectionsJson: JSON.stringify({
        diff: "## Risk factors\n### Added\n+ We may *not* comply_with 1. rules.\n[3 less important changes are left out here; see filing_changes_10-Q.txt]",
      }),
    },
    ...Array.from({ length: 25 }, (_, i) => ({
      accessionNo: `form4-${i}`,
      form: "4",
      filedAt: "2026-11-04",
      primaryDocUrl: "https://www.sec.gov/form4",
      items: null,
      sectionsJson: null,
    })),
  ];
  const html = await renderTicker("data");
  assert.match(
    html,
    /Prices as of Nov 4, 2026, 4:00 PM ET\. Research file from Nov 5, 2026\./,
  );
  assert.match(html, /Latest quarter, Q4 2026, ended Sep 27, 2026/);
  assert.match(html, /Forward P\/E uses analyst estimates/);
  assert.match(html, /valuation and growth uses free cash flow yield/);
  assert.match(html, /Oct 31, 2025/);
  assert.match(html, /<h4[^>]*>Risk factors<\/h4>/);
  assert.match(html, /\+ We may \*not\* comply_with 1\. rules\./);
  assert.doesNotMatch(html, /filing_changes|<pre/);
  assert.match(html, /3 less important changes are not shown/);
  assert.match(html, /Insider filings, Form 4 \(latest 20\)/);
  assert.equal((html.match(/Open on EDGAR/g) ?? []).length, 20);
  tickerFixture.filings = [];
  assert.match(
    await renderTicker("data"),
    /Most funds are not in the SEC company list this app uses/,
  );
});

void test("ticker history labels its review limit and gives old decisions a year", async () => {
  await resetTicker();
  tickerFixture.history = Array.from({ length: 30 }, (_, i) => ({
    ...review(),
    id: i,
    createdAt: new Date(2025, 9, 31, 12).toISOString(),
  }));
  tickerFixture.decisions = [
    { id: 1, date: "2024-12-05", actionTaken: "Held", note: "Long-term view" },
  ];
  const html = await renderTicker("history");
  assert.match(html, /Reviews: latest 30/);
  assert.match(html, /Oct 31, 2025/);
  assert.match(html, /Dec 5, 2024/);
});

void test("ticker notes keep owner links, remove model links and never load images", async () => {
  await resetTicker();
  tickerFixture.dossier =
    "# AAA\n\n## Thesis\n\n[Owner link](https://example.com/owner) ![owner](https://example.com/owner.png)\n\n## Current view\n\n[Model link](https://example.com/model) ![model](https://example.com/model.png)";
  const html = await renderTicker("notes");
  assert.match(html, /href="https:\/\/example.com\/owner"/);
  assert.doesNotMatch(html, /href="https:\/\/example.com\/model"|<img|preload/);
  assert.match(html, /Model link/);
});

void test("ticker browser titles identify the normalized holding without data reads", async () => {
  assert.deepEqual(
    await tickerPage.generateMetadata({
      params: Promise.resolve({ ticker: "qcom" }),
    }),
    { title: "QCOM" },
  );
});

const queueItem = (ticker = "AAA") => ({
  ticker,
  action: null,
  urgency: null,
  sizeHint: null,
  why: "Look again",
  reasoning: null,
  decision: null,
});
function resetPageFixture() {
  Object.assign(pageFixture, {
    facts: portfolioRules.computePortfolioFacts(
      [{ ticker: "AAA", name: "Example", quantity: 2, costBasis: null }],
      new Map([
        [
          "AAA",
          {
            price: 10,
            change: 1,
            changePercentage: 10,
            quote_date: "2026-11-05",
          },
        ],
      ]),
      new Map(),
      "2026-11-05",
    ),
    updates: new Map(),
    queue: [],
    openCount: 0,
    runId: 1,
    briefReadyAt: "2026-11-05T15:00:00Z",
    decisions: [],
    brief: {
      date: "2026-11-05",
      summary: "Steady portfolio.",
      portfolio_observations: [],
      needs_attention: [],
      suggested_actions: [],
      nothing_to_do: true,
    },
  });
}
const renderToday = async () => renderToStaticMarkup(await todayPage.default());
const renderHoldings = async () =>
  renderToStaticMarkup(await holdingsPage.default());

void test("Holdings sorting uses the displayed proof score while historical scores stay intact", async () => {
  resetPageFixture();
  const update = review();
  update.result.evidence = [
    {
      claim: "The acquisition received final regulatory approval in Q3",
      source: "file:report",
      date: "2026-11-05",
    },
  ];
  update.verification!.checks = [
    {
      claim: "The acquisition received conditional regulatory approval in Q3",
      verdict: "verified",
      source: "file:report",
      note: "Conditions remain.",
    },
  ];
  update.verifiedScore = 1;
  pageFixture.updates.set("AAA", update);
  const table = elements(await holdingsPage.default()).find((element) =>
    Array.isArray(element.props.rows),
  );
  const rows = table?.props.rows as { verifiedScore: number | null }[];
  assert.equal(rows[0]?.verifiedScore, 0.5);
  assert.match(await renderHoldings(), /1 of 2 claims verified/);
  assert.match(renderReview(update), /Verified score: 50%/);
  assert.equal(update.verifiedScore, 1);
});

void test("removed holdings leave the active queue and its undecided count", () => {
  const decided = {
    ...queueItem("EXPE"),
    decision: {
      ticker: "EXPE",
      date: "2026-11-05",
      actionTaken: "hold",
      note: "",
    },
  };
  const result = updateRules.heldQueue?.(
    [queueItem("NVO"), queueItem("QCOM"), decided],
    new Set(["QCOM", "EXPE"]),
  );
  assert.deepEqual(
    result?.queue.map((item) => item.ticker),
    ["QCOM", "EXPE"],
  );
  assert.equal(result?.openCount, 1);
});

void test("a brief action wins and an attention-only call never borrows a newer action", () => {
  assert.equal(
    queueRules.queueAction?.(
      { action: "trim" },
      { result: { action: "add" } },
      true,
    ),
    "trim",
  );
  assert.equal(
    queueRules.queueAction?.(
      { action: null },
      { result: { action: "add" } },
      false,
    ),
    "add",
  );
  assert.equal(
    queueRules.queueAction?.(
      { action: null },
      { result: { action: "add" } },
      true,
    ),
    null,
  );
  assert.equal(
    queueRules.queueAction?.({ action: null }, undefined, false),
    null,
  );
});

void test("a successful review or quiet recheck clears an earlier failed-review notice", () => {
  const later = { ...review(), createdAt: "2026-11-05T16:00:00Z" };
  const older = { ...review(), createdAt: "2026-11-05T14:00:00Z" };
  const failures = ["LATER", "OLDER", "MISSING", "RECHECK"].map((ticker) => ({
    ticker,
    reason: "Unavailable",
  }));
  const updates = new Map([
    ["LATER", later],
    ["OLDER", older],
    ["RECHECK", { ...older, recheckedAt: "2026-11-05T16:00:00Z" }],
  ]);
  assert.deepEqual(
    queueRules
      .stillFailed?.(failures, updates, "2026-11-05T15:00:00Z")
      ?.map((item) => item.ticker),
    ["OLDER", "MISSING"],
  );
  assert.deepEqual(queueRules.stillFailed?.(failures, updates, null), failures);
});

void test("day columns stay short while the portfolio summary keeps its session date", () => {
  const dates = { newest: "2026-11-04", oldest: "2026-11-04", stale: [] };
  assert.equal(format.dayColumnLabel?.(dates, "2026-11-05"), "Nov 4");
  assert.equal(format.dayColumnLabel?.(dates, "2026-11-04"), "Today");
  assert.equal(format.dayColumnLabel?.(undefined, "2026-11-04"), "Today");
  assert.equal(
    format.dayColumnLabel?.({ ...dates, newest: null }, "2026-11-05"),
    "Last session",
  );
  assert.equal(
    format.dayMoveLabel(dates, "2026-11-05"),
    "Last session (Nov 4)",
  );
});

void test("Today hides removed calls and labels the attention-only action", async () => {
  resetPageFixture();
  pageFixture.queue = [queueItem("REMOVED"), queueItem()];
  pageFixture.openCount = 2;
  pageFixture.updates.set("AAA", {
    ...review(),
    result: { ...review().result, action: "add" },
  });
  const html = await renderToday();
  assert.doesNotMatch(html, /REMOVED/);
  assert.match(html, /1 to look at/);
  assert.match(html, />Add<\/span>/);
});

void test("decided Today rows keep full-strength text and their logged decision", async () => {
  resetPageFixture();
  pageFixture.queue = [
    {
      ...queueItem(),
      decision: {
        ticker: "AAA",
        date: "2026-11-05",
        actionTaken: "hold",
        note: "",
      },
    },
  ];
  const html = await renderToday();
  assert.match(html, /<summary class="[^"]*bg-paper/);
  assert.doesNotMatch(html, /<summary class="[^"]*opacity/);
  assert.match(html, /You logged: hold/);
  assert.match(html, /1 of 1 decided/);
});

void test("Today explains untraceable figures only when any were saved", async () => {
  resetPageFixture();
  const clean = await renderToday();
  pageFixture.brief!.untraced_figures = ["27.3%"];
  const warned = await renderToday();
  assert.match(warned, /could not be traced/i);
  assert.doesNotMatch(clean, /could not be traced/i);
  assert.doesNotMatch(warned, /untraced_figures/);
});

void test("saved brief status words read plainly and position sizes come from code", async () => {
  resetPageFixture();
  pageFixture.brief!.summary = "No thesis_weakened or thesis_broken flags.";
  pageFixture.queue = [
    { ...queueItem(), action: "add", sizeHint: "Wait for the next report." },
  ];
  const html = await renderToday();
  assert.doesNotMatch(html, /thesis_weakened|thesis_broken/);
  assert.match(html, /Now 100\.00% \(\$20\.00\)/);
  assert.match(html, /1% of the portfolio is \$0\.20/);
  assert.match(html, /Wait for the next report/);
});

void test("Today translates queue reasons, size hints, observations and saved headlines", async () => {
  resetPageFixture();
  pageFixture.brief!.portfolio_observations = [
    "my_position in pack.json has 10 shares.",
  ];
  pageFixture.queue = [
    {
      ...queueItem(),
      why: "revenue_yoy_pct in pack.json is 30.99.",
      reasoning: "income_statement_quarterly is steady.",
      sizeHint: "key_metrics_ttm in pack.json is available.",
    },
  ];
  let html = await renderToday();
  assert.doesNotMatch(
    html,
    /my_position|pack\.json|revenue_yoy_pct|income_statement_quarterly|key_metrics_ttm/,
  );
  assert.match(html, /30\.99/);
  const update = review();
  update.result.headline = "my_position in pack.json has 10 shares.";
  update.result.action = "add";
  pageFixture.updates.set("AAA", update);
  pageFixture.queue = [];
  html = await renderToday();
  assert.doesNotMatch(html, /my_position|pack\.json/);
});

void test("ticker headlines and model notes translate internal prose while owner notes remain literal", async () => {
  const update = review();
  update.result.headline = "my_position in pack.json has 10 shares.";
  tickerFixture.facts = portfolioRules.computePortfolioFacts(
    [{ ticker: "AAA", name: "Example", quantity: 10, costBasis: null }],
    new Map(),
    new Map(),
  );
  tickerFixture.history = [update];
  tickerFixture.dossier =
    "# AAA\n\n## Thesis\n\nmy_position in pack.json is my note.\n\n## Current view\n\nrevenue_yoy_pct in pack.json is 30.99.";
  try {
    const html = renderToStaticMarkup(
      await tickerPage.default({
        params: Promise.resolve({ ticker: "AAA" }),
        searchParams: Promise.resolve({ tab: "notes" }),
      }),
    );
    assert.match(html, /my position in research data has 10 shares/);
    assert.match(html, /revenue yoy pct in research data is 30\.99/);
    assert.match(html, /my_position in pack\.json is my note/);
  } finally {
    tickerFixture.history = [];
    tickerFixture.dossier = "# AAA\n\n## Thesis\n\nMy thesis";
  }
});

void test("Today rejection and proof counts agree on queue, open calls and the no-brief list", async () => {
  resetPageFixture();
  const rejected = review();
  rejected.result.evidence = [
    { claim: "Revenue rose", source: "fmp:income", date: "2026-11-05" },
    { claim: "Costs fell", source: "fmp:income", date: "2026-11-05" },
  ];
  rejected.verification!.checks = [
    {
      claim: "Revenue rose",
      source: "fmp:income",
      note: "Found",
      verdict: "verified",
    },
  ];
  rejected.verification!.conclusion_supported = false;
  rejected.result.action = "add";
  rejected.verification!.independent_action = "trim";
  pageFixture.updates.set("AAA", rejected);
  pageFixture.queue = [queueItem()];
  let html = await renderToday();
  assert.match(html, /Final check rejected/);
  assert.match(html, /1 of 2 claims verified/);
  assert.match(html, /Second check:.*Trim/);
  pageFixture.queue = [];
  html = await renderToday();
  assert.match(html, /Final check rejected/);
  assert.match(html, /1 of 2 claims verified/);
  pageFixture.brief = null;
  html = await renderToday();
  assert.match(html, /Final check rejected/);
  assert.match(html, /1 of 2 claims verified/);
});

void test("Holdings dates the shown review, flags rejected or unchecked claims and identifies old day moves", async () => {
  resetPageFixture();
  const shown = {
    ...review(),
    createdAt: "2026-11-05T02:00:00Z",
    recheckedAt: "2026-11-05T18:00:00Z",
  };
  shown.result.evidence = [
    { claim: "Unmatched claim", source: "fmp:quote", date: "2026-11-04" },
  ];
  shown.verification!.conclusion_supported = false;
  shown.verification!.independent_action = "trim";
  pageFixture.updates.set("AAA", shown);
  pageFixture.facts.positions[0]!.quote_date = "2026-11-04";
  const html = await renderHoldings();
  const local = format.shortDate(
    new Date(shown.createdAt).toLocaleDateString("en-CA"),
  );
  assert.match(
    html,
    new RegExp(`text-muted block text-xs md:hidden">${local}</span>`),
  );
  assert.match(html, new RegExp(`lg:table-cell">[\\s\\S]*${local}</span>`));
  assert.match(html, /Final check rejected/);
  assert.match(html, /Second check:.*Trim/);
  assert.match(html, /0 of 1 claims verified/);
  assert.match(html, /Claims to check/);
  assert.match(html, />Nov 4<\/span>/);
});

void test("a rejected conclusion belongs in the claims filter even when every fact was verified", () => {
  assert.equal(
    queueRules.holdingHasFlags?.({
      rejected: true,
      checks: [{ verdict: "verified" }],
    }),
    true,
  );
  assert.equal(
    queueRules.holdingHasFlags?.({
      rejected: false,
      checks: [{ verdict: "not_checked" }],
    }),
    true,
  );
  assert.equal(
    queueRules.holdingHasFlags?.({
      rejected: false,
      checks: [{ verdict: "verified" }],
    }),
    false,
  );
});

void test("Holdings names each fund whose sector breakdown is missing", async () => {
  resetPageFixture();
  pageFixture.facts.funds_no_breakdown = [
    { ticker: "BOND", weight_pct: 6.72 },
    { ticker: "ALTF", weight_pct: 2.31 },
  ];
  pageFixture.facts.sector_weights = [
    { sector: "Funds, no breakdown", weight_pct: 9.04 },
  ];
  const html = await renderHoldings();
  assert.match(html, /Sector weights/);
  assert.match(html, /BOND 6\.72%/);
  assert.match(html, /ALTF 2\.31%/);
  assert.match(html, /9\.0%/);
});

void test("server pages identify Today and Holdings in browser titles", () => {
  assert.deepEqual(todayPage.metadata?.title, {
    absolute: "Today · Portchecker",
  });
  assert.equal(holdingsPage.metadata?.title, "Holdings");
});

const preparePortfolioDb = async () =>
  client.executeMultiple(`
  CREATE TABLE IF NOT EXISTS holdings (ticker TEXT,name TEXT,quantity REAL,cost_basis REAL,account_label TEXT,updated_at TEXT,PRIMARY KEY(ticker,account_label));
  CREATE TABLE IF NOT EXISTS tickers (ticker TEXT PRIMARY KEY,cik TEXT,sector TEXT,industry TEXT,fmp_profile_json TEXT,last_full_review_at TEXT);
  CREATE TABLE IF NOT EXISTS fmp_cache (ticker TEXT,endpoint TEXT,fetched_on TEXT,payload_json TEXT,PRIMARY KEY(ticker,endpoint,fetched_on));
  DELETE FROM holdings; DELETE FROM tickers; DELETE FROM fmp_cache;
`);

void test("holdings age uses the oldest saved row and is absent for an empty portfolio", async () => {
  await preparePortfolioDb();
  const oldest = new Date(2026, 8, 1, 12).toISOString();
  await client.execute({
    sql: "INSERT INTO holdings VALUES ('AAA','Old',2,NULL,'',?),('CASH','Cash',5,NULL,'',?);",
    args: [oldest, new Date(2026, 10, 5, 12).toISOString()],
  });
  const facts = await portfolioRules.loadPortfolioFacts();
  assert.equal(facts.holdings_updated_at, oldest);
  resetPageFixture();
  Object.assign(pageFixture.facts, {
    holdings_updated_at: facts.holdings_updated_at,
  });
  const html = await renderToday();
  assert.match(html, /text-warn[^>]*>.*Holdings updated Sep 1/);
  await client.execute("DELETE FROM holdings");
  assert.equal(
    (await portfolioRules.loadPortfolioFacts()).holdings_updated_at,
    null,
  );
});

void test("portfolio facts retain the oldest holdings date and expose the newest change", async () => {
  await preparePortfolioDb();
  const oldest = new Date(2026, 8, 1, 12).toISOString();
  const newest = new Date(2026, 10, 5, 12).toISOString();
  await client.execute({
    sql: "INSERT INTO holdings VALUES ('AAA','Old',2,NULL,'',?),('CASH','Cash',5,NULL,'',?);",
    args: [oldest, newest],
  });
  const facts = await portfolioRules.loadPortfolioFacts();
  assert.equal(facts.holdings_updated_at, oldest);
  assert.equal(facts.holdings_latest_updated_at, newest);
  resetPageFixture();
  Object.assign(pageFixture.facts, facts);
  const html = await renderToday();
  // Historical dates include the year when this fixture is viewed in a later year.
  const year = new Date().getFullYear() === 2026 ? "" : ", 2026";
  assert.match(
    html,
    new RegExp(
      `text-warn[^>]*>.*Holdings updated Sep 1${year} to Nov 5${year}`,
    ),
  );
  await client.execute("DELETE FROM holdings");
  assert.equal(
    (await portfolioRules.loadPortfolioFacts()).holdings_latest_updated_at,
    null,
  );
});

void test("Today warns about changed holdings using the brief run time with a date-only fallback", async () => {
  resetPageFixture();
  Object.assign(pageFixture.facts, {
    holdings_updated_at: new Date(2026, 10, 4, 12).toISOString(),
    holdings_latest_updated_at: new Date(2026, 10, 5, 12).toISOString(),
  });
  pageFixture.briefReadyAt = new Date(2026, 10, 5, 11).toISOString();
  const notice =
    /Written before your holdings changed on .+, so position sizes and cash in this brief are from then\./;
  assert.match(await renderToday(), notice);
  pageFixture.briefReadyAt = new Date(2026, 10, 5, 13).toISOString();
  assert.doesNotMatch(await renderToday(), notice);
  pageFixture.briefReadyAt = null;
  assert.doesNotMatch(await renderToday(), notice);
  pageFixture.facts.holdings_latest_updated_at = new Date(
    2026,
    10,
    6,
    12,
  ).toISOString();
  assert.match(await renderToday(), notice);
  pageFixture.briefReadyAt = "2026-11-05T15:00:00Z";
});

void test("ticker reviews warn about later portfolio changes even when a different holding changed", async () => {
  await resetTicker();
  const saved = review();
  saved.createdAt = "2026-11-05T15:00:00Z";
  tickerFixture.history = [saved];
  Object.assign(tickerFixture.facts!, {
    holdings_latest_updated_at: "2026-11-05T18:00:00Z",
  });
  const notice =
    /Written before your holdings changed on .+, so position sizes and cash in this review are from then\./;
  assert.match(await renderTicker(), notice);
  Object.assign(tickerFixture.facts!, {
    holdings_latest_updated_at: "2026-11-05T14:00:00Z",
  });
  assert.doesNotMatch(await renderTicker(), notice);
});

void test("ticker history warns only on reviews saved before the holdings change", async () => {
  await resetTicker();
  tickerFixture.history = [
    { ...review(), id: 2, createdAt: "2026-11-05T19:00:00Z" },
    { ...review(), id: 1, createdAt: "2026-11-05T15:00:00Z" },
  ];
  Object.assign(tickerFixture.facts!, {
    holdings_latest_updated_at: "2026-11-05T18:00:00Z",
  });
  assert.doesNotMatch(
    await renderTicker(),
    /Written before your holdings changed/,
  );
  const html = await renderTicker("history");
  assert.equal(
    (html.match(/Written before your holdings changed/g) ?? []).length,
    1,
  );
});

void test("adding a holding prices it once and vendor failures never undo the save", async () => {
  await preparePortfolioDb();
  const { holdingsRouter } =
    await import("../../server/api/routers/holdings.ts");
  const { db } = await import("../../server/db/index.ts");
  const { env } = await import("../../env.js");
  const runtimeEnv = env as unknown as Record<string, unknown>;
  const previousKey = runtimeEnv.FMP_API_KEY;
  const previousFetch = globalThis.fetch;
  let mode = "quote";
  const requested: string[] = [];
  runtimeEnv.FMP_API_KEY = "offline-test-key";
  globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    assert.equal(url.pathname, "/stable/quote");
    requested.push(url.searchParams.get("symbol")!);
    return new Response(
      JSON.stringify(
        mode === "quote"
          ? [
              {
                symbol: "NEW",
                price: 25,
                change: 1,
                changePercentage: 4,
                timestamp: 1793890800,
              },
            ]
          : null,
      ),
      { status: mode === "quote" ? 200 : 403 },
    );
  };
  const caller = holdingsRouter.createCaller({ db });
  try {
    await caller.upsert({
      ticker: "NEW",
      name: "New",
      quantity: 2,
      costBasis: null,
      adding: true,
    });
    assert.equal((await portfolioRules.loadPortfolioFacts()).total_value, 50);
    assert.deepEqual(requested, ["NEW"]);
    await caller.upsert({
      ticker: "NEW",
      name: "New",
      quantity: 3,
      costBasis: null,
    });
    await caller.upsert({
      ticker: "CASH",
      name: "Cash",
      quantity: 5,
      costBasis: null,
      adding: true,
    });
    assert.deepEqual(requested, ["NEW"]);
    assert.equal((await portfolioRules.loadPortfolioFacts()).total_value, 80);
    mode = "failure";
    await caller.upsert({
      ticker: "FAIL",
      name: "Unavailable",
      quantity: 1,
      costBasis: null,
      adding: true,
    });
    assert.equal(
      (await caller.list()).some((row) => row.ticker === "FAIL"),
      true,
    );
    assert.ok(
      (await portfolioRules.loadPortfolioFacts()).missing_prices.includes(
        "FAIL",
      ),
    );
    runtimeEnv.FMP_API_KEY = undefined;
    const count = requested.length;
    await caller.upsert({
      ticker: "NOKEY",
      name: "Offline",
      quantity: 1,
      costBasis: null,
      adding: true,
    });
    assert.equal(requested.length, count);
    assert.equal(
      (await caller.list()).some((row) => row.ticker === "NOKEY"),
      true,
    );
  } finally {
    globalThis.fetch = previousFetch;
    runtimeEnv.FMP_API_KEY = previousKey;
  }
});

void test("import confirmation focuses Keep and names each row action by holding", async () => {
  const state = { values: [] as unknown[], cursor: 0 };
  Object.assign(globalThis, { portcheckerImportState: state });
  const formHooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL?.endsWith("/src/app/import/page.tsx")) {
        if (specifier === "react")
          return { url: "ui-import:state", shortCircuit: true };
        if (specifier === "~/trpc/react")
          return { url: "ui-import:api", shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url === "ui-import:state")
        return {
          format: "module",
          shortCircuit: true,
          source:
            "export const useMemo = f=>f(); export function useState(initial){ const s=globalThis.portcheckerImportState; const i=s.cursor++; if(!(i in s.values))s.values[i]=typeof initial==='function'?initial():initial; return [s.values[i],value=>{s.values[i]=typeof value==='function'?value(s.values[i]):value}];}",
        };
      if (url === "ui-import:api")
        return {
          format: "module",
          shortCircuit: true,
          source:
            "const mutation={isPending:false,error:null,reset(){}}; export const api={useUtils:()=>({}),holdings:{upsert:{useMutation:()=>mutation},delete:{useMutation:()=>mutation}}};",
        };
      if (url.endsWith("/src/app/import/page.tsx"))
        return {
          format: "module",
          shortCircuit: true,
          source: ts.transpileModule(
            readFileSync(fileURLToPath(url), "utf8") +
              "\nexport {HoldingForm};",
            {
              compilerOptions: {
                jsx: ts.JsxEmit.ReactJSX,
                module: ts.ModuleKind.ESNext,
              },
            },
          ).outputText,
        };
      return next(url, context);
    },
  });
  type Element = {
    type: unknown;
    props: {
      children?: unknown;
      "aria-label"?: string;
      autoFocus?: boolean;
      onClick?: () => void;
    };
  };
  const buttons = (node: unknown): Element[] => {
    if (Array.isArray(node)) return node.flatMap(buttons);
    if (!node || typeof node !== "object" || !("props" in node)) return [];
    const element = node as Element;
    return [
      ...(element.type === "button" ? [element] : []),
      ...buttons(element.props.children),
    ];
  };
  try {
    const importForms = (await import("../import/page.tsx")) as unknown as {
      HoldingForm: (props: {
        holding: {
          ticker: string;
          name: string;
          quantity: number;
          costBasis: null;
          accountLabel: string;
          updatedAt: string;
        };
      }) => Element;
    };
    const props = {
      holding: {
        ticker: "AAA",
        name: "Example",
        quantity: 2,
        costBasis: null,
        accountLabel: "Brokerage",
        updatedAt: "2026-11-05",
      },
    };
    const render = () => {
      state.cursor = 0;
      return buttons(importForms.HoldingForm(props));
    };
    let row = render();
    const remove = row.find((button) => button.props.children === "Delete")!;
    assert.match(remove.props["aria-label"] ?? "", /Delete AAA.*Brokerage/);
    remove.props.onClick!();
    row = render();
    const keep = row.find((button) => button.props.children === "Keep")!;
    assert.equal(keep.props.autoFocus, true);
    assert.match(keep.props["aria-label"] ?? "", /Keep AAA.*Brokerage/);
    keep.props.onClick!();
    state.values[1] = "Edited name";
    row = render();
    assert.match(
      row.find((button) => button.props.children === "Save")?.props[
        "aria-label"
      ] ?? "",
      /Save AAA.*Brokerage/,
    );
  } finally {
    formHooks.deregister();
  }
});

void test("replacing holdings prices only missing tickers and archives in isolated storage", async () => {
  await preparePortfolioDb();
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const scratch = mkdtempSync(
    path.join(tmpdir(), "portchecker-import-quotes-"),
  );
  const previousCwd = process.cwd();
  const previousFetch = globalThis.fetch;
  const { env } = await import("../../env.js");
  const runtimeEnv = env as unknown as Record<string, unknown>;
  const previousKey = runtimeEnv.FMP_API_KEY;
  const requested: string[] = [];
  try {
    process.chdir(scratch);
    runtimeEnv.FMP_API_KEY = "offline-test-key";
    globalThis.fetch = async (input) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      assert.equal(url.pathname, "/stable/quote");
      const ticker = url.searchParams.get("symbol")!;
      requested.push(ticker);
      return new Response(JSON.stringify([{ symbol: ticker, price: 20 }]));
    };
    await client.execute({
      sql: "INSERT INTO fmp_cache VALUES ('OLD','quote','2026-11-04',?)",
      args: [JSON.stringify([{ price: 10 }])],
    });
    const { holdingsRouter } =
      await import("../../server/api/routers/holdings.ts");
    const { db } = await import("../../server/db/index.ts");
    const caller = holdingsRouter.createCaller({ db });
    const csv =
      "Symbol,Description,Quantity,Cost Basis\nOLD,Old,2,\nNEW,New,3,\nCASH,Cash,5,";
    assert.equal(
      (await caller.import({ csv, fileName: "positions.csv" })).imported,
      3,
    );
    assert.deepEqual(requested, ["NEW"]);
    assert.equal((await portfolioRules.loadPortfolioFacts()).total_value, 85);
    assert.equal(
      readFileSync(path.join(scratch, "data/imports/positions.csv"), "utf8"),
      csv,
    );
    await caller.import({ csv, fileName: "positions.csv" });
    assert.deepEqual(requested, ["NEW"]);
  } finally {
    process.chdir(previousCwd);
    globalThis.fetch = previousFetch;
    runtimeEnv.FMP_API_KEY = previousKey;
    rmSync(scratch, { recursive: true, force: true });
  }
});

void test("a later successful review removes only its own failed-review message", async () => {
  resetPageFixture();
  pageFixture.brief!.failed = [
    { ticker: "AAA", reason: "Earlier failure" },
    { ticker: "MISSING", reason: "Still unavailable" },
  ];
  pageFixture.updates.set("AAA", {
    ...review(),
    createdAt: "2026-11-05T16:00:00Z",
  });
  const html = await renderToday();
  assert.match(html, /Could not review 1 holding/);
  assert.match(html, /Still unavailable/);
  assert.doesNotMatch(html, /Earlier failure/);
});

void test("first-run instructions distinguish a manual run from daily scheduling", async () => {
  resetPageFixture();
  pageFixture.brief = null;
  const html = await renderToday();
  assert.match(html, /Three steps to your first brief/);
  assert.match(html, /schedule.*pnpm research/);
  assert.match(html, /Press Run research/);
});

void test("undated row moves cannot inherit a Today date and cash has no review date", async () => {
  resetPageFixture();
  pageFixture.facts.positions[0]!.quote_date = null;
  let html = await renderHoldings();
  assert.match(html, />Undated<\/span>/);
  pageFixture.facts = portfolioRules.computePortfolioFacts(
    [{ ticker: "CASH", name: "Cash", quantity: 10, costBasis: null }],
    new Map(),
    new Map(),
  );
  html = await renderHoldings();
  assert.doesNotMatch(html, /Undated|Invalid Date/);
});

void test("local amendments disclose that the original model checks were retained", async () => {
  const updated = review();
  updated.result.local_correction = {
    at: "2026-11-06T04:00:00Z",
    notes: ["Cash-flow definitions were qualified against the filing."],
  };
  updated.result.condition_warnings = [
    "The proposed allocation condition is already met.",
  ];
  const html = renderToStaticMarkup(
    createElement(ReasoningChain, { update: updated, links: {} }),
  );
  assert.match(html, /Local correction/);
  assert.match(html, /original model checks/i);
  assert.match(html, /Cash-flow definitions were qualified/);
  assert.match(html, /proposed allocation condition is already met/);
  resetPageFixture();
  Object.assign(pageFixture.brief!, {
    local_correction: {
      at: "2026-11-06T04:00:00Z",
      notes: ["The disagreement explanation was corrected locally."],
    },
  });
  const page = await renderToday();
  assert.match(page, /corrected locally/);
});
