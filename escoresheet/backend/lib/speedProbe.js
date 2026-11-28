/**
 * The internet speed probe of the scorer app's start check (frontend
 * utils/internetCheck.js): GET /health/speed answers a fixed 256 KiB, which
 * the app downloads once per start to tell a good connection from a slow one.
 *
 * - Random bytes, made once per process: incompressible, so a proxy's
 *   compression (Cloudflare) can never make the download look faster than the
 *   connection is.
 * - Never cached (no-store) and never transformed (no-transform).
 * - Anonymous: no account, no database, no content from the device. The route
 *   limits it per address (SPEED_PROBE_RATE_LIMIT_MAX a minute; the IP is held
 *   in memory only, like every rate limit).
 */
import { randomBytes } from 'node:crypto'

/** Size of the probe body: the app's download test reads at most this. */
export const SPEED_PROBE_BYTES = 256 * 1024

/**
 * Probes per address (an IPv6 /64 on the cloud) and minute. The tablets and
 * phones of a hall share one address; each start downloads one probe.
 */
export const SPEED_PROBE_RATE_LIMIT_MAX = 30

export const SPEED_PROBE_HEADERS = Object.freeze({
  'Content-Type': 'application/octet-stream',
  'Content-Length': String(SPEED_PROBE_BYTES),
  'Cache-Control': 'no-store, no-transform'
})

let body = null

/** The probe body: the same random bytes for the life of the process. */
export function speedProbeBody() {
  if (!body) body = randomBytes(SPEED_PROBE_BYTES)
  return body
}
