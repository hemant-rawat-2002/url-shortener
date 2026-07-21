/**
 * Cache layer (Redis).
 *
 * Pattern used: CACHE-ASIDE (lazy loading)
 *   read:  check cache -> on miss, read DB -> populate cache -> return
 *   write: write DB -> invalidate/refresh cache
 *
 * Why cache redirects at all?
 *   Redirection is the hottest path (read >> write for a URL shortener,
 *   often 100:1 or more). Hitting Postgres on every single redirect
 *   wastes connections and adds latency. Redis serves reads from
 *   memory in ~1ms and can handle >100k ops/sec on modest hardware,
 *   which is what "high-throughput redirection" is referring to.
 *
 * TTL strategy: short codes are cached for 24h with sliding expiry on
 * access (re-set TTL on hit) so hot links stay warm and cold ones fall
 * out of memory automatically -> keeps cache size bounded without a
 * manual eviction job (LRU-ish behavior on top of Redis' own maxmemory
 * policy, which should be set to allkeys-lru in production).
 */

const USE_MEMORY = !process.env.REDIS_URL;
const TTL_SECONDS = 60 * 60 * 24; // 24h

let client;

if (USE_MEMORY) {
  console.log('[cache] REDIS_URL not set -> using in-memory Map (demo mode)');
  const store = new Map(); // key -> { value, expiresAt }

  client = {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlSeconds = TTL_SECONDS) {
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async del(key) {
      store.delete(key);
    },
    async incr(counterKey) {
      const entry = store.get(counterKey);
      const next = (entry ? Number(entry.value) : 0) + 1;
      store.set(counterKey, { value: String(next), expiresAt: Infinity });
      return next;
    },
  };
} else {
  const Redis = require('ioredis');
  const redis = new Redis(process.env.REDIS_URL);

  client = {
    async get(key) {
      return redis.get(key);
    },
    async set(key, value, ttlSeconds = TTL_SECONDS) {
      await redis.set(key, value, 'EX', ttlSeconds);
    },
    async del(key) {
      await redis.del(key);
    },
    async incr(counterKey) {
      return redis.incr(counterKey);
    },
  };
}

module.exports = client;
