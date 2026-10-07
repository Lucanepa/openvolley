#!/usr/bin/env node
// Desktop updater signatures and manifest, for publish-pkgs.sh --desktop.
// Node only, no npm dependencies (node:crypto has Ed25519 and BLAKE2b-512).
//
//   desktop-updater.mjs pubkey   --tauri-conf FILE
//       Print the updater public key the app trusts (plugins.updater.pubkey).
//   desktop-updater.mjs verify   (--tauri-conf FILE | --pubkey B64) --version V FILE...
//       Check FILE.sig for each FILE, the way the app's updater does.
//   desktop-updater.mjs manifest (--tauri-conf FILE | --pubkey B64) --version V --out FILE
//                                --nsis FILE URL --appimage FILE URL --deb FILE URL
//                                [--app FILE URL] [--notes-file FILE] [--pub-date RFC3339]
//       Verify the signatures, then write latest.json. --app: the macOS
//       universal .app.tar.gz, announced for both Mac architectures.
//   desktop-updater.mjs check    (--tauri-conf FILE | --pubkey B64) [--version V] [--dir DIR] FILE
//       Validate a latest.json; with --dir, also verify every signature against
//       the file named like the last segment of its URL in DIR.
//   desktop-updater.mjs compare  A B
//       Print -1, 0 or 1 (semver precedence of A against B).
//
// Signature format (tauri signer = minisign): FILE.sig holds base64 of
//   untrusted comment: ...\n
//   base64("ED" | key id (8) | Ed25519(BLAKE2b-512(file)) (64))\n
//   trusted comment: timestamp:...\tfile:...\tversion:V\n
//   base64(Ed25519(signature (64) | trusted comment text))\n
// and the public key is base64 of
//   untrusted comment: minisign public key: KEYID\n
//   base64("Ed" | key id (8) | Ed25519 public key (32))\n
// This mirrors tauri-plugin-updater 2.12 (verify_signature, verify_signed_version,
// RemoteRelease deserialization, get_urls) and minisign-verify 0.2: a version
// that verifies here verifies in the app (requireSignedVersion: true).
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto'
import { createReadStream, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'

// Targets the updater looks up, in its order: {os}-{arch}-{installer}, then {os}-{arch}.
// The bare fallbacks only matter for an app whose bundle type is unknown; they
// point at the same file as the bundle-specific key next to them.
export const PLATFORMS = {
  'windows-x86_64-nsis': 'nsis',
  'windows-x86_64': 'nsis',
  'linux-x86_64-appimage': 'appimage',
  'linux-x86_64': 'appimage',
  'linux-x86_64-deb': 'deb',
}
// macOS: one universal .app.tar.gz for both architectures (each slice looks
// up its own darwin-{arch}). All four or none: a release built before the
// macOS job, or whose macOS build failed, announces no Mac update.
export const MAC_PLATFORMS = {
  'darwin-aarch64-app': 'app',
  'darwin-aarch64': 'app',
  'darwin-x86_64-app': 'app',
  'darwin-x86_64': 'app',
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

export class UpdaterError extends Error {}
const fail = (msg) => { throw new UpdaterError(msg) }

// Strict base64: what Rust's base64 STANDARD engine accepts (padding, no junk).
function b64(s, what) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4) fail(`${what}: not base64`)
  const buf = Buffer.from(s, 'base64')
  if (buf.toString('base64') !== s) fail(`${what}: not canonical base64`)
  return buf
}

function utf8(buf, what) {
  const s = buf.toString('utf8')
  if (!Buffer.from(s, 'utf8').equals(buf)) fail(`${what}: not UTF-8`)
  return s
}

// Rust str::lines(): split on \n, drop one trailing \r per line.
const lines = (s) => s.split('\n').map((l) => l.replace(/\r$/, ''))

