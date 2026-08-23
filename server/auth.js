import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const SALT_ROUNDS = 10;
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$/;

// A session cookie's value. Opaque and unguessable -- nothing about the user
// is encoded in it, so it carries no information on its own; the sessions
// table is what maps it back to a user_id.
export function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function isBcryptHash(value) {
  return typeof value === 'string' && BCRYPT_HASH_PATTERN.test(value);
}

export async function hashPassword(plainPassword) {
  return bcrypt.hash(String(plainPassword), SALT_ROUNDS);
}

export async function verifyPassword(plainPassword, storedHash) {
  if (!storedHash || !isBcryptHash(storedHash)) return false;
  return bcrypt.compare(String(plainPassword), storedHash);
}
