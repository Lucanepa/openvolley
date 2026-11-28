/**
 * The "Internet" row of the start-up connection check (StartupConnectivityModal):
 * how good this device's connection to the OpenVolley server is, measured once
 * per start, light and never in the way of scoring.
 *
 * - Round trip: the median of 3 small requests in a row to the backend's
 *   /health/live (no database behind it). The median leaves out the one
 *   request that still opened the connection (DNS, TLS).
 * - Throughput: one fixed 256 KiB download from the backend's /health/speed
 *   (random bytes, backend lib/speedProbe.js), timed from its first byte to
 *   its last. A slow link stops at the time budget and is measured on what
 *   arrived. Never a third-party speed test: only our own server is asked.
 * - Both carry a cache-busting query and go out with no credentials and no
 *   cache (no cookies, no token: nothing that names the device or the user).
 *   Nothing is stored, the result stays in the dialog.
 * - Offline (navigator.onLine false): nothing is sent. Data saver on
 *   (navigator.connection.saveData): the round trip only, no download.
 * - At most TOTAL_BUDGET_MS in all; every request ends there (abort).
 *
 * A 256 KiB file is too small to measure a fast line (TCP slow start: it is
 * over after a few round trips), so a high number is a lower bound. It is
 * enough to tell a good connection from one too slow for the cloud sync and
 * the livescore, which is what the row says.
 */

/** The verdicts: good, slow, offline; not_checked when this page has no cloud server. */
export const INTERNET_STATUSES = Object.freeze(['good', 'slow', 'offline', 'not_checked'])

// Above SLOW_RTT_MS round trip or below SLOW_MBPS the row reads "Slow": the
// sync's small requests then take noticeably long, a scoresheet upload long.
export const SLOW_RTT_MS = 300
export const SLOW_MBPS = 1

export const RTT_SAMPLES = 3
export const RTT_PATH = '/health/live'
export const DOWNLOAD_PATH = '/health/speed'
export const DOWNLOAD_BYTES = 256 * 1024
/** The whole check, round trips and download together. */
export const TOTAL_BUDGET_MS = 2500
/** One round trip that takes longer counts as no answer. */
export const RTT_TIMEOUT_MS = 1500
/** The download's share; it never starts with less than MIN_DOWNLOAD_MS left. */
export const DOWNLOAD_BUDGET_MS = 1000
export const MIN_DOWNLOAD_MS = 400
// Fewer bytes than this before the budget ran out: too few for a number
const MIN_MEASURED_BYTES = 16 * 1024
// The shortest transfer time a number is made from: a body that was already
// there with its headers would otherwise read as thousands of Mbit/s
const MIN_TRANSFER_MS = 20

const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())

export function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * The verdict from the numbers: slow when the round trip is over SLOW_RTT_MS
 * or the throughput under SLOW_MBPS (a number that was not measured does not
 * count), else good.
 * @param {{ rttMs: number|null, mbps: number|null }} numbers
 */
export function internetVerdict({ rttMs, mbps }) {
  if (Number.isFinite(rttMs) && rttMs > SLOW_RTT_MS) return 'slow'
  if (Number.isFinite(mbps) && mbps < SLOW_MBPS) return 'slow'
  return 'good'
}

const isAbort = (err) => err?.name === 'AbortError' || err?.name === 'TimeoutError'

function withQuery(base, path, nonce) {
  return `${String(base).replace(/\/+$/, '')}${path}?t=${nonce}`
}

/**
 * One request with its own deadline, which also ends when `signal` does.
 * Resolves with the fetch Response; rejects like fetch (an AbortError for the
 * deadline or the outer signal).
 */
function timedFetch(fetchImpl, url, ms, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(0, ms))
  const onOuterAbort = () => controller.abort()
  signal?.addEventListener?.('abort', onOuterAbort, { once: true })
  const done = () => {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onOuterAbort)
  }
  return {
    controller,
    done,
    response: fetchImpl(url, { cache: 'no-store', credentials: 'omit', signal: controller.signal })
  }
}