export function parsePublicKey(tauriB64) {
  const text = utf8(b64(tauriB64.trim(), 'public key'), 'public key')
  const [comment, keyLine] = lines(text)
  if (keyLine === undefined) fail('public key: expected two lines')
  const bin = b64(keyLine, 'public key')
  if (bin.length !== 42) fail('public key: wrong length')
  if (bin.subarray(0, 2).toString('latin1') !== 'Ed') fail('public key: not an Ed25519 minisign key')
  const keyId = bin.subarray(2, 10)
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: bin.subarray(10).toString('base64url') }, format: 'jwk' })
  return { comment, keyId, key, keyIdHex: Buffer.from(keyId).reverse().toString('hex').toUpperCase() }
}

export function parseSignature(tauriB64) {
  const text = utf8(b64(tauriB64.trim(), 'signature'), 'signature')
  const [untrusted, sigLine, trusted, globalLine] = lines(text)
  if (globalLine === undefined) fail('signature: expected four lines')
  const bin = b64(sigLine, 'signature')
  if (bin.length !== 74) fail('signature: wrong length')
  const global = b64(globalLine, 'signature')
  if (global.length !== 64) fail('signature: wrong global signature length')
  if (!trusted.startsWith('trusted comment: ')) fail('signature: no trusted comment')
  const alg = bin.subarray(0, 2).toString('latin1')
  // tauri signer always prehashes ("ED"); a legacy "Ed" signature would mean
  // the file was not signed by our pipeline.
  if (alg !== 'ED') fail(`signature: algorithm ${JSON.stringify(alg)}, expected prehashed "ED"`)
  const trustedComment = trusted.slice(17)
  const fields = Object.fromEntries(trustedComment.split('\t').map((f) => {
    const i = f.indexOf(':')
    return i < 0 ? [f, ''] : [f.slice(0, i), f.slice(i + 1)]
  }))
  return { untrusted, keyId: bin.subarray(2, 10), sig: bin.subarray(10), trustedComment, fields, global }
}

async function blake2b512(file) {
  const h = createHash('blake2b512')
  for await (const chunk of createReadStream(file)) h.update(chunk)
  return h.digest()
}

function semverParts(v) {
  const m = SEMVER.exec(v)
  if (!m) return null
  return { nums: [m[1], m[2], m[3]].map(BigInt), pre: m[4] ? m[4].split('.') : [] }
}

export function compareVersions(a, b) {
  const pa = semverParts(a.replace(/^v/, ''))
  const pb = semverParts(b.replace(/^v/, ''))
  if (!pa || !pb) fail(`not a semver version: ${pa ? b : a}`)
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1
  if (!pa.pre.length || !pb.pre.length) return pa.pre.length === pb.pre.length ? 0 : (pa.pre.length ? -1 : 1)
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i]; const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x); const ny = /^\d+$/.test(y)
    if (nx && ny) return BigInt(x) < BigInt(y) ? -1 : 1
    if (nx !== ny) return nx ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

// The updater's verify_signed_version: semver equality, else literal.
function sameVersion(signed, announced) {
  try { return compareVersions(signed, announced) === 0 } catch { return signed === announced }
}

// Checks what the signature says without the file: key id and signed version.
export function checkSignatureMeta(sigB64, pub, version, what) {
  const s = parseSignature(sigB64)
  if (!s.keyId.equals(pub.keyId)) {
    fail(`${what}: signed by key ${Buffer.from(s.keyId).reverse().toString('hex').toUpperCase()}, the app trusts ${pub.keyIdHex}`)
  }
  if (!edVerify(null, Buffer.concat([s.sig, Buffer.from(s.trustedComment, 'utf8')]), pub.key, s.global)) {
    fail(`${what}: trusted comment does not verify`)
  }
  if (s.fields.version === undefined) fail(`${what}: no version in the signature (tauri CLI older than 2.12, or signed without --app-version)`)
  if (!sameVersion(s.fields.version, version)) fail(`${what}: signed for version ${s.fields.version}, announced ${version}`)
  return s
}

export async function verifyFile(file, sigB64, pub, version) {
  const what = basename(file)
  const s = checkSignatureMeta(sigB64, pub, version, what)
  if (!edVerify(null, await blake2b512(file), pub.key, s.sig)) fail(`${what}: signature does not match the file`)
  return s
}

