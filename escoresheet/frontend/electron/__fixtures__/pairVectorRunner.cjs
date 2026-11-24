'use strict'
/**
 * Runs ./pair-vectors.json (Pair a phone) against a JS implementation of
 * electron/pairSessionCore.cjs (or its generated backend copy). Used by the
 * frontend vitest and the backend node:test suites; src-tauri/src/pair.rs has
 * its own runner over the same file. Returns a list of mismatches (empty when
 * everything agrees). Long-polls are held 0 ms here, so a wait or a poll with
 * nothing new answers its current state at once.
 */
const { checkAnswer } = require('./signVectorRunner.cjs')

const DEFAULT_OWNER = 'local'
const DEFAULT_IP = '192.0.2.1'

function deepEqual(a, b) {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  return v
}

/** "$token" / "$watch" / "$code" / "$codeDashed" / "$phone", and { "$repeat": [s, n] }. */
function fill(value, saved) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.$repeat)) {
    return String(value.$repeat[0]).repeat(value.$repeat[1])
  }
  if (typeof value === 'string') {
    const m = /^\$(token|watch|code|codeDashed|phone)$/.exec(value)
    return m && saved[m[1]] !== undefined ? saved[m[1]] : value
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, saved))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, saved)]))
  return value
}

/**
 * @param {object} core pairSessionCore
 * @param {any} vectors the parsed pair-vectors.json
 * @param {(text: string) => string} sha256
 * @returns {Promise<string[]>}
 */
async function runPairVectors(core, vectors, sha256) {
  const failures = []
  for (const v of vectors.context) {
    const r = core.validateContext(fill(v.in, {}))
    const out = fill(v.out, {})
    if (v.error) {
      if (r.ok || r.code !== v.error) failures.push(`context "${v.name}": ${JSON.stringify(r)} != error ${v.error}`)
    } else if (!r.ok || !deepEqual(r.context, out)) failures.push(`context "${v.name}": ${JSON.stringify(r).slice(0, 200)}`)
  }
  for (const v of vectors.fields) {
    const r = core.validateField(fill(v.in, {}))
    const out = fill(v.out, {})
    if (v.error) {
      if (r.ok || r.code !== v.error) failures.push(`field "${v.name}": ${JSON.stringify(r)} != error ${v.error}`)
    } else if (!r.ok || !deepEqual(r.field, out)) failures.push(`field "${v.name}": ${JSON.stringify(r).slice(0, 200)}`)
  }
  for (const v of vectors.codes) {
    const r = core.normalizeCode(v.in)
    if (r !== v.out) failures.push(`code ${JSON.stringify(v.in)}: ${r} != ${v.out}`)
  }
  for (const flow of vectors.flows) {
    let clock = 0
    const sessions = core.createPairSessions({
      sha256,
      now: () => clock,
      caps: { ...core.LAN_CAPS, ...(flow.caps || {}) },
      waitMs: 0,
      log: () => {},
    })
    const saved = {}
    try {
      for (const [i, step] of flow.steps.entries()) {
        if (typeof step.at === 'number') clock = step.at
        const body = fill(step.body, saved)
        const owner = step.owner || DEFAULT_OWNER
        const ipKey = step.ip || DEFAULT_IP
        let r
        if (step.op === 'start') r = sessions.start(body, { owner })
        else if (step.op === 'wait') r = await sessions.wait(body)
        else if (step.op === 'focus') r = sessions.focus(body)
        else if (step.op === 'close') r = sessions.close(body)
        else if (step.op === 'join') r = sessions.join(body, { ipKey })
        else if (step.op === 'poll') r = await sessions.poll(body, { ipKey })
        else if (step.op === 'input') r = sessions.input(body, { ipKey })
        else throw new Error(`unknown op ${step.op}`)
        if (step.op === 'start' && r.status === 201) {
          Object.assign(saved, { token: r.body.token, watch: r.body.watch, code: r.body.code, codeDashed: `${r.body.code.slice(0, 4)}-${r.body.code.slice(4)}` })
        }
        if (step.op === 'join' && r.status === 200) saved.phone = r.body.phone
        for (const f of checkAnswer(r, fill(step.expect || {}, saved))) failures.push(`flow "${flow.name}" step ${i} (${step.op}): ${f}`)
      }
    } finally {
      sessions.dispose()
    }
  }
  return failures
}

module.exports = { runPairVectors, fill }