/** Reads a body to its end or until `deadline` (then aborts); { bytes, endedAt }. */
async function readBody(response, { deadline, now, controller }) {
  const reader = response.body?.getReader?.()
  if (!reader) {
    // No stream (an old WebView): the whole body at once
    const buf = await response.arrayBuffer()
    return { bytes: buf.byteLength, endedAt: now(), complete: true, streamed: false }
  }
  let bytes = 0
  let timer = null
  const cut = new Promise((resolve) => {
    timer = setTimeout(() => resolve('cut'), Math.max(0, deadline - now()))
  })
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), cut])
      if (next === 'cut') {
        controller.abort()
        reader.cancel?.().catch(() => {})
        return { bytes, endedAt: now(), complete: false, streamed: true }
      }
      if (next.done) return { bytes, endedAt: now(), complete: true, streamed: true }
      bytes += next.value?.byteLength || 0
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Measures the connection to `baseUrl` (the cloud API: getCloudApiBaseUrl).
 *
 * @param {object} options
 * @param {string|null} options.baseUrl  the cloud server; none: 'not_checked'
 * @param {AbortSignal} [options.signal] ends the check (the dialog closed)
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]   milliseconds (performance.now)
 * @param {boolean} [options.online]     navigator.onLine
 * @param {boolean} [options.saveData]   navigator.connection.saveData
 * @returns {Promise<{ status: 'good'|'slow'|'offline'|'not_checked', rttMs: number|null, mbps: number|null,
 *   samples: number[], bytes: number, saveData: boolean, noAnswerMs: number|null, durationMs: number }>}
 */
