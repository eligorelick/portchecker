/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation.
 */
import "./src/env.js";

/** @type {import("next").NextConfig} */
const config = {
  // Native bindings and the Codex CLI wrapper must load from node_modules at runtime.
  serverExternalPackages: ["@libsql/client", "libsql", "@openai/codex-sdk"],
  poweredByHeader: false,
  // The middleware sets the Content-Security-Policy but skips static files, so these go on every
  // path here. "same-origin" rather than "no-referrer": with no referrer a browser may send
  // "Origin: null" on a form post, which the middleware refuses.
  headers: async () => [
    {
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "same-origin" },
      ],
    },
  ],
};

export default config;
