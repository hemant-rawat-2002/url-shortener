const express = require('express');
const router = express.Router();
const db = require('../db');
const { hashPassword, verifyPassword } = require('./password');
const jwt = require('./jwt');
const { requireAuth, SECRET } = require('./middleware');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/api/auth/signup', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: 'A valid email is required' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await db.getUserByEmail(normalizedEmail);
    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }

    const passwordHash = hashPassword(password);
    let user;
    try {
      user = await db.insertUser({ email: normalizedEmail, passwordHash });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'An account with that email already exists' });
      }
      throw err;
    }

    const token = jwt.sign({ sub: String(user.id), email: user.email }, SECRET);
    res.status(201).json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    next(err);
  }
});

router.post('/api/auth/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await db.getUserByEmail(normalizedEmail);

    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ sub: String(user.id), email: user.email }, SECRET);
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    next(err);
  }
});

router.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;