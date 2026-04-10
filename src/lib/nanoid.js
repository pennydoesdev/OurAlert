/**
 * lib/nanoid.js — short unique ID generation for Workers.
 *
 * Uses crypto.getRandomValues (available natively in the Workers runtime)
 * with a url-safe alphabet. No external dependency.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const LOWER_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generate a random ID.
 * @param {number} size — length in characters
 * @param {boolean} lowerOnly — use only lowercase letters + digits
 */
export function nanoid(size = 12, lowerOnly = true) {
  const alphabet = lowerOnly ? LOWER_ALPHABET : ALPHABET;
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let id = '';
  for (let i = 0; i < size; i++) {
    id += alphabet[bytes[i] % alphabet.length];
  }
  return id;
}

/**
 * Generate a prefixed ID suitable for a specific entity.
 *   prefixedId('rep') => 'rep_a8s93kfj22x1'
 */
export function prefixedId(prefix, size = 12) {
  return `${prefix}_${nanoid(size)}`;
}
