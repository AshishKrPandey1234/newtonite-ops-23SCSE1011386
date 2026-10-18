import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const KEY_LENGTH = 64;

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, expectedHash) {
  const actual = scryptSync(password, salt, KEY_LENGTH);
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function digestToken(token) {
  return createHash('sha256').update(token).digest('hex');
}
