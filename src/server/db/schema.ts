import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// One row per ticker per account. Cash is a row with ticker CASH and quantity in dollars.
export const holdings = sqliteTable(
  "holdings",
  {
    ticker: text("ticker").notNull(),
    name: text("name").notNull().default(""),
    quantity: real("quantity").notNull(),
    costBasis: real("cost_basis"),
    accountLabel: text("account_label").notNull().default(""),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.ticker, t.accountLabel] })],
);

export const tickers = sqliteTable("tickers", {
  ticker: text("ticker").primaryKey(),
  cik: text("cik"),
  sector: text("sector"),
  industry: text("industry"),
  fmpProfileJson: text("fmp_profile_json"),
  lastFullReviewAt: text("last_full_review_at"),
});

// Keyed with the ticker too: GOOG and GOOGL share one issuer, and so share accession numbers.
export const filings = sqliteTable(
  "filings",
  {
    accessionNo: text("accession_no").notNull(),
    ticker: text("ticker").notNull(),
    form: text("form").notNull(),
    filedAt: text("filed_at").notNull(),
    primaryDocUrl: text("primary_doc_url").notNull(),
    items: text("items"),
    sectionsJson: text("sections_json"),
    processedAt: text("processed_at"),
  },
  (t) => [primaryKey({ columns: [t.accessionNo, t.ticker] })],
);

export const fmpCache = sqliteTable(
  "fmp_cache",
  {
    ticker: text("ticker").notNull(),
    endpoint: text("endpoint").notNull(),
    fetchedOn: text("fetched_on").notNull(),
    payloadJson: text("payload_json").notNull(),
  },
  (t) => [primaryKey({ columns: [t.ticker, t.endpoint, t.fetchedOn] })],
);

export const researchRuns = sqliteTable("research_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startedAt: text("started_at").notNull(),
  // A live run updates this every minute, however long it takes.
  heartbeatAt: text("heartbeat_at"),
  finishedAt: text("finished_at"),
  status: text("status").notNull(), // running | finished | failed | failed_setup
  providerMode: text("provider_mode").notNull(),
  usageJson: text("usage_json"),
  logText: text("log_text").notNull().default(""),
  briefId: integer("brief_id"),
});

export const tickerUpdates = sqliteTable("ticker_updates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("run_id").notNull(),
  ticker: text("ticker").notNull(),
  reviewDepth: text("review_depth").notNull(),
  resultJson: text("result_json").notNull(),
  verificationJson: text("verification_json"),
  verifiedScore: real("verified_score"),
  analystProvider: text("analyst_provider").notNull(),
  analystModel: text("analyst_model").notNull(),
  verifierProvider: text("verifier_provider"),
  verifierModel: text("verifier_model"),
  usedFallback: integer("used_fallback", { mode: "boolean" })
    .notNull()
    .default(false),
  revisedAfterReview: integer("revised_after_review", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: text("created_at").notNull(),
});

export const briefs = sqliteTable("briefs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("run_id").notNull(),
  date: text("date").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  resultJson: text("result_json").notNull(),
  markdown: text("markdown").notNull(),
});

export const decisions = sqliteTable("decisions", {
  createdAt: text("created_at"),
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  date: text("date").notNull(),
  actionTaken: text("action_taken").notNull(),
  note: text("note").notNull().default(""),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
