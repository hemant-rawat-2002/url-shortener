const crypto = require('crypto');
const db = require('./db');
const cache = require('./cache');
const base62 = require('./base62');

const URL_REGEX = /^https?:\/\/.+/i;

/**
 * In-process analytics queue.
 *
 * Why not write click events to Postgres synchronously inside the
 * redirect handler? Because the redirect response should return in
 * single-digit milliseconds - the user is waiting to be bounced to
 * the destination site. Writing an analytics row is not on that
 * critical path, so we push the event onto a queue and flush it in
 * batches on a timer. This is the same idea as Kafka/SQS + a
 * consumer in a "real" deployment: producer (redirect handler) never
 * blocks on the consumer (analytics writer).
 *
 * In this demo the "queue" is an in-memory array flushed every 2s.
 * In production this would be replaced by publishing to
 * Kafka/SQS/Redis Streams, with a separate worker process/service
 * consuming and batch-inserting into Postgres or a columnar store
 * (ClickHouse/BigQuery) built for analytical queries.
 */
const analyticsQueue = [];
setInterval(flushAnalyticsQueue, 2000).unref();

async function flushAnalyticsQueue() {
  if (analyticsQueue.length === 0) return;
  const batch = analyticsQueue.splice(0, analyticsQueue.length);
  await Promise.all(
    batch.map((event) =>
      db.recordClick(event).catch((err) => console.error('[analytics] write failed', err))
    )
  );
}

function isValidUrl(url) {
  return typeof url === 'string' && URL_REGEX.test(url) && url.length < 2048;
}

function hashIp(ip) {
  return crypto.createHash('sha256').update(ip || '').digest('hex').slice(0, 16);
}

/**
 * Create a short URL.
 * Flow:
 *  1. Insert a placeholder row to get a DB-generated auto-increment id
 *     (id is the single source of truth for uniqueness).
 *  2. Base62-encode the id -> short_code. No collision check needed:
 *     ids are monotonic and unique by construction.
 *  3. Persist the short_code back onto the row.
 *  4. Warm the cache immediately so the very first redirect is also a
 *     cache hit.
 */
async function shortenUrl({ longUrl, ownerId, expiresAt }) {
  if (!isValidUrl(longUrl)) {
    const err = new Error('Invalid URL. Must start with http:// or https://');
    err.status = 400;
    throw err;
  }

  const { id } = await db.insertUrl({ longUrl, ownerId, expiresAt });
  const shortCode = base62.encode(id);
  const row = await db.saveShortCode({ id, shortCode, longUrl, ownerId, expiresAt });

  await cache.set(shortCode, longUrl);
  return row;
}

/**
 * Resolve a short code -> long URL for redirection.
 * Cache-aside read with async, non-blocking analytics + click count.
 */
async function resolveShortCode(shortCode, meta = {}) {
  let longUrl = await cache.get(shortCode);
  let fromCache = true;

  if (!longUrl) {
    fromCache = false;
    const row = await db.getByShortCode(shortCode);
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
    longUrl = row.long_url;
    await cache.set(shortCode, longUrl); // populate cache for next time
  }

  // Fire-and-forget: never block the redirect on analytics/db writes.
  db.incrementClickCount(shortCode).catch((e) => console.error(e));
  analyticsQueue.push({
    shortCode,
    referrer: meta.referrer,
    userAgent: meta.userAgent,
    ipHash: hashIp(meta.ip),
  });

  return { longUrl, fromCache };
}

async function getStats(shortCode) {
  return db.getStats(shortCode);
}

async function getAnalyticsSummary() {
  return db.getAnalyticsSummary();
}

async function getLinksByOwner(ownerId) {
  return db.getLinksByOwner(ownerId);
}

module.exports = {
  shortenUrl,
  resolveShortCode,
  getStats,
  getAnalyticsSummary,
  getLinksByOwner,
  isValidUrl,
  flushAnalyticsQueue,
};