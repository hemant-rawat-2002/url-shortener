/**
 * Base62 Encoder/Decoder
 * ----------------------
 * Why Base62 instead of Base64?
 *  - Base64 includes '+' and '/' which are not URL-safe.
 *  - Base62 uses only [0-9a-zA-Z] -> every character is safe to put
 *    directly into a URL path with no escaping.
 *
 * Why encode an integer ID instead of hashing the URL?
 *  - Hashing (e.g. MD5/SHA + truncate) can collide, and you only find
 *    out *after* insertion, forcing retries under load.
 *  - Encoding a monotonically increasing integer (DB auto-increment /
 *    a Redis INCR counter / a Snowflake-style ID) guarantees uniqueness
 *    by construction -> zero collision checks, zero retries.
 *  - It's also reversible: decode(code) -> id lets us jump straight to
 *    a DB row by primary key (O(1) lookup, no secondary index needed
 *    if we want it, though we still index short_code for direct reads).
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = ALPHABET.length; // 62

function encode(num) {
  if (num === 0) return ALPHABET[0];
  let str = '';
  let n = BigInt(num);
  const base = BigInt(BASE);
  while (n > 0n) {
    str = ALPHABET[Number(n % base)] + str;
    n = n / base;
  }
  return str;
}

function decode(str) {
  let num = 0n;
  const base = BigInt(BASE);
  for (const ch of str) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base62 character: ${ch}`);
    num = num * base + BigInt(idx);
  }
  return num.toString();
}

module.exports = { encode, decode };
