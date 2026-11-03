#!/usr/bin/env node
/**
 * One-click installer for dsh-lan-exec.
 *
 * Installation and mode are separate on purpose: installing only links the
 * package and writes an inert row (`mode: off`). The user picks the mode when
 * they start using it - either from the plugin settings in the app (which edits
 * the same row and reloads through HMR) or with `--mode server|client` here.
 *
 * Usage:
 *   node setup.mjs                                  install only (mode stays off)
 *   node setup.mjs --mode server --port 45870
 *   node setup.mjs --mode client --host 192.168.1.23 --port 45870 --peer-token <token>
 *   node setup.mjs --show
 *   node setup.mjs --uninstall
 *
 * @module dsh-lan-exec/setup
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateToken, fingerprint } from './lib/token.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)

/**
 * Read one `--flag value` pair.
 * @param {string} name - flag name without dashes.
 * @param {string} [fallback] - default.
 * @returns {string} value.
 */
function flag(name, fallback = '') {
  const index = args.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = args[index + 1]
  return typeof value === 'string' && !value.startsWith('--') ? value : fallback
}

/** @returns {boolean} whether the flag is present. */
function has(name) {
  return args.includes(`--${name}`)
}

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileName = flag('profile', process.env.DSH_PROFILE || 'desktop')
const profileDir = path.join(dshHome, 'profiles', profileName)
const patchFile = path.join(profileDir, 'cordis.patch.yml')
const target = path.join(profileDir, 'node_modules', 'dsh-lan-exec')
const ROW_ID = 'lan-exec'

if (!fs.existsSync(profileDir)) {
  console.error(`profile directory not found: ${profileDir}`)
  console.error('start DeepSeek Harness once so the profile exists, or pass --profile <name>')
  process.exit(1)
}

/**
 * Drop the previous `lan-exec` row from the profile patch.
 * @param {string} text - current patch file.
 * @returns {string} patch text without the row.
 */
