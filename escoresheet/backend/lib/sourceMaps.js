/**
 * sourceMaps — readable stack frames for the error tracker (lib/errorTracker.js).
 *
 * The web builds carry hidden source maps next to their bundles (Cloudflare
 * Pages, frontend scripts/build-subdomains.js: no sourceMappingURL comment, so
 * browsers never fetch them; the code is open source). A frame
 * "onPoint@/assets/_build_app-V03cqV1j.js:1:23456" of a report from the scorer
 * becomes "src/components/Scoreboard.jsx:812:9 (onPoint)" by reading
 * https://app.openvolley.app/assets/_build_app-V03cqV1j.js.map.
 *
 *   - Only the app's own sites (HOSTS by product and tool), https, never a URL
 *     from a report: the report gives a path, this table the host.
 *   - The backend has a small heap: a map is fetched with a size cap
 *     (MAX_MAP_BYTES), kept without sourcesContent, at most CACHE_SIZE of them
 *     (least recently used out); a position is found by scanning the mappings
 *     string, never by decoding all of it into arrays.
 *   - A map that is not there (the desktop and phone apps' bundles, a build
 *     replaced by a later deploy) is remembered as missing for a while.
 *   - Never throws: a frame it cannot read stays as it was (null in the result).
 */

export const MAX_MAP_BYTES = 20 * 1024 * 1024
export const CACHE_SIZE = 4
export const FOUND_TTL_MS = 60 * 60 * 1000
export const MISSING_TTL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000

// The site each tool's bundles are served from
const OV = { scorer: 'app.openvolley.app', dictate: 'app.openvolley.app', referee: 'referee.openvolley.app', bench: 'bench.openvolley.app', livescore: 'livescore.openvolley.app', roster: 'roster.openvolley.app', scoresheet: 'scoresheet.openvolley.app', manager: 'manager.openvolley.app' }
const OB = { manager: 'manager-beach.openvolley.app' }
export const BEACH_HOST = 'beach.openvolley.app'

/** The https origin of a report's bundles, or null (the server, the TV page, a tool without a site). */
export function hostFor(product, tool) {
  if (product === 'openbeach') return OB[tool] || (tool === 'tv' || tool === 'server' || tool === 'render' ? null : BEACH_HOST)
  return OV[tool] || null
}

/** "fn@/assets/x.js:1:2", "fn (/assets/x.js:1:2)", "/assets/x.js:1:2" -> { fn, path, line, col } or null. */
export function parseFrame(frame) {
  if (typeof frame !== 'string') return null
  const m = /^(?:(.*?)\s*[@(]\s*)?(\/[^\s():]+\.m?js):(\d+):(\d+)\)?$/.exec(frame.trim())
  if (!m) return null
  const fn = (m[1] || '').trim() || null
  return { fn: fn && fn !== 'async' ? fn.replace(/^async\s+/, '') : null, path: m[2], line: Number(m[3]), col: Number(m[4]) }
}

const B64 = new Int8Array(128).fill(-1)
'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((c, i) => { B64[c.charCodeAt(0)] = i })

/**
 * The original position of a generated one (line 1-based, column 0-based),
 * scanning the mappings string: { source, line, column, name } (1-based line
 * and column) or null.
 */
export function originalPosition({ mappings, sources = [], names = [] }, line, column) {
  if (typeof mappings !== 'string' || !(line >= 1) || !(column >= 0)) return null
  let genLine = 1
  let genCol = 0
  let src = 0
  let srcLine = 0
  let srcCol = 0
  let name = 0
  let best = null
  const n = mappings.length
  let i = 0
  const fields = [0, 0, 0, 0, 0]
  while (i < n) {
    const ch = mappings.charCodeAt(i)
    if (ch === 59) { // ';' next generated line
      if (genLine === line) break
      genLine++
      genCol = 0
      i++
      continue
    }
    if (ch === 44) { i++; continue } // ','
    // one segment: 1, 4 or 5 VLQ fields
    let count = 0
    while (i < n) {
      const c = mappings.charCodeAt(i)
      if (c === 44 || c === 59) break
      let value = 0
      let shift = 0
      let digit
      do {
        digit = B64[mappings.charCodeAt(i++)]
        if (digit < 0 || digit === undefined) return null
        value += (digit & 31) << shift
        shift += 5
      } while (digit & 32)
      fields[count++] = value & 1 ? -(value >>> 1) : value >>> 1
      if (count > 5) return null
    }
    genCol += fields[0]
    if (count >= 4) { src += fields[1]; srcLine += fields[2]; srcCol += fields[3] }
    if (count === 5) name += fields[4]
    if (genLine === line) {
      if (genCol > column) break // segments of a line are sorted by column
      if (count >= 4) best = { src, srcLine, srcCol, name: count === 5 ? name : -1 }
    }
  }
  if (!best || !sources[best.src]) return null
  return { source: cleanSource(sources[best.src]), line: best.srcLine + 1, column: best.srcCol + 1, name: best.name >= 0 ? names[best.name] || null : null }
}