export async function measureInternet({
  baseUrl,
  signal,
  fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
  now = nowMs,
  online = typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  saveData = typeof navigator !== 'undefined' && !!navigator.connection?.saveData
} = {}) {
  const startedAt = now()
  const result = (status, extra = {}) => ({
    status,
    rttMs: null,
    mbps: null,
    samples: [],
    bytes: 0,
    saveData: !!saveData,
    noAnswerMs: null,
    ...extra,
    durationMs: Math.round(now() - startedAt)
  })
  if (!baseUrl || !fetchImpl) return result('not_checked')
  if (!online) return result('offline')
  const deadline = startedAt + TOTAL_BUDGET_MS
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

  // Round trips, one after the other (in parallel they would share the first
  // connection's set-up). A network error with no answer yet: offline. No
  // answer within the time: stop, the line is too slow (or blocked).
  const samples = []
  let noAnswerMs = null
  for (let i = 0; i < RTT_SAMPLES; i++) {
    if (signal?.aborted) return result('not_checked', { samples })
    // keep MIN_DOWNLOAD_MS for the download once a round trip came back
    const left = deadline - now() - (samples.length ? MIN_DOWNLOAD_MS : 0)
    const timeout = Math.min(RTT_TIMEOUT_MS, left)
    if (timeout <= 0) break
    const t0 = now()
    const req = timedFetch(fetchImpl, withQuery(baseUrl, RTT_PATH, `${nonce}-${i}`), timeout, signal)
    try {
      const res = await req.response
      // any answer is a round trip, also an error status (the internet works)
      await res.arrayBuffer().catch(() => {})
      samples.push(now() - t0)
    } catch (err) {
      if (signal?.aborted) return result('not_checked', { samples })
      if (isAbort(err)) {
        if (!samples.length) noAnswerMs = Math.round(timeout)
        // a later round trip with no answer in the full time counts with that
        // time (at least that slow); one cut short by the budget does not
        else if (timeout >= RTT_TIMEOUT_MS) samples.push(timeout)
        break
      }
      if (!samples.length) return result('offline')
      break
    } finally {
      req.done()
    }
  }
  if (!samples.length) {
    // no answer at all within the time, while the device says it is online
    return noAnswerMs != null ? result('slow', { noAnswerMs }) : result('offline')
  }
  const rttMs = Math.round(median(samples))

  // The download: skipped with data saver on and when the time is up
  let mbps = null
  let bytes = 0
  // (less the 50 ms the request's own deadline is given beyond the cut, so
  // that the cut, not the abort, ends a slow download)
  const downloadMs = Math.min(DOWNLOAD_BUDGET_MS, deadline - now() - 50)
  if (!saveData && downloadMs >= MIN_DOWNLOAD_MS && !signal?.aborted) {
    const requestStart = now()
    const downloadDeadline = requestStart + downloadMs
    const req = timedFetch(fetchImpl, withQuery(baseUrl, DOWNLOAD_PATH, `${nonce}-d`), downloadMs + 50, signal)
    try {
      const res = await req.response
      // an older server without the probe (404), a rate limit (429): no number
      const type = res.headers?.get?.('content-type') || ''
      if (res.ok && /octet-stream/i.test(type)) {
        const firstByteAt = now()
        const read = await readBody(res, { deadline: downloadDeadline, now, controller: req.controller })
        bytes = read.bytes
        // from the first byte to the last; without a stream from the request
        // less one round trip (the time to the first byte)
        const transferMs = read.streamed ? read.endedAt - firstByteAt : read.endedAt - requestStart - rttMs
        if (bytes >= MIN_MEASURED_BYTES) {
          mbps = (bytes * 8) / (Math.max(transferMs, MIN_TRANSFER_MS) / 1000) / 1e6
        } else if (!read.complete) {
          // the budget ran out with almost nothing: at most this fast
          mbps = (bytes * 8) / (downloadMs / 1000) / 1e6
        }
      } else {
        res.body?.cancel?.().catch(() => {})
      }
    } catch (err) {
      if (signal?.aborted) return result('not_checked', { samples, rttMs })
      // the download did not even start in time: a slow line
      if (isAbort(err)) mbps = 0
    } finally {
      req.done()
    }
  }
  const rounded = mbps == null ? null : (mbps >= 10 ? Math.round(mbps) : Math.round(mbps * 10) / 10)
  return result(internetVerdict({ rttMs, mbps }), { rttMs, mbps: rounded, samples: samples.map(Math.round), bytes })
}

function formatNumber(value, locale, digits = 0) {
  try {
    return new Intl.NumberFormat(locale || undefined, { maximumFractionDigits: digits }).format(value)
  } catch {
    return String(value)
  }
}

/**
 * The numbers beside the verdict: "38 ms, 24 Mbit/s"; the round trip alone
 * when no download was measured (data saver, an older server); "no answer
 * in 1.5 s" when no round trip came back in time. Numbers in the device
 * language (a decimal comma in German and French).
 * @param {object|null} internet  measureInternet's result
 * @param {Function} t            i18next t
 * @param {string} [locale]       i18n.language
 */
export function internetNumbers(internet, t, locale) {
  if (!internet) return ''
  if (Number.isFinite(internet.noAnswerMs)) {
    const seconds = formatNumber(internet.noAnswerMs / 1000, locale, 1)
    return t('connectionStatus.internetNoAnswer', 'no answer in {{seconds}} s', { seconds })
  }
  if (!Number.isFinite(internet.rttMs)) return ''
  const parts = [`${formatNumber(internet.rttMs, locale)} ms`]
  if (Number.isFinite(internet.mbps)) {
    parts.push(internet.mbps < 0.1
      ? `< ${formatNumber(0.1, locale, 1)} Mbit/s`
      : `${formatNumber(internet.mbps, locale, internet.mbps >= 10 ? 0 : 1)} Mbit/s`)
  } else if (internet.saveData) {
    parts.push(t('connectionStatus.internetDataSaver', 'data saver: no download'))
  }
  return parts.join(', ')
}
