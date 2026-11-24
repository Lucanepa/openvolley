// Preloaded into a test server (NODE_OPTIONS=--import): it may connect to
// this machine only. Any other TCP connect or DNS lookup fails at once
// (ECONNREFUSED / ENOTFOUND), so a code path that fetches from the internet
// (the VolleyManager iCal feeds of /api/official-matches) never reaches a
// third party from a test. Counts what it refused in globalThis.__ovEgressRefused.
import net from 'node:net'
import dns from 'node:dns'
import { syncBuiltinESMExports } from 'node:module'

const LOCAL = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1'])
globalThis.__ovEgressRefused = 0
const hostOf = (args) => {
  let a = args[0]
  if (Array.isArray(a)) a = a[0]
  if (a && typeof a === 'object') return a.path != null ? null : String(a.host ?? 'localhost')
  if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) return typeof args[1] === 'string' ? args[1] : 'localhost'
  return null // a unix socket path
}
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function guarded (...args) {
  const host = hostOf(args)
  if (host === null || LOCAL.has(host.replace(/^\[|\]$/g, '').toLowerCase())) return connect.apply(this, args)
  globalThis.__ovEgressRefused++
  const err = Object.assign(new Error(`connect ECONNREFUSED ${host} (tests/helpers/noEgress.mjs)`), { code: 'ECONNREFUSED' })
  process.nextTick(() => this.destroy(err))
  return this
}
const refused = (h) => Object.assign(new Error(`getaddrinfo ENOTFOUND ${h} (tests/helpers/noEgress.mjs)`), { code: 'ENOTFOUND', hostname: h })
const lookup = dns.lookup
dns.lookup = function guardedLookup (hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {} }
  if (LOCAL.has(String(hostname).toLowerCase())) return lookup.call(dns, hostname, options, cb)
  process.nextTick(() => cb(refused(hostname)))
  return {}
}
const plookup = dns.promises.lookup
dns.promises.lookup = (hostname, options) => (LOCAL.has(String(hostname).toLowerCase()) ? plookup.call(dns.promises, hostname, options) : Promise.reject(refused(hostname)))
syncBuiltinESMExports()
