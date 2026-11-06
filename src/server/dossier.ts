import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { dossierTemplate, THESIS_PLACEHOLDER } from "./research/prompts.ts";

export function dossierHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const DOSSIER_DIR = path.join("data", "dossiers");

export function dossierPath(ticker: string) {
  return path.join(DOSSIER_DIR, `${path.basename(ticker)}.md`);
}

export function ensureDossier(ticker: string, name: string) {
  const file = dossierPath(ticker);
  if (!existsSync(file)) {
    mkdirSync(DOSSIER_DIR, { recursive: true });
    writeFileSync(file, dossierTemplate(ticker, name));
  }
}

export function readDossier(ticker: string) {
  const file = dossierPath(ticker);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

export function saveDossier(ticker: string, markdown: string) {
  mkdirSync(DOSSIER_DIR, { recursive: true });
  writeFileSync(dossierPath(ticker), markdown);
}

// The sections the app itself reads and writes. A dossier can hold other headings of mine too.
const KNOWN_SECTIONS = new Set([
  "thesis",
  "what would break the thesis",
  "key numbers to watch",
  "current view",
  "watch items",
]);

/** A "## " line's title in lower case, without "(owner: me)". Null for any other line. */
function sectionTitle(line: string) {
  return line.startsWith("## ")
    ? line
        .slice(3)
        .replace(/\(owner:[^)]*\)\s*$/i, "")
        .trim()
        .toLowerCase()
    : null;
}

const titleIs = (title: string) => (line: string) =>
  sectionTitle(line) === title.toLowerCase();

/**
 * Text of a section, matched on its whole title in any case. Excludes the heading. A heading of my
 * own stays part of the section above it, so a note under the thesis does not hide the thesis.
 */
export function dossierSection(markdown: string, title: string) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(titleIs(title));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => KNOWN_SECTIONS.has(sectionTitle(l) ?? ""));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

/** The thesis I wrote, or null while the section still holds the template's placeholder. */
export function thesisText(markdown: string) {
  const thesis = dossierSection(markdown, "Thesis")
    ?.replace(THESIS_PLACEHOLDER, "")
    .trim();
  return thesis ? thesis : null;
}

/** What a review is judged against. If this changes, the last full review no longer answers it. */
export function reviewBasis(markdown: string) {
  return JSON.stringify([
    thesisText(markdown),
    dossierSection(markdown, "What would break the thesis"),
  ]);
}

export function readThesis(ticker: string) {
  const dossier = readDossier(ticker);
  return dossier ? thesisText(dossier) : null;
}

/**
 * Exactly what replaceSection overwrites. Rewriting a section from dossierSection's wider reading
 * would copy a section of mine into it, while the original stays where it was.
 */
export function replaceableSection(markdown: string, title: string) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(titleIs(title));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

/**
 * Replaces one section's body, up to the next heading of any kind, so a section of mine that
 * follows it survives. Headings in the new text are demoted so it can never open a new section or
 * reach into another one.
 */
export function replaceSection(
  markdown: string,
  title: string,
  newBody: string,
) {
  const body = newBody.trim().replace(/^(#{1,2}) /gm, "### ");
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(titleIs(title));
  if (start < 0) return `${markdown.trimEnd()}\n\n## ${title}\n\n${body}\n`;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const after = end < 0 ? [] : rest.slice(end);
  return [...lines.slice(0, start + 1), "", body, "", ...after].join("\n");
}

/** The daily job may change only this section of a dossier. */
export function replaceCurrentView(markdown: string, view: string) {
  return replaceSection(markdown, "Current view", view);
}

const STALE_MARK = /^> Not updated on .*\n*/;

/**
 * Keeps the old view when a new one failed its check, and says so. EXPE's view said "Add modestly"
 * after the latest review had moved to hold, and the next analyst reads this section too.
 */
export function markCurrentViewStale(
  markdown: string,
  date: string,
  action: string,
) {
  const view = replaceableSection(markdown, "Current view") ?? "";
  return replaceCurrentView(
    markdown,
    `> Not updated on ${date}: the latest review suggests ${action}, but it did not pass its final check, so this older view may not match it.\n\n${view.replace(STALE_MARK, "")}`,
  );
}

const UNCONFIRMED_SHOWN = 5;
const UNCONFIRMED_CLAIM_CHARS = 160;

/** Claims the second check could not confirm stay beside the view that may repeat them. */
export function viewWithUnconfirmed(
  view: string,
  checks: { claim: string; verdict: string }[],
) {
  const unconfirmed = checks.filter((c) => c.verdict === "unverified");
  if (!unconfirmed.length) return view;
  const lines = unconfirmed.slice(0, UNCONFIRMED_SHOWN).map((c) => {
    const claim = c.claim.replace(/\s+/g, " ").trim();
    return `- ${claim.length > UNCONFIRMED_CLAIM_CHARS ? `${claim.slice(0, UNCONFIRMED_CLAIM_CHARS)}...` : claim}`;
  });
  const more = unconfirmed.length - UNCONFIRMED_SHOWN;
  if (more > 0) lines.push(`- and ${more} more`);
  return `${view.trim()}\n\nThe second check could not confirm:\n\n${lines.join("\n")}`;
}
