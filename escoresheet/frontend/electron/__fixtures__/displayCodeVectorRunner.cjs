'use strict'
/**
 * Runs ./display-code-vectors.json (scoreboard codes,
 * docs/scoreboard-code-spec.md) against a JS implementation of
 * electron/displayCodeCore.cjs (or its generated backend copy
 * backend/lib/displayCodes.js). Used by the frontend vitest and the backend
 * node:test suites; src-tauri/src/display_code.rs has its own runner over the
 * same file. Returns a list of mismatches (empty when everything agrees).
 */

const DEFAULT_IP = '192.0.2.1'
const DEFAULT_OWNER = 'o1'

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  return v
}
const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
const show = (v) => JSON.stringify(v)

/** { "$repeat": [s, n] } -> s repeated n times, anywhere in a value. */
function fill(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.$repeat)) {
    return String(value.$repeat[0]).repeat(value.$repeat[1])
  }
  if (Array.isArray(value)) return value.map(fill)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]))
  return value
}

/**
 * @param {object} core displayCodeCore
 * @param {any} vectors the parsed display-code-vectors.json
 * @param {(text: string) => string} sha256
 * @returns {string[]}
 */
function runDisplayCodeVectors(core, vectors, sha256) {
  const failures = []
  for (const c of vectors.codes) {
    const got = core.normalizeCode(c.in)
    if (got !== c.out) failures.push(`code ${show(c.in)}: ${show(got)} != ${show(c.out)}`)
  }
  for (const c of vectors.display) {
    const got = core.displayCode(c.in)
    if (got !== c.out) failures.push(`display ${show(c.in)}: ${show(got)} != ${show(c.out)}`)
  }
  for (const c of vectors.fromBytes) {
    const got = core.codeFromBytes(Uint8Array.from(c.in))
    if (got !== c.out) failures.push(`fromBytes ${show(c.in)}: ${got} != ${c.out}`)
  }
  for (const c of vectors.endpoints) {
    const got = core.displayEndpointOf(c.path)
    if (got !== c.out) failures.push(`endpoint ${c.path}: ${show(got)} != ${show(c.out)}`)
  }
  for (const c of vectors.bodies) {
    const r = core.parseDisplayBody(c.contentType, c.text)
    const got = r.ok ? r.code : null
    if (got !== c.out) failures.push(`body ${show(c.contentType)} ${c.text}: ${show(got)} != ${show(c.out)}`)
  }
  for (const c of vectors.publicLive) {
    const got = core.publicLiveState(c.in)
    if (!same(got, c.out)) failures.push(`publicLive ${show(c.in)}: ${show(got)}`)
  }
  for (const c of vectors.messages) {
    const got = c.fn === 'state' ? core.codeStateMessage(c.matchId, c.in)
      : c.fn === 'answer' ? core.codeAnswerMessage(c.in)
        : core.codeEndedMessage(c.matchId)
    if (!same(got, c.out)) failures.push(`message ${c.fn} ${show(c.in)}: ${show(got)}`)
  }
  for (const sc of vectors.scenarios) {
    let clock = 0
    const ends = []
    const codes = core.createDisplayCodes({
      sha256,
      now: () => clock,
      via: sc.via || 'lan',
      caps: sc.caps || {},
      log: () => {},
      onEnd: (room, _hash, reason) => ends.push([room, reason]),
      timers: { setInterval: () => null, clearInterval: () => {} },
    })
    const fail = (i, what) => failures.push(`"${sc.name}" step ${i}: ${what}`)
    const run = (step, i, check) => {
      if (Number.isFinite(step.at)) clock = step.at
      const s = fill(step)
      const expect = s.expect
      switch (s.op) {
        case 'set': {
          const arg = { room: s.room, code: s.code, owner: s.owner || DEFAULT_OWNER }
          if ('issuedAt' in s) arg.issuedAt = s.issuedAt
          const r = codes.set(arg)
          if (check && !same(r, expect)) fail(i, `set ${show(r)} != ${show(expect)}`)
          break
        }
        case 'resolve': {
          const r = codes.resolve(s.code, { ipKey: s.ip || DEFAULT_IP })
          const { hash, ...rest } = r
          if (check && r.ok && !/^[0-9a-f]{64}$/.test(hash)) fail(i, `resolve hash ${show(hash)}`)
          if (check && !same(rest, expect)) fail(i, `resolve ${show(rest)} != ${show(expect)}`)
          break
        }
        case 'revoke': {
          const r = codes.revoke(s.room)
          if (check && r !== expect) fail(i, `revoke ${r}`)
          break
        }
        case 'drop': {
          const r = codes.dropRoom(s.room)
          if (check && r !== expect) fail(i, `drop ${r}`)
          break
        }
        case 'codeOfRoom': {
          const r = codes.codeOfRoom(s.room)
          if (check && !same(r, expect)) fail(i, `codeOfRoom ${show(r)}`)
          break
        }
        case 'isLive': {
          const r = codes.isLive(sha256(`d:${core.normalizeCode(s.code)}`), s.room)
          if (check && r !== expect) fail(i, `isLive ${r}`)
          break
        }
        case 'sweep': codes.sweep(); break
        case 'stats': {
          const st = codes.stats()
          const got = { codes: st.codes, tombstones: st.tombstones }
          if (check && !same(got, expect)) fail(i, `stats ${show(got)}`)
          break
        }
        case 'ends': {
          const got = ends.splice(0)
          if (check && !same(got, expect)) fail(i, `ends ${show(got)} != ${show(expect)}`)
          break
        }
        case 'http': {
          const text = s.text !== undefined ? s.text : JSON.stringify(s.body)
          const summary = s.summary || {}
          const r = codes.http(s.endpoint, { contentType: s.contentType, text, ipKey: s.ip || DEFAULT_IP, summaryOf: (room) => summary[room] || null })
          if (check && (r.status !== expect.status || !same(r.body, expect.body) || (expect.headers && !same(r.headers, expect.headers)))) {
            fail(i, `http ${s.endpoint} ${r.status} ${show(r.body)} ${show(r.headers)}`)
          }
          break
        }
        case 'repeat':
          for (let n = 0; n < s.n; n++) run(s.step, i, false)
          break
        default:
          fail(i, `unknown op ${s.op}`)
      }
    }
    sc.steps.forEach((step, i) => run(step, i, true))
  }
  return failures
}

module.exports = { runDisplayCodeVectors }
