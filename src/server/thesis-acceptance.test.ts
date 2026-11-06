import "./test-env.ts";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { viewWithUnconfirmed } from "./dossier.ts";

function inChild(script: string) {
  const temp = mkdtempSync(path.join(tmpdir(), "portchecker-thesis-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-test-module-mocks",
        "--input-type=module",
        "-e",
        `${script}\nprocess.stdout.write('checks-complete');`,
      ],
      {
        cwd: temp,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          DATABASE_PATH: ":memory:",
          ANTHROPIC_API_KEY: "fake-env-key",
          OPENAI_API_KEY: "",
          FMP_API_KEY: "fake-fmp-key",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "checks-complete");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

void test("accepting a thesis replaces template hints, keeps owner notes, and refuses an empty thesis", () => {
  inChild(String.raw`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { registerHooks } from 'node:module';
    import { pathToFileURL } from 'node:url';
    import { mock } from 'node:test';
    const unexpected = () => { throw new Error('Unexpected provider or network call'); };
    globalThis.fetch = unexpected;
    mock.module('node:child_process', { namedExports: { exec: unexpected, spawn: unexpected } });
    const source = ${JSON.stringify(path.resolve(import.meta.dirname, ".."))};
    registerHooks({ resolve(specifier, context, next) {
      if (!specifier.startsWith('~/')) return next(specifier, context);
      const base = path.join(source, specifier.slice(2));
      const file = [base + '.ts', base + '.js', path.join(base, 'index.ts')].find(fs.existsSync);
      assert.ok(file, specifier);
      return next(pathToFileURL(file).href, context);
    } });
    const fullReviews = [];
    mock.module(${JSON.stringify(new URL("./research/pack.ts", import.meta.url).href)}, { namedExports: {
      buildResearchContext: unexpected,
      requestFullReview: async (ticker) => fullReviews.push(ticker),
    } });
    mock.module(${JSON.stringify(new URL("./model.ts", import.meta.url).href)}, { namedExports: {
      runModel: unexpected,
      errorMessage: (error) => String(error),
    } });
    const { ensureDossier, readDossier, dossierSection, replaceSection, saveDossier } = await import(${JSON.stringify(new URL("./dossier.ts", import.meta.url).href)});
    const { tickersRouter } = await import(${JSON.stringify(new URL("./api/routers/tickers.ts", import.meta.url).href)});
    const caller = tickersRouter.createCaller({});
    ensureDossier('AAA', 'Example');
    const before = readDossier('AAA');
    const input = { ticker: 'AAA', thesis: 'Own it', breakConditions: 'Revenue below 900', numbersToWatch: 'Revenue 1000' };
    for (const thesis of ['', '  \n\t']) {
      await assert.rejects(caller.acceptThesis({ ...input, thesis }), /thesis is empty/);
      assert.equal(readDossier('AAA'), before, 'an empty thesis cannot alter the dossier');
      assert.deepEqual(fullReviews, [], 'an empty thesis cannot request a review');
    }
    await caller.acceptThesis(input);
    const accepted = readDossier('AAA');
    assert.equal(dossierSection(accepted, 'Thesis'), 'Own it');
    assert.equal(dossierSection(accepted, 'What would break the thesis'), input.breakConditions);
    assert.equal(dossierSection(accepted, 'Key numbers to watch'), input.numbersToWatch);
    assert.equal(dossierSection(accepted, 'Current view'), dossierSection(before, 'Current view'));
    assert.deepEqual(fullReviews, ['AAA']);
    await assert.rejects(caller.acceptThesis({ ...input, thesis: 'Replace it' }), /not replaced/);
    assert.equal(readDossier('AAA'), accepted);
    assert.deepEqual(fullReviews, ['AAA']);

    ensureDossier('BBB', 'Example with notes');
    let mine = readDossier('BBB');
    mine = replaceSection(mine, 'What would break the thesis', 'Owner break condition');
    mine = replaceSection(mine, 'Key numbers to watch', 'Owner metric');
    saveDossier('BBB', mine);
    await caller.acceptThesis({ ...input, ticker: 'BBB' });
    assert.equal(dossierSection(readDossier('BBB'), 'What would break the thesis'), 'Owner break condition\n\n' + input.breakConditions);
    assert.equal(dossierSection(readDossier('BBB'), 'Key numbers to watch'), 'Owner metric\n\n' + input.numbersToWatch);
    assert.deepEqual(fullReviews, ['AAA', 'BBB']);
  `);
});

void test("only unverified claims sit beside the view, without relabeling contradictions", () => {
  const checked = [
    { claim: "Margin fell", verdict: "contradicted" },
    { claim: "Revenue rose", verdict: "verified" },
  ];
  assert.equal(viewWithUnconfirmed("The view", checked), "The view");
  assert.equal(
    viewWithUnconfirmed("The view", [
      ...checked,
      { claim: "Backlog grew", verdict: "unverified" },
    ]),
    "The view\n\nThe second check could not confirm:\n\n- Backlog grew",
  );
});

void test("a saved Claude key wins over the environment, and the mode label follows the selected mode", () => {
  inChild(String.raw`
    import assert from 'node:assert/strict';
    const { claudeApiKey, modeLabel } = await import(${JSON.stringify(new URL("./settings.ts", import.meta.url).href)});
    assert.equal(claudeApiKey({ anthropic_api_key: 'fake-saved-key' }), 'fake-saved-key');
    assert.equal(claudeApiKey({ anthropic_api_key: '' }), 'fake-env-key');
    assert.equal(modeLabel({ provider_mode: 'claude', analyst_provider: 'chatgpt' }), 'Claude');
    assert.equal(modeLabel({ provider_mode: 'chatgpt', analyst_provider: 'claude' }), 'ChatGPT');
    assert.match(modeLabel({ provider_mode: 'both', analyst_provider: 'claude' }), /^Claude.*checked by ChatGPT$/);
    assert.match(modeLabel({ provider_mode: 'both', analyst_provider: 'chatgpt' }), /^ChatGPT.*checked by Claude$/);
  `);
});
