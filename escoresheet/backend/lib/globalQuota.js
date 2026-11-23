/**
 * globalQuota — what one network may add a day to the Global tool's anonymous
 * stores (lib/globalStore.js files, lib/globalMatches.js cloud copies): new
 * keys and bytes per IPv6 /64 and per /56 (an IPv4 address counts as both),
 * so one caller cannot take a whole store (audit 2026-11-23 SEC-01, SEC-17).
 *
 * In memory only: the privacy policy keeps IP addresses in memory, never
 * stored (a restart starts every budget over). Fixed windows of windowMs per
 * prefix; at most maxEntries prefixes are tracked (the oldest window goes
 * first). Node built-ins only.
 *
 *   const budget = createNetworkBudget({ limits: [{ name: '/64', v6Bits: 64, max: { keys: 200, bytes: 1 << 30 } }] })
 *   budget.over(ip, { keys: 1, bytes: 4096 })   // null, or { limit: '/64', what: 'bytes' }
 *   budget.charge(ip, { keys: 1, bytes: 4096 }) // after the write
 */
import { isIPv4, isIPv6 } from 'node:net'

export const DAY_MS = 24 * 60 * 60 * 1000

/** The eight 16-bit words of an IPv6 address, or null. */
function v6Words(s) {
  let text = s
  const words = []
  // an embedded IPv4 tail (::ffff:192.0.2.1, 64:ff9b::192.0.2.1)
  const dot = text.lastIndexOf(':')
  const tail = text.slice(dot + 1)
  let v4 = null
  if (tail.includes('.')) {
    if (!isIPv4(tail)) return null
    v4 = tail.split('.').map(Number)
    text = text.slice(0, dot + 1) + '0:0'
  }
  const parts = text.split('::')
  if (parts.length > 2) return null
  const side = (p) => (p ? p.split(':') : [])
  const head = side(parts[0])
  const rest = parts.length === 2 ? side(parts[1]) : []
  const fill = 8 - head.length - rest.length
  if ((parts.length === 1 && fill !== 0) || fill < 0) return null
  for (const w of [...head, ...Array(parts.length === 2 ? fill : 0).fill('0'), ...rest]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(w)) return null
    words.push(parseInt(w, 16))
  }
  if (v4) {
    words[6] = (v4[0] << 8) | v4[1]
    words[7] = (v4[2] << 8) | v4[3]
  }
  return words.length === 8 ? words : null
}

/**
 * The network of an address: an IPv6 address cut to v6Bits ('2001:db8:1:200::/56'),
 * an IPv4 address (also IPv4-mapped IPv6) cut to v4Bits ('192.0.2.0/24', or the
 * address itself at 32). Anything else: the trimmed text itself (or 'unknown').
 */
export function addressPrefix(ip, v6Bits = 64, v4Bits = 32) {
  if (typeof ip !== 'string') return 'unknown'
  let s = ip.trim()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  const v4 = (a) => {
    if (v4Bits >= 32) return a
    const n = a.split('.').map(Number).reduce((x, y) => (x * 256) + y, 0)
    const masked = v4Bits <= 0 ? 0 : Math.floor(n / 2 ** (32 - v4Bits)) * 2 ** (32 - v4Bits)
    return `${[24, 16, 8, 0].map((b) => Math.floor(masked / 2 ** b) % 256).join('.')}/${v4Bits}`
  }
  if (isIPv4(s)) return v4(s)
  if (!isIPv6(s)) return s || 'unknown'
  const w = v6Words(s)
  if (!w) return s
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) {
    return v4([w[6] >> 8, w[6] & 255, w[7] >> 8, w[7] & 255].join('.'))
  }
  const bits = Math.max(0, Math.min(128, v6Bits))
  const out = w.map((x, i) => {
    const from = i * 16
    if (from >= bits) return 0
    if (from + 16 <= bits) return x
    const keep = bits - from
    return x & (0xffff << (16 - keep)) & 0xffff
  })
  // the words in use, then '::' (the rest is zero by the cut)
  const used = Math.ceil(bits / 16)
  return `${out.slice(0, used).map((x) => x.toString(16)).join(':')}::/${bits}`
}

/**
 * Per-network daily budgets. limits: [{ name, v6Bits, v4Bits = 32, max: { <counter>: n } }]
 * (a counter without a positive max is not limited). over(ip, amounts) says
 * which limit the amounts would pass (null: none); charge(ip, amounts) counts
 * them. No ip (a caller that knows none): never over, nothing counted.
 */
