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
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS urls (
  id BIGSERIAL PRIMARY KEY,
  short_code VARCHAR(12) UNIQUE,
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
  const clicksLog = []; // { shortCode, clickedAt, referrer, userAgent }
  const usersByEmail = new Map(); // email -> user row
  let nextId = 1;
  let nextUserId = 1;

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
      clicksLog.push({ shortCode, clickedAt: new Date(), referrer, userAgent, ipHash });
    },
    async getStats(shortCode) {
      const row = urls.get(shortCode);
      if (!row) return null;

      const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const linkClicks = clicksLog.filter((c) => c.shortCode === shortCode);

      const byDay = new Map();
      const byReferrer = new Map();
      for (const c of linkClicks) {
        if (c.clickedAt.getTime() >= cutoff) {
          const day = c.clickedAt.toISOString().slice(0, 10);
          byDay.set(day, (byDay.get(day) || 0) + 1);
        }
        const ref = c.referrer && c.referrer.trim() ? c.referrer : 'Direct / unknown';
        byReferrer.set(ref, (byReferrer.get(ref) || 0) + 1);
      }

      const clicksByDay = Array.from(byDay.entries())
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([day, count]) => ({ day, count }));

      const topReferrers = Array.from(byReferrer.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([referrer, count]) => ({ referrer, count }));

      return {
        short_code: shortCode,
        long_url: row.long_url,
        click_count: row.click_count,
        created_at: row.created_at,
        clicksByDay,
        topReferrers,
      };
    },
    async insertUser({ email, passwordHash }) {
      if (usersByEmail.has(email)) {
        const err = new Error('duplicate email');
        err.code = '23505';
        throw err;
      }
      const user = { id: nextUserId++, email, password_hash: passwordHash, created_at: new Date().toISOString() };
      usersByEmail.set(email, user);
      return user;
    },
    async getUserByEmail(email) {
      return usersByEmail.get(email) || null;
    },
    async getLinksByOwner(ownerId) {
      return Array.from(urls.values())
        .filter((u) => u.owner_id === ownerId)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .map((u) => ({
          shortCode: u.short_code,
          longUrl: u.long_url,
          clickCount: u.click_count,
          createdAt: u.created_at,
        }));
    },
    async getAnalyticsSummary() {
      const allUrls = Array.from(urls.values());
      const totalLinks = allUrls.length;
      const totalClicks = allUrls.reduce((sum, u) => sum + u.click_count, 0);

      const topLinks = [...allUrls]
        .sort((a, b) => b.click_count - a.click_count)
        .slice(0, 10)
        .map((u) => ({
          shortCode: u.short_code,
          longUrl: u.long_url,
          clickCount: u.click_count,
          createdAt: u.created_at,
        }));

      const byDay = new Map(); // 'YYYY-MM-DD' -> count
      const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
      for (const c of clicksLog) {
        if (c.clickedAt.getTime() < cutoff) continue;
        const day = c.clickedAt.toISOString().slice(0, 10);
        byDay.set(day, (byDay.get(day) || 0) + 1);
      }
      const clicksByDay = Array.from(byDay.entries())
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([day, count]) => ({ day, count }));

      return { totalLinks, totalClicks, topLinks, clicksByDay };
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
         VALUES (NULL, $1, $2, $3) RETURNING id`,
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
        `SELECT short_code, long_url, click_count, created_at FROM urls WHERE short_code = $1`,
        [shortCode]
      );
      if (!res.rows[0]) return null;

      const dayRes = await pool.query(
        `SELECT to_char(date_trunc('day', clicked_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
         FROM clicks
         WHERE short_code = $1 AND clicked_at > now() - interval '14 days'
         GROUP BY day ORDER BY day ASC`,
        [shortCode]
      );
      const refRes = await pool.query(
        `SELECT COALESCE(NULLIF(referrer, ''), 'Direct / unknown') AS referrer, COUNT(*)::int AS count
         FROM clicks WHERE short_code = $1
         GROUP BY referrer ORDER BY count DESC LIMIT 8`,
        [shortCode]
      );

      return {
        ...res.rows[0],
        clicksByDay: dayRes.rows.map((r) => ({ day: r.day, count: r.count })),
        topReferrers: refRes.rows.map((r) => ({ referrer: r.referrer, count: r.count })),
      };
    },
    async insertUser({ email, passwordHash }) {
      const res = await pool.query(
        `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING *`,
        [email, passwordHash]
      );
      return res.rows[0];
    },
    async getUserByEmail(email) {
      const res = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
      return res.rows[0] || null;
    },
    async getLinksByOwner(ownerId) {
      const res = await pool.query(
        `SELECT short_code, long_url, click_count, created_at
         FROM urls WHERE owner_id = $1 ORDER BY created_at DESC`,
        [ownerId]
      );
      return res.rows.map((r) => ({
        shortCode: r.short_code,
        longUrl: r.long_url,
        clickCount: r.click_count,
        createdAt: r.created_at,
      }));
    },
    async getAnalyticsSummary() {
      const totalsRes = await pool.query(
        `SELECT COUNT(*)::int AS total_links, COALESCE(SUM(click_count), 0)::int AS total_clicks FROM urls`
      );
      const topRes = await pool.query(
        `SELECT short_code, long_url, click_count, created_at
         FROM urls ORDER BY click_count DESC, created_at DESC LIMIT 10`
      );
      const dayRes = await pool.query(
        `SELECT to_char(date_trunc('day', clicked_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
         FROM clicks
         WHERE clicked_at > now() - interval '14 days'
         GROUP BY day ORDER BY day ASC`
      );
      return {
        totalLinks: totalsRes.rows[0].total_links,
        totalClicks: totalsRes.rows[0].total_clicks,
        topLinks: topRes.rows.map((r) => ({
          shortCode: r.short_code,
          longUrl: r.long_url,
          clickCount: r.click_count,
          createdAt: r.created_at,
        })),
        clicksByDay: dayRes.rows.map((r) => ({ day: r.day, count: r.count })),
      };
    },
  };
}

module.exports = impl;