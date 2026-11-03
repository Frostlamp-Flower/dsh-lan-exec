/**
 * Credential minting for the LAN bridge.
 *
 * The strength mirrors what the harness itself uses for machine-issued secrets:
 * 256 bits from the platform CSPRNG (`crypto.getRandomValues` in the browser
 * bundle, `randomBytes` here), encoded as unpadded base64url so the value is
 * copy-pasteable and URL-safe.
 *
 * @module dsh-lan-exec/token
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Bytes of entropy behind one credential. 32 bytes = 256 bits. */
export const TOKEN_BYTES = 32

/** Prefix that makes a pasted credential recognizable at a glance. */
export const TOKEN_PREFIX = 'dshlan_'

/**
 * Mint one credential.
 * @returns {string} `dshlan_` + 43 base64url characters.
 */
export function generateToken() {
  return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url')
}

/**
 * A short, non-secret label for one credential, safe to print in logs and in
 * the pairing card; the credential itself never leaves its owner.
 * @param {string} token - the credential.
 * @returns {string} ten base64url characters of its SHA-256 digest.
 */
export function fingerprint(token) {
  return createHash('sha256').update(token, 'utf8').digest('base64url').slice(0, 10)
}

/**
 * Constant-time comparison of two UTF-8 strings.
 * @param {string} left - first string.
 * @param {string} right - second string.
 * @returns {boolean} whether they are byte-identical.
 */
export function secureEquals(left, right) {
  const a = Buffer.from(String(left), 'utf8')
  const b = Buffer.from(String(right), 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Whether a configured credential looks like one this module minted. The check
 * is advisory: a hand-written strong secret is still accepted.
 * @param {string} token - candidate credential.
 * @returns {boolean} whether a warning should be printed.
 */
export function looksWeak(token) {
  return typeof token !== 'string' || token.length < 40
}
