import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$/;

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
