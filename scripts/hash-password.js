#!/usr/bin/env node
/**
 * hash-password.js — generate a PBKDF2 password hash for manual volunteer insertion.
 *
 * Usage:
 *   node scripts/hash-password.js "your-password-here"
 *
 * Output format: "salt:iterations:hash" (base64-encoded salt and hash)
 *
 * This uses the exact same PBKDF2 parameters as the Worker's auth lib
 * (src/lib/auth.js). If you change one, change both.
 *
 * The output is safe to paste into a D1 INSERT. Example:
 *
 *   wrangler d1 execute ouralert --remote --command \
 *     "INSERT INTO volunteers (id, email, password_hash, display_name, role, status, created_at) \
 *      VALUES ('adm_$(openssl rand -hex 8)', 'you@example.com', '<PASTE_HASH_HERE>', \
 *              'Your Name', 'admin', 'active', $(date +%s)000);"
 *
 * Never commit the generated hash. Never share it. Treat it like a password itself.
 */

import { webcrypto } from 'node:crypto';

const ITERATIONS = 100_000;
const SALT_BYTES = 32;
const HASH_BITS = 256;

async function hashPassword(password) {
  if (!password || typeof password !== 'string') {
    throw new Error('Password must be a non-empty string');
  }
  if (password.length < 12) {
    console.warn('\n  WARNING: passwords under 12 characters are not recommended.\n');
  }

  const salt = webcrypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const keyMaterial = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derived = await webcrypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    HASH_BITS
  );

  const saltB64 = Buffer.from(salt).toString('base64');
  const hashB64 = Buffer.from(derived).toString('base64');

  return `${saltB64}:${ITERATIONS}:${hashB64}`;
}

const password = process.argv[2];

if (!password) {
  console.error('\n  Usage: node scripts/hash-password.js "your-password-here"\n');
  console.error('  Wrap the password in quotes to avoid shell interpretation of special characters.\n');
  process.exit(1);
}

hashPassword(password)
  .then(hash => {
    console.log('\n  Password hash (paste into D1 INSERT):\n');
    console.log(`  ${hash}\n`);
    console.log('  See docs/ADMIN_BOOTSTRAP.md for the full INSERT command.\n');
  })
  .catch(err => {
    console.error('\n  Error generating hash:', err.message, '\n');
    process.exit(1);
  });
