import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// Only the vendors and model are replaced. Every scenario imports the real job,
// routers and storage code in a fresh process whose cwd and database are temporary.
const harness = String.raw`
import assert from 'node:assert/strict';
import { mock } from 'node:test';
mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 9, 18).getTime() });
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const calls = [],
  scripts = [],
  unexpected = [],
  requests = [];
const notices = [];
globalThis.setupIssues = [];
globalThis.noticeSpawn = (_command, _args, opts) => {
  notices.push(opts.env.PORTCHECKER_NOTICE);
  return { on() {}, unref() {} };
};
globalThis.modelStub = async (opts) => {
  const files = Object.fromEntries(
    readdirSync(opts.workingDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const name = entry.name;
        return [name, readFileSync(path.join(opts.workingDirectory, name), 'utf8')];
      }),
  );
  calls.push({
    role: opts.role,
    workingDirectory: opts.workingDirectory,
    prompt: opts.prompt,
    avoidProvider: opts.avoidProvider,
    files,
  });
  const ticker = files['pack.json'] ? JSON.parse(files['pack.json']).ticker : null;
  const index = scripts.findIndex(
    (s) => s.role === opts.role && (!s.ticker || s.ticker === ticker),
  );
  let data;
  if (index >= 0) data = scripts.splice(index, 1)[0].data;
  else if (opts.role === 'research') data = { findings: [] };
  else if (opts.role === 'analyst')
    data = analysis(ticker, opts.prompt.includes('Review depth: LIGHT'));
  else if (opts.role === 'verifier') data = verification(ticker);
  else if (opts.role === 'brief') data = brief();
  else {
    unexpected.push('Unscripted model role: ' + opts.role);
    throw new Error(unexpected.at(-1));
  }
  return {
    data: opts.schema.parse(data),
    provider: 'chatgpt',
    model: 'stub-model',
    usedFallback: false,
  };
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'node:child_process' && context.parentURL?.endsWith('/research/run.ts'))
      return { url: 'portchecker:notifications', shortCircuit: true };
    if (specifier.startsWith('~/')) {
      const base = path.join(root, 'src', specifier.slice(2));
      const file = [base + '.ts', base + '.js', path.join(base, 'index.ts')].find(
        existsSync,
      );
      return next(pathToFileURL(file).href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'portchecker:notifications')
      return { format: 'module', shortCircuit: true, source: 'export const spawn = (...args) => globalThis.noticeSpawn(...args);' };
    if (url === pathToFileURL(path.join(root, 'src/server/model.ts')).href)
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export { addUsage } from ' + JSON.stringify(pathToFileURL(path.join(root, 'src/server/model.ts')).href + '?usage-only') + '; export const runModel = opts => globalThis.modelStub(opts); export const setupProblems = async () => [...globalThis.setupIssues]; export const claudeCodeStatus = async () => ({installed:true,signedIn:true,detail:"Signed in",advice:""}); export const errorMessage = e => e instanceof Error ? e.message : String(e);',
      };
    return next(url, context);
  },
});
// Vendor requests are stubbed; request spacing has no bearing on these scenarios.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, _ms, ...args) => realSetTimeout(fn, 0, ...args);
const load = (name) => import(pathToFileURL(path.join(root, 'src/server', name)).href);
const { db, client } = await load('db/index.ts');
await client.executeMultiple(
  'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
    'CREATE TABLE holdings (ticker TEXT, name TEXT, quantity REAL, cost_basis REAL, account_label TEXT, updated_at TEXT, PRIMARY KEY(ticker,account_label));' +
    'CREATE TABLE tickers (ticker TEXT PRIMARY KEY, cik TEXT, sector TEXT, industry TEXT, fmp_profile_json TEXT, last_full_review_at TEXT);' +
    'CREATE TABLE filings (accession_no TEXT, ticker TEXT, form TEXT, filed_at TEXT, primary_doc_url TEXT, items TEXT, sections_json TEXT, processed_at TEXT, PRIMARY KEY(accession_no,ticker));' +
    'CREATE TABLE fmp_cache (ticker TEXT, endpoint TEXT, fetched_on TEXT, payload_json TEXT, PRIMARY KEY(ticker,endpoint,fetched_on));' +
    'CREATE TABLE research_runs (id INTEGER PRIMARY KEY, started_at TEXT, heartbeat_at TEXT, finished_at TEXT, status TEXT, provider_mode TEXT, usage_json TEXT, log_text TEXT DEFAULT ' +
    "''" +
    ', brief_id INTEGER);' +
    'CREATE TABLE ticker_updates (id INTEGER PRIMARY KEY, run_id INTEGER, ticker TEXT, review_depth TEXT, result_json TEXT, verification_json TEXT, verified_score REAL, analyst_provider TEXT, analyst_model TEXT, verifier_provider TEXT, verifier_model TEXT, used_fallback INTEGER DEFAULT 0, revised_after_review INTEGER DEFAULT 0, created_at TEXT);' +
    'CREATE TABLE briefs (id INTEGER PRIMARY KEY, run_id INTEGER, date TEXT, provider TEXT, model TEXT, result_json TEXT, markdown TEXT);' +
    'CREATE TABLE decisions (id INTEGER PRIMARY KEY, ticker TEXT, date TEXT, action_taken TEXT, note TEXT, created_at TEXT);',
);
const { today } = await load('fmp.ts');
const date = today();
const ago = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toLocaleDateString('en-CA');
};
const futureYear = new Date().getFullYear() + 1;
const { runResearch: researchJob } = await load('research/run.ts');
const runResearch = (...args) => {
  mock.timers.tick(1000);
  return researchJob(...args);
};
const { latestUpdates, openCalls, loadBrief } = await load('updates.ts');
const { readDossier, saveDossier, dossierSection, replaceSection } =
  await load('dossier.ts');
let filingPresent = true,
  unreadable = false;
const noQuote = new Set(), funds = new Set(), earningsRows = new Map();
let spyLagDays = 0;
const endpoints = new Set([
  'profile',
  'quote',
  'dividends',
  'earnings',
  'analyst-estimates',
  'price-target-consensus',
  'price-target-summary',
  'price-target-news',
  'grades-consensus',
  'grades',
  'ratings-snapshot',
  'financial-scores',
  'insider-trading/search',
  'income-statement',
  'balance-sheet-statement',
  'cash-flow-statement',
  'key-metrics',
  'key-metrics-ttm',
  'ratios',
  'ratios-ttm',
  'historical-price-eod/light',
  'news/stock',
  'economic-calendar',
  'etf/sector-weightings',
  'etf/info',
  'etf/country-weightings',
  'etf/asset-exposure',
]);
const accession = '0000000001-26-000001';
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  requests.push(url.href);
  const json = (value) =>
    new Response(JSON.stringify(value), {
      headers: { 'content-type': 'application/json' },
    });
  if (
    url.origin === 'https://financialmodelingprep.com' &&
    url.pathname.startsWith('/stable/')
  ) {
    const endpoint = url.pathname.slice('/stable/'.length),
      ticker = url.searchParams.get('symbol');
    if (
      !endpoints.has(endpoint) ||
      !['AAA', 'BBB', 'CCC', 'BRK-B', 'SPY', '_MARKET'].includes(ticker)
    ) {
      unexpected.push(url.href);
      throw new Error('Unexpected FMP URL ' + url.href);
    }
    if (endpoint === 'profile')
      return json([
        {
          symbol: ticker,
          companyName: ticker + ' Company',
          sector: 'Technology',
          industry: 'Software',
          isEtf: funds.has(ticker),
          isFund: false,
        },
      ]);
    if (endpoint === 'earnings') return json(earningsRows.get(ticker) ?? []);
    if (endpoint === 'etf/sector-weightings') return json([{ sector: 'Energy', weightPercentage: 100 }]);
    if (endpoint === 'quote')
      return json(
        noQuote.has(ticker)
          ? []
          : [
              {
                symbol: ticker,
                price: 100,
                changePercentage: 6,
                timestamp: Math.floor(Date.now() / 1000) - 60,
                marketCap: 1000000,
              },
            ],
      );
    if (endpoint === 'historical-price-eod/light')
      return json([0, 1, 2, 3, 4, 5, 6].map((n) => ({ date: ago(n + (ticker === 'SPY' ? spyLagDays : 0)), price: 100 - n })));
    if (endpoint === 'analyst-estimates')
      return json([
        { date: futureYear + '-12-31', epsAvg: 6, revenueAvg: 1200 },
        { date: futureYear + 1 + '-12-31', epsAvg: 7, revenueAvg: 1300 },
      ]);
    if (endpoint === 'income-statement')
      return json([
        {
          date: ago(30),
          fiscalYear: String(futureYear - 1),
          period: 'Q3',
          revenue: 1000,
          netIncome: 100,
          eps: 1,
          reportedCurrency: 'USD',
        },
      ]);
    return json([]);
  }
  if (url.href === 'https://www.sec.gov/files/company_tickers.json')
    return json({ 0: { cik_str: 1, ticker: 'AAA' } });
  if (url.href === 'https://data.sec.gov/submissions/CIK0000000001.json')
    return json({
      filings: {
        recent: {
          accessionNumber: filingPresent ? [accession] : [],
          filingDate: filingPresent ? [date] : [],
          form: filingPresent ? ['8-K'] : [],
          primaryDocument: filingPresent ? ['cover.htm'] : [],
          items: filingPresent ? ['2.02,9.01'] : [],
        },
      },
    });
  const base = 'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/';
  if (url.href === base + 'cover.htm')
    return new Response('<p>Item 2.02 Results. See attached exhibit.</p>', {
      status: unreadable ? 500 : 200,
    });
  if (url.href === base + accession + '-index.html')
    return new Response(
      '<table><tr><td>1</td><td>Results</td><td><a href="results.htm">results.htm</a></td><td>EX-99.1</td><td>2000</td></tr></table>',
    );
  if (url.href === base + 'results.htm')
    return new Response(
      '<p>EXHIBIT RESULTS: revenue was 1000 and guidance remains steady.</p>',
    );
  unexpected.push(url.href);
  throw new Error('Unexpected network URL ' + url.href);
};
function analysis(ticker, light = false, action = 'hold') {
  return {
    ticker,
    status: 'no_change',
    headline: 'Stable results',
    what_changed: ['Price is 100'],
    evidence: [{ claim: 'Price is 100', source: 'fmp:quote', date }],
    action,
    confidence: 0.8,
    business_view: 'Stable',
    valuation_view: 'Price is 100',
    evidence_against: [],
    next_proof_point: 'Next results',
    reasoning: 'The quote is 100.',
    would_change_my_mind: ['Revenue falls below 900'],
    dossier_current_view: light ? null : 'Passing view on ' + date,
  };
}
function verification(ticker = 'AAA', verdict = 'verified', supported = true) {
  return {
    ticker,
    checks: [{ claim: 'Price is 100', verdict, note: 'quote', source: 'fmp:quote' }],
    conclusion_supported: supported,
    concerns: [],
    independent_action: 'hold',
    independent_reason: 'Stable',
  };
}
function brief() {
  return {
    date,
    summary: 'Stable portfolio.',
    needs_attention: [],
    portfolio_observations: [],
    suggested_actions: [],
    nothing_to_do: true,
  };
}
function script(role, data, ticker) {
  scripts.push({ role, data, ticker });
}
const rows = async (sql) => (await client.execute(sql)).rows;
const last = async (table) =>
  (await rows('SELECT * FROM ' + table + ' ORDER BY id DESC LIMIT 1'))[0];
const update = () => last('ticker_updates');
const packDir = (ticker) => path.join('data/packs', today(), ticker);
const pack = (ticker = 'AAA') =>
  JSON.parse(readFileSync(path.join(packDir(ticker), 'pack.json'), 'utf8'));
const briefFile = () => readFileSync(path.join('data/briefs', date + '.md'), 'utf8');
const clock = async () =>
  (await rows("SELECT last_full_review_at FROM tickers WHERE ticker='AAA'"))[0]
    .last_full_review_at;
const pending = async () =>
  (await rows('SELECT processed_at FROM filings'))[0].processed_at;
const roleCount = (role) => calls.filter((c) => c.role === role).length;
const fmpCount = () =>
  requests.filter((u) => u.startsWith('https://financialmodelingprep.com/')).length;
async function holding(ticker) {
  await client.execute({
    sql: 'INSERT INTO holdings VALUES (?,?,2,150,?,?)',
    args: [ticker, ticker + ' Company', '', date],
  });
}
async function run(only) {
  assert.equal(await runResearch(only), true);
  assert.equal((await last('research_runs')).status, 'finished');
}
const setQuote = (ticker, fields) =>
  client.execute({
    sql: "INSERT OR REPLACE INTO fmp_cache VALUES (?,'quote',?,?)",
    args: [ticker, date, JSON.stringify([{ symbol: ticker, price: 100, ...fields }])],
  });
await holding('AAA');
`;

