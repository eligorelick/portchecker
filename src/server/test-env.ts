// Import this first in a test file, so importing server code can never open the real database.
process.env.DATABASE_PATH = ":memory:";
