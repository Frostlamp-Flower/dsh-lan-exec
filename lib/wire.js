/**
 * Wire format: one token per request, exactly the habit the harness itself uses
 * for machine-to-machine calls (a bearer credential on every request, no
 * long-lived handshake state).
 *
 * Both ends still verify each other:
 *   - the request carries the caller's own token; the executor compares it with
 *     the credential it was configured with;
 *   - the response carries an HMAC over the nonce, status and body, keyed with
 *     the executor's token; the caller compares it with the token it holds.
 *
 * Neither token is transmitted as a payload field: the caller's token travels
 * only as the bearer credential, and the executor's token never leaves its host.
 * Per-request key material is derived from both tokens plus the nonce, so the
 * sealed body differs on every call and a replayed frame cannot be opened.
 *
 * @module dsh-lan-exec/wire
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Protocol version carried by every frame. */
export const PROTOCOL_VERSION = 1

/** Bytes in one request nonce. */
const NONCE_BYTES = 16

/**
 * HMAC-SHA256 over the parts joined by NUL, base64url-encoded.
 * @param {Buffer|string} key - MAC key.
 * @param {readonly (string|number)[]} parts - message parts.
 * @returns {string} base64url tag.
 */
export function hmac(key, parts) {
  const mac = createHmac('sha256', key)
  for (const part of parts) {
    mac.update(String(part), 'utf8')
    mac.update(Buffer.from([0]))
  }
  return mac.digest('base64url')
}

/**
 * Constant-time string comparison.
 * @param {string} expected - value computed locally.
 * @param {string} received - value from the peer.
 * @returns {boolean} whether they are identical.
 */
export function constantEquals(expected, received) {
  const a = Buffer.from(String(expected), 'utf8')
  const b = Buffer.from(String(received ?? ''), 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Mint one request nonce.
 * @returns {string} base64url nonce.
 */
export function createNonce() {
  return randomBytes(NONCE_BYTES).toString('base64url')
}

/**
 * Derive the key that seals one request/response pair.
 * @param {string} callerToken - the calling host's credential.
 * @param {string} executorToken - the executing host's credential.
 * @param {string} nonce - request nonce.
 * @returns {Buffer} 32-byte AES-256-GCM key.
 */
export function requestKey(callerToken, executorToken, nonce) {
  return createHash('sha256')
    .update('dshlan/v2/request\0', 'utf8')
    .update(callerToken, 'utf8')
    .update('\0', 'utf8')
    .update(executorToken, 'utf8')
    .update('\0', 'utf8')
    .update(nonce, 'utf8')
    .digest()
}

/**
 * Proof the executor stamps on every response.
 * @param {string} executorToken - the executor's credential.
 * @param {string} nonce - request nonce.
 * @param {number} status - HTTP status.
 * @param {string} body - raw response body.
 * @returns {string} base64url tag.
 */
export function responseProof(executorToken, nonce, status, body) {
  const digest = createHash('sha256').update(body, 'utf8').digest('base64url')
  return hmac(executorToken, ['dshlan/v2/response', nonce, status, digest])
}

/**
 * Seal one JSON value into a transport envelope bound to its direction.
 * @param {Buffer} key - per-request key.
 * @param {readonly (string|number)[]} aadParts - associated data.
 * @param {unknown} value - JSON value.
 * @returns {{iv: string, ct: string, tag: string}} envelope.
 */
export function seal(key, aadParts, value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aadParts.join('\n'), 'utf8'))
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()])
  return { iv: iv.toString('base64url'), ct: ct.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }
}

/**
 * Open one transport envelope, rejecting anything sealed for another slot.
 * @param {Buffer} key - per-request key.
 * @param {readonly (string|number)[]} aadParts - associated data.
 * @param {{iv?: unknown, ct?: unknown, tag?: unknown}} envelope - received frame.
 * @returns {unknown} the decoded JSON value.
 * @throws {Error} when the envelope is malformed or fails authentication.
 */
export function open(key, aadParts, envelope) {
  const iv = Buffer.from(String(envelope?.iv ?? ''), 'base64url')
  const ct = Buffer.from(String(envelope?.ct ?? ''), 'base64url')
  const tag = Buffer.from(String(envelope?.tag ?? ''), 'base64url')
  if (iv.length !== 12 || tag.length !== 16) throw new Error('malformed envelope')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.from(aadParts.join('\n'), 'utf8'))
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ct), decipher.final()])
  return JSON.parse(plain.toString('utf8'))
}