function scenario(
  name: string,
  body: string,
  env: Record<string, string> = {},
) {
  void test(name, () => {
    const temp = mkdtempSync(path.join(tmpdir(), "portchecker-run-e2e-"));
    const root = path.resolve(import.meta.dirname, "../..");
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--no-warnings",
          "--input-type=module",
          "--eval",
          `const root = ${JSON.stringify(root)};\n${harness}\ntry {\n${body}\nassert.deepEqual(unexpected, []); assert.equal(scripts.length,0,'Unused model script');\n} finally { client.close(); }`,
        ],
        {
          cwd: temp,
          env: {
            ...process.env,
            DATABASE_PATH: path.join(temp, "test.db"),
            FMP_API_KEY: "test",
            SEC_USER_AGENT: "test",
            ANTHROPIC_API_KEY: "",
            NODE_ENV: "test",
            ...env,
          },
          encoding: "utf8",
          timeout: 120_000,
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

for (const existing of [
  "history",
  "settings",
  "dossier",
  "brief",
  "imports",
  "empty",
] as const) {
  scenario(
    `demo seed protects an installation with ${existing}`,
    String.raw`
await client.execute('DELETE FROM holdings');
const kind = ${JSON.stringify(existing)};
if (kind === 'history') await client.execute("INSERT INTO research_runs (id,started_at,status,provider_mode) VALUES (71,'2026-11-01','finished','chatgpt')");
if (kind === 'settings') await client.execute("INSERT INTO settings VALUES ('provider_mode','claude')");
let savedFile;
if (['dossier','brief','imports'].includes(kind)) {
  savedFile = kind === 'dossier' ? 'data/dossiers/MRDN.md' : kind === 'brief' ? 'data/briefs/'+date+'.md' : 'data/imports/owner.csv';
  mkdirSync(path.dirname(savedFile), {recursive:true});
  writeFileSync(savedFile, 'Preserve owner content');
}
const before = await rows('SELECT id,status FROM research_runs');
const exit = process.exit;
let code;
process.exit = value => { code = value; throw new Error('demo-exit'); };
try {
  await assert.rejects(import(pathToFileURL(path.join(root,'scripts/seed-demo.ts')).href), /demo-exit/);
} finally { process.exit = exit; }
assert.equal(code, kind === 'empty' ? 0 : 1);
if (kind === 'empty') {
  assert.equal((await rows('SELECT * FROM holdings')).length, 5);
  assert.equal((await rows('SELECT * FROM briefs')).length, 1);
} else {
  assert.equal((await rows('SELECT * FROM holdings')).length, 0);
  assert.deepEqual(await rows('SELECT id,status FROM research_runs'), before);
  if (savedFile) assert.equal(readFileSync(savedFile,'utf8'), 'Preserve owner content');
  if (kind === 'settings') assert.equal((await rows("SELECT value FROM settings WHERE key='provider_mode'"))[0].value, 'claude');
}
assert.equal(calls.length, 0);
assert.equal(requests.length, 0);
`,
  );
}

for (const role of ["analyst", "verifier"] as const) {
  for (const revision of [false, true]) {
    scenario(
      `a wrong ticker in the ${revision ? "revised" : "initial"} ${role} output cannot be saved`,
      String.raw`
const role = ${JSON.stringify(role)};
if (${revision}) {
  script('analyst', analysis('AAA'));
  script('verifier', verification('AAA', 'contradicted', false));
}
script(role, role === 'analyst' ? { ...analysis('BBB'), dossier_current_view:'BBB-only view' } : verification('BBB'));
assert.equal(await runResearch(), false);
assert.equal((await rows('SELECT * FROM ticker_updates')).length, 0);
assert.equal((await rows('SELECT * FROM briefs')).length, 0);
assert.doesNotMatch(readDossier('AAA'), /BBB-only view/);
assert.equal(await pending(), null);
assert.match((await last('research_runs')).log_text, /ticker/);
`,
    );
  }
}

scenario(
  "an intraday review uses the price it actually read and suppresses the same quote",
  String.raw`
mock.timers.setTime(Date.parse('2026-11-09T17:00:00Z'));
const vendor = globalThis.fetch;
let phase = 1;
globalThis.fetch = async (input) => {
  const u = new URL(String(input));
  if (u.origin === 'https://financialmodelingprep.com' && u.searchParams.get('symbol') === 'AAA') {
    if (u.pathname === '/stable/quote') return Response.json([{ symbol:'AAA', price:phase === 1 ? 100 : 110.04, changePercentage:phase === 1 ? 0 : 4.9, timestamp:Date.parse(phase === 1 ? '2026-11-09T17:00:00Z' : '2026-11-10T21:00:00Z') / 1000, marketCap:1000000 }]);
    if (u.pathname === '/stable/historical-price-eod/light') return Response.json((phase === 1 ? [['2026-11-09',100],['2026-11-06',100],['2026-11-05',100],['2026-11-04',100],['2026-11-03',100],['2026-11-02',100]] : [['2026-11-10',110.04],['2026-11-09',104.9],['2026-11-06',100],['2026-11-05',100],['2026-11-04',100],['2026-11-03',100]]).map(([date,price]) => ({date,price})));
  }
  return vendor(input);
};
await run();
assert.equal((await update()).review_depth, 'FULL');
assert.equal(pack().quote.price, 100);
phase = 2;
mock.timers.setTime(Date.parse('2026-11-10T21:05:00Z'));
await run();
assert.equal((await update()).review_depth, 'FULL');
assert.equal(roleCount('verifier'), 2);
await run();
assert.equal((await update()).review_depth, 'LIGHT');
assert.equal(roleCount('verifier'), 2);
`,
);

scenario(
  "a final rejected hold remains visible in the brief and without a brief",
  String.raw`
for (let i = 0; i < 2; i++) {
  script('verifier', { ...verification('AAA', 'unverified', false), concerns:['The premise supporting hold is absent.'] });
}
script('brief', { ...brief(), summary:'Nothing needs attention. Every holding can remain unchanged.' });
await run();
const saved = (await loadBrief()).brief;
assert.equal(saved.nothing_to_do, false);
assert.match(saved.needs_attention[0].why, /final check.*concerns/i);
assert.equal(saved.suggested_actions[0].action, 'review');
assert.doesNotMatch(saved.summary, /Nothing needs attention|Every holding can remain unchanged/);
const latest = await latestUpdates();
assert.deepEqual(openCalls([], latest, [], new Set(['AAA'])).map(u => u.ticker), ['AAA']);
assert.equal(openCalls([{ticker:'AAA'}], latest, [], new Set(['AAA'])).length, 0);
assert.equal(await pending(), null);
assert.doesNotMatch(dossierSection(readDossier('AAA'), 'Current view') ?? '', /Fresh view/);
`,
);

scenario(
  "attention-only warnings cannot invent a sell beside an agreed hold",
  String.raw`
script('brief', { ...brief(), summary:'Sell AAA immediately: the thesis has broken.', nothing_to_do:false,
  needs_attention:[{ticker:'AAA',why:'Sell AAA immediately: the thesis has broken.'}] });
await run();
const saved = await loadBrief();
assert.equal((await latestUpdates()).get('AAA').result.action, 'hold');
assert.equal(saved.queue[0].why, 'Stable results');
assert.doesNotMatch(saved.brief.needs_attention[0].why, /Sell|broken/);
assert.doesNotMatch(saved.brief.summary, /Sell|broken/);
`,
);

scenario(
  "restoring a sell replaces all-clear prose even when its flag is false",
  String.raw`
script('analyst', { ...analysis('AAA', false, 'sell'), status:'thesis_broken', headline:'Sell AAA: its main contract was cancelled.' });
script('verifier', { ...verification(), independent_action:'sell' });
script('brief', { ...brief(), summary:'Nothing needs attention today. Every holding can remain unchanged.', nothing_to_do:false });
await run();
const saved = (await loadBrief()).brief;
assert.equal(saved.suggested_actions[0].action, 'sell');
assert.match(saved.summary, /^Needs attention: AAA\./);
assert.doesNotMatch(saved.summary, /Nothing needs attention|Every holding can remain unchanged/);
`,
);

scenario(
  "late dossier saves keep their requested review and pending filings",
  String.raw`
await run();
const { dossiersRouter } = await load('api/routers/dossiers.ts');
const { dossierHash } = await load('dossier.ts');
const dossiers = dossiersRouter.createCaller({ db });
await client.execute('UPDATE tickers SET last_full_review_at=NULL');
await client.execute('UPDATE filings SET processed_at=NULL');
const expectedHash = dossierHash(readDossier('AAA'));
const realLog = console.log;
let saved;
console.log = (line, ...args) => {
  if (String(line).startsWith('AAA: updated data') && !saved)
    saved = dossiers.save({ ticker:'AAA', expectedHash, markdown:replaceSection(readDossier('AAA'), 'Thesis', 'A new thesis saved during final logging') });
  realLog(line, ...args);
};
try { await run(); await saved; } finally { console.log = realLog; }
assert.ok(saved);
assert.equal(await clock(), null);
assert.equal(await pending(), null);
assert.equal(dossierSection(readDossier('AAA'), 'Thesis'), 'A new thesis saved during final logging');
await run();
assert.equal((await update()).review_depth, 'FULL');
assert.ok(await clock());
assert.ok(await pending());
`,
);

scenario(
  "a save after filing finalization retains the review request even when the thesis is reverted",
  String.raw`
await run();
const { dossiersRouter } = await load('api/routers/dossiers.ts');
const { dossierHash } = await load('dossier.ts');
const dossiers = dossiersRouter.createCaller({ db });
await client.execute('UPDATE tickers SET last_full_review_at=NULL');
await client.execute('UPDATE filings SET processed_at=NULL');
const original = readDossier('AAA');
const realLog = console.log;
let saved;
console.log = (line, ...args) => {
  if (String(line).startsWith('AAA: no_change, hold, verified') && !saved) {
    saved = (async () => {
      assert.ok(await pending(), 'Filing finalization must already have happened');
      await dossiers.save({ ticker:'AAA', expectedHash:dossierHash(readDossier('AAA')), markdown:replaceSection(readDossier('AAA'), 'What would break the thesis', 'A newly cancelled contract') });
      await dossiers.save({ ticker:'AAA', expectedHash:dossierHash(readDossier('AAA')), markdown:original });
    })();
  }
  realLog(line, ...args);
};
try { await run(); await saved; } finally { console.log = realLog; }
assert.ok(saved);
assert.equal(readDossier('AAA'), original);
assert.equal(await clock(), null);
assert.equal(await pending(), null);
`,
);

scenario(
  "results 8-K FULL review saves exhibit, provenance, view and brief",
  String.raw`
const v = verification();
v.checks.push({
  claim: 'Demand outlook is unclear',
  verdict: 'unverified',
  note: 'Not in files',
  source: 'fmp:quote',
});
script('verifier', v);
await run();
const row = await update();
assert.equal(row.review_depth, 'FULL');
assert.equal(row.verified_score, 0.5);
assert.equal(row.analyst_model, 'stub-model');
assert.equal(row.verifier_model, 'stub-model');
const dir = packDir('AAA');
const exhibit = readdirSync(dir).find((n) => n.startsWith('new_8k_'));
assert.ok(exhibit);
assert.match(readFileSync(path.join(dir, exhibit), 'utf8'), /EXHIBIT RESULTS/);
assert.ok(existsSync(path.join(dir, 'web_research.md')));
assert.ok(
  calls
    .find((c) => c.role === 'research')
    .prompt.includes('Results were published on ' + date),
);
assert.ok(pack().quote.as_of_et);
assert.equal(
  pack().valuation_and_growth.valuation.next_year_fiscal_year_end,
  futureYear + 1 + '-12-31',
);
assert.equal(pack().previous_review, null);
assert.ok(await pending());
assert.ok(await clock());
assert.match(readDossier('AAA'), /Passing view/);
assert.match(readDossier('AAA'), /could not confirm:\n\n- Demand outlook is unclear/);
assert.equal((await rows('SELECT * FROM briefs')).length, 1);
assert.equal(briefFile(), (await last('briefs')).markdown);
`,
);

scenario(
  "same-day cached move gets quiet LIGHT pack and retains FULL review",
  String.raw`
await run();
const first = await update(),
  count = fmpCount();
await run();
const second = await update();
assert.equal(fmpCount(), count);
assert.equal(second.review_depth, 'LIGHT');
assert.equal(second.verification_json, null);
assert.equal(second.verified_score, null);
assert.deepEqual(readdirSync(packDir('AAA')).sort(), ['dossier.md', 'pack.json']);
const kept = packDir('AAA') + '.full';
assert.ok(existsSync(path.join(kept, 'web_research.md')));
assert.ok(readdirSync(kept).some((n) => n.startsWith('new_8k_')));
assert.equal(pack().previous_review.action, 'hold');
const latest = (await latestUpdates()).get('AAA');
assert.equal(latest.id, first.id);
assert.equal(latest.recheckedAt, second.created_at);
`,
);

scenario(
  "LIGHT add-to-hold change is verified and remains visible",
  String.raw`
script('analyst', analysis('AAA', false, 'add'));
await run();
const count = roleCount('verifier');
await run();
const row = await update();
assert.equal(row.review_depth, 'LIGHT');
assert.equal(roleCount('verifier'), count + 1);
assert.ok(row.verification_json);
assert.equal(JSON.parse(row.result_json).previous_action, 'add');
assert.equal((await latestUpdates()).get('AAA').id, row.id);
assert.equal((await latestUpdates()).get('AAA').recheckedAt, null);
`,
);

scenario(
  "rejected final check preserves owner sections and pending filing until passing retry",
  String.raw`
await run();
const original = readDossier('AAA'),
  before = await clock();
await client.execute('UPDATE filings SET processed_at=NULL');
const analystCount = roleCount('analyst'),
  verifierCount = roleCount('verifier');
script('analyst', {
  ...analysis('AAA'),
  dossier_current_view: 'Unsupported replacement',
});
script('analyst', {
  ...analysis('AAA'),
  dossier_current_view: 'Unsupported replacement',
});
script('verifier', verification('AAA', 'verified', false));
script('verifier', verification('AAA', 'verified', false));
await run();
assert.equal(roleCount('analyst'), analystCount + 2);
assert.equal(roleCount('verifier'), verifierCount + 2);
assert.equal(await pending(), null);
assert.equal(await clock(), before);
const stale = readDossier('AAA');
assert.match(stale, new RegExp('Not updated on ' + date));
assert.match(stale, /Passing view/);
assert.doesNotMatch(stale, /Unsupported replacement/);
// Removing only Current view must leave every other byte unchanged.
assert.equal(
  replaceSection(stale, 'Current view', ''),
  replaceSection(original, 'Current view', ''),
);
await run();
assert.ok(await pending());
assert.notEqual(await clock(), before);
// The next review is told its predecessor failed, so that call is not its starting point.
assert.equal(pack().previous_review.conclusion_supported, false);
assert.doesNotMatch(readDossier('AAA'), /Not updated on/);
`,
);

scenario(
  "supported contradiction processes filing but keeps stale Current view and first pass",
  String.raw`
await run();
const before = await clock();
await client.execute('UPDATE filings SET processed_at=NULL');
script('analyst', { ...analysis('AAA'), dossier_current_view: 'Rejected replacement' });
script('analyst', { ...analysis('AAA'), dossier_current_view: 'Rejected replacement' });
script('verifier', verification('AAA', 'contradicted', true));
script('verifier', verification('AAA', 'contradicted', true));
await run();
assert.ok(await pending());
assert.notEqual(await clock(), before);
assert.match(readDossier('AAA'), /Not updated on/);
assert.match(readDossier('AAA'), /Passing view/);
assert.doesNotMatch(readDossier('AAA'), /Rejected replacement/);
const row = await update(),
  v = JSON.parse(row.verification_json);
assert.equal(row.revised_after_review, 1);
assert.equal(v.first_pass.action, 'hold');
assert.equal(v.first_pass.conclusion_supported, true);
`,
);

scenario(
  "subset review keeps full brief and other holding's open call",
  String.raw`
await holding('BBB');
script('analyst', analysis('BBB', false, 'trim'), 'BBB');
await run();
const before = briefFile(),
  count = (await rows('SELECT * FROM briefs')).length,
  start = calls.length;
await run(['AAA']);
assert.deepEqual(
  calls
    .slice(start)
    .filter((c) => c.role === 'analyst')
    .map((c) => JSON.parse(c.files['pack.json']).ticker),
  ['AAA'],
);
assert.equal((await rows('SELECT * FROM briefs')).length, count);
assert.equal(briefFile(), before);
assert.equal((await last('research_runs')).brief_id, null);
const updates = await latestUpdates(),
  kept = await loadBrief();
assert.ok(
  openCalls([], updates, kept.decisions, new Set(['AAA', 'BBB'])).some(
    (c) => c.ticker === 'BBB' && c.result.action === 'trim',
  ),
);
assert.ok(kept.queue.some((c) => c.ticker === 'BBB' && c.action === 'trim'));
assert.deepEqual(
  openCalls(kept.queue, updates, kept.decisions, new Set(['AAA', 'BBB'])),
  [],
);
`,
);

scenario(
  "brief repairs omitted and invented calls and corrects actions using code scores",
  String.raw`
await holding('BBB');
await holding('CCC');
script('analyst', analysis('AAA', false, 'add'), 'AAA');
script('analyst', analysis('BBB', false, 'trim'), 'BBB');
script('analyst', analysis('CCC', false, 'hold'), 'CCC');
script('verifier', { ...verification('CCC'), independent_action: 'add' }, 'CCC');
const item = (ticker, action) => ({
  ticker,
  action,
  size_hint: 'small',
  reasoning: 'check',
  urgency: 'today',
  verified_score: 0.01,
  models_agree: true,
});
script('brief', {
  ...brief(),
  suggested_actions: [item('BBB', 'sell'), item('FAKE', 'add'), item('CCC', 'review')],
});
await run();
const saved = JSON.parse((await last('briefs')).result_json);
assert.equal(saved.suggested_actions.find((a) => a.ticker === 'AAA').action, 'add');
assert.equal(saved.suggested_actions.find((a) => a.ticker === 'BBB').action, 'trim');
assert.equal(saved.suggested_actions.find((a) => a.ticker === 'CCC').action, 'review');
assert.ok(!saved.suggested_actions.some((a) => a.ticker === 'FAKE'));
for (const action of saved.suggested_actions) assert.equal(action.verified_score, 1);
`,
);

scenario(
  "unreadable filing remains pending and stops retries after five days",
  String.raw`
unreadable = true;
await run();
assert.equal((await update()).ticker, 'AAA');
assert.equal(await pending(), null);
assert.ok(
  pack().data_notes.some((n) => n.includes(accession) && n.includes('could not be read')),
);
// Filed long ago makes no difference: only days since the first failure count.
await client.execute({ sql: 'UPDATE filings SET filed_at=?', args: [ago(6)] });
await run();
assert.equal(await pending(), null);
await client.execute({
  sql: "UPDATE fmp_cache SET fetched_on=? WHERE endpoint LIKE 'retrying:%'",
  args: [ago(6)],
});
await run();
assert.ok(await pending());
assert.match(
  (await last('research_runs')).log_text,
  /stopped retrying 8-K .* after 5 days/,
);
`,
);

scenario(
  "missing quote is recorded in brief and excluded from portfolio totals",
  String.raw`
await holding('BBB');
noQuote.add('BBB');
await run();
const saved = JSON.parse((await last('briefs')).result_json);
assert.ok(
  saved.failed.some((f) => f.ticker === 'BBB' && /No market data/.test(f.reason)),
);
assert.ok(pack().data_notes.some((n) => n.includes('leave out BBB')));
assert.deepEqual(
  (await rows('SELECT ticker FROM ticker_updates')).map((r) => r.ticker),
  ['AAA'],
);
`,
);

scenario(
  "thesis draft uses live context and acceptance invalidates review without overwriting owner notes",
  String.raw`
await run();
await run();
const { tickersRouter } = await load('api/routers/tickers.ts');
const { dossiersRouter } = await load('api/routers/dossiers.ts');
const caller = tickersRouter.createCaller({ db }),
  dossiers = dossiersRouter.createCaller({ db });
let live = replaceSection(
  readDossier('AAA'),
  'What would break the thesis',
  'Hand-written break condition',
);
live = live.replace('## Thesis (owner: me)', '## thesis');
live = live.replace(
  '## Current view',
  '## Valuation notes\n\nPaid 12x in 2024.\n\n## Current view',
);
live += '\nLive owner edit after pack.\n';
saveDossier('AAA', live);
const latestPack = readFileSync(path.join(packDir('AAA'), 'pack.json'), 'utf8');
script('ask', {
  thesis: ['Revenue supports ownership'],
  break_conditions: ['Revenue below 900'],
  numbers_to_watch: ['Revenue 1000'],
});
const draft = await caller.draftThesis({ ticker: 'AAA' }),
  call = calls.at(-1);
assert.equal(draft.provider, 'chatgpt');
assert.equal(draft.model, 'stub-model');
assert.equal(draft.usedFallback, false);
assert.ok(path.basename(call.workingDirectory).startsWith('_context-'));
assert.equal(call.files['dossier.md'], live);
assert.equal(call.files['pack.json'], latestPack);
assert.ok(
  Object.entries(call.files).some(
    ([n, text]) => n.startsWith('new_8k_') && text.includes('EXHIBIT RESULTS'),
  ),
);
assert.ok(!existsSync(call.workingDirectory));
script('ask', { thesis: [' '], break_conditions: [], numbers_to_watch: [] });
await assert.rejects(caller.draftThesis({ ticker: 'AAA' }), /empty draft/);
assert.ok(!existsSync(calls.at(-1).workingDirectory));
const input = {
  ticker: 'AAA',
  thesis: 'Revenue supports ownership',
  breakConditions: 'Revenue below 900',
  numbersToWatch: 'Revenue 1000',
};
await caller.acceptThesis(input);
const accepted = readDossier('AAA');
assert.equal(await clock(), null);
assert.equal(dossierSection(accepted, 'Thesis'), input.thesis);
assert.match(
  dossierSection(accepted, 'What would break the thesis'),
  /Hand-written break condition/,
);
assert.match(
  dossierSection(accepted, 'What would break the thesis'),
  /Revenue below 900/,
);
for (const section of ['Current view', 'Watch items'])
  assert.equal(dossierSection(accepted, section), dossierSection(live, section));
assert.equal((accepted.match(/^## thesis/gim) ?? []).length, 1);
assert.equal(accepted.split('Paid 12x in 2024.').length - 1, 1);
assert.match(accepted, /^## Valuation notes$/m);
await assert.rejects(caller.acceptThesis(input), (e) => e.code === 'CONFLICT');
assert.equal(readDossier('AAA'), accepted);
const start = calls.length;
await run();
assert.equal((await update()).review_depth, 'FULL');
for (const c of calls
  .slice(start)
  .filter((c) => ['analyst', 'verifier'].includes(c.role)))
  assert.doesNotMatch(c.prompt, /Thesis section is blank/i);
const before = await clock();
await dossiers.save({
  ticker: 'AAA',
  markdown: readDossier('AAA') + '\nUnchanged thesis note\n',
});
assert.equal(await clock(), before);
await dossiers.save({
  ticker: 'AAA',
  markdown: replaceSection(readDossier('AAA'), 'Thesis', 'Changed thesis'),
});
assert.equal(await clock(), null);
`,
);

scenario(
  "a thesis saved during a review keeps the full review it asked for",
  String.raw`
await run();
const stub = globalThis.modelStub;
globalThis.modelStub = async (opts) => {
  if (opts.role === 'verifier')
    saveDossier(
      'AAA',
      replaceSection(readDossier('AAA'), 'Thesis', 'A thesis saved mid-review'),
    );
  return stub(opts);
};
await client.execute('UPDATE tickers SET last_full_review_at=NULL');
await client.execute('UPDATE filings SET processed_at=NULL');
const view = dossierSection(readDossier('AAA'), 'Current view');
script('analyst', { ...analysis('AAA'), dossier_current_view: 'Judged the old thesis' });
script('verifier', verification('AAA', 'verified', true));
await run();
globalThis.modelStub = stub;
assert.equal(await clock(), null);
assert.equal(await pending(), null);
assert.equal(dossierSection(readDossier('AAA'), 'Current view'), view);
assert.equal(
  dossierSection(readDossier('AAA'), 'Thesis'),
  'A thesis saved mid-review',
);
assert.match(
  (await last('research_runs')).log_text,
  /the thesis or its break conditions changed during this review/,
);
`,
);

scenario(
  "ask uses temporary research context and returns model provenance",
  String.raw`
await run();
await run();
saveDossier('AAA', readDossier('AAA') + '\nLive question note\n');
const { tickersRouter } = await load('api/routers/tickers.ts');
script('ask', {
  answer: 'Price is 100',
  evidence: [{ claim: 'Price is 100', source: 'fmp:quote' }],
});
const result = await tickersRouter
  .createCaller({ db })
  .ask({ ticker: 'AAA', question: 'What is the price?' });
assert.equal(result.answer, 'Price is 100');
assert.equal(result.provider, 'chatgpt');
assert.equal(result.model, 'stub-model');
assert.equal(result.usedFallback, false);
const call = calls.at(-1);
assert.ok(path.basename(call.workingDirectory).startsWith('_context-'));
assert.match(call.files['dossier.md'], /Live question note/);
assert.equal(
  call.files['pack.json'],
  readFileSync(path.join(packDir('AAA'), 'pack.json'), 'utf8'),
);
assert.ok(Object.keys(call.files).some((n) => n.startsWith('new_8k_')));
assert.ok(!existsSync(call.workingDirectory));
assert.deepEqual(await rows('SELECT * FROM decisions'), []);
`,
);

scenario(
  "only the analyst and checker decide a review's fallback label, and the log keeps the rest",
  String.raw`
const stub = globalThis.modelStub;
const fellBack = (role) => async (opts) => {
  const out = await stub(opts);
  return opts.role === role
    ? { ...out, provider: 'claude', usedFallback: true, fallbackReason: 'Selected model is at capacity.' }
    : out;
};
globalThis.modelStub = fellBack('research');
await run();
assert.equal(Boolean((await update()).used_fallback), false);
assert.match(
  (await last('research_runs')).log_text,
  /FALLBACK on AAA web research: used Claude/,
);
await client.execute('UPDATE tickers SET last_full_review_at=NULL');
globalThis.modelStub = fellBack('analyst');
await run();
globalThis.modelStub = stub;
assert.equal(Boolean((await update()).used_fallback), true);
`,
);

scenario(
  "a full review counts as seeing only the quote it read, and a rejected one sees none",
  String.raw`
await run();
const first = await update();
const seen = JSON.parse(first.result_json).quote_priced_at;
assert.ok(seen);
// Priced before that review finished, so the clock alone would call this move seen.
const pricedAt = Math.floor(Date.parse(await clock()) / 1000) - 1;
assert.ok(pricedAt > seen);
await setQuote('AAA', { changePercentage: -8, timestamp: pricedAt });
for (let i = 0; i < 2; i++) {
  script('analyst', analysis('AAA'));
  script('verifier', verification('AAA', 'verified', false));
}
await run();
const rejected = await update();
assert.equal(rejected.review_depth, 'FULL');
assert.match((await last('research_runs')).log_text, /AAA: FULL review \(day move of 8\.0%\)/);
assert.equal(JSON.parse(rejected.result_json).quote_priced_at, pricedAt);
// It did not set the clock, so the same quote gets its retry.
await run();
const passed = await update();
assert.equal(passed.review_depth, 'FULL');
assert.notEqual(passed.id, rejected.id);
await run();
assert.equal((await update()).review_depth, 'LIGHT');
`,
);

scenario(
  "a failed web search leaves a note both passes read, with nothing to cite",
  String.raw`
const stub = globalThis.modelStub;
globalThis.modelStub = async (opts) => {
  if (opts.role === 'research') throw new Error('Search provider down');
  return stub(opts);
};
await run();
globalThis.modelStub = stub;
const note = readFileSync(path.join(packDir('AAA'), 'web_research.md'), 'utf8');
assert.match(note, /web search failed/);
assert.doesNotMatch(note, /https?:/);
assert.doesNotMatch(note, /No material developments/);
for (const role of ['analyst', 'verifier'])
  assert.equal(calls.find((c) => c.role === role).files['web_research.md'], note);
assert.match(
  (await last('research_runs')).log_text,
  /web research failed, continuing without it\. Search provider down/,
);
assert.equal((await update()).review_depth, 'FULL');
`,
);

scenario(
  "a review rejected with no new view still marks the old Current view stale",
  String.raw`
await run();
const original = readDossier('AAA');
const rejectTwice = (action) => {
  for (let i = 0; i < 2; i++) {
    script('analyst', analysis('AAA', true, action));
    script('verifier', verification('AAA', 'verified', false));
  }
};
const unchangedOutsideView = (text) =>
  assert.equal(
    replaceSection(text, 'Current view', ''),
    replaceSection(original, 'Current view', ''),
  );
rejectTwice('trim');
await run();
assert.equal((await update()).review_depth, 'LIGHT');
assert.equal(JSON.parse((await update()).result_json).dossier_current_view, null);
const light = readDossier('AAA');
assert.match(light, new RegExp('Not updated on ' + date + ': the latest review suggests trim'));
assert.match(light, /Passing view/);
unchangedOutsideView(light);

await client.execute('UPDATE tickers SET last_full_review_at=NULL');
rejectTwice('sell');
await run();
assert.equal((await update()).review_depth, 'FULL');
const full = readDossier('AAA');
assert.match(full, /the latest review suggests sell/);
assert.equal(full.match(/Not updated on/g).length, 1);
assert.match(full, /Passing view/);
unchangedOutsideView(full);

// A checked review with no view and a passing result leaves the dossier alone.
await client.execute({
  sql: 'UPDATE tickers SET last_full_review_at=?',
  args: [new Date().toISOString()],
});
const checked = roleCount('verifier');
await run();
assert.equal((await update()).review_depth, 'LIGHT');
assert.equal(roleCount('verifier'), checked + 1);
assert.equal(readDossier('AAA'), full);
`,
);

scenario(
  "an old quote gets a note on its own holding, and the brief dates its prices",
  String.raw`
await holding('BBB');
await setQuote('AAA', {
  changePercentage: 0.5,
  timestamp: Math.floor(Date.parse(ago(10) + 'T12:00:00') / 1000),
});
await setQuote('BBB', {
  changePercentage: 0.5,
  timestamp: Math.floor(Date.now() / 1000) - 60,
});
await run();
const dated = (ticker) =>
  pack(ticker).data_notes.filter((n) => n.startsWith('This quote is dated'));
assert.equal(dated('AAA').length, 1);
assert.ok(dated('AAA')[0].startsWith('This quote is dated ' + ago(10) + ','));
assert.deepEqual(dated('BBB'), []);
const { dataWarnings } = await load('research/pack.ts');
assert.ok(dataWarnings(pack('AAA').data_notes).includes(dated('AAA')[0]));
assert.match(briefFile(), /^Prices as of \S+\. Older or stale quotes: AAA\.$/m);
`,
);

scenario(
  "a ticker not held is named, and stops the run before any data is fetched if it is all there is",
  String.raw`
await holding('BBB');
const { runProgress } = await load('queue.ts');
const before = requests.length;
assert.equal(await runResearch(['ZZZ']), false);
assert.equal(requests.length, before);
let row = await last('research_runs');
assert.equal(row.status, 'failed');
assert.match(row.log_text, /Nothing to review: ZZZ not in your holdings\./);
assert.doesNotMatch(row.log_text, /Reviewing only/);

// With two holdings failing, the message names the one asked for.
noQuote.add('AAA');
noQuote.add('BBB');
assert.equal(await runResearch(['BBB']), false);
row = await last('research_runs');
assert.doesNotMatch(row.log_text, /Reviewing only/);
assert.match(row.log_text, /No holding could be reviewed\. BBB: No market data/);
noQuote.clear();

await run(['AAA', 'ZZZ']);
row = await last('research_runs');
assert.match(row.log_text, /Not in your holdings, so not reviewed: ZZZ\./);
assert.match(row.log_text, /Reviewing only: AAA\./);
assert.equal((await update()).ticker, 'AAA');
assert.deepEqual(runProgress(row.log_text), { done: 1, total: 1 });
`,
);

scenario(
  "a pack folder that cannot be made fails the run at once and frees the button",
  String.raw`
const { activeRun, latestRun } = await load('research/run.ts');
mkdirSync('data', { recursive: true });
writeFileSync('data/packs', 'x');
assert.equal(await runResearch(), false);
assert.equal((await last('research_runs')).status, 'failed');
assert.match((await latestRun()).message, /ENOTDIR|EEXIST/);
assert.equal(await activeRun(), null);
assert.equal(calls.length, 0);
`,
);

scenario(
  "a row at zero shares gets no paid review and is named, and counts again once it has shares",
  String.raw`
await holding('BBB');
await client.execute("UPDATE holdings SET quantity=0 WHERE ticker='BBB'");
const analyzed = () =>
  calls
    .filter((c) => c.role === 'analyst')
    .map((c) => JSON.parse(c.files['pack.json']).ticker);
await run();
assert.deepEqual(analyzed(), ['AAA']);
assert.deepEqual(
  (await rows('SELECT DISTINCT ticker FROM ticker_updates')).map((r) => r.ticker),
  ['AAA'],
);
const saved = JSON.parse((await last('briefs')).result_json);
assert.ok(saved.failed.some((f) => f.ticker === 'BBB' && /zero shares/.test(f.reason)));
// Its quote was still fetched, so it does not read as a missing price.
assert.ok(!pack().data_notes.some((n) => n.includes('leave out BBB')));
const { runProgress } = await load('queue.ts');
assert.deepEqual(runProgress((await last('research_runs')).log_text), {
  done: 2,
  total: 2,
});
// A second account's shares make it a position.
await client.execute({
  sql: 'INSERT INTO holdings VALUES (?,?,2,150,?,?)',
  args: ['BBB', 'BBB Company', 'IRA', date],
});
await run();
assert.ok(analyzed().includes('BBB'));
`,
);

scenario(
  "an outage after a week away keeps the last quotes until a run has fresh ones",
  String.raw`
await holding('BBB');
await client.execute({
  sql: "INSERT INTO holdings VALUES ('CASH','Cash',100,NULL,'',?)",
  args: [date],
});
const nineDaysAgo = Math.floor(Date.now() / 1000) - 9 * 86400;
for (const ticker of ['AAA', 'BBB'])
  await client.execute({
    sql: "INSERT INTO fmp_cache VALUES (?,'quote',?,?)",
    args: [
      ticker,
      ago(9),
      JSON.stringify([
        { symbol: ticker, price: 100, changePercentage: 1, timestamp: nineDaysAgo },
      ]),
    ],
  });
await client.execute({
  sql: "INSERT INTO fmp_cache VALUES ('_SEC','retrying:x',?,'[]')",
  args: [ago(9)],
});
const oldRows = async () =>
  (
    await rows(
      "SELECT ticker FROM fmp_cache WHERE fetched_on < '" + ago(7) + "' ORDER BY ticker",
    )
  ).map((r) => r.ticker);
const { loadPortfolioFacts } = await load('portfolio.ts');
const working = globalThis.fetch;
globalThis.fetch = async () => {
  throw new TypeError('fetch failed');
};
assert.equal(await runResearch(), false);
globalThis.fetch = working;
assert.deepEqual(await oldRows(), ['AAA', 'BBB', '_SEC']);
const facts = await loadPortfolioFacts();
assert.equal(facts.total_value, 500);
assert.deepEqual(facts.missing_prices, []);
assert.deepEqual(facts.quote_dates.stale.sort(), ['AAA', 'BBB']);
await run();
assert.deepEqual(await oldRows(), ['_SEC']);
`,
);

scenario(
  "a broken thesis hold stays open after a quiet run and notifies with the ticker",
  String.raw`
script('analyst', { ...analysis('AAA'), status: 'thesis_broken', headline: 'The contract was cancelled.' });
await run();
let saved = JSON.parse((await last('briefs')).result_json);
assert.equal(saved.needs_attention[0].why, 'Thesis broken: The contract was cancelled.');
assert.equal(saved.nothing_to_do, false);
assert.match(notices[0], /^Needs attention: AAA\./);
await run();
saved = await loadBrief();
const open = openCalls(saved.queue, await latestUpdates(), saved.decisions, new Set(['AAA']));
assert.equal(open[0].result.status, 'thesis_broken');
assert.equal(open[0].result.action, 'hold');
`,
);

scenario(
  "a disputed hold stays open after a following quiet brief",
  String.raw`
script('verifier', { ...verification(), independent_action: 'trim' });
await run();
assert.ok((await loadBrief()).queue.some(item => item.ticker === 'AAA'));
await run();
const saved = await loadBrief();
assert.deepEqual(saved.queue, []);
const open = openCalls(saved.queue, await latestUpdates(), saved.decisions, new Set(['AAA']));
assert.equal(open[0]?.ticker, 'AAA');
assert.equal(open[0].verification.independent_action, 'trim');
`,
);

scenario(
  "restoring an omitted sell removes the all-clear and sends an attention notice",
  String.raw`
script('analyst', analysis('AAA', false, 'sell'));
await run();
const saved = JSON.parse((await last('briefs')).result_json);
assert.equal(saved.nothing_to_do, false);
assert.doesNotMatch(saved.summary, /Stable portfolio/);
assert.match(saved.summary, /AAA/);
assert.doesNotMatch(briefFile(), /Nothing needs attention today/);
assert.match(notices[0], /^Needs attention: AAA\./);
`,
);

scenario(
  "a failed brief names saved reviews and keeps the earlier brief",
  String.raw`
await holding('BBB');
await run();
const before = briefFile(), count = (await rows('SELECT * FROM briefs')).length;
const stub = globalThis.modelStub;
globalThis.modelStub = async (opts) => {
  if (opts.role === 'brief') throw new Error('Selected model is at capacity.');
  return stub(opts);
};
assert.equal(await runResearch(), false);
assert.equal((await last('research_runs')).status, 'failed');
const { latestRun } = await load('research/run.ts');
const latest = await latestRun();
assert.match(latest.message, /The brief was not written, but 2 reviews were saved/);
assert.doesNotMatch(latest.message, /Run failed:/);
assert.match(latest.logText, /Run failed: The brief was not written/);
assert.equal((await rows('SELECT * FROM ticker_updates')).length, 4);
assert.equal((await rows('SELECT * FROM briefs')).length, count);
assert.equal(briefFile(), before);
assert.equal(notices.length, 1);
assert.match(notices[0], /^Research run failed:/);
`,
);

scenario(
  "setup failures and all-holding failures notify while quiet and refused runs stay silent",
  String.raw`
await run();
assert.deepEqual(notices, []);
globalThis.setupIssues = ['Run codex login in a terminal.'];
assert.equal(await runResearch(), false);
assert.match(notices.pop(), /^Research run could not start: Run codex login/);
globalThis.setupIssues = [];
const stub = globalThis.modelStub;
globalThis.modelStub = async () => { throw new Error('Model unavailable'); };
assert.equal(await runResearch(), false);
assert.match(notices.pop(), /^Research run failed: No holding could be reviewed/);
globalThis.modelStub = stub;
const { claimRun } = await load('research/run.ts');
assert.ok(await claimRun('chatgpt'));
assert.equal(await runResearch(), false);
assert.deepEqual(notices, []);
`,
);

scenario(
  "newest logged decision reaches only the saved brief and never a model",
  String.raw`
for (const [id, action, day] of [[1, 'Declined', ago(1)], [2, 'Held', date], [3, 'Added', date]])
  await client.execute({ sql: 'INSERT INTO decisions VALUES (?,?,?,?,?,?)', args: [id, 'AAA', day, action, 'PRIVATE-DECISION-NOTE', new Date().toISOString()] });
script('analyst', analysis('AAA', false, 'add'));
await run();
const saved = JSON.parse((await last('briefs')).result_json);
assert.match(saved.suggested_actions[0].reasoning, new RegExp('Last logged: Added, ' + date + '\\.$'));
assert.equal(saved.suggested_actions[0].action, 'add');
assert.equal(pack().my_last_decision, undefined);
assert.doesNotMatch(JSON.stringify(calls), /Last logged:|PRIVATE-DECISION-NOTE|Declined|Added/);
assert.doesNotMatch(readFileSync(path.join('data/packs', date, 'ticker_results.json'), 'utf8'), /Last logged:|PRIVATE-DECISION-NOTE|Added/);
`,
);

scenario(
  "unmatched brief figures are saved and logged without removing the model text",
  String.raw`
script('brief', { ...brief(), portfolio_observations: ['Cash is $999.99.'] });
await run();
let saved = JSON.parse((await last('briefs')).result_json);
assert.deepEqual(saved.untraced_figures, ['$999.99']);
assert.deepEqual(saved.portfolio_observations, ['Cash is $999.99.']);
assert.match((await last('research_runs')).log_text, /Brief figures not found in its inputs: \$999\.99/);
assert.match(briefFile(), /Figures not traced to the brief inputs: \$999\.99/);
assert.deepEqual((await loadBrief()).brief.untraced_figures, ['$999.99']);
await run();
saved = JSON.parse((await last('briefs')).result_json);
assert.deepEqual(saved.untraced_figures, []);
assert.doesNotMatch(briefFile(), /Figures not traced/);
`,
);

scenario(
  "each final checker avoids the provider of the analysis it is checking",
  String.raw`
const stub = globalThis.modelStub;
let analysts = 0;
globalThis.modelStub = async (opts) => {
  const result = await stub(opts);
  if (opts.role === 'analyst') return { ...result, provider: ++analysts === 1 ? 'claude' : 'chatgpt' };
  return result;
};
script('verifier', verification('AAA', 'contradicted', false));
script('verifier', verification());
await run();
assert.deepEqual(calls.filter(c => c.role === 'verifier').map(c => c.avoidProvider), ['claude', 'chatgpt']);
`,
);

scenario(
  "break conditions saved during verification keep the full review due and the filing pending",
  String.raw`
await run();
await client.execute('UPDATE tickers SET last_full_review_at=NULL');
await client.execute('UPDATE filings SET processed_at=NULL');
const view = dossierSection(readDossier('AAA'), 'Current view');
const { dossiersRouter } = await load('api/routers/dossiers.ts');
const stub = globalThis.modelStub;
globalThis.modelStub = async (opts) => {
  if (opts.role === 'verifier')
    await dossiersRouter.createCaller({ db }).save({ ticker: 'AAA', markdown: replaceSection(readDossier('AAA'), 'What would break the thesis', 'The contract is cancelled.') });
  return stub(opts);
};
script('analyst', { ...analysis('AAA'), dossier_current_view: 'Judged old conditions' });
await run();
assert.equal(await clock(), null);
assert.equal(await pending(), null);
assert.equal(dossierSection(readDossier('AAA'), 'Current view'), view);
assert.equal(dossierSection(readDossier('AAA'), 'What would break the thesis'), 'The contract is cancelled.');
assert.match((await last('research_runs')).log_text, /the thesis or its break conditions changed/);
`,
);

scenario(
  "research arguments normalize share-class punctuation before selecting holdings",
  String.raw`
await client.execute("UPDATE holdings SET ticker='BRK-B' WHERE ticker='AAA'");
const args = process.argv, exit = process.exit;
let code;
try {
  process.argv = [process.execPath, path.join(root, 'scripts/research.ts'), ' brk.b ', 'brk/b'];
  process.exit = (value) => { code = value; };
  await import(pathToFileURL(path.join(root, 'scripts/research.ts')).href);
} finally { process.argv = args; process.exit = exit; }
assert.equal(code, 0);
assert.equal((await update()).ticker, 'BRK-B');
assert.match((await last('research_runs')).log_text, /Reviewing only: BRK-B\./);
assert.equal(roleCount('analyst'), 1);
`,
);

scenario(
  "held cash is named as cash and never reviewed",
  String.raw`
await holding('CASH');
assert.equal(await runResearch(['CASH']), false);
assert.equal(requests.length, 0);
assert.equal(calls.length, 0);
assert.match((await last('research_runs')).log_text, /CASH is cash/);
assert.doesNotMatch((await last('research_runs')).log_text, /CASH not in your holdings/);
await run(['AAA', 'CASH', 'ZZZ']);
assert.match((await last('research_runs')).log_text, /CASH is cash/);
assert.match((await last('research_runs')).log_text, /Not in your holdings, so not reviewed: ZZZ\./);
assert.equal((await update()).ticker, 'AAA');
assert.equal(roleCount('analyst'), 1);
`,
);

scenario(
  "a filing after the last full review stays pending across a long review gap",
  String.raw`
await run();
await client.execute({ sql: "UPDATE tickers SET last_full_review_at=? WHERE ticker='AAA'", args: [ago(70) + 'T12:00:00Z'] });
const vendor = globalThis.fetch;
globalThis.fetch = async (input) => {
  if (String(input).includes('/000000000126000002/')) {
    requests.push(String(input));
    return new Response('<p>Item 5.02. An officer resigned.</p>');
  }
  const response = await vendor(input);
  if (String(input) !== 'https://data.sec.gov/submissions/CIK0000000001.json') return response;
  const data = await response.json();
  const recent = data.filings.recent;
  recent.accessionNumber.push('0000000001-26-000002');
  recent.filingDate.push(ago(45));
  recent.form.push('8-K');
  recent.primaryDocument.push('cover.htm');
  recent.items.push('5.02');
  return new Response(JSON.stringify(data));
};
script('verifier', verification('AAA', 'unverified', false));
script('verifier', verification('AAA', 'unverified', false));
await run();
const delayed = (await rows("SELECT * FROM filings WHERE accession_no='0000000001-26-000002'"))[0];
assert.equal(delayed.processed_at, null);
assert.match((await last('research_runs')).log_text, /new filings: 8-K/);
assert.equal((await update()).review_depth, 'FULL');
// The pack-only command uses the same review clock without consuming the filing.
await client.execute("DELETE FROM filings WHERE accession_no='0000000001-26-000002'");
const args = process.argv, exit = process.exit;
let code;
try {
  process.argv = [process.execPath, path.join(root, 'scripts/pack-ticker.ts'), 'AAA'];
  process.exit = (value) => { code = value; };
  await import(pathToFileURL(path.join(root, 'scripts/pack-ticker.ts')).href);
} finally { process.argv = args; process.exit = exit; }
assert.equal(code, 0);
assert.equal((await rows("SELECT processed_at FROM filings WHERE accession_no='0000000001-26-000002'"))[0].processed_at, null);
`,
);

scenario(
  "an SEC lookup failure skips only unknown stocks and preserves prices and earnings",
  String.raw`
await holding('BBB');
const vendor = globalThis.fetch;
let secDown = true;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (secDown && url.href === 'https://www.sec.gov/files/company_tickers.json') {
    requests.push(url.href);
    return new Response('Unavailable', { status: 403 });
  }
  const response = await vendor(input);
  if (url.pathname === '/stable/earnings') return new Response(JSON.stringify([{ date: ago(-5), epsActual: null }]));
  return response;
};
// A previously resolved CIK remains usable even if today's company-list request fails.
await client.execute("INSERT INTO tickers (ticker,cik,sector) VALUES ('AAA','1','Technology')");
await run();
let saved = JSON.parse((await last('briefs')).result_json);
assert.deepEqual(saved.failed.map(f => f.ticker), ['BBB']);
assert.match(saved.failed[0].reason, /Setup failed: SEC returned 403/);
assert.doesNotMatch((await last('research_runs')).log_text, /BBB: not in SEC/);
assert.deepEqual((await rows('SELECT ticker FROM ticker_updates')).map(r => r.ticker), ['AAA']);
let facts = JSON.parse(readFileSync(path.join('data/packs', date, 'portfolio_facts.json'), 'utf8'));
assert.equal(facts.total_value, 400);
assert.equal(pack().my_position.weight_pct, 50);
assert.deepEqual(facts.missing_prices, []);
assert.ok(facts.upcoming_earnings.some(e => e.ticker === 'BBB'));
secDown = false;
await run();
saved = JSON.parse((await last('briefs')).result_json);
assert.deepEqual(saved.failed, []);
assert.ok((await rows('SELECT ticker FROM ticker_updates')).some(r => r.ticker === 'BBB'));
`,
);

scenario(
  "funds without a CIK keep their look-through sectors when the SEC list is unavailable",
  String.raw`
await holding('BBB');
const vendor = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.href === 'https://www.sec.gov/files/company_tickers.json') {
    requests.push(url.href);
    return new Response('Unavailable', { status: 403 });
  }
  if (url.pathname === '/stable/profile' && url.searchParams.get('symbol') === 'BBB')
    return new Response(JSON.stringify([{ symbol: 'BBB', companyName: 'BBB Fund', sector: 'Financial Services', isEtf: true }]));
  if (url.pathname.startsWith('/stable/etf/')) {
    requests.push(url.href);
    const data = url.pathname.endsWith('/sector-weightings') ? [{ sector: 'Healthcare', weightPercentage: '100%' }] : [];
    return new Response(JSON.stringify(data));
  }
  return vendor(input);
};
await client.execute("INSERT INTO tickers (ticker,cik,sector) VALUES ('AAA','1','Technology')");
await run();
const saved = JSON.parse((await last('briefs')).result_json);
assert.deepEqual(saved.failed, []);
assert.deepEqual((await rows('SELECT ticker FROM ticker_updates ORDER BY ticker')).map(r => r.ticker), ['AAA', 'BBB']);
const facts = JSON.parse(readFileSync(path.join('data/packs', date, 'portfolio_facts.json'), 'utf8'));
assert.equal(facts.total_value, 400);
assert.equal(facts.sector_weights.find(s => s.sector === 'Healthcare').weight_pct, 50);
assert.ok(!facts.sector_weights.some(s => s.sector === 'Financial Services'));
`,
);

scenario(
  "a whitespace brief fails without replacing the good brief or hiding saved calls",
  String.raw`
await run();
const before = briefFile(), count = (await rows('SELECT * FROM briefs')).length;
script('analyst', analysis('AAA', true, 'add'));
script('brief', { ...brief(), summary: '   \t\n ' });
assert.equal(await runResearch(), false);
assert.equal((await last('research_runs')).status, 'failed');
assert.equal((await rows('SELECT * FROM briefs')).length, count);
assert.equal(briefFile(), before);
const saved = await loadBrief();
const open = openCalls(saved.queue, await latestUpdates(), saved.decisions, new Set(['AAA']));
assert.equal(open[0]?.result.action, 'add');
assert.equal((await rows('SELECT * FROM ticker_updates')).length, 2);
`,
);

scenario(
  "omitted disputed holds are saved as review suggestions without changing their scores",
  String.raw`
script('verifier', { ...verification(), independent_action: 'add', independent_reason: 'Small position at a supported price.' });
await run();
const saved = JSON.parse((await last('briefs')).result_json);
assert.equal(saved.suggested_actions[0].action, 'review');
assert.equal(saved.suggested_actions[0].models_agree, false);
assert.equal(saved.suggested_actions[0].verified_score, (await update()).verified_score);
assert.equal((await loadBrief()).queue[0].action, 'review');
assert.match(briefFile(), /1 of 1/);
`,
);

scenario(
  "review metadata records fund status and link provenance only when saving",
  String.raw`
await holding('BBB');
const vendor = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname === '/stable/profile' && url.searchParams.get('symbol') === 'BBB')
    return new Response(JSON.stringify([{ symbol: 'BBB', companyName: 'BBB Fund', isEtf: true }]));
  if (url.pathname.startsWith('/stable/etf/')) return new Response('[]');
  return vendor(input);
};
const known = 'https://example.com/known', absent = 'https://example.com/mistyped';
script('research', { findings: [{ claim: 'Known news', url: known, publisher: 'Publisher', date, why_it_matters: 'Context' }] }, 'BBB');
const reviewed = analysis('BBB');
reviewed.evidence = [
  { claim: 'Known news', source: 'news:' + known, date },
  { claim: 'Other news', source: 'news:' + absent, date },
];
script('analyst', reviewed, 'BBB');
await run();
const saved = await latestUpdates();
const stock = saved.get('AAA').result, fund = saved.get('BBB').result;
assert.equal(stock.is_fund, false);
assert.equal(fund.is_fund, true);
assert.deepEqual(fund.evidence.map(e => e.link_not_in_files), [undefined, true]);
const score = saved.get('BBB').verifiedScore;
assert.equal(score, 0.3333);
assert.equal(calls.find(c => c.role === 'verifier' && c.workingDirectory.endsWith('BBB')).files['review.json'].includes('link_not_in_files'), false);
assert.equal(readFileSync(path.join('data/packs', date, 'ticker_results.json'), 'utf8').includes('is_fund'), false);
await run();
assert.equal((await latestUpdates()).get('BBB').result.is_fund, true);
const latest = await last('ticker_updates');
const old = JSON.parse(latest.result_json);
delete old.is_fund;
old.evidence = old.evidence.map(({ link_not_in_files, ...e }) => e);
await client.execute({ sql: 'UPDATE ticker_updates SET result_json=? WHERE id=?', args: [JSON.stringify(old), latest.id] });
const { tickerHistory } = await load('updates.ts');
const loaded = (await tickerHistory(latest.ticker))[0].result;
assert.equal(loaded.is_fund, undefined);
assert.ok(loaded.evidence.every(e => e.link_not_in_files === undefined));
`,
);

scenario(
  "saved source warnings use both research files and survive later pack replacement",
  String.raw`
const packLink = 'https://example.com/vendor-news';
const webLink = 'https://example.com/web-news';
const absent = 'https://example.com/mistyped';
const vendor = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname === '/stable/news/stock')
    return new Response(JSON.stringify([{ title: 'Vendor news', url: packLink, publishedDate: date }]));
  return vendor(input);
};
script('research', { findings: [{ claim: 'Web news', url: webLink, publisher: 'Publisher', date, why_it_matters: 'Context' }] });
const reviewed = analysis('AAA');
reviewed.evidence = [packLink, webLink, absent].map((url, i) => ({ claim: 'News claim ' + i, source: 'news:' + url, date }));
script('analyst', reviewed);
await run();
const saved = (await latestUpdates()).get('AAA');
assert.deepEqual(saved.result.evidence.map(e => e.link_not_in_files), [undefined, undefined, true]);
assert.equal(saved.verifiedScore, 0.25);
assert.equal(calls.find(c => c.role === 'verifier').files['review.json'].includes('link_not_in_files'), false);
assert.equal(readFileSync(path.join('data/packs', date, 'ticker_results.json'), 'utf8').includes('link_not_in_files'), false);
writeFileSync(path.join(packDir('AAA'), 'pack.json'), JSON.stringify({ news: [{ url: absent }] }));
writeFileSync(path.join(packDir('AAA'), 'web_research.md'), 'Replacement research');
assert.deepEqual((await latestUpdates()).get('AAA').result.evidence.map(e => e.link_not_in_files), [undefined, undefined, true]);
`,
);

scenario(
  "a missing FMP key stops the run at setup, with no model call",
  String.raw`
assert.equal(await runResearch(), false);
const run = await last('research_runs');
assert.equal(run.status, 'failed_setup');
assert.match(run.log_text, /Add FMP_API_KEY to \.env\./);
assert.equal(calls.length, 0);
assert.equal(requests.length, 0);
`,
  { FMP_API_KEY: "" },
);

scenario(
  "a missing SEC contact stops the run at setup, with no model call",
  String.raw`
assert.equal(await runResearch(), false);
const run = await last('research_runs');
assert.equal(run.status, 'failed_setup');
assert.match(run.log_text, /Add SEC_USER_AGENT to \.env\./);
assert.equal(calls.length, 0);
`,
  { SEC_USER_AGENT: "" },
);

scenario(
  "portfolio facts see through funds and list upcoming earnings",
  String.raw`
await holding('BBB');
funds.add('BBB');
earningsRows.set('AAA', [{ date: ago(-5), epsActual: null, epsEstimated: 2 }]);
await run();
const facts = JSON.parse(readFileSync(path.join('data/packs', date, 'portfolio_facts.json'), 'utf8'));
assert.ok(facts.sector_weights.some((s) => s.sector === 'Energy'), JSON.stringify(facts.sector_weights));
assert.deepEqual(facts.upcoming_earnings.map((e) => e.ticker), ['AAA']);
`,
);

scenario(
  "nothing reviewable fails the run and writes no brief",
  String.raw`
noQuote.add('AAA');
assert.equal(await runResearch(), false);
const run = await last('research_runs');
assert.equal(run.status, 'failed');
assert.match(run.log_text, /No holding could be reviewed\. AAA: No market data/);
assert.equal(roleCount('brief'), 0);
assert.equal((await rows('SELECT * FROM briefs')).length, 0);
`,
);

scenario(
  "no notice when nothing needs attention",
  String.raw`
await run();
assert.equal(notices.length, 0);
`,
);

scenario(
  "the market move is only quoted against the same trading day",
  String.raw`
spyLagDays = 1;
await setQuote('AAA', { changePercentage: 6, timestamp: Date.parse(date + 'T17:00:00Z') / 1000 });
await run();
assert.match(calls.find((c) => c.role === 'research').prompt, /no S&P 500 figure for that day/);
`,
);

scenario(
  "an analyst with no evidence fails the ticker and saves nothing",
  String.raw`
script('analyst', { ...analysis('AAA'), evidence: [] });
assert.equal(await runResearch(), false);
assert.match((await last('research_runs')).log_text, /returned no evidence/);
assert.equal((await rows('SELECT * FROM ticker_updates')).length, 0);
assert.equal(roleCount('verifier'), 0);
`,
);

scenario(
  "a checker with no checks fails the ticker and saves nothing",
  String.raw`
script('verifier', { ...verification(), checks: [] });
assert.equal(await runResearch(), false);
assert.match((await last('research_runs')).log_text, /returned no checks/);
assert.equal((await rows('SELECT * FROM ticker_updates')).length, 0);
`,
);

scenario(
  "a revision with no evidence or no checks fails too, and the first review is not saved",
  String.raw`
script('verifier', verification('AAA', 'contradicted', true));
script('analyst', analysis('AAA'));
script('analyst', { ...analysis('AAA'), evidence: [] });
assert.equal(await runResearch(), false);
assert.match((await last('research_runs')).log_text, /returned no evidence/);
assert.equal((await rows('SELECT * FROM ticker_updates')).length, 0);
assert.equal(roleCount('verifier'), 1, 'an empty revision is not sent to the checker');
`,
);

scenario(
  "a second check with no checks fails the ticker",
  String.raw`
script('verifier', verification('AAA', 'contradicted', true));
script('analyst', analysis('AAA'));
script('analyst', analysis('AAA'));
script('verifier', { ...verification(), checks: [] });
assert.equal(await runResearch(), false);
assert.match((await last('research_runs')).log_text, /returned no checks/);
assert.equal((await rows('SELECT * FROM ticker_updates')).length, 0);
`,
);

scenario(
  "a quote object with no usable price never reaches the analyst",
  String.raw`
const vendor = globalThis.fetch;
globalThis.fetch = async (input) => new URL(String(input)).pathname === '/stable/quote'
  ? Response.json([{symbol:'AAA',price:null}]) : vendor(input);
assert.equal(await runResearch(), false);
assert.equal(roleCount('analyst'), 0);
assert.equal((await rows('SELECT * FROM ticker_updates')).length, 0);
assert.match((await last('research_runs')).log_text, /No market data/);
`,
);

scenario(
  "a claim the checker skipped counts against the stored score",
  String.raw`
script('analyst', { ...analysis('AAA'), evidence: [{ claim: 'Price is 100', source: 'fmp:quote', date }, { claim: 'Margin rose sharply', source: 'fmp:income', date }] });
script('verifier', verification());
await run();
assert.equal((await update()).verified_score, 0.5);
`,
);

scenario(
  "a Form 4 is finished even when the review was rejected, the 8-K stays pending, and a handled filing leaves no retry marker",
  String.raw`
await run();
assert.equal((await rows("SELECT * FROM fmp_cache WHERE endpoint LIKE 'retrying:%'")).length, 0, 'a filing the review dealt with starts no retry clock');
await client.execute('UPDATE filings SET processed_at=NULL');
await client.execute({ sql: "INSERT INTO filings (accession_no, ticker, form, filed_at, primary_doc_url) VALUES ('form4-1', 'AAA', '4', ?, 'https://www.sec.gov/x')", args: [date] });
script('verifier', verification('AAA', 'verified', false));
script('analyst', analysis('AAA'));
script('verifier', verification('AAA', 'verified', false));
await run();
const processed = await rows('SELECT form, processed_at FROM filings ORDER BY form');
assert.equal(processed.find((f) => f.form === '4').processed_at !== null, true, 'Form 4 done');
assert.equal(processed.find((f) => f.form === '8-K').processed_at, null, '8-K pending');
`,
);
scenario(
  "a provider setup problem stops before any vendor or model call",
  String.raw`
globalThis.setupIssues = ['Codex needs to sign in.'];
assert.equal(await runResearch(), false);
assert.equal((await last('research_runs')).status, 'failed_setup');
assert.match((await last('research_runs')).log_text, /Codex needs to sign in/);
assert.equal(calls.length, 0);
assert.equal(requests.length, 0);
`,
);
scenario(
  "an attention call sends one stubbed notice with the saved summary",
  String.raw`
const summary = 'Attention: $(plain text) "quoted" summary';
script('brief', { ...brief(), summary, nothing_to_do: false, needs_attention: [{ ticker: 'AAA', why: 'Review the holding.' }] });
await run();
assert.equal(JSON.parse((await last('briefs')).result_json).summary, summary);
assert.equal(notices.length, 1);
assert.ok(notices[0].includes(summary), notices[0]);
`,
);

scenario(
  "a fund's already-current future weight condition gets the one revision",
  String.raw`
funds.add('AAA');
await client.execute({sql:"INSERT INTO holdings VALUES ('CASH','Cash',3800,NULL,'',?)",args:[date]});
script('analyst',{...analysis('AAA'),would_change_my_mind:['The portfolio weight rises above 5%.'],dossier_current_view:'Unusable boundary at portfolio weight above 5%.'});
script('analyst',{...analysis('AAA'),would_change_my_mind:['The portfolio weight rises above 6%, a proposed review level.'],dossier_current_view:'A proposed future portfolio weight above 6% would reopen the allocation review.'});
await run();
assert.equal(roleCount('analyst'),2);
assert.equal(roleCount('verifier'),2);
assert.equal((await update()).revised_after_review,1);
assert.equal(JSON.parse((await update()).result_json).condition_warnings,undefined);
assert.match(readDossier('AAA'),/above 6%/);
assert.doesNotMatch(readDossier('AAA'),/Unusable boundary/);
`,
);

scenario(
  "a repeated invalid fund boundary stays visibly flagged and cannot overwrite the dossier",
  String.raw`
funds.add('AAA');
await client.execute({sql:"INSERT INTO holdings VALUES ('CASH','Cash',3800,NULL,'',?)",args:[date]});
for(let i=0;i<2;i++)script('analyst',{...analysis('AAA'),would_change_my_mind:['The portfolio weight rises above 5%.'],dossier_current_view:'Unusable boundary at portfolio weight above 5%.'});
await run();
assert.equal(roleCount('analyst'),2);
assert.equal(roleCount('verifier'),2);
assert.equal(JSON.parse((await update()).result_json).condition_warnings.length,1);
assert.doesNotMatch(readDossier('AAA'),/Unusable boundary/);
`,
);

scenario(
  "run usage keeps total input and cached categories from every model role",
  String.raw`
const original = globalThis.modelStub;
globalThis.modelStub=async(opts)=>{opts.onUsage?.({inputTokens:157,uncachedInputTokens:17,cacheReadInputTokens:100,cacheCreationInputTokens:40,outputTokens:11,webSearches:0});return original(opts);};
await run();
const usage=JSON.parse((await last('research_runs')).usage_json);
assert.equal(usage.inputTokens,628);
assert.equal(usage.uncachedInputTokens,68);
assert.equal(usage.cacheReadInputTokens,400);
assert.equal(usage.cacheCreationInputTokens,160);
assert.equal(usage.outputTokens,44);
`,
);
