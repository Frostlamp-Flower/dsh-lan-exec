/**
 * The shared data space: a small JSON store, keyed by string, that both paired
 * hosts keep as an identical copy.
 *
 * Both ends write the same file format. The server is the merge point: client
 * mutations are applied there first and mirrored locally, and the client pulls
 * any server-side change on reconnect and on a slow poll. Writes are sequenced
 * by a monotonic revision so a late sync cannot resurrect an older value.
 *
 * Limits: 1 GiB of stored values by default, one entry per key, 8 MiB per value.
 *
 * @module dsh-lan-exec/store
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** Default ceiling for the whole store. */
export const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024

/** Ceiling for one value, sized so a write fits one RPC frame. */
export const MAX_VALUE_BYTES = 8 * 1024 * 1024

/** Longest accepted key. */
const MAX_KEY_LENGTH = 256

/**
 * Validate a key.
 * @param {unknown} key - candidate key.
 * @returns {string} the key.
 */
export function assertKey(key) {
  if (typeof key !== 'string' || key.length === 0) throw new Error('store key must be a non-empty string')
  if (key.length > MAX_KEY_LENGTH) throw new Error(`store key is longer than ${MAX_KEY_LENGTH} characters`)
  if (/[\u0000-\u001f]/.test(key)) throw new Error('store key must not contain control characters')
  return key
}

/**
 * Serialized size of one JSON value.
 * @param {unknown} value - JSON value.
 * @returns {number} bytes.
 */
