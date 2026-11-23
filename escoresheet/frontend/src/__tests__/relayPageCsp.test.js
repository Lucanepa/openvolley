// @vitest-environment node
// SEC-47: the pages the LAN relays hand out (the desktop app's built-in
// server, to its own scoretable window with every native command and to the
// venue tablets; frontend/server.js) ran without any Content-Security-Policy,
// and the Tauri config had csp null and withGlobalTauri on. The Rust side has
// its own test (relay.rs the_app_pages_are_served_with_the_app_policy); this
// checks what the frontend and the Tauri config give it.
import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'fs'
import { createServer } from 'net'
import { spawn } from 'child_process'
import { tmpdir } from 'os'
import { resolve, dirname, join } from 'path'
import { contentSecurityPolicy, relayPageCsp } from '../../csp.js'
import core from '../../electron/lanRelayCore.cjs'
import signCore from '../../electron/signSessionCore.cjs'

const frontendDir = resolve(__dirname, '../..')
const read = (p) => readFileSync(resolve(frontendDir, p), 'utf8')
const json = (p) => JSON.parse(read(p))

const directives = (policy) => new Map(policy.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
  const [name, ...values] = d.split(/\s+/)
  return [name, values.join(' ')]
}))

describe('the relays\' page policy (csp.js relayPageCsp)', () => {
  it('is the app\'s policy, with Tauri\'s ipc: and without frame-ancestors (the relays send X-Frame-Options)', () => {
    const relay = directives(relayPageCsp())
    const app = directives(contentSecurityPolicy({ frameAncestors: null }))
    expect([...relay.keys()]).toEqual([...app.keys()])
    for (const [name, value] of app) {
      if (name === 'connect-src') continue
      expect(relay.get(name), name).toBe(value)
    }
    expect(relay.get('connect-src')).toBe(`${app.get('connect-src')} ipc:`)
    expect(relay.has('frame-ancestors')).toBe(false)
    // tablets reach the relay's socket (ws://<lan>:8080) and the cloud (https:)
    expect(relay.get('connect-src').split(' ')).toEqual(expect.arrayContaining(["'self'", 'ws:', 'http:', 'https:', 'wss:']))
    expect(relay.get('script-src')).not.toMatch(/'unsafe-eval'|'unsafe-inline'/)
  })

  it('relay.rs reads the same policy (shared/relayPageCsp.txt)', () => {
    expect(read('shared/relayPageCsp.txt')).toBe(`${relayPageCsp()}\n`)
    expect(read('src-tauri/src/relay.rs')).toContain('include_str!("../../shared/relayPageCsp.txt")')
  })

  it('the Tauri config: the policy for its own assets, no window.__TAURI__ (OpenBeach: its own, none here)', () => {
    const conf = json('src-tauri/tauri.conf.json')
    expect(conf.app.security.csp).toBe(relayPageCsp())
    expect(conf.app.withGlobalTauri).toBe(false)
    expect(json('src-tauri/tauri.beach.conf.json').app.security.csp).toBeNull()
  })

  it('no page code needs window.__TAURI__ (every check also takes __TAURI_INTERNALS__)', () => {
    const files = []
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          if (!['__tests__', '__audit__', 'node_modules'].includes(e.name)) walk(p)
        } else if (/\.(jsx?|tsx?)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p)
      }
    }
    walk(resolve(frontendDir, 'src'))
    walk(resolve(frontendDir, 'scoresheet_pdf'))
    for (const f of files) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (/__TAURI__\b/.test(line)) expect(line, f).toMatch(/__TAURI_INTERNALS__/)
      }
    }
  })

  it('the "already running" page of the relays has a strict policy of its own', () => {
    expect(core.MAIN_INSTANCE_PAGE_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")
    expect(read('src-tauri/src/relay.rs')).toContain(`pub const MAIN_INSTANCE_PAGE_CSP: &str =\n    "${core.MAIN_INSTANCE_PAGE_CSP}";`)
    const gate = core.createMainInstanceGate({ isLocal: (addr) => addr === '127.0.0.1' })
    gate.register('desk', '127.0.0.1')
    let head = null
    const res = { writeHead: (status, headers) => { head = { status, headers } }, end: () => {} }
    expect(gate.handleMainPage({ url: '/', headers: {}, socket: { remoteAddress: '192.168.1.50' } }, res, '/')).toBe(true)
    expect(head.status).toBe(403)
    expect(head.headers['Content-Security-Policy']).toBe(core.MAIN_INSTANCE_PAGE_CSP)
  })
})

const freePort = () => new Promise((ok, fail) => {
  const s = createServer()
  s.on('error', fail)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)) })
})

async function serve(dist, paths) {
  const [port, wsPort] = [await freePort(), await freePort()]
  const child = spawn(process.execPath, ['server.js'], {
    cwd: frontendDir,
    env: { ...process.env, PORT: String(port), WS_PORT: String(wsPort), HTTPS: 'false', NODE_ENV: 'test', OV_RELAY_DIST_DIR: dist },
    stdio: 'ignore'
  })
  try {
    const start = Date.now()
    for (;;) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/server/status`)).ok) break } catch { /* not yet */ }
      if (Date.now() - start > 15000) throw new Error('server.js did not start')
      await new Promise((r) => setTimeout(r, 100))
    }
    const out = {}
    for (const p of paths) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`)
      await r.arrayBuffer()
      out[p] = r.headers.get('content-security-policy')
    }
    return out
  } finally {
    child.kill('SIGKILL')
  }
}

describe('frontend/server.js sends the policy with the app\'s pages (SEC-47)', () => {
  const page = (dir, file, text) => {
    mkdirSync(dirname(resolve(dir, file)), { recursive: true })
    writeFileSync(resolve(dir, file), text)
  }

  it('OpenVolley build: every page, not the files; the phone pages keep their own', async () => {
    const dist = mkdtempSync(resolve(tmpdir(), 'ov-relay-csp-'))
    try {
      for (const [f, t] of [['index.html', '<!doctype html><title>scorer</title>'], ['referee/index.html', '<!doctype html><title>referee</title>'],
        ['assets/app.js', 'console.log(1)'], ['sign/index.html', '<!doctype html><title>sign</title>']]) page(dist, f, t)
      const got = await serve(dist, ['/', '/referee', '/referee/', '/assets/app.js', '/sign/'])
      expect(got['/']).toBe(relayPageCsp())
      expect(got['/referee']).toBe(relayPageCsp())
      expect(got['/referee/']).toBe(relayPageCsp())
      expect(got['/assets/app.js']).toBeNull()
      expect(got['/sign/']).toBe(signCore.SIGN_PAGE_CSP)
    } finally {
      rmSync(dist, { recursive: true, force: true })
    }
  }, 30000)

  it('an OpenBeach build (its own inline scripts): no policy from here, as before', async () => {
    const dist = mkdtempSync(resolve(tmpdir(), 'ov-relay-csp-beach-'))
    try {
      for (const [f, t] of [['index.html', '<!doctype html><title>scorer</title>'], ['referee_beach.html', '<!doctype html><title>beach referee</title>']]) page(dist, f, t)
      const got = await serve(dist, ['/', '/referee'])
      expect(got).toEqual({ '/': null, '/referee': null })
    } finally {
      rmSync(dist, { recursive: true, force: true })
    }
  }, 30000)
})
