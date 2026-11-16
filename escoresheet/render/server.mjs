/**
 * openvolley-render: the backend's vector scoresheet PDF service (field-spec
 * 17.19, escoresheet/deploy/Dockerfile.render). It listens on the backend's
 * private network only (compose ov-render-net, internal: true: no egress).
 *
 *   POST /render  { record, rebuildReason?, rebuiltAt? }  ->  application/pdf
 *        headers: x-ov-filename, x-ov-render-ms, x-ov-remarks-pages (0/1),
 *        x-ov-missing-pictures (count)
 *        401 without the shared token, 413 body too large, 422 the sheet
 *        could not be drawn, 503 busy (queue full) or Chromium down, 504 timeout
 *   GET  /health  { ok, browser, queue }
 *
 * Env: PORT (8090), OV_RENDER_TOKEN (shared with the backend; required),
 * OV_RENDER_DIST (dist-render/), CHROMIUM_PATH (else Playwright's own),
 * OV_RENDER_TIMEOUT_MS (60000), OV_RENDER_MAX_BODY_MB (25), OV_RENDER_QUEUE (8),
 * OV_TIMEZONE (Europe/Zurich).
 */
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createRenderer, LAUNCH_ARGS } from './lib/renderPdf.mjs'
import { createQueue, QueueFull } from './lib/queue.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8090)
const TOKEN = String(process.env.OV_RENDER_TOKEN || '')
const DIST = resolve(process.env.OV_RENDER_DIST || resolve(here, 'dist-render'))
const TIMEOUT_MS = Number(process.env.OV_RENDER_TIMEOUT_MS || 60_000)
const MAX_BODY = Number(process.env.OV_RENDER_MAX_BODY_MB || 25) * 1024 * 1024

if (TOKEN.length < 24) {
  console.error('FATAL: OV_RENDER_TOKEN must be set (24+ characters), the same value as the backend\'s')
  process.exit(78)
}

const renderer = createRenderer({
  distDir: DIST,
  timeoutMs: TIMEOUT_MS,
  launch: () => chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: LAUNCH_ARGS
  })
})
const queue = createQueue({ max: Number(process.env.OV_RENDER_QUEUE || 8) })

function authorized (req) {
  const got = Buffer.from(String(req.headers['x-ov-render-token'] || ''))
  const want = Buffer.from(TOKEN)
  return got.length === want.length && timingSafeEqual(got, want)
}

function readBody (req) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function json (res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return json(res, 200, { ok: true, browser: renderer.connected(), queue: queue.stats() })
    }
    if (req.method !== 'POST' || req.url !== '/render') return json(res, 404, { error: 'not found' })
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' })
    let payload
    try {
      payload = JSON.parse((await readBody(req)).toString('utf8'))
    } catch (err) {
      return json(res, err?.status === 413 ? 413 : 400, { error: err?.status === 413 ? 'body too large' : 'bad JSON' })
    }
    if (!payload || typeof payload !== 'object' || !payload.record?.match) return json(res, 400, { error: 'record.match required' })
    const out = await queue.run(() => renderer.render({
      record: payload.record,
      rebuildReason: typeof payload.rebuildReason === 'string' ? payload.rebuildReason.slice(0, 500) : null,
      rebuiltAt: typeof payload.rebuiltAt === 'string' ? payload.rebuiltAt : null
    }))
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length': out.pdf.length,
      'x-ov-filename': encodeURIComponent(out.info.filename || 'scoresheet.pdf'),
      'x-ov-render-ms': String(out.ms),
      'x-ov-remarks-pages': out.info.remarksPages ? '1' : '0',
      'x-ov-missing-pictures': String(out.info.missingPictures?.length || 0)
    })
    res.end(out.pdf)
    console.log(`[render] ${out.pdf.length} bytes in ${out.ms} ms${out.info.missingPictures?.length ? `, missing pictures: ${out.info.missingPictures.join(', ')}` : ''}`)
  } catch (err) {
    if (err instanceof QueueFull) return json(res, 503, { error: 'busy', code: err.code })
    if (err?.code === 'OV_RENDER_SHEET') return json(res, 422, { error: err.message, code: err.code })
    const timedOut = /Timeout|closed|Target page, context or browser has been closed/i.test(String(err?.message))
    console.error(`[render] failed: ${String(err?.message || err).slice(0, 300)}`)
    if (!res.headersSent) json(res, timedOut ? 504 : 503, { error: timedOut ? 'timeout' : 'render failed', code: timedOut ? 'OV_RENDER_TIMEOUT' : 'OV_RENDER_FAILED' })
  }
})

server.requestTimeout = TIMEOUT_MS + 30_000
server.listen(PORT, () => console.log(`[render] listening on ${PORT}, pages from ${DIST}`))

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close()
    renderer.close().finally(() => process.exit(0))
  })
}