export function pubkeyFromConf(confFile) {
  let conf
  try { conf = JSON.parse(readFileSync(confFile, 'utf8')) } catch (e) { fail(`${confFile}: ${e.message}`) }
  const key = conf?.plugins?.updater?.pubkey
  if (typeof key !== 'string' || !key.trim()) {
    fail(`${confFile}: no plugins.updater.pubkey (the app would accept no update signature)`)
  }
  return key.trim()
}

// Mirrors InnerRemoteRelease + get_urls, plus our own stricter rules:
// exactly our five targets (and the four macOS ones, all or none, one file),
// https only, every signature by the trusted key and bound to the announced
// version.
export function checkManifest(m, pub, expectVersion) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) fail('manifest: not a JSON object')
  const allowed = new Set(['version', 'notes', 'pub_date', 'platforms'])
  for (const k of Object.keys(m)) if (!allowed.has(k)) fail(`manifest: unexpected field ${k}`)
  if (typeof m.version !== 'string' || !semverParts(m.version.replace(/^v/, ''))) fail('manifest: version is not semver')
  if (expectVersion !== undefined && !sameVersion(m.version, expectVersion)) fail(`manifest: version ${m.version}, expected ${expectVersion}`)
  if (m.notes !== undefined && m.notes !== null && typeof m.notes !== 'string') fail('manifest: notes is not a string')
  if (m.pub_date !== undefined && m.pub_date !== null) {
    if (typeof m.pub_date !== 'string' || !RFC3339.test(m.pub_date) || Number.isNaN(Date.parse(m.pub_date))) fail('manifest: pub_date is not RFC 3339')
  }
  const p = m.platforms
  if (!p || typeof p !== 'object' || Array.isArray(p)) fail('manifest: no platforms object')
  for (const k of Object.keys(p)) if (!(k in PLATFORMS) && !(k in MAC_PLATFORMS)) fail(`manifest: unexpected platform ${k}`)
  const mac = Object.keys(MAC_PLATFORMS).filter((k) => k in p)
  if (mac.length && mac.length !== Object.keys(MAC_PLATFORMS).length) {
    fail(`manifest: macOS platforms ${mac.join(', ')} without ${Object.keys(MAC_PLATFORMS).filter((k) => !(k in p)).join(', ')}`)
  }
  for (const k of [...Object.keys(PLATFORMS), ...mac]) {
    const e = p[k]
    if (!e || typeof e !== 'object') fail(`manifest: platform ${k} missing`)
    for (const f of Object.keys(e)) if (f !== 'url' && f !== 'signature') fail(`manifest: ${k}: unexpected field ${f}`)
    if (typeof e.url !== 'string') fail(`manifest: ${k}: no url`)
    let u
    try { u = new URL(e.url) } catch { fail(`manifest: ${k}: url is not absolute`) }
    if (u.protocol !== 'https:') fail(`manifest: ${k}: url is not https`)
    if (typeof e.signature !== 'string') fail(`manifest: ${k}: no signature`)
    checkSignatureMeta(e.signature, pub, m.version, `manifest: ${k}`)
  }
  const same = [['windows-x86_64', 'windows-x86_64-nsis'], ['linux-x86_64', 'linux-x86_64-appimage']]
  for (const k of mac.slice(1)) same.push([k, mac[0]])
  for (const [bare, full] of same) {
    if (p[bare].url !== p[full].url || p[bare].signature !== p[full].signature) fail(`manifest: ${bare} differs from ${full}`)
  }
  return m
}

function readSig(file) {
  if (!existsSync(`${file}.sig`)) fail(`${basename(file)}.sig: missing`)
  return readFileSync(`${file}.sig`, 'utf8').trim()
}

function urlName(url) {
  return decodeURIComponent(new URL(url).pathname.split('/').pop())
}

