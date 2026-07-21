const path = require('path');
const express = require('express');
const cors = require('cors');
const db = require('./db');
const urlRoutes = require('./routes/urls');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve the static frontend (index.html) so the whole app runs from one process.
app.use(express.static(path.join(__dirname, '..', '..', 'frontend')));

/**
 * Minimal per-IP rate limiter (token bucket, in-memory).
 * Protects the write path (POST /api/shorten) from abuse/spam.
 * In production with multiple app instances this counter should live
 * in Redis (INCR + EXPIRE) so limits are enforced cluster-wide, not
 * per-instance. Swapping this out is a one-function change since it's
 * isolated here.
 */
const buckets = new Map();
function rateLimit({ windowMs = 60_000, max = 30 } = {}) {
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const bucket = buckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }
    bucket.count += 1;
    buckets.set(key, bucket);
    if (bucket.count > max) {
      return res.status(429).json({ error: 'Too many requests, slow down.' });
    }
    next();
  };
}

app.use('/api/shorten', rateLimit({ windowMs: 60_000, max: 30 }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/', urlRoutes);

// Centralized error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

async function start() {
  await db.init();
  app.listen(PORT, () => console.log(`URL shortener listening on :${PORT}`));
}

start();
