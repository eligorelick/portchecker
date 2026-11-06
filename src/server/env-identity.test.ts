import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function secIdentity(value: string) {
  const result = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--input-type=module",
      "-e",
      `import { env } from ${JSON.stringify(new URL("../env.js", import.meta.url).href)};
       console.log(JSON.stringify(env.SEC_USER_AGENT ?? null));`,
    ],
    {
      env: {
        ...process.env,
        DATABASE_PATH: ":memory:",
        SEC_USER_AGENT: value,
        SKIP_ENV_VALIDATION: "",
      },
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()) as string | null;
}

void test("a sample SEC email cannot count as a configured identity", () => {
  assert.equal(secIdentity("Your Name you@example.com"), null);
  assert.equal(secIdentity("Your Name YOU@EXAMPLE.COM"), null);
});

void test("a non-placeholder contact and existing non-email test identities stay configured", () => {
  assert.equal(
    secIdentity("Test User contact@fixture.test"),
    "Test User contact@fixture.test",
  );
  assert.equal(
    secIdentity("Portchecker test contact"),
    "Portchecker test contact",
  );
  assert.equal(secIdentity("test"), "test");
});

void test("a blank SEC identity stays unconfigured", () => {
  assert.equal(secIdentity(""), null);
});