// --- CLI -------------------------------------------------------------------
function parseArgs(argv, spec) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const name = a.slice(2)
    const n = spec[name]
    if (n === undefined) fail(`unknown option ${a}`)
    const vals = argv.slice(i + 1, i + 1 + n)
    if (vals.length < n) fail(`${a} needs ${n} value(s)`)
    out[name] = n === 1 ? vals[0] : vals
    i += n
  }
  return out
}

function pubFrom(o) {
  if (!!o['tauri-conf'] === !!o.pubkey) fail('give exactly one of --tauri-conf or --pubkey')
  return parsePublicKey(o.pubkey ?? pubkeyFromConf(o['tauri-conf']))
}

async function main(argv) {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case 'pubkey': {
      const o = parseArgs(rest, { 'tauri-conf': 1 })
      const key = pubkeyFromConf(o['tauri-conf'])
      parsePublicKey(key)
      process.stdout.write(`${key}\n`)
      return
    }
    case 'verify': {
      const o = parseArgs(rest, { 'tauri-conf': 1, pubkey: 1, version: 1 })
      const pub = pubFrom(o)
      if (!o.version) fail('--version is required')
      if (!o._.length) fail('no files')
      for (const f of o._) {
        const s = await verifyFile(f, readSig(f), pub, o.version)
        console.log(`verified ${basename(f)} (key ${pub.keyIdHex}, ${s.trustedComment.replace(/\t/g, ' ')})`)
      }
      return
    }
    case 'manifest': {
      const o = parseArgs(rest, { 'tauri-conf': 1, pubkey: 1, version: 1, out: 1, nsis: 2, appimage: 2, deb: 2, app: 2, 'notes-file': 1, 'pub-date': 1 })
      const pub = pubFrom(o)
      for (const k of ['version', 'out', 'nsis', 'appimage', 'deb']) if (!o[k]) fail(`--${k} is required`)
      const entries = {}
      const kinds = ['nsis', 'appimage', 'deb', ...(o.app ? ['app'] : [])]
      for (const kind of kinds) {
        const [file, url] = o[kind]
        if (urlName(url) !== basename(file)) fail(`--${kind}: ${url} does not end in ${basename(file)}`)
        const signature = readSig(file)
        await verifyFile(file, signature, pub, o.version)
        entries[kind] = { url, signature }
      }
      const m = { version: o.version }
      const notes = o['notes-file'] ? readFileSync(o['notes-file'], 'utf8').trim() : ''
      if (notes) m.notes = notes
      m.pub_date = o['pub-date'] ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
      const targets = { ...PLATFORMS, ...(o.app ? MAC_PLATFORMS : {}) }
      m.platforms = Object.fromEntries(Object.entries(targets).map(([k, kind]) => [k, entries[kind]]))
      checkManifest(m, pub, o.version)
      writeFileSync(`${o.out}.tmp`, `${JSON.stringify(m, null, 2)}\n`)
      renameSync(`${o.out}.tmp`, o.out)
      console.log(`wrote ${o.out}: ${m.version}, ${Object.keys(m.platforms).join(', ')}`)
      return
    }
    case 'check': {
      const o = parseArgs(rest, { 'tauri-conf': 1, pubkey: 1, version: 1, dir: 1 })
      const pub = pubFrom(o)
      if (o._.length !== 1) fail('give one manifest file')
      let m
      try { m = JSON.parse(readFileSync(o._[0], 'utf8')) } catch (e) { fail(`${o._[0]}: ${e.message}`) }
      checkManifest(m, pub, o.version)
      if (o.dir) {
        for (const [k, e] of Object.entries(m.platforms)) await verifyFile(join(o.dir, urlName(e.url)), e.signature, pub, m.version)
      }
      console.log(`ok ${o._[0]}: ${m.version}${o.dir ? ', signatures match the files' : ''}`)
      return
    }
    case 'compare': {
      if (rest.length !== 2) fail('compare A B')
      console.log(String(compareVersions(rest[0], rest[1])))
      return
    }
    default:
      fail(`unknown command ${cmd ?? '(none)'}; see the header of ${basename(process.argv[1])}`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`desktop-updater: ${e instanceof UpdaterError ? e.message : e.stack}`)
    process.exit(1)
  })
}
