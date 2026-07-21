# Snip — Scalable URL Shortener

A URL shortener built to demonstrate system design fundamentals: **Base62
encoding**, **cache-aside Redis caching**, **relational storage**, and an
**async analytics pipeline** — with a working frontend + backend + REST API.

Resume line this project backs up:
> Built a scalable URL shortener service supporting high-throughput
> redirection using Base62 encoding, Redis caching, and relational database
> storage, with optional analytics pipeline for click tracking.

---

## 1. Architecture at a glance

```
                 ┌─────────────┐
   Browser  ───▶ │  Frontend    │  (static HTML/JS, fetch() calls)
                 └──────┬───────┘
                        │ REST (JSON)
                        ▼
                 ┌─────────────┐
                 │  Express API │  server.js
                 └──────┬───────┘
             ┌──────────┼───────────┐
             ▼          ▼           ▼
        ┌────────┐ ┌─────────┐ ┌───────────┐
        │ Redis   │ │ Postgres│ │ Analytics │
        │ (cache) │ │ (source │ │  queue    │
        │         │ │ of truth)│ │ (async)   │
        └────────┘ └─────────┘ └───────────┘
```

- **Write path** (`POST /api/shorten`): validate → insert row in Postgres to
  get an auto-increment `id` → Base62-encode `id` → save `short_code` → warm
  the Redis cache.
- **Read path** (`GET /:code`): check Redis first (cache-aside) → on miss,
  read Postgres → populate cache → redirect. Click is recorded
  asynchronously so the redirect itself is never slowed down by analytics.

---

## 2. Project layout

```
url-shortener/
  backend/
    src/
      base62.js          # encode/decode integer <-> short code
      db.js               # Postgres access (falls back to in-memory demo mode)
      cache.js            # Redis access (falls back to in-memory demo mode)
      shortenerService.js # business logic + analytics queue
      routes/urls.js      # REST endpoints
      server.js            # Express app, rate limiting, error handling
    package.json
    .env.example
  frontend/
    index.html            # single-page UI, no framework needed
```

## 3. Running it

```bash
cd backend
npm install
cp .env.example .env      # optional — see below
npm start                 # http://localhost:3000
```

**No Postgres/Redis installed?** That's fine — leave `DATABASE_URL` and
`REDIS_URL` unset in `.env` and the app automatically runs in **demo mode**,
using an in-memory Map in place of each. Same code path, same interfaces,
just swapped implementations. This is worth mentioning in an interview: it's
the **adapter/repository pattern** — the rest of the app never talks to `pg`
or `ioredis` directly, only to `db.js`/`cache.js`'s exported functions, so
the storage engine is swappable without touching business logic.

For a "real" run: set `DATABASE_URL=postgres://...` and
`REDIS_URL=redis://...` in `.env`.

---

## 4. Step-by-step: how a request flows (what to say in an interview)

### Creating a short URL
1. Client `POST /api/shorten` with `{ longUrl }`.
2. Server validates the URL format (`http(s)://...`, length cap) to reject
   garbage input early — cheap check before touching the DB.
3. Server inserts a row into Postgres with an empty `short_code` and lets
   Postgres assign the auto-increment `id` (`BIGSERIAL`). This id is the
   **single source of uniqueness**.
4. `base62.encode(id)` converts that integer to a short alphanumeric string.
   Example: id `125` → `"cb"` in base62.
5. The row is updated with its `short_code`, and Redis is pre-warmed with
   `short_code -> longUrl` so the very first redirect is already a cache hit.
6. Response returns the full short URL to the client.

### Why Base62 and not just hash the URL?
- Hashing (MD5/SHA1 truncated) can **collide** — two different URLs can map
  to the same short code, and you only discover it *after* trying to
  insert, forcing a retry loop.
- Encoding a **monotonic integer ID** guarantees uniqueness by construction:
  no collision checks, no retries, O(1) generation.
- Base62 (`0-9A-Za-z`) is used instead of Base64 because it avoids `+` and
  `/`, which aren't URL-path-safe and would need escaping.

