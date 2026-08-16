const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const hashBuf = Buffer.from(hash, 'hex');
  const testHash = crypto.scryptSync(password, salt, 64);
  return hashBuf.length === testHash.length && crypto.timingSafeEqual(hashBuf, testHash);
}

module.exports = { hashPassword, verifyPassword };