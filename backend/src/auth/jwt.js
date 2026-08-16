/**
 * Minimal JWT (HS256) — implemented by hand instead of pulling in
 * `jsonwebtoken`, specifically so every part of it is something you can
 * explain, not a black box.
 *
 * A JWT is just: base64url(header) + "." + base64url(payload) + "." + signature
 * where signature = HMAC-SHA256(header + "." + payload, secret).
 *
 * Verifying is: recompute that same HMAC over the received header+payload
 * and compare it (in constant time) to the signature that came with the
 * token. If they match, the token wasn't tampered with, because only
 * someone holding the secret could have produced that signature.
 *
 * What a JWT does NOT do: encrypt the payload. It's signed, not sealed —
 * anyone can base64-decode the payload and read it. Only put non-secret
 * claims (user id, email) in it, never passwords or sensitive data.
 */

const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString();
}

function sign(payload, secret, expiresInSeconds = 7 * 24 * 60 * 60) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(fullPayload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${signingInput}.${signature}`;
}

function verify(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, signature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(base64urlDecode(encodedPayload));
  } catch {
    return null;
  }

  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    return null;
  }

  return payload;
}

module.exports = { sign, verify };