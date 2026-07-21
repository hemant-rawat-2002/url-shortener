/**
 * Data layer.
 *
 * Production path: PostgreSQL via `pg`, using a sequence-backed
 * auto-increment id as the source of truth for Base62 encoding, plus
 * a UNIQUE index on short_code (belt-and-braces even though ids
 * can't collide).
 *
 * Local-demo path: if no DATABASE_URL is set, we swap in an in-memory
 * adapter that implements the exact same interface. This is the
 * "adapter / repository pattern" -> the rest of the app (services,
 * routes) only ever talks to this module's exported functions, never
 * to `pg` directly, so swapping Postgres -> MySQL -> DynamoDB later is
 * a one-file change.
 */

const USE_MEMORY = !process.env.DATABASE_URL;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS urls (
  id BIGSERIAL PRIMARY KEY,
  short_code VARCHAR(12) UNIQUE NOT NULL,
  long_url TEXT NOT NULL,
  custom_alias BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,
  owner_id VARCHAR(64),
  click_count BIGINT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_urls_short_code ON urls(short_code);

CREATE TABLE IF NOT EXISTS clicks (
  id BIGSERIAL PRIMARY KEY,
  short_code VARCHAR(12) NOT NULL,
  clicked_at TIMESTAMPTZ DEFAULT now(),
  referrer TEXT,
  user_agent TEXT,
  ip_hash VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS idx_clicks_short_code ON clicks(short_code);
`;

let impl;

if (USE_MEMORY) {
  console.log('[db] DATABASE_URL not set -> using in-memory store (demo mode)');
  const urls = new Map(); // short_code -> row
  let nextId = 1;

  impl = {
    async init() {},
    async insertUrl({ longUrl, customAlias, ownerId, expiresAt }) {
      const id = nextId++;
      return { id };
    },
    async saveShortCode({ id, shortCode, longUrl, customAlias, ownerId, expiresAt }) {
      const row = {
        id,
        short_code: shortCode,
        long_url: longUrl,
        custom_alias: !!customAlias,
        created_at: new Date().toISOString(),
        expires_at: expiresAt || null,
        owner_id: ownerId || null,
        click_count: 0,
      };
      urls.set(shortCode, row);
      return row;
    },
    async getByShortCode(shortCode) {
      return urls.get(shortCode) || null;
    },
    async incrementClickCount(shortCode) {
      const row = urls.get(shortCode);
      if (row) row.click_count += 1;
    },
    async recordClick({ shortCode, referrer, userAgent, ipHash }) {
      // no-op storage in memory mode beyond the counter above
    },
    async getStats(shortCode) {
      const row = urls.get(shortCode);
      if (!row) return null;
      return { short_code: shortCode, click_count: row.click_count, created_at: row.created_at };
    },
  };
} else {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  impl = {
    async init() {
      await pool.query(SCHEMA_SQL);
    },
    // Two-step insert lets us get the DB-generated id BEFORE we know
    // the short_code (since short_code = base62(id)).
    async insertUrl({ longUrl, ownerId, expiresAt }) {
      const res = await pool.query(
        `INSERT INTO urls (short_code, long_url, owner_id, expires_at)
         VALUES ('', $1, $2, $3) RETURNING id`,
        [longUrl, ownerId || null, expiresAt || null]
      );
      return { id: res.rows[0].id };
    },
    async saveShortCode({ id, shortCode, customAlias }) {
      const res = await pool.query(
        `UPDATE urls SET short_code = $1, custom_alias = $2 WHERE id = $3 RETURNING *`,
        [shortCode, !!customAlias, id]
      );
      return res.rows[0];
    },
    async getByShortCode(shortCode) {
      const res = await pool.query(`SELECT * FROM urls WHERE short_code = $1`, [shortCode]);
      return res.rows[0] || null;
    },
    async incrementClickCount(shortCode) {
      await pool.query(`UPDATE urls SET click_count = click_count + 1 WHERE short_code = $1`, [shortCode]);
    },
    async recordClick({ shortCode, referrer, userAgent, ipHash }) {
      await pool.query(
        `INSERT INTO clicks (short_code, referrer, user_agent, ip_hash) VALUES ($1,$2,$3,$4)`,
        [shortCode, referrer || null, userAgent || null, ipHash || null]
      );
    },
    async getStats(shortCode) {
      const res = await pool.query(
        `SELECT short_code, click_count, created_at FROM urls WHERE short_code = $1`,
        [shortCode]
      );
      return res.rows[0] || null;
    },
  };
}

module.exports = impl;
