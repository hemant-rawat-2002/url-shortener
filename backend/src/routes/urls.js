const express = require('express');
const router = express.Router();
const service = require('../shortenerService');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// POST /api/shorten  { longUrl, expiresAt? }
router.post('/api/shorten', async (req, res, next) => {
  try {
    const { longUrl, expiresAt } = req.body;
    const row = await service.shortenUrl({
      longUrl,
      ownerId: req.headers['x-owner-id'] || null,
      expiresAt,
    });
    res.status(201).json({
      shortCode: row.short_code,
      shortUrl: `${BASE_URL}/${row.short_code}`,
      longUrl: row.long_url,
      createdAt: row.created_at,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/urls/:code/stats
router.get('/api/urls/:code/stats', async (req, res, next) => {
  try {
    const stats = await service.getStats(req.params.code);
    if (!stats) return res.status(404).json({ error: 'Short code not found' });
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

// GET /:code  -> 302 redirect (kept in main app so it can sit at root path)
router.get('/:code', async (req, res, next) => {
  try {
    const result = await service.resolveShortCode(req.params.code, {
      referrer: req.headers.referer,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    if (!result) return res.status(404).json({ error: 'Short URL not found or expired' });
    res.redirect(302, result.longUrl);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
