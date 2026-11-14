/**
 * The desktop app's Rust relay (src-tauri/src/relay.rs) for the relay contract
 * tests: a built binary in OV_TAURI_RELAY_BIN, started with --server-only.
 * CI builds it (.github/workflows/relay-contract.yml); locally:
 *   (cd src-tauri && cargo build) && OV_TAURI_RELAY_BIN=src-tauri/target/debug/openvolley-escoresheet npx vitest run lanRelay
 *
 * Each relay gets its own HOME: the relay keeps its room claims there
 * (~/.openvolley-relay), so a test never reads or leaves claims in the real
 * one. Pass the `home` and `port` of an earlier start to restart the same relay.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { resolve } from 'node:path'

export const TAURI_RELAY_BIN = process.env.OV_TAURI_RELAY_BIN || ''

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })
}

/** Starts the relay; resolves once /api/health answers. */
export async function startTauriRelay({ home = null, port = null, wsPort = null } = {}) {
  const ownHome = home || mkdtempSync(resolve(tmpdir(), 'ov-tauri-relay-'))
  const httpPort = port || await freePort()
  const ws = wsPort || await freePort()
  const child = spawn(TAURI_RELAY_BIN, ['--server-only'], {
    env: { ...process.env, HOME: ownHome, USERPROFILE: ownHome, OPENVOLLEY_HTTP_PORT: String(httpPort), OPENVOLLEY_WS_PORT: String(ws) },
    stdio: 'ignore'
  })
  let exited = null
  child.on('exit', (code) => { exited = code })
  const base = `http://127.0.0.1:${httpPort}`
  for (const start = Date.now(); ;) {
    if (exited !== null) throw new Error(`the Tauri relay exited with ${exited}`)
    try { if ((await fetch(`${base}/api/health`)).ok) break } catch { /* not up yet */ }
    if (Date.now() - start > 15000) {
      child.kill('SIGKILL')
      throw new Error('the Tauri relay did not start')
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return {
    child,
    home: ownHome,
    port: httpPort,
    wsPort: ws,
    base,
    wsUrl: `ws://127.0.0.1:${ws}`,
    /** Ends the relay; `keepHome` for a restart on the same claims. */
    async stop({ keepHome = false } = {}) {
      if (exited === null) {
        const gone = new Promise((r) => child.once('exit', r))
        child.kill('SIGKILL')
        await gone
      }
      if (!keepHome) rmSync(ownHome, { recursive: true, force: true })
    }
  }
}
