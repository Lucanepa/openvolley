'use strict'
/**
 * Runs ./sign-vectors.json against a JS implementation of the Sign on phone
 * core (electron/signSessionCore.cjs or its generated backend copy). Used by
 * the frontend vitest and the backend node:test suites; src-tauri/src/sign.rs
 * has its own runner over the same file. Returns a list of mismatches (empty
 * when everything agrees), so it needs no assertion library.
 */

const LAN_DEFAULT_OWNER = 'local'
const DEFAULT_IP = '192.0.2.1'

function deepEqual(a, b) {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  return v
}

/** Mismatches of one answer against a step's `expect`. */
function checkAnswer(r, expect) {
  const out = []
  const body = r.body || {}
  for (const [k, want] of Object.entries(expect)) {
    if (k === 'status') { if (r.status !== want) out.push(`status ${r.status} != ${want} (${JSON.stringify(body)})`) }
    else if (k === 'has') { for (const key of want) if (!(key in body)) out.push(`body lacks ${key}`) }
    else if (k === 'lacks') { for (const key of want) if (key in body) out.push(`body has ${key}`) }
    else if (k === 'retryAfter') { const h = r.headers && r.headers['Retry-After']; if (want && !(Number(h) > 0)) out.push('no Retry-After') }
    else if (!deepEqual(body[k], want)) out.push(`${k}: ${JSON.stringify(body[k])} != ${JSON.stringify(want)}`)
  }
  return out
}

/** Replace "$token", "$watch", "$token:<name>" ... in a step body. */
function fill(value, saved) {
  if (typeof value === 'string') {
    const m = /^\$(token|watch)(?::(\w+))?$/.exec(value)
    if (m) {
      const s = saved[m[2] || '_last']
      return s ? s[m[1]] : value
    }
    return value
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, saved))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, saved)]))
  return value
}

/**
 * @param {{ createSignSessions: Function, validateContext: Function, validateStrokes: Function, LAN_CAPS: object }} core
 * @param {any} vectors the parsed sign-vectors.json
 * @returns {Promise<string[]>}
 */
async function runSignVectors(core, vectors) {
  const failures = []
  for (const v of vectors.context) {
    const r = core.validateContext(v.in)
    if (v.error) {
      if (r.ok || r.code !== v.error) failures.push(`context "${v.name}": ${JSON.stringify(r)} != error ${v.error}`)
    } else if (!r.ok || !deepEqual(r.context, v.out)) {
      failures.push(`context "${v.name}": ${JSON.stringify(r)} != ${JSON.stringify(v.out)}`)
    }
  }
  for (const v of vectors.strokes) {
    const r = core.validateStrokes(v.pad, v.strokes)
    if (v.ok && !r.ok) failures.push(`strokes "${v.name}": refused (${r.code})`)
    if (v.error && (r.ok || r.code !== v.error)) failures.push(`strokes "${v.name}": ${r.ok ? 'accepted' : r.code} != ${v.error}`)
  }
  for (const flow of vectors.flows) {
    let clock = 0
    const sessions = core.createSignSessions({
      now: () => clock,
      caps: { ...core.LAN_CAPS, ...(flow.caps || {}) },
      waitMs: flow.waitMs ?? 25000,
      log: () => {},
    })
    const saved = {}
    try {
      for (const [i, step] of flow.steps.entries()) {
        if (typeof step.at === 'number') clock = step.at
        const body = fill(step.body, saved)
        const owner = step.owner || LAN_DEFAULT_OWNER
        const ipKey = step.ip || DEFAULT_IP
        let r
        if (step.op === 'start') r = sessions.start(body, { owner })
        else if (step.op === 'open') r = sessions.open(body, { ipKey })
        else if (step.op === 'submit') r = sessions.submit(body, { ipKey })
        else if (step.op === 'wait') r = await sessions.wait(body)
        else if (step.op === 'close') r = sessions.close(body)
        else throw new Error(`unknown op ${step.op}`)
        if (step.op === 'start' && r.status === 201) {
          saved._last = { token: r.body.token, watch: r.body.watch }
          if (step.save) saved[step.save] = saved._last
        }
        for (const f of checkAnswer(r, step.expect || {})) failures.push(`flow "${flow.name}" step ${i} (${step.op}): ${f}`)
      }
    } finally {
      sessions.dispose()
    }
  }
  return failures
}

module.exports = { runSignVectors, checkAnswer, fill }