/** "../../src/components/X.jsx" -> "src/components/X.jsx"; node_modules kept from its folder on. */
export function cleanSource(s) {
  const t = String(s || '').replace(/^[a-z]+:\/\/\/?/i, '').replace(/^(\.\.?\/)+/, '')
  const nm = t.lastIndexOf('node_modules/')
  return (nm >= 0 ? t.slice(nm) : t).slice(0, 200)
}

/**
 * @param {{ fetchImpl?: Function, now?: () => number, log?: Console, maxBytes?: number, cacheSize?: number }} deps
 */
export function createSourceMaps({ fetchImpl = globalThis.fetch, now = Date.now, log = console, maxBytes = MAX_MAP_BYTES, cacheSize = CACHE_SIZE } = {}) {
  const cache = new Map() // url -> { at, map|null, pending? }

  async function load(url) {
    const hit = cache.get(url)
    const t = now()
    if (hit && (hit.pending || t - hit.at < (hit.map ? FOUND_TTL_MS : MISSING_TTL_MS))) {
      cache.delete(url)
      cache.set(url, hit) // most recently used last
      return hit.pending ? hit.pending : hit.map
    }
    const pending = (async () => {
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
        let res
        try {
          res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'error' })
        } finally {
          clearTimeout(timer)
        }
        if (!res.ok) return null
        const declared = Number(res.headers?.get?.('content-length'))
        if (Number.isFinite(declared) && declared > maxBytes) return null
        const text = await res.text()
        if (text.length > maxBytes) return null
        const raw = JSON.parse(text)
        if (raw?.version !== 3 || typeof raw.mappings !== 'string') return null
        // without sourcesContent: the heap keeps only what a lookup needs
        return { mappings: raw.mappings, sources: (raw.sources || []).map(String), names: (raw.names || []).map(String) }
      } catch (err) {
        log.warn?.(`[errors] source map not read (${url.replace(/^https:\/\/[^/]+/, '')}): ${String(err?.message || err).slice(0, 80)}`)
        return null
      }
    })()
    cache.set(url, { at: t, map: null, pending })
    const map = await pending
    cache.set(url, { at: now(), map })
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value)
    return map
  }

  /**
   * The readable form of each frame ("src/x.jsx:12:5 (fn)") or null, in the
   * frames' order. Gives up after `budgetMs` (what is left stays null).
   */
  async function symbolicate(frames, { product, tool, budgetMs = 4000 } = {}) {
    const host = hostFor(product, tool)
    const list = Array.isArray(frames) ? frames.slice(0, 20) : []
    const out = list.map(() => null)
    if (!host || !list.length) return out
    const deadline = now() + budgetMs
    for (let k = 0; k < list.length; k++) {
      if (now() > deadline) break
      const f = parseFrame(list[k])
      if (!f || !/^\/[A-Za-z0-9/_.-]+\.m?js$/.test(f.path)) continue
      const map = await load(`https://${host}${f.path}.map`)
      if (!map) continue
      const pos = originalPosition(map, f.line, Math.max(0, f.col - 1))
      if (pos) out[k] = `${pos.source}:${pos.line}:${pos.column}${pos.name || f.fn ? ` (${pos.name || f.fn})` : ''}`
    }
    return out
  }

  return { symbolicate, stats: () => ({ cached: cache.size }) }
}