function stripRow(text) {
  const lines = text.split(/\r?\n/)
  const kept = []
  let skipping = false
  for (const line of lines) {
    if (/^#\s*dsh-lan-exec\b.*written by setup\.mjs/.test(line)) continue
    if (!skipping && /^-\s+id:\s*['"]?lan-exec['"]?\s*$/.test(line.trimEnd())) {
      skipping = true
      continue
    }
    if (skipping) {
      if (/^-\s+/.test(line)) skipping = false
      else continue
    }
    kept.push(line)
  }
  return `${kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/**
 * Read the current row's flat config values.
 * @returns {Record<string, string>} values.
 */
function currentConfig() {
  if (!fs.existsSync(patchFile)) return {}
  const lines = fs.readFileSync(patchFile, 'utf8').split(/\r?\n/)
  const start = lines.findIndex((line) => /^-\s+id:\s*['"]?lan-exec['"]?\s*$/.test(line.trimEnd()))
  if (start === -1) return {}
  const values = {}
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^-\s+/.test(line)) break
    const match = /^\s{4}([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
  return values
}

/**
 * Write the row for one mode.
 * @param {Record<string, unknown>} config - plugin config.
 */
function writeRow(config) {
  const body = Object.entries(config)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `    ${key}: ${typeof value === 'number' ? value : String(value)}`)
    .join('\n')
  const block = `- id: ${ROW_ID}\n  name: dsh-lan-exec\n  config:\n${body}\n`
  const current = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : ''
  const cleaned = stripRow(current).trimEnd()
  fs.writeFileSync(
    patchFile,
    `# dsh-lan-exec - written by setup.mjs. Remove with: node setup.mjs --uninstall\n${cleaned === '' ? '' : `${cleaned}\n`}${block}`,
    'utf8',
  )
}

/**
 * @param {string} candidate - path.
 * @returns {boolean} whether it is a link.
 */
function isLink(candidate) {
  try {
    return fs.lstatSync(candidate).isSymbolicLink()
  } catch {
    return false
  }
}

/** Link (or copy) the package into the profile's node_modules. */
function install() {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (fs.existsSync(target) || isLink(target)) fs.rmSync(target, { recursive: true, force: true })
  try {
    fs.symlinkSync(here, target, 'junction')
  } catch {
    fs.cpSync(here, target, { recursive: true })
  }
}

/**
 * Whether a copy is already installed by the official plugin manager (a real
 * directory rather than our junction). Those installs are managed by DSH, so
 * this script must not replace them behind its back.
 * @returns {boolean} true when the official install owns the directory.
 */
function installedByManager() {
  if (!fs.existsSync(target)) return false
  return !isLink(target)
}

/** @returns {string[]} every non-internal IPv4 address. */
function addresses() {
  const found = []
  for (const rows of Object.values(os.networkInterfaces())) {
    for (const row of rows ?? []) {
      if (row.family === 'IPv4' && row.internal === false) found.push(row.address)
    }
  }
  return found.length > 0 ? found : ['127.0.0.1']
}

/**
 * Print the pairing card for one mode.
 * @param {object} card - card inputs.
 */
function printCard({ mode, token, peerToken, port, host, name }) {
  const lines = ['', '+- dsh-lan-exec -----------------------------------------', `| this host : ${name}`]
  lines.push(`| mode      : ${mode}`)
  if (mode === 'executor') {
    lines.push(`| listen    : 0.0.0.0:${port}`)
    for (const address of addresses()) lines.push(`| reachable : ${address}:${port}`)
  }
  if (mode === 'origin') lines.push(`| connect   : ${host}:${port}`)
  lines.push(
    `| this token : ${token}   (digest ${fingerprint(token)})`,
    `| peer token : ${peerToken || '(paste the other host\'s token)'}`,
    '|',
    '| Each host mints its own token and verifies the other:',
    '| paste this token into the other host as --peer-token.',
    '+----------------------------------------------------------',
    '',
    `profile : ${profileDir}`,
    `patch   : ${patchFile}`,
    '',
    mode === 'off'
      ? 'Installed with mode "off". Pick origin or executor in Settings -> Plugins -> dsh-lan-exec,'
      : 'Restart DeepSeek Harness (or let HMR reload) to apply.',
    mode === 'off' ? 'or re-run setup.mjs with --mode origin|executor.' : '',
    '',
  )
  console.log(lines.filter((line) => line !== '').join('\n'))
}

if (has('uninstall')) {
  if (fs.existsSync(patchFile)) fs.writeFileSync(patchFile, stripRow(fs.readFileSync(patchFile, 'utf8')), 'utf8')
  if (installedByManager()) {
    console.log(`removed the ${ROW_ID} row; the package was installed by DSH itself, so remove it from Settings -> Plugins`)
  } else if (fs.existsSync(target) || isLink(target)) {
    fs.rmSync(target, { recursive: true, force: true })
    console.log(`removed ${ROW_ID} from ${profileDir}`)
  } else {
    console.log(`removed the ${ROW_ID} row from ${profileDir}`)
  }
  process.exit(0)
}

const previous = currentConfig()
const requested = flag('mode', flag('role', ''))

if (has('show')) {
  console.log(JSON.stringify({ profile: profileDir, patch: patchFile, config: previous }, null, 2))
  process.exit(0)
}

if (requested !== '' && !['origin', 'executor', 'server', 'client', 'off'].includes(requested)) {
  console.error('--mode must be "origin", "executor" or "off"')
  process.exit(1)
}

const requestedMode = requested === '' ? (previous.mode ?? previous.role ?? 'off') : requested
const mode = requestedMode === 'server' ? 'executor' : requestedMode === 'client' ? 'origin' : requestedMode
const token = flag('token', previous.token && previous.token.length > 0 ? previous.token : generateToken())
const peerToken = flag('peer-token', previous.peerToken ?? '')
const port = Number(flag('port', previous.port ?? '45870'))
const host = flag('host', previous.host ?? '')
const name = flag('name', previous.name ?? os.hostname())
const maxStoreBytes = Number(flag('max-store-bytes', previous.maxStoreBytes ?? String(1024 * 1024 * 1024)))

if (mode === 'origin' && host === '') {
  console.error('--host is required in origin mode (the LAN address of the executing host)')
  process.exit(1)
}

if (installedByManager() && !has('link')) {
  // DSH owns this directory; keep its install and only write the config row.
  console.log(`package already installed by DSH at ${target}; keeping it (pass --link to replace it with a link to this folder)`)
} else {
  install()
}
writeRow({
  mode,
  name,
  token,
  ...(peerToken ? { peerToken } : {}),
  port,
  ...(mode === 'origin' ? { host } : { bind: '0.0.0.0' }),
  peerName: flag('peer-name', previous.peerName ?? (mode === 'executor' ? 'origin' : 'executor')),
  maxStoreBytes,
})
printCard({ mode, token, peerToken, port, host, name })

