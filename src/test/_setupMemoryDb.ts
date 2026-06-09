// Side-effect module: must be imported BEFORE any module that pulls in
// config/db, so the DB singleton opens an in-memory database for tests instead
// of the real data/state.db. ESM evaluates imports in source order, so placing
// `import './_setupMemoryDb.js'` first guarantees this runs before db.ts loads.
process.env.DATABASE_PATH = ':memory:';
// config.ts requires a token at import time; provide a dummy if none is present
// so DB-layer tests don't depend on a real .env.
if (!process.env.SPACETRADERS_TOKEN) process.env.SPACETRADERS_TOKEN = 'test-token';
