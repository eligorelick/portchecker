# Contributor instructions

Read CONTRIBUTING.md and SECURITY.md before making changes. Keep the app local and single-user, and follow the scope and verification rules in those documents.

Use fictional fixtures, a throwaway database and a temporary working directory for tests. Stub vendor and model calls. Verify changes in a separate source copy when an installation is running.

Before finishing, run pnpm typecheck, pnpm lint, pnpm format:check, pnpm test and pnpm build (in the separate copy when one is used), and report any checks not performed. CI fails on any lint warning, and one test of the ignore rules runs only inside a git checkout. Do not push, tag or publish without the owner's authorization. Keep the MIT LICENSE file and its notices.
