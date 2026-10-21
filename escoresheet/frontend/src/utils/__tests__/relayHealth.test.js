// @vitest-environment node
/**
 * GET /health on the Node relays: the coin toss's "WebSocket server" check
 * asks the relay's /health. The Electron and Tauri relays answered it, the
 * standalone server.js and the Vite dev server answered 404, so the check
 * failed ("Some checks reported issues") on them, offline mode included.
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { vitePluginApiRoutes } from '../../../vite-plugin-api-routes.js'

const here = dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = resolve(here, '../../..')

function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createNetServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolvePort(port))
    })
  })
}

async function waitForHttp(url, timeoutMs = 10000) {
  const start = Date.now()
  for (;;) {
    try {
      if ((await fetch(url)).ok) return
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`server at ${url} did not start`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('relay /health', () => {
  it('standalone server.js answers /health and /api/health', async () => {
    const [port, wsPort] = [await freePort(), await freePort()]
    const child = spawn(process.execPath, ['server.js'], {
      cwd: FRONTEND_DIR,
      env: { ...process.env, PORT: String(port), WS_PORT: String(wsPort), HTTPS: 'false', NODE_ENV: 'test' },
      stdio: 'ignore',
    })
    try {
      await waitForHttp(`http://127.0.0.1:${port}/api/server/status`)
      for (const path of ['/health', '/api/health']) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`)
        expect(res.status, path).toBe(200)
        expect(await res.json()).toEqual({ status: 'ok', running: true })
      }
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('the Vite dev plugin answers /health and /api/health, not /health/other', async () => {
    const plugin = vitePluginApiRoutes({ wsPort: 0 })
    const routes = {}
    plugin.configureServer({
      config: { server: { https: false, port: 5173 } },
      middlewares: { use: (prefix, fn) => { routes[prefix] = fn } },
    })
    // connect strips the mount prefix before the middleware sees the url
    const call = (prefix, url) => new Promise((resolveCall) => {
      const res = {
        headersSent: false,
        setHeader() {},
        writeHead(status) { this.status = status },
        end(body) { resolveCall({ status: this.status, body: JSON.parse(body) }) }
      }
      routes[prefix]({ url, method: 'GET', headers: {} }, res, () => resolveCall({ next: true }))
    })
    try {
      expect(await call('/health', '/')).toEqual({ status: 200, body: { status: 'ok', running: true } })
      expect(await call('/api', '/health')).toEqual({ status: 200, body: { status: 'ok', running: true } })
      expect(await call('/health', '/other')).toEqual({ next: true })
    } finally {
      plugin.closeBundle()
    }
  })
})
