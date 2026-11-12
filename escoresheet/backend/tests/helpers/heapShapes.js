// Run as `node --expose-gc tests/helpers/heapShapes.js <case>` (from
// tests/relayLimits.test.js): parses one array of objects from JSON text, as the
// relay does with a frame, and prints { objects, real, est } -- the heap the
// parsed array keeps (heapUsed after a full GC, before and after) and what
// lib/relayLimits.js approxHeapBytes counts for it. Cases:
//   varied-<K>  every object a different order of the same K names
//   fixed-<K>   every object the same K names in the same order (a scorer's events)
//   separator   every object a different list of names that hold the separator
//               character, from a small pool of names
import { approxHeapBytes } from '../../lib/relayLimits.js'

const [, , name] = process.argv
if (typeof global.gc !== 'function') throw new Error('run with --expose-gc')

// The values of one frame stay well under MAX_FRAME_VALUES; enough objects that
// the hidden classes dominate the measurement noise.
const VALUES = 120000

let seed = 7
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const shuffled = (list) => {
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1));[out[i], out[j]] = [out[j], out[i]] }
  return out
}
const objectText = (keys) => '{' + keys.map((k) => JSON.stringify(k) + ':0').join(',') + '}'

function caseText(c) {
  const order = /^(varied|fixed)-(\d+)$/.exec(c)
  if (order) {
    const K = Number(order[2])
    const names = Array.from({ length: K }, (_, i) => 'field' + i)
    const n = Math.min(20000, Math.floor(VALUES / (K + 1)))
    const parts = []
    for (let i = 0; i < n; i++) parts.push(objectText(order[1] === 'varied' ? shuffled(names) : names))
    return '[' + parts.join(',') + ']'
  }
  if (c === 'separator') {
    // Names made of 'a' runs joined by the separator: an object holding the
    // names of run lengths r1, r2, ... (all different, in that order) is its own
    // key list, while the plain joined text of every list summing to the same
    // total is one and the same.
    const name = (r) => Array(r).fill('a').join('\u0000')
    const total = 28
    const lists = []
    const walk = (left, used, cur) => {
      if (lists.length >= 20000) return
      if (left === 0) { lists.push(cur.slice()); return }
      for (let p = 1; p <= left; p++) {
        if (used.has(p)) continue
        used.add(p); cur.push(p)
        walk(left - p, used, cur)
        cur.pop(); used.delete(p)
      }
    }
    walk(total, new Set(), [])
    const parts = []
    let values = 1
    for (const list of lists) {
      if (values + 1 + list.length > VALUES) break
      values += 1 + list.length
      parts.push(objectText(list.map(name)))
    }
    return '[' + parts.join(',') + ']'
  }
  throw new Error(`unknown case ${c}`)
}

const text = caseText(name)
global.gc(); global.gc()
const before = process.memoryUsage().heapUsed
const parsed = JSON.parse(text)
global.gc(); global.gc()
const real = process.memoryUsage().heapUsed - before
const est = approxHeapBytes(parsed)
process.stdout.write(JSON.stringify({ objects: parsed.length, real, est, json: text.length }) + '\n')
