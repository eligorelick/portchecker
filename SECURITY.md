# Security and privacy

Portchecker is a local, single-user app with no login. The start and development commands bind to `127.0.0.1`. The app applies these request checks:

- Page and API requests must be addressed to `localhost`, `127.0.0.1`, `[::1]` or a hostname listed in `ALLOWED_HOSTS`, a comma-separated value read from the environment or `.env`. Built static files under `/_next/static` and `/_next/image` are served without that check.
- A request other than GET or HEAD whose Origin differs from the address it was sent to is refused.
- A request to `/api/` that the browser's `Sec-Fetch-Site` header marks as coming from anywhere but the app's own pages or the address bar is refused, which stops a page on another site from calling the API with a GET.
- Pages cannot be framed. Rendered images are restricted to local or embedded images, and plugins, a `<base>` pointing elsewhere and forms posting to another site are blocked. Responses carry `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`.

A request that carries neither an Origin nor a `Sec-Fetch-Site` header, such as one from a script or command-line tool on the same machine, passes the second and third checks. These checks are not authentication. Anyone who can reach an allowed address can use the app, so enable network access only on a network you trust.

## Stored on your machine

The SQLite database holds positions, decisions, settings and research history. A Claude key saved in Settings is stored there as plain text. Environment keys are in `.env`. The app masks credentials in Settings responses, scrubs configured keys from provider errors and reports a failed settings save without the key; that does not encrypt files or backups.

`data/` also holds dossiers, briefs, research packs, imported CSVs, screenshots and run logs. Dossiers and packs can contain your thesis, position sizes, cost basis and portfolio values. Imports can contain account details. Screenshot files are saved before extraction and remain even if you cancel the preview. There is no automatic pruning of dated packs or imports.

`.env`, `data/` and database files are gitignored, but copies and archives need the same care. Keep the project and backups in storage only you can access. Stop the app and research jobs before backing up the whole data folder, the database and its companion files, and `.env`.

## Sent to providers

FMP receives ticker requests and its API key. SEC requests include your configured name and email. AI calls send prompts and research context to OpenAI through Codex or to Anthropic: that includes dossier text, questions, position quantities, value, weight, cost basis, gains, portfolio totals and cash share. Claude API mode receives shortened filing sections and selected passages rather than whole filing files. Claude subscription mode runs the official Claude Code CLI and permits read/search access to the research pack, including full filing text. A brief call receives portfolio facts and the reviewed holdings. Logged decisions are added to the saved brief after the model call; the app does not add decision notes to prompts.

Screenshot extraction sends the entire image to the selected provider before confirmation. Crop identifying details first. CSV parsing stays local. Fallback is enabled by default and can send a failed call to the other configured provider. Web research also sends model-chosen search terms to web search services. Provider retention and account policies apply to anything sent.

## Claude subscription access

Claude Code owns subscription sign-in and credential storage; Portchecker stores only the authentication-mode choice. It does not copy OAuth credentials into its database. API keys and API-routing environment overrides are removed from the CLI child environment, and native subscription readiness is checked before each call. Existing API keys remain saved for the separate API option. Subscription usage counts against the plan's limits; Claude Code's own extra-usage settings govern possible additional charges.

The CLI is started in safe and restricted modes with customizations disabled and no MCP configuration. File calls receive only Read, Grep and Glob; web calls receive only WebSearch and WebFetch. The app supplies no write or command tools and permits no interactive approval. Restricted mode requests that file tools stay within the working directories. WebFetch retrieves addresses the model chooses; whether the CLI refuses addresses on this machine or its local network has not been tested. These are CLI-enforced controls; offline tests verify the app's flags and routing, not a comprehensive adversarial proof of the installed CLI. Managed administrator policy can still apply.

## Codex access limits

The app requests a read-only Codex permission profile. File-reading calls disable web search and command network access; web-search calls disable the shell. It disables plugins, skills, sub-agents and MCP servers declared with `[mcp_servers.name]` tables, and excludes environment names matching `*KEY*`, `*TOKEN*`, `*SECRET*` and `SEC_USER_AGENT` from model-run shell commands. Other hand-written MCP configuration forms are not detected.

The requested file deny list includes existing environment, database, import, backup and common credential paths. **That list is not a verified boundary in the tested Windows configuration:** an audit found most deny entries were not enforced. Other readable files outside the research pack can also be exposed. Do not assume the profile confines the model to its pack or protects all local secrets. Real-model checks of the final configuration are still pending.

Filings, news and model output are untrusted input. Prompt rules and source checks reduce mistakes; they do not guarantee correct research or complete isolation. Check evidence before acting on a suggestion.

## Dependency audit

On 2026-11-12, `pnpm audit --prod` reported no known production-dependency advisories for the committed lockfile. The full audit reported one moderate advisory in a development dependency:

- **minimatch 10.2.6**, through TypeScript ESLint tooling: attacker-controlled glob patterns can amplify CPU and memory use when `optimizationLevel >= 2`. Treat lint configuration and glob patterns as trusted development inputs. See [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). The newest typescript-eslint release still requires minimatch 10, so this waits for an upstream release. In the installed version that tooling passes patterns to minimatch only for its `allowDefaultProject` option, which Portchecker's ESLint configuration does not set.

This advisory remains unresolved in the lockfile. A second advisory present at initial publication, for esbuild 0.18.20 reached through Drizzle Kit's TypeScript loader ([GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)), was cleared by an override in `pnpm-workspace.yaml` that gives the loader esbuild 0.25.12, the version Drizzle Kit itself uses. The override is outside the range the loader declares, so re-check `pnpm db:push` when updating Drizzle Kit.

Re-run both audits when updating dependencies; this dated result is not an ongoing security guarantee.