### Redirecting a short URL
1. Client hits `GET /:code`.
2. Server checks Redis first. **Cache hit** → respond with a `302` redirect
   in ~1ms, no database touched at all.
3. **Cache miss** → query Postgres by `short_code` (indexed column), then
   populate Redis for next time, then redirect.
4. Regardless of hit/miss, the click event is pushed onto an **in-memory
   analytics queue** — not written synchronously — so the user's redirect
   is never held up waiting on an analytics insert.
5. A background timer flushes the queue to the `clicks` table every 2
   seconds in a batch, which is far cheaper than one INSERT per click.

### Why cache-aside instead of write-through?
Cache-aside (lazy loading) was chosen because reads vastly outnumber writes
for a URL shortener (people click links far more often than they create
them). It also means the cache only ever holds what's actually being
requested, keeping memory usage proportional to real traffic instead of
mirroring the entire dataset.

### Why is analytics "optional" / decoupled?
If the analytics write path fails (DB hiccup, queue backlog), it must never
break the core feature — redirecting the user. Decoupling it onto a queue
means a slow or failing analytics sink degrades gracefully (you lose some
click data) instead of taking down redirects. In a larger deployment, this
in-memory queue would be replaced by **Kafka / SQS / Redis Streams**, with
a separate consumer service doing the batch writes — same idea, just
distributed instead of in-process.

---

## 5. Scalability & reliability — talking points

| Concern | How it's addressed |
|---|---|
| **High read throughput** | Redis cache-aside absorbs the vast majority of redirect traffic; Postgres only sees cache misses and writes. |
| **Horizontal scaling** | The API is stateless — no in-process session state is required for correctness (the demo's in-memory rate limiter is the one exception, called out below). Multiple API instances can sit behind a load balancer, all reading/writing the same Postgres + Redis. |
| **Collision safety** | Base62(auto-increment id) can't collide by construction — no locking or retry logic needed even under concurrent writes. |
| **DB write scaling** | Writes (`POST /api/shorten`) are far rarer than reads, so a single primary Postgres instance with read replicas is normally enough; if not, the id generator can be swapped for a distributed one (Snowflake IDs, or a Redis `INCR` counter shared across instances). |
| **Fault isolation** | Analytics is decoupled via a queue so it can degrade without affecting redirects. |
| **Rate limiting** | The write endpoint is throttled per IP to prevent abuse. In this demo it's an in-memory token bucket; in a multi-instance deployment this should move to Redis (`INCR` + `EXPIRE`) so limits are enforced cluster-wide, not per-instance. |
| **Expiry** | URLs can carry an optional `expires_at`; expired codes are treated as not-found on read. |
| **Data durability** | Postgres is the source of truth; Redis is purely a performance cache and can be flushed/restarted without losing data — it just gets repopulated on demand. |

## 6. Things to mention as "what I'd add for production"
- Move the rate limiter and id counter (if not using DB sequence) into
  Redis so limits/state are shared across instances.
- Replace the in-memory analytics queue with Kafka/SQS + a consumer
  service, and land click events in a columnar store (ClickHouse/BigQuery)
  suited for analytical queries (clicks/day, top referrers, etc.).
- Add a CDN/edge layer in front of the redirect endpoint for geographically
  distributed low-latency redirects.
- Add authentication (API keys/JWT) for per-user link ownership and
  dashboards, and custom-alias support with a uniqueness check against
  reserved/collision cases.
- Add structured logging + metrics (Prometheus) around cache hit ratio,
  redirect latency, and queue depth — the numbers you'd actually watch in
  production for this kind of service.

## 7. API reference

| Method | Path | Description |
|---|---|---|
| POST | `/api/shorten` | Body `{ longUrl, expiresAt? }` → `{ shortCode, shortUrl, longUrl, createdAt }` |
| GET | `/:code` | 302 redirect to the original URL |
| GET | `/api/urls/:code/stats` | `{ short_code, click_count, created_at }` |
| GET | `/health` | Liveness check |
