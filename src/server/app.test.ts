import "./test-env.ts";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

void test("app server contracts use isolated storage", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "portchecker-app-test-"));
  const root = path.resolve(import.meta.dirname, "../..");
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import assert from 'node:assert/strict';
      import { registerHooks, syncBuiltinESMExports } from 'node:module';
      import childProcess from 'node:child_process';
      import { EventEmitter } from 'node:events';
      import { pathToFileURL } from 'node:url';
      import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, fstatSync } from 'node:fs';
      import path from 'node:path';
      const root = ${JSON.stringify(root)};
      registerHooks({ resolve(specifier, context, next) {
        if (specifier.startsWith('~/')) {
          const base = path.join(root, 'src', specifier.slice(2));
          const file = [base + '.ts', base + '.js', path.join(base, 'index.ts')].find(existsSync);
          return next(pathToFileURL(file).href, context);
        }
        return next(specifier, context);
      }});
      const load = name => import(pathToFileURL(path.join(root, 'src/server', name)).href);
      const { buildQueue } = await load('queue.ts');
      const brief = { date: '2026-11-04', needs_attention: [{ticker:'AAA', why:'review'}], suggested_actions: [] };
      const decision = {ticker:'AAA', date:brief.date, actionTaken:'hold', note:'', createdAt:'2026-11-04T09:00:00.000Z'};
      assert.equal(buildQueue(brief, [decision], '2026-11-04T15:00:00.000Z')[0].decision, null);
      assert.ok(buildQueue(brief, [decision], decision.createdAt)[0].decision);
      assert.ok(buildQueue(brief, [{...decision, createdAt:null}], '2026-11-04T15:00:00.000Z')[0].decision);
      assert.ok(buildQueue(brief, [decision], null)[0].decision);
      const { db, client } = await load('db/index.ts');
      await client.executeMultiple(\`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE decisions (id INTEGER PRIMARY KEY, ticker TEXT, date TEXT, action_taken TEXT, note TEXT, created_at TEXT);
        CREATE TABLE research_runs (id INTEGER PRIMARY KEY, heartbeat_at TEXT, started_at TEXT, finished_at TEXT, status TEXT, provider_mode TEXT, usage_json TEXT, log_text TEXT, brief_id INTEGER);
        CREATE TABLE briefs (id INTEGER PRIMARY KEY, run_id INTEGER, date TEXT, provider TEXT, model TEXT, result_json TEXT, markdown TEXT);
        CREATE TABLE holdings (ticker TEXT, name TEXT, quantity REAL, cost_basis REAL, account_label TEXT, updated_at TEXT);
      \`);
      const { listedActions, reviewNewerThanBrief, loadBrief } = await load('updates.ts');
      const updates = new Map([['AAA', {runId:3, result:{action:'sell'}}]]);
      const queue = [{ticker:'AAA', action:'review'}, {ticker:'BBB', action:'add'}];
      assert.equal(listedActions(queue, updates, 2).get('AAA'), 'sell');
      assert.equal(listedActions(queue, updates, 3).get('AAA'), 'review');
      assert.equal(listedActions(queue, updates, null).get('AAA'), 'sell');
      assert.equal(listedActions(queue, updates, 2).get('BBB'), 'add');
      assert.equal(reviewNewerThanBrief({runId:3}, null), true);
      assert.equal(reviewNewerThanBrief({runId:3}, 3), false);
      assert.equal((await loadBrief()).runId, null);
      await client.execute("INSERT INTO research_runs (id,started_at,finished_at,status,provider_mode) VALUES (2,'2026-11-04T12:00:00.000Z','2026-11-04T15:00:00.000Z','finished','chatgpt')");
      await client.execute({sql:'INSERT INTO briefs VALUES (1,2,?,?,?,?,?)', args:[brief.date,'chatgpt','test',JSON.stringify(brief),'brief']});
      assert.equal((await loadBrief()).briefReadyAt, '2026-11-04T15:00:00.000Z');
      await client.execute('UPDATE research_runs SET finished_at = NULL WHERE id = 2');
      assert.equal((await loadBrief()).briefReadyAt, '2026-11-04T12:00:00.000Z');
      const { tickersRouter } = await load('api/routers/tickers.ts');
      await tickersRouter.createCaller({db}).addDecision({ticker:'AAA', actionTaken:'hold'});
      const savedDecision = (await client.execute('SELECT created_at FROM decisions')).rows[0];
      assert.match(savedDecision.created_at, /^\\d{4}-\\d{2}-\\d{2}T/);
      const { dossiersRouter } = await load('api/routers/dossiers.ts');
      const dossiers = dossiersRouter.createCaller({db});
      await dossiers.save({ticker:'AAA', markdown:'original'});
      const original = await dossiers.get({ticker:'AAA'});
      assert.match(original.hash, /^[a-f0-9]{64}$/);
      await dossiers.save({ticker:'AAA', markdown:'new review'});
      await assert.rejects(dossiers.save({ticker:'AAA', markdown:'stale', expectedHash:original.hash}), e => e.code === 'CONFLICT');
      assert.equal((await dossiers.get({ticker:'AAA'})).markdown, 'new review');
      const { holdingsRouter } = await load('api/routers/holdings.ts');
      const holdings = holdingsRouter.createCaller({db});
      const csv = 'Symbol,Description,Quantity,Price,Market Value,Cost Basis\\nAAA,Example,2,10,20,15';
      mkdirSync('data/imports', {recursive:true});
      writeFileSync('data/imports/positions.csv', 'previous');
      await holdings.import({csv, fileName:'../positions.csv'});
      assert.equal(readFileSync('data/imports/positions.csv', 'utf8'), 'previous');
      assert.equal(readdirSync('data/imports').length, 2);
      await holdings.import({csv, fileName:'positions.csv'});
      assert.equal(readdirSync('data/imports').length, 2);
      renameSync('data/imports', 'data/saved-imports');
      writeFileSync('data/imports', 'blocks archival');
      const before = await client.execute('SELECT * FROM holdings');
      await assert.rejects(holdings.import({csv:csv.replace('AAA,Example,2', 'AAA,Example,7'), fileName:'fail.csv'}));
      assert.deepEqual((await client.execute('SELECT * FROM holdings')).rows, before.rows);
      let spawns = 0;
      let descriptor;
      let child;
      childProcess.spawn = (_command, _args, options) => {
        spawns++;
        writeFileSync('data/last-run.log', 'first child log');
        descriptor = options.stdio[1];
        child = new EventEmitter();
        child.unref = () => {};
        return child;
      };
      syncBuiltinESMExports();
      const { runsRouter } = await load('api/routers/runs.ts');
      const runs = runsRouter.createCaller({db});
      assert.equal(await runs.launchProblem(), null);
      writeFileSync('data/last-run.log', '  failure sk-ant-api03-' + 'x'.repeat(60) + '  ');
      const problem = await runs.launchProblem();
      assert.ok(!problem.includes('x'.repeat(60)));
      writeFileSync('data/last-run.log', 'a'.repeat(3000));
      assert.equal((await runs.launchProblem()).length, 2000);
      const [first, second] = await Promise.all([runs.start(), runs.start()]);
      assert.equal(first.started, true);
      assert.equal(second.started, false);
      assert.equal(spawns, 1);
      assert.equal(readFileSync('data/last-run.log', 'utf8'), 'first child log');
      assert.throws(() => fstatSync(descriptor), e => e.code === 'EBADF');
      child.emit('error', new Error('synthetic spawn failure'));
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.match(await runs.launchProblem(), /synthetic spawn failure/);
      client.close();
    `,
      ],
      {
        cwd: temp,
        env: {
          ...process.env,
          DATABASE_PATH: path.join(temp, "test.db"),
          NODE_ENV: "test",
        },
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
