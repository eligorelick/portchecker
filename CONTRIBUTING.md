# Contributing

Portchecker is a local, single-user research app. Keep SQLite, Markdown research files and the existing provider routing through `runModel()`. Authentication, cloud deployment, trading execution and new infrastructure are outside the current scope. Read [AGENTS.md](AGENTS.md) and [SECURITY.md](SECURITY.md) before changing behavior; preserve the owner's deferred decisions and private operational history.

## Setup and verification

Use Node.js 22.18 or newer and the pnpm version recorded in `package.json`. Install from the existing lockfile with `pnpm install --frozen-lockfile`. New dependencies and schema changes need a concrete reason and the owner's approval.

Tests must use a throwaway `DATABASE_PATH`, such as `:memory:` or a database inside a temporary directory. Import `src/server/test-env.ts` before server modules in new test files. Tests that write dossiers, packs, imports or briefs also need a temporary working directory: `DATABASE_PATH` changes only the database location, not the rest of `data/`.

Stub vendor requests and model calls, and make unexpected external calls fail. Use fictional inputs. Do not use real credentials, portfolios, provider Test buttons, screenshot extraction, thesis generation, `pnpm research` or `pnpm pack:ticker` for ordinary verification. Even the pack command contacts vendors. A real-provider check requires a separately authorized scope and budget.

Run checks appropriate to the change, then the full required checks:

```sh
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

If this directory serves a running installation, verify in a separate source-only copy. Copy the required source and configuration, install from the lockfile, and use an empty throwaway database and fictional fixtures. Do not copy `.env`, private `data/`, backups or the live `.next` directory. Building or running development mode in the live directory can replace files used by the running server.

For a preview of the verified copy, invoke Next directly on a separate loopback port:

On Windows, run `.\node_modules\.bin\next.cmd build` and then `.\node_modules\.bin\next.cmd start -H 127.0.0.1 -p 3100`. On macOS or Linux, use `./node_modules/.bin/next build` and `./node_modules/.bin/next start -H 127.0.0.1 -p 3100`. Invoke those binaries from the copy itself; avoid package scripts when the copy shares linked dependencies with a live installation.

Run that command from the copy after its build completes. Stop the temporary server when finished. Report the checks actually run, their results and any remaining gaps; offline tests do not prove real-provider isolation or research accuracy.

## Before a public release

Prepare an explicit file list and review the resulting export, rather than archiving the working directory. Include the application source, scripts, required assets, configuration, lockfile and public documentation. Review any example configuration to ensure it contains placeholders only.

Keep `.env`, database files and sidecars, `data/`, logs, screenshots of real holdings, backups, audit artifacts and local tool directories out of the export. Treat `docs/PROGRESS.md` and the subscription and report-repair plans as private operational records: they contain owner activity and local paths. Preserve them locally. Public project history should be written separately without those details. Review any exported `AGENTS.md`, `CLAUDE.md` and planning documents so contributor instructions refer only to included public files.

Check that the release tree contains every required file, including source files that may still be untracked in a development checkout. Check the approved export against the reviewed file list; do not use blanket staging or assume ignore rules cover every private artifact.

Review inline test fixtures as well as standalone files. Use fictional position quantities, cost basis, cash balances, allocations and account identifiers; a fixture copied from a saved report can disclose a portfolio even when `data/` is excluded. Keep the test's numerical boundaries and assertions when replacing private examples. Use reserved email domains such as `example.com` or `.test` for contact fixtures.

Release gates remain:

- Include the [MIT license](LICENSE) and preserve its copyright and permission notices. The owner authorizes publication separately from code changes.
- The reviewed export installs from the lockfile and passes typecheck, lint, offline tests and a production build in a clean directory. Check empty-install and fictional-demo flows there.
- Public instructions describe the local-only scope, provider data sharing and the access limits in [SECURITY.md](SECURITY.md). The unresolved Codex file boundary must remain disclosed; passing offline checks is not a security certification.
- Known research limits remain visible in [README.md](README.md): untested real Schwab exports, incomplete fund source coverage, vendor-data errors, split/ADR reconciliation and no owner target weights. Record unperformed provider and browser checks explicitly.

Include the concrete problem, changed behavior and verification evidence in a proposed change. Keep private holdings, source packs, credentials and operational logs out of issue reports and patches.
