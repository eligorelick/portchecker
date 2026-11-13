# Contributing

Portchecker is a local, single-user research app. This page says what a change may touch, how to check it without calling a vendor or a model, and what must stay true in anything that is published. Read [SECURITY.md](SECURITY.md) before changing behavior. [AGENTS.md](AGENTS.md) is the short version for coding agents.

## Scope

- Keep SQLite for records, Markdown files for research, and the existing provider routing through `runModel()`.
- Authentication, cloud deployment, trading execution and new infrastructure are outside the current scope.
- New dependencies and schema changes need a concrete reason and the owner's approval.
- The limits listed under "Known limits" in [README.md](README.md) and in [SECURITY.md](SECURITY.md) are decisions the owner has left open. Do not settle one inside another change; propose it on its own.

## Setup

Use Node.js 22.18 or newer and the pnpm version recorded in `package.json`. Install from the existing lockfile with `pnpm install --frozen-lockfile`.

## Tests stay offline

- Tests must use a throwaway `DATABASE_PATH`, such as `:memory:` or a database inside a temporary directory. Import `src/server/test-env.ts` before server modules in new test files.
- Tests that write dossiers, packs, imports or briefs also need a temporary working directory: `DATABASE_PATH` changes only the database location, not the rest of `data/`.
- Stub vendor requests and model calls, and make unexpected external calls fail.
- Use fictional inputs: position quantities, cost basis, cash balances, allocations and account identifiers. This applies to fixtures written inline in a test as well as to standalone files; a fixture copied from a saved report can disclose a portfolio even when `data/` is excluded. When replacing such a fixture, keep the test's numerical boundaries and assertions. Use reserved email domains such as `example.com` or `.test` for contact fixtures.
- Do not use real credentials, portfolios, provider Test buttons, screenshot extraction, thesis generation, `pnpm research` or `pnpm pack:ticker` for ordinary verification. Even the pack command contacts vendors. A real-provider check requires a scope and budget the owner has authorized separately.

## Required checks

Run checks appropriate to the change, then all of these:

```sh
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
```

`pnpm build` opens the database, so it creates an empty file at `DATABASE_PATH` (by default `data/portfolio.db`) if none exists.

Report the checks actually run, their results and any remaining gaps, including provider and browser checks that were not performed. Offline tests do not prove real-provider isolation or research accuracy.

## Verifying beside a running installation

If this directory serves a running installation, verify in a separate source-only copy. Copy the required source and configuration, install from the lockfile, and use an empty throwaway database and fictional fixtures. Do not copy `.env`, private `data/`, backups or the live `.next` directory. Building or running development mode in the live directory can replace files used by the running server.

To preview the verified copy, invoke Next directly on a separate loopback port after the build completes:

- Windows: `.\node_modules\.bin\next.cmd build`, then `.\node_modules\.bin\next.cmd start -H 127.0.0.1 -p 3100`.
- macOS or Linux: `./node_modules/.bin/next build`, then `./node_modules/.bin/next start -H 127.0.0.1 -p 3100`.

Invoke those binaries from the copy itself; avoid package scripts when the copy shares linked dependencies with a live installation. Stop the temporary server when finished.

## Proposing a change

Include the concrete problem, the changed behavior and the verification evidence. Keep private holdings, source packs, credentials and operational logs out of issue reports and patches.

Before committing:

- Stage files by name and read the result. Do not use blanket staging, and do not assume the ignore rules cover every private artifact.
- Check that the change contains every file it needs, including new source files that are still untracked.
- Keep `.env`, database files and their `-wal`/`-shm` sidecars, `data/`, logs, screenshots of real holdings, backups, audit artifacts and local tool directories out of the repository.
- Keep `.env.example` to placeholders only.
- `.gitignore` lists some private local notes (`/backups/` and several files under `/docs/`). Leave those entries in place; a test in `src/server/app-guards.test.ts` checks them. Do not commit such notes, and keep owner activity and local paths out of commit messages and public documents.
- Contributor instructions (`AGENTS.md`, this file, any `CLAUDE.md` or planning document) may refer only to files that are in the repository.

## Publishing and releases

The owner decides what is merged, tagged and published. A change that passes the checks is not an authorization to publish.

- Publish tracked files only, from a clone or `git archive`, never by archiving a working directory. Review the list of files being published before it goes out.
- Keep the [MIT license](LICENSE) in every copy and preserve its copyright and permission notices.
- A release is checked in a clean directory: it installs from the lockfile and passes the required checks above, and the empty-install and fictional-demo flows work there (`pnpm db:push`, then `pnpm demo:seed`).
- The public documents keep describing the local-only scope, provider data sharing and the access limits in [SECURITY.md](SECURITY.md). The unresolved Codex file boundary must remain disclosed; passing offline checks is not a security certification.
- These research limits stay visible in [README.md](README.md): untested real Schwab exports, incomplete fund source coverage, vendor-data errors, split/ADR reconciliation and no owner target weights.
