# Portchecker

Portchecker is a local portfolio research app. It combines your holdings and investment theses with market data, SEC filings and AI research to produce a daily brief. Each holding shows the recommendation, supporting evidence, a second check and the conditions that would change the conclusion.

**Decision support only. Portchecker never places trades.** A verified claim means a model matched it to the supplied research material; it does not establish that the source or investment recommendation is correct.

Licensed under [MIT](LICENSE). For development and release guidance, see [CONTRIBUTING.md](CONTRIBUTING.md).

## What you can do

- Review changes and unresolved calls on **Today**.
- Track positions, cash, gains and concentration on **Holdings**.
- Inspect each holding's reasoning, evidence, financial data, filings and review history.
- Keep your own thesis and break conditions alongside the model's current view.
- Import a Schwab Positions CSV, review screenshots with AI assistance, or edit holdings manually.
- Run research on demand or schedule the command on your computer.

The app stores data locally in SQLite and Markdown files. AI processing uses external providers. It has **no authentication** and is intended for one user on a trusted machine, not a public web deployment. Read [SECURITY.md](SECURITY.md) before connecting accounts or adding real holdings, including the documented Codex file-access limitation.

## Requirements

- **Node.js 22.18 or newer** and **pnpm 12.16.1**, as recorded in `package.json`.
- A separate, writable project directory. On Windows, keep it outside `AppData\Local\Temp`; the tested Codex sandbox could not start processes there.
- For real research: Financial Modeling Prep access, a name/email for the SEC request identity, and at least one AI provider below. The app has been tested with FMP Starter; endpoint availability depends on your plan.

Current verification covers Windows. Linux/macOS scheduling examples are provided below, but those platforms have not received the same end-to-end checks.

Download or clone the source, open a terminal in the project root, then install:

```sh
npm install -g pnpm@12.16.1
pnpm install --frozen-lockfile
```

## Try the demo without credentials

Use a fresh copy of the project, separate from any real installation. After installing dependencies:

```sh
pnpm db:push
pnpm demo:seed
pnpm dev
```

Open <http://localhost:3000>. The demo creates four fictional investments, cash and a completed research brief. Seeding does not call market-data providers or models. Explore Today, Holdings and the individual holding pages; running new research, provider tests, thesis drafting or Ask requires real setup and can consume provider usage.

The seed command refuses an installation that already contains records or saved data files. Keep the demo separate from your real portfolio. Changing `DATABASE_PATH` alone does not isolate dossiers, packs, imports and briefs, which remain under the working directory's `data/` folder.

## Set up your own portfolio

### 1. Configure the environment

Use a fresh installation rather than converting the demo in place. Copy `.env.example` to `.env` in the project root and enter your values:

```dotenv
FMP_API_KEY=your-fmp-key
SEC_USER_AGENT="Your Name you@example.com"
DATABASE_PATH=./data/portfolio.db
ANTHROPIC_API_KEY=
```

Replace the sample name/email with your own request identity. The app treats an `example.com` SEC contact as unset and stops research until it is replaced. `ANTHROPIC_API_KEY` is optional if you use ChatGPT or Claude subscription access; API users can save it in Settings instead. A saved value takes precedence over the environment value. Restart the app after changing `.env`.

Do not commit `.env`, your database or `data/`. Credentials saved in Settings are stored as plain text in the local database; protect the files and backups accordingly.

### 2. Set up an AI provider

| Option                | Setup                                                                                                                                                                                                   | Usage                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ChatGPT through Codex | Install with `npm install -g @openai/codex`, run `codex login`, and sign in with ChatGPT.                                                                                                               | Uses the signed-in plan's limits; no OpenAI API key is required by Portchecker.            |
| Claude subscription   | Follow the [Claude Code installation guide](https://code.claude.com/docs/en/setup), run `claude auth login`, and choose subscription sign-in. Select **Claude subscription (Claude Code)** in Settings. | Uses subscription limits. Claude Code's extra-usage settings can allow additional charges. |
| Anthropic API         | Select **Anthropic API** in Settings and enter an API key there or in `.env`.                                                                                                                           | Billed separately for API usage.                                                           |
| Both                  | Configure ChatGPT and one Claude access option, then choose which provider analyzes and which checks.                                                                                                   | Consumes usage from both providers.                                                        |

Run sign-in commands as the same operating-system user that will run Portchecker. Keep `node`, `pnpm` and any selected provider CLI on the app's and scheduler's `PATH`.

In single-provider mode, the same provider performs analysis and verification. In Both mode, the other provider performs the second check. Claude subscription mode does not use a saved API key or switch to API authentication when a subscription limit is reached.

### 3. Initialize and start

From the project root:

```sh
pnpm db:push
pnpm build
pnpm start
```

Open <http://localhost:3000>. `pnpm start` serves the production build; keep its terminal/process running while using the app. For development, use `pnpm dev` instead of the build/start pair. Both start commands bind to `127.0.0.1` by default.

In **Settings**, select the provider mode, model and effort. Decide whether to enable **If one fails, use the other**, then save changes. Each provider's **Test** button makes a real model call using the saved settings; use it to confirm setup before a full run.

Fallback is enabled by default. If another provider is configured, a failed call can be retried there, sharing the same research context and consuming that provider's usage. Turn fallback off if you do not want this behavior.

### 4. Add and check holdings

Open **Holdings → Update holdings**.

- **CSV:** export Positions from Schwab and choose the CSV file. Parsing is local. Review every preview row, skipped-row notice, account label and cost-basis warning before confirming.
- **Screenshots:** upload up to 12 images. AI extracts the positions before you confirm them, so crop out account identifiers and check every extracted value. Images are sent to the selected provider, or to the other one if that call fails and fallback is on, and are retained locally even if you cancel the preview.
- **Manual entry:** add or edit individual rows. Enter **total cost basis**, not cost per share. Leave an unknown basis blank; zero is a real value. Keep account labels distinct when holding the same ticker in multiple accounts.

**File import replaces the current holdings list.** Positions missing from the confirmed preview will be removed from that list; it is not an append operation. Use manual entry for a small change. Preview deletions and changed quantities carefully before choosing **Replace my holdings**.

For cash and money-market balances, use ticker `CASH` and enter the dollar balance as the quantity. For example, $1,250 in cash is quantity `1250`. Portfolio amounts are displayed in US dollars; the app does not perform portfolio currency conversion. Use USD-valued positions and USD cost basis.

### 5. Run research and record your thesis

1. Press **Run research** in the sidebar. Watch its status and review any failed/skipped holdings. A first run performs full reviews and can take substantial time, especially with many holdings or high effort settings.
2. Open **Today** for the brief. Check its date, quote dates, coverage and warnings before acting.
3. Open each holding's **Thesis and notes** tab. Write why you own it and measurable conditions that would break that thesis, then save. After an initial run, **Draft a thesis for me** can help; it is a real model call, and you must review the draft before saving it as your thesis.
4. Run research again when you want saved thesis changes evaluated. Saving a thesis requests a full review; it does not rewrite the previous review automatically.
5. Read the evidence and second opinion, then use **Log a decision** to record what you chose. Logging is a journal entry: it neither executes a trade nor updates your share count. Update holdings after making a real trade.

The job may update the dossier's **Current view** after a successful final check. It does not replace your thesis or other owner-written sections. Without a saved thesis, reviews judge the available evidence without knowing your personal reasons for owning the holding.

Use **Ask about this holding**, on the Reasoning tab of a holding page, for follow-up questions about its saved research files. This makes a model call; it does not refresh the market data or run a new review. Answers are shown on the page but are not stored, so copy anything you want to keep into your notes.

## Read the results correctly

Later runs choose a full review when a qualifying filing arrives, a new large price move warrants it, the previous full review is old, or you have changed your thesis. Otherwise they use a light review. A quiet light review can skip the second check; it must not be read as a newly verified conclusion. When a check finds a material problem, the job can revise once and check again. Unresolved concerns stay visible.

| Label                 | Meaning                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verified              | The second check matched a claim to the supplied research material.                                                                                                   |
| Unverified            | The claim could not be confirmed from that material. It is not necessarily false.                                                                                     |
| Contradicted          | The second check found material that conflicts with the claim.                                                                                                        |
| Not checked           | No second check was performed, as can happen on a quiet light review, or the second check did not cover that claim.                                                   |
| Verified score        | The share of displayed evidence/check claims marked verified. It is not a probability of investment success.                                                          |
| Models agree/disagree | Whether the analyst's and the checker's action judgments agree, shown when two different providers did the two passes. Agreement does not guarantee factual accuracy. |
| Final check rejected  | The final check did not support the conclusion. Read the concerns before using the recommendation.                                                                    |
| Review                | The holding needs attention; it is not an instruction to trade.                                                                                                       |

With one provider doing both passes, a disagreement reads "Second check disagrees" and agreement shows no label. A claim that is still contradicted while the final check supports the conclusion does not show "Final check rejected": it appears as a "contradicted" count beside the proof marks and as "Contradicted" on the claim, and the holding is listed on Today.

An unpriced holding is named and omitted from totals, not valued at zero. Missing cost basis limits gain calculations. A stale brief, partial run or missing filing warning limits what was checked. A quiet brief is not a guarantee that the portfolio is safe.

Web findings are model-written summaries with links. A verified web claim means the saved findings support it; inspect the original source when the claim matters to your decision. Claude API mode receives selected, shortened filing text, so a true claim may remain unverified when the relevant passage was not included.

## Run research on a schedule

Research runs when you press the button or invoke the command; the app does not install a scheduler for you. From the project root:

```sh
pnpm research
```

To review specific holdings without replacing the portfolio-wide brief:

```sh
pnpm research AAPL MSFT
```

Schedule the full command only after a manual run succeeds. Use the same user and provider sign-ins, set the working directory to the project root, and ensure `node`, `pnpm` and the provider CLIs are on `PATH`. Do not overlap jobs. The computer must be awake and able to reach the providers.

**Windows Task Scheduler:** create a task under your user account with a weekday trigger. Use `cmd.exe` as the program, `/d /c pnpm research > data\scheduled-run.log 2>&1` as the arguments, and the full project directory in **Start in**. Choose **Run only when user is logged on** when using desktop notifications. Use full executable paths if the task cannot find your tools. Test the task manually and inspect its log before relying on the schedule.

**Linux/macOS cron:** this example runs at 07:00 on weekdays in the scheduler's local time:

```cron
0 7 * * 1-5 cd "/path/to/portchecker" && pnpm research > data/scheduled-run.log 2>&1
```

Cron does not load your normal shell profile. Set its `PATH` to include the required tools, and replace the example directory. On macOS you can instead configure a user launchd agent with the same command and working directory. Desktop notifications depend on the operating system and session; use the saved log and app status to check completion.

## Privacy, cost and limitations

**Local storage does not mean local AI.** Research, thesis drafting and Ask can send your notes, holdings and research context to OpenAI through Codex or to Anthropic. Brief generation includes portfolio totals. Screenshot extraction sends the entire image. Fallback can send the same context to another provider. CSV parsing stays local; market-data requests still identify the requested tickers to FMP, and SEC requests include your configured contact identity.

FMP access and AI usage are separate. Subscription calls use plan limits and may be affected by the provider's extra-usage settings; API calls are billed separately. Full reviews, web research, revisions, provider tests and fallback all consume usage. Settings shows the Claude token and web-search counts recorded for the last research run, which is not a complete bill or a price guarantee. ChatGPT usage is not recorded. Check your providers' current terms and rates before running a large portfolio.

Known limits:

- Vendor figures and model conclusions can be wrong despite the checks.
- Some filings or exhibits cannot be read; some funds lack filings, holdings or sector breakdowns.
- Splits, ADR ratios, currency conversion and cost-basis reconciliation require your own checks.
- There are no owner-defined target weights, so add/trim suggestions do not implement a personal allocation plan.
- CSV tests cover fixtures and screenshot-derived data; a real Schwab export has not yet been validated end to end.
- The requested Codex file deny list is **not a verified isolation boundary on the tested Windows installation**. Do not assume a model is confined to its research pack or that all local secrets are protected.

See [SECURITY.md](SECURITY.md) for provider data sharing, plain-text credential storage and the limits of the CLI controls. Portchecker should not be exposed to the public internet.

## Data, backups and updates

| Location                  | Contents                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `data/portfolio.db`       | Default SQLite database: holdings, settings, decisions and research history.                  |
| `data/dossiers/TICKER.md` | Your thesis, notes and the model's current view.                                              |
| `data/briefs/`            | Saved daily briefs.                                                                           |
| `data/packs/`             | Dated research inputs, extracted sections, full filing text when available and model outputs. |
| `data/imports/`           | Imported CSVs and screenshots.                                                                |
| `data/last-run.log`       | Output of the most recent sidebar-started research run.                                       |
| `data/scheduled-run.log`  | Output if you use the scheduling examples above.                                              |

`DATABASE_PATH` changes the database location only. Other data files remain relative to the directory from which the app or script runs. Use the project root consistently. There is no automatic pruning of research packs or imports.

**Back up:** stop the app and all research jobs, then back up the entire `data/` folder, including database `-wal` and `-shm` companions. Include a custom database location if configured, and keep `.env` in a protected backup. Dossiers alone are not a complete backup.

**Restore:** stop the app and jobs, preserve the current data separately, then restore the complete backup, custom database path and environment configuration together.

**Update:** stop the app and jobs, make a backup, and replace the code while preserving your data and environment file. Then run:

```sh
pnpm install --frozen-lockfile
pnpm db:push
pnpm build
pnpm start
```

Read and review any schema-change prompt before accepting it. Do not build over a directory serving a running production app. Without a new build, the browser can serve old code while the research command uses the updated source. See [CONTRIBUTING.md](CONTRIBUTING.md) for verifying changes in an isolated copy.

## Commands

| Command                                                            | Purpose                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `pnpm dev`                                                         | Start the development server on loopback.                                 |
| `pnpm build` / `pnpm start`                                        | Build and serve the production app.                                       |
| `pnpm research [TICKER...]`                                        | Run one research job; optional tickers keep the existing portfolio brief. |
| `pnpm pack:ticker AAPL`                                            | Build a research pack; contacts data vendors but does not call a model.   |
| `pnpm demo:seed`                                                   | Seed a separate empty installation with fictional data.                   |
| `pnpm db:push`                                                     | Initialize or update the database schema.                                 |
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm test` | Run development checks; follow the isolation rules in CONTRIBUTING.       |

## Troubleshooting

- **Missing FMP or SEC setup:** check the values in your local environment configuration, replace placeholder contact details, and restart the app.
- **Codex missing or not signed in:** install `@openai/codex`, confirm it is on the app's `PATH`, run `codex login`, and check `codex login status` as the same user.
- **Claude subscription not ready:** use native `claude auth login`, choose subscription access, and recheck sign-in in Settings. An API key does not satisfy subscription readiness.
- **A provider test uses old settings:** save changes first, then test again. Tests use persisted settings.
- **Another research run is in progress:** let the active run finish. A crashed run becomes reclaimable after its heartbeat is stale for ten minutes; do not start competing processes to bypass the guard.
- **A filing could not be read:** inspect the warning. Temporary failures can be retried; a PDF/image exhibit that the app cannot extract remains explicitly unread. A review may proceed with incomplete source material.
- **An unpriced holding or missing gains:** check the ticker, quote date and total cost basis. Missing values are not automatically zero.
- **403 response:** open the app at `localhost` or `127.0.0.1` on the machine running it, in its own tab rather than from another site's page. Hostnames added through `ALLOWED_HOSTS` do not add authentication; review SECURITY before changing network access.
- **A scheduled job fails but manual research works:** check its operating-system user, working directory, `PATH`, provider sign-ins and `data/scheduled-run.log`.
- **Changes do not appear:** `pnpm start` serves the previous build until you stop it, rebuild and restart. A browser can also retain an older tab icon until refreshed.

## Contributing and release

See [CONTRIBUTING.md](CONTRIBUTING.md) for offline verification and release checks, and [SECURITY.md](SECURITY.md) for the security model. Report reproducible issues with fictional or redacted inputs; do not attach real portfolios, screenshots, research packs or credentials.

If you share a copy, share the tracked source (a clone or `git archive`), not your working directory: `.env`, `data/`, databases, logs and backups are ignored by git but would be included in a folder copy. Portchecker is available under the [MIT license](LICENSE).
