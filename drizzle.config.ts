import { type Config } from "drizzle-kit";

export default {
  schema: "./src/server/db/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: `file:${process.env.DATABASE_PATH ?? "./data/portfolio.db"}`,
  },
} satisfies Config;
