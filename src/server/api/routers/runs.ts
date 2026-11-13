import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import path from "node:path";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { runProgress } from "~/server/queue";
import { activeRun, latestRun } from "~/server/research/run";
import { env } from "~/env";
import { errorMessage } from "~/server/model";
import { claudeApiKey, getSettings } from "~/server/settings";

let launchGuardUntil = 0;
const launchLog = path.join("data", "last-run.log");

export const runFailures = (message: string) =>
  Number(/(\d+) failed or skipped/.exec(message)?.[1] ?? 0);

async function safeLaunchText(text: string) {
  const settings = await getSettings();
  for (const key of [
    claudeApiKey(settings),
    env.FMP_API_KEY,
    env.ANTHROPIC_API_KEY,
  ]) {
    if (key) text = text.replaceAll(key, "[key]");
  }
  return errorMessage(new Error(text))
    .replace(/\bsk-[\w-]+/gi, "[key]")
    .replace(/(bearer\s+)\S+/gi, "$1[key]")
    .replace(
      /((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s&"']+/gi,
      "$1[key]",
    );
}

export const runsRouter = createTRPCRouter({
  // Spawns the same script the scheduler runs, then returns right away.
  start: publicProcedure.mutation(async () => {
    if (Date.now() < launchGuardUntil) return { started: false };
    launchGuardUntil = Date.now() + 5000;
    if (await activeRun()) return { started: false };
    mkdirSync("data", { recursive: true });
    // Output goes to a file so a script that dies before it can reach the database still leaves a trace.
    const out = openSync(launchLog, "w");
    try {
      const child = spawn(
        process.execPath,
        ["--env-file-if-exists=.env", "--no-warnings", "scripts/research.ts"],
        { detached: true, stdio: ["ignore", out, out], windowsHide: true },
      );
      child.on("error", (error) => {
        void safeLaunchText(
          `Could not start research: ${errorMessage(error)}\n`,
        )
          .then((message) => appendFileSync(launchLog, message))
          .catch(() =>
            console.error("Could not record research launch failure"),
          );
      });
      child.unref();
    } finally {
      closeSync(out);
    }
    return { started: true };
  }),

  launchProblem: publicProcedure.query(async () => {
    let text: string;
    try {
      text = readFileSync(launchLog, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return (await safeLaunchText(text)).trim().slice(-2000) || null;
  }),

  // Polled every few seconds during a run, so the whole log stays on the server.
  status: publicProcedure.query(async () => {
    const run = await latestRun();
    if (!run) return null;
    const { logText, ...rest } = run;
    return {
      ...rest,
      failedOrSkipped: runFailures(run.message),
      progress: run.status === "running" ? runProgress(logText) : null,
    };
  }),
});