function sizeOf(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/**
 * Open (or create) one store file.
 * @param {object} options - store options.
 * @param {string} options.file - absolute path of the JSON file.
 * @param {number} [options.maxBytes] - total ceiling.
 * @param {(level: string, message: string) => void} [options.log] - logger.
 * @returns {object} store handle.
 */
export function createStore({ file, maxBytes = DEFAULT_MAX_BYTES, log = () => {} }) {
  /** @type {{rev: number, entries: Map<string, {value: unknown, rev: number, updatedAt: number, bytes: number}>, bytes: number}} */
  const state = { rev: 0, entries: new Map(), bytes: 0 }

  /** Load the file if it exists. */
  function load() {
    try {
      const text = fs.readFileSync(file, 'utf8')
      const parsed = JSON.parse(text)
      if (parsed?.version !== 1 || typeof parsed.entries !== 'object') throw new Error('unsupported store format')
      state.rev = Number.isInteger(parsed.rev) ? parsed.rev : 0
      state.entries.clear()
      state.bytes = 0
      for (const [key, entry] of Object.entries(parsed.entries)) {
        const bytes = Number(entry?.bytes) || sizeOf(entry?.value)
        state.entries.set(key, { value: entry?.value, rev: Number(entry?.rev) || 0, updatedAt: Number(entry?.updatedAt) || 0, bytes })
        state.bytes += bytes
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') log('warn', `store file ${file} could not be read (${error.message}); starting empty`)
    }
  }

  /** Persist atomically. */
  function save() {
    const payload = {
      version: 1,
      rev: state.rev,
      entries: Object.fromEntries(
        [...state.entries.entries()].map(([key, entry]) => [key, { value: entry.value, rev: entry.rev, updatedAt: entry.updatedAt, bytes: entry.bytes }]),
      ),
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(payload), 'utf8')
    fs.renameSync(temporary, file)
  }

  /**
   * Apply one mutation.
   * @param {'create'|'update'|'delete'} op - operation.
   * @param {string} key - entry key.
   * @param {unknown} [value] - value for create/update.
   * @param {number} [rev] - caller-supplied revision; omitted means "next".
   * @returns {{rev: number, key: string}} applied revision.
   */
  function apply(op, key, value, rev) {
    assertKey(key)
    const existing = state.entries.get(key)
    if (op === 'create') {
      if (existing !== undefined) throw Object.assign(new Error(`entry "${key}" already exists`), { code: 'EEXIST' })
      const bytes = sizeOf(value)
      if (bytes > MAX_VALUE_BYTES) throw Object.assign(new Error(`value is ${bytes} bytes; the per-entry limit is ${MAX_VALUE_BYTES}`), { code: 'ETOOBIG' })
      if (state.bytes + bytes > maxBytes) throw Object.assign(new Error(`store would exceed its ${maxBytes}-byte budget`), { code: 'EFULL' })
      const next = rev ?? state.rev + 1
      state.entries.set(key, { value, rev: next, updatedAt: Date.now(), bytes })
      state.bytes += bytes
      state.rev = Math.max(state.rev, next)
      return { rev: state.rev, key }
    }
    if (op === 'update') {
      if (existing === undefined) throw Object.assign(new Error(`entry "${key}" does not exist`), { code: 'ENOENT' })
      const bytes = sizeOf(value)
      if (bytes > MAX_VALUE_BYTES) throw Object.assign(new Error(`value is ${bytes} bytes; the per-entry limit is ${MAX_VALUE_BYTES}`), { code: 'ETOOBIG' })
      if (state.bytes - existing.bytes + bytes > maxBytes) throw Object.assign(new Error(`store would exceed its ${maxBytes}-byte budget`), { code: 'EFULL' })
      const next = rev ?? state.rev + 1
      state.entries.set(key, { value, rev: next, updatedAt: Date.now(), bytes })
      state.bytes += bytes - existing.bytes
      state.rev = Math.max(state.rev, next)
      return { rev: state.rev, key }
    }
    if (op === 'delete') {
      if (existing === undefined) throw Object.assign(new Error(`entry "${key}" does not exist`), { code: 'ENOENT' })
      state.entries.delete(key)
      state.bytes -= existing.bytes
      state.rev += 1
      return { rev: state.rev, key }
    }
    throw new Error(`unknown store operation "${op}"`)
  }

  return {
    load,
    /**
     * Read one entry.
     * @param {string} key - entry key.
     * @returns {unknown} the value.
     */
    read(key) {
      const entry = state.entries.get(assertKey(key))
      if (entry === undefined) throw Object.assign(new Error(`entry "${key}" does not exist`), { code: 'ENOENT' })
      return entry.value
    },
    /**
     * List keys, optionally filtered by prefix.
     * @param {string} [prefix] - prefix filter.
     * @returns {Array<{key: string, bytes: number, rev: number, updatedAt: number}>} rows.
     */
    list(prefix = '') {
      return [...state.entries.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => ({ key, bytes: entry.bytes, rev: entry.rev, updatedAt: entry.updatedAt }))
    },
    /**
     * One mutation, persisted.
     * @param {'create'|'update'|'delete'} op - operation.
     * @param {string} key - key.
     * @param {unknown} [value] - value.
     * @param {number} [rev] - revision.
     * @returns {{rev: number, key: string}} applied revision.
     */
    mutate(op, key, value, rev) {
      const outcome = apply(op, key, value, rev)
      save()
      return outcome
    },
    /** @returns {{rev: number, entries: number, bytes: number, maxBytes: number}} store statistics. */
    stat() {
      return { rev: state.rev, entries: state.entries.size, bytes: state.bytes, maxBytes }
    },
    /**
     * Adopt the ceiling the executor publishes. Kept local to this copy so both
     * ends enforce the same budget; lowering it below current usage is allowed
     * and blocks further growth.
     * @param {number} next - byte ceiling.
     */
    setMaxBytes(next) {
      if (Number.isFinite(next) && next >= 0) maxBytes = Math.floor(next)
    },
    /** @returns {string} digest of the current contents. */
    digest() {
      const canonical = JSON.stringify([state.rev, [...state.entries.entries()].sort(([a], [b]) => (a < b ? -1 : 1))])
      return createHash('sha256').update(canonical).digest('base64url').slice(0, 16)
    },
    /**
     * Export the full contents for replication.
     * @param {number} [sinceRev] - only entries newer than this revision.
     * @returns {{rev: number, entries: Record<string, {value: unknown, rev: number, updatedAt: number}>}} snapshot.
     */
    export(sinceRev = 0) {
      const entries = {}
      for (const [key, entry] of state.entries) {
        if (entry.rev > sinceRev) entries[key] = { value: entry.value, rev: entry.rev, updatedAt: entry.updatedAt }
      }
      return { rev: state.rev, entries }
    },
    /**
     * Merge a peer snapshot, keeping the newer revision per key.
     * @param {{rev?: number, entries?: Record<string, {value: unknown, rev?: number, updatedAt?: number}>}} snapshot - peer contents.
     * @returns {{applied: number, rev: number}} merge outcome.
     */
    merge(snapshot) {
      let applied = 0
      for (const [key, incoming] of Object.entries(snapshot?.entries ?? {})) {
        try {
          assertKey(key)
        } catch {
          continue
        }
        const entry = state.entries.get(key)
        const incomingRev = Number(incoming?.rev) || 0
        if (entry !== undefined && entry.rev >= incomingRev) continue
        const bytes = sizeOf(incoming?.value)
        if (bytes > MAX_VALUE_BYTES) continue
        if (state.bytes - (entry?.bytes ?? 0) + bytes > maxBytes) continue
        state.entries.set(key, { value: incoming?.value, rev: incomingRev, updatedAt: Number(incoming?.updatedAt) || Date.now(), bytes })
        state.bytes += bytes - (entry?.bytes ?? 0)
        applied += 1
      }
      state.rev = Math.max(state.rev, Number(snapshot?.rev) || 0)
      if (applied > 0) save()
      return { applied, rev: state.rev }
    },
    /** Replace contents wholesale (used when adopting the authoritative copy). */
    replace(snapshot) {
      state.entries.clear()
      state.bytes = 0
      for (const [key, incoming] of Object.entries(snapshot?.entries ?? {})) {
        const bytes = sizeOf(incoming?.value)
        state.entries.set(key, { value: incoming?.value, rev: Number(incoming?.rev) || 0, updatedAt: Number(incoming?.updatedAt) || 0, bytes })
        state.bytes += bytes
      }
      state.rev = Number(snapshot?.rev) || 0
      save()
    },
  }
}

/**
 * Bindings exposed to programs as the `store` namespace.
 * @param {object} store - store handle.
 * @returns {Record<string, Function>} binding functions.
 */
export function storeBindings(store) {
  return {
    create: async (args) => store.mutate('create', args?.key, args?.value),
    update: async (args) => store.mutate('update', args?.key, args?.value),
    read: async (args) => store.read(args?.key),
    delete: async (args) => store.mutate('delete', args?.key),
    list: async (args) => store.list(args?.prefix ?? ''),
    stat: async () => store.stat(),
  }
}
