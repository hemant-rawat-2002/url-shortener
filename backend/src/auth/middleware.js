const jwt = require('./jwt');

const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
if (SECRET === 'dev-insecure-secret-change-me') {
  console.warn('[auth] WARNING: JWT_SECRET not set — using an insecure default. Set JWT_SECRET in production.');
}

function getTokenFromReq(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7);
}

function optionalAuth(req, res, next) {
  const token = getTokenFromReq(req);
  if (token) {
    const payload = jwt.verify(token, SECRET);
    if (payload) req.user = { id: payload.sub, email: payload.email };
  }
  next();
}

function requireAuth(req, res, next) {
  const token = getTokenFromReq(req);
  const payload = token && jwt.verify(token, SECRET);
  if (!payload) return res.status(401).json({ error: 'Authentication required' });
  req.user = { id: payload.sub, email: payload.email };
  next();
}

module.exports = { optionalAuth, requireAuth, SECRET };