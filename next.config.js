/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation.
 */
import "./src/env.js";

/** @type {import("next").NextConfig} */
const config = {
  // Native bindings and the Codex CLI wrapper must load from node_modules at runtime.
  serverExternalPackages: ["@libsql/client", "libsql", "@openai/codex-sdk"],
};

export default config;
