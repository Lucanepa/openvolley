/**
 * One checkout of a pg Pool client that cannot end the process.
 *
 * pg-pool drops its own 'error' listener while a client is checked out (it
 * covers idle clients only). When Postgres ends the session of a checked-out
 * client (a restart, an OOM kill, pg_terminate_backend, the network), pg emits
 * 'error' on that client; with no listener that is an unhandled 'error' event
 * and the whole backend exits, with every relay room, PIN budget and sign
 * session in memory. connectClient listens for the time of the checkout: the
 * query in flight still fails (the request answers 503 or 500 as before), the
 * loss is logged once, and release() hands the error to the pool, which then
 * drops the broken client instead of lending it out again.
 *
 *   const client = await connectClient(pool, log)
 *   try { ... } finally { client.release() }
 *
 * Pure module: no imports, safe in the LAN / SEA bundle.
 */

/**
 * @param {{ connect: () => Promise<any> }} pool  a pg.Pool
 * @param {{ error?: Function }} [log]
 * @returns {Promise<any>} the client; its release() removes the listener
 */
export async function connectClient(pool, log = console) {
  const client = await pool.connect()
  let lost = null
  const onError = (err) => {
    if (!lost) log?.error?.(`[db] connection lost during a request: ${String(err?.message || err).slice(0, 200)}`)
    lost = lost || err || new Error('connection lost')
  }
  // (a test double without events has nothing to listen to)
  if (typeof client?.on !== 'function') return client
  client.on('error', onError)
  // pg-pool sets client.release anew on every checkout
  const release = client.release
  client.release = (err) => {
    client.removeListener('error', onError)
    return release.call(client, err || lost || undefined)
  }
  return client
}