export function createNetworkBudget({ limits = [], windowMs = DAY_MS, maxEntries = 50_000, now = Date.now } = {}) {
  const entries = new Map() // `${name}\n${prefix}` -> { start, counts: {} }
  const idOf = (l, ip) => `${l.name}\n${addressPrefix(ip, l.v6Bits ?? 64, l.v4Bits ?? 32)}`

  function live(id, t) {
    const e = entries.get(id)
    if (!e) return null
    if (t - e.start >= windowMs) { entries.delete(id); return null }
    return e
  }

  function over(ip, amounts = {}) {
    if (typeof ip !== 'string' || !ip) return null
    const t = now()
    for (const l of limits) {
      const e = live(idOf(l, ip), t)
      for (const [what, n] of Object.entries(amounts)) {
        const max = Number(l.max?.[what])
        if (!(n > 0) || !(max > 0)) continue
        if ((e?.counts[what] ?? 0) + n > max) return { limit: l.name, what }
      }
    }
    return null
  }

  function charge(ip, amounts = {}) {
    if (typeof ip !== 'string' || !ip) return
    const t = now()
    for (const l of limits) {
      const id = idOf(l, ip)
      let e = live(id, t)
      if (!e) {
        while (entries.size >= maxEntries) entries.delete(entries.keys().next().value)
        e = { start: t, counts: {} }
        entries.set(id, e)
      }
      for (const [what, n] of Object.entries(amounts)) {
        if (n > 0) e.counts[what] = (e.counts[what] ?? 0) + n
      }
    }
  }

  /** What a network has used in its window (tests, /health): { [limit name]: counts }. */
  function usedBy(ip) {
    const t = now()
    const out = {}
    for (const l of limits) out[l.name] = { ...(live(idOf(l, ip), t)?.counts ?? {}) }
    return out
  }

  function sweep() {
    const t = now()
    for (const [id, e] of entries) if (t - e.start >= windowMs) entries.delete(id)
  }

  return { over, charge, usedBy, sweep, get size() { return entries.size } }
}

/**
 * A budget everyone shares, per window (GCS-R1: the Global cloud's bytes
 * written in a minute, an hour and a day, which all become WAL). windows:
 * [{ name, ms, max }] (a window without a positive max is not limited). One
 * network (netOf: an IPv6 /48, an IPv4 /24) may use netShare of a window;
 * the last reserveShare of it is kept for the networks that used less than
 * lightShare of it, so a few heavy networks cannot leave everyone else with
 * nothing. over(ip, n) says which window n more would pass ({ window, why:
 * 'total' | 'network' | 'reserve', retryMs }, or null); charge(ip, n) counts
 * n. Fixed windows; at most maxNets networks per window (the oldest go).
 */
export function createSharedBudget({ windows = [], netOf = (ip) => addressPrefix(ip, 48, 24), netShare = 0.25, reserveShare = 0.25, lightShare = 1 / 32, maxNets = 50_000, now = Date.now } = {}) {
  const state = windows.map((w) => ({ name: w.name, ms: w.ms, max: Number(w.max), start: 0, total: 0, nets: new Map() }))
  const roll = (s, t) => {
    if (t - s.start < s.ms) return
    s.start = t
    s.total = 0
    s.nets.clear()
  }

  function over(ip, n = 1) {
    const t = now()
    const net = netOf(ip)
    for (const s of state) {
      if (!(s.max > 0)) continue
      roll(s, t)
      const used = s.nets.get(net) ?? 0
      const why = s.total + n > s.max ? 'total'
        : used + n > s.max * netShare ? 'network'
          : s.total + n > s.max * (1 - reserveShare) && used + n > s.max * lightShare ? 'reserve'
            : null
      if (why) return { window: s.name, why, retryMs: Math.max(1000, s.start + s.ms - t) }
    }
    return null
  }

  function charge(ip, n) {
    if (!(n > 0)) return
    const t = now()
    const net = netOf(ip)
    for (const s of state) {
      roll(s, t)
      s.total += n
      if (!s.nets.has(net) && s.nets.size >= maxNets) s.nets.delete(s.nets.keys().next().value)
      s.nets.set(net, (s.nets.get(net) ?? 0) + n)
    }
  }

  /** Each window's total and networks (tests, alerts). */
  function used() {
    const t = now()
    return Object.fromEntries(state.map((s) => { roll(s, t); return [s.name, { total: s.total, networks: s.nets.size }] }))
  }

  return { over, charge, used }
}

/** One call at most every everyMs (an alert that must not repeat on every request). */
export function createOncePer(everyMs, now = Date.now) {
  const last = new Map()
  return (name) => {
    const t = now()
    if (last.has(name) && t - last.get(name) < everyMs) return false
    last.set(name, t)
    return true
  }
}

/**
 * The kind of page that sent a request, for the anonymous GET budgets that a
 * browser lets any site spend (an <img> of an API address, a no-cors fetch;
 * audit 2026-11-23 SEC-42): 'app' (an Origin the server trusts, the apps'
 * own fetches), 'other' (another Origin, or Sec-Fetch-Site cross-site: a
 * foreign page) or 'plain' (no browser signal: the native apps' plain
 * requests, scripts, a link opened in a tab). Three kinds only, so a script
 * that sends made-up Origins gets no more than three budgets per address.
 */
export function pageKindOf(headers = {}, isTrusted = () => false) {
  const origin = headers.origin
  if (origin !== undefined) return isTrusted(origin) ? 'app' : 'other'
  return String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site' ? 'other' : 'plain'
}
