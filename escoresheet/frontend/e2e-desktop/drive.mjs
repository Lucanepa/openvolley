#!/usr/bin/env node
// Drive the real desktop app (Tauri 2, WebKitGTK on Linux) through
// tauri-driver + WebKitWebDriver, with diagnostics mode on, and read back the
// diagnostics lines. No npm dependency: plain W3C WebDriver over fetch (Node 22+).
//
// Needs: tauri-driver (cargo install tauri-driver --locked) and WebKitWebDriver
// (Debian/Ubuntu package webkit2gtk-driver). No other copy of the same app may
// be running (single instance: a second launch only focuses the first, so quit
// it from the tray first).
//
// One session lives across commands, so a person or an agent can drive the app
// step by step:
//
//   node e2e-desktop/drive.mjs start [--beach] [--app PATH] [--no-diag]
//   node e2e-desktop/drive.mjs ui                      visible buttons (caption + test id) and open dialogs
//   node e2e-desktop/drive.mjs click "Confirm time-out"   a visible button/link by caption (the topmost one)
//   node e2e-desktop/drive.mjs click testid=scoreboard-timeout-left    or by data-testid, or css=SELECTOR
//                                                     (refuses, naming it, when something covers the target)
//   node e2e-desktop/drive.mjs domclick "Options"     element.click() even when covered (no mouse events)
//   node e2e-desktop/drive.mjs key Escape|Enter|Tab|<text>
//   node e2e-desktop/drive.mjs eval "document.title"   run JS in the page, print the result as JSON
//   node e2e-desktop/drive.mjs size 1250 760           set the window's size (CSS px)
//   node e2e-desktop/drive.mjs bounce 1250 760 [ms]    resize there and back after ms (default 250)
//   node e2e-desktop/drive.mjs max | fullscreen | rect
//   node e2e-desktop/drive.mjs shot out.png            screenshot of the page
//   node e2e-desktop/drive.mjs log [all]               this session's notable diagnostics lines (all: every line)
//   node e2e-desktop/drive.mjs stop                    end the session (closes the app) and the driver
//   node e2e-desktop/drive.mjs smoke [--beach] [--app PATH]   start, a short tour, the summary, stop
//
// The app is started with OPENVOLLEY_DIAGNOSTICS=1 (unless --no-diag) plus the
// rest of this environment, so OPENVOLLEY_LOG_DIR, OV_DEBUG,
// WEBKIT_DISABLE_DMABUF_RENDERER, GDK_BACKEND, GDK_SCALE ... reach it.
// Default app: the cargo debug build, src-tauri/target/debug/openvolley-escoresheet
// (--beach: src-tauri/target-beach/debug/openvolley-escoresheet, built with
// OV_FLAVOUR=beach CARGO_TARGET_DIR=target-beach). The installed .deb works too:
// --app /usr/bin/openvolley-escoresheet or --app /usr/bin/openbeach-escoresheet.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND = path.resolve(HERE, '..')
const STATE = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'ov-e2e-desktop.json')
const DRIVER_PORT = Number(process.env.TAURI_DRIVER_PORT || 4444)
const NATIVE_PORT = DRIVER_PORT + 1
const W3C_ELEMENT = 'element-6066-11e4-a52e-4f735466cecf'
const KEYS = { Enter: '', Escape: '', Tab: '', Backspace: '', Space: '', ArrowLeft: '', ArrowUp: '', ArrowRight: '', ArrowDown: '', F11: '' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const die = (msg) => { console.error(msg); process.exit(1) }

function args(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--beach') out.beach = true
    else if (a === '--no-diag') out.noDiag = true
    else if (a === '--app') out.app = argv[++i]
    else out._.push(a)
  }
  return out
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return null }
}

async function wd(method, url, body, timeoutMs = 60000) {
  const res = await fetch(`http://127.0.0.1:${DRIVER_PORT}${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${json?.value?.error || ''} ${json?.value?.message || ''}`.trim())
  return json.value
}

const session = () => {
  const s = readState()
  if (!s?.sessionId) die(`no session: run "node e2e-desktop/drive.mjs start" first (${STATE})`)
  return s
}
const sx = (method, sub, body, t) => wd(method, `/session/${session().sessionId}${sub}`, body, t)
const exec = (script, ...a) => sx('POST', '/execute/sync', { script, args: a })

async function driverUp() {
  try { await fetch(`http://127.0.0.1:${DRIVER_PORT}/status`, { signal: AbortSignal.timeout(1000) }); return true } catch { return false }
}

async function appPortBusy(port) {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }); return true } catch { return false }
}

function logDir() {
  if (process.env.OPENVOLLEY_LOG_DIR) return process.env.OPENVOLLEY_LOG_DIR
  // OpenBeach on Linux writes into OpenVolley's folder too (activity.rs data_log_root)
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(data, 'OpenVolley', 'logs')
}

async function start(o) {
  if (readState()?.sessionId) die(`a session is open (${STATE}): run "stop" first`)
  const which = (b) => process.env.PATH.split(':').map((d) => path.join(d, b)).find((p) => fs.existsSync(p))
  const tauriDriver = which('tauri-driver') || path.join(os.homedir(), '.cargo', 'bin', 'tauri-driver')
  if (!fs.existsSync(tauriDriver)) die('tauri-driver not found: cargo install tauri-driver --locked')
  const native = which('WebKitWebDriver') || die('WebKitWebDriver not found: sudo apt install webkit2gtk-driver')
  const app = path.resolve(o.app || path.join(FRONTEND, 'src-tauri', o.beach ? 'target-beach' : 'target', 'debug', 'openvolley-escoresheet'))
  if (!fs.existsSync(app)) die(`no app at ${app} (build it, or pass --app)`)
  const beach = o.beach || /openbeach/.test(app)
  const port = Number(process.env.OPENVOLLEY_HTTP_PORT || (beach ? 5174 : 5173))
  if (await appPortBusy(port)) die(`port ${port} answers: ${beach ? 'OpenBeach' : 'OpenVolley'} is already running (tray?). Quit it first: a second instance only focuses the first.`)
  if (await driverUp()) die(`something already listens on ${DRIVER_PORT} (an old tauri-driver?): kill it or set TAURI_DRIVER_PORT`)

  const env = { ...process.env }
  if (!o.noDiag) env.OPENVOLLEY_DIAGNOSTICS = '1'
  const logFile = path.join(os.tmpdir(), `ov-e2e-driver-${Date.now()}.log`)
  const out = fs.openSync(logFile, 'a')
  const drv = spawn(tauriDriver, ['--port', String(DRIVER_PORT), '--native-port', String(NATIVE_PORT), '--native-driver', native], { env, detached: true, stdio: ['ignore', out, out] })
  drv.unref()
  for (let i = 0; i < 40 && !(await driverUp()); i++) await sleep(250)
  if (!(await driverUp())) die(`tauri-driver did not start, see ${logFile}`)

  const startedAt = new Date().toISOString()
  const s = await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application: app } } } }, 120000)
  fs.writeFileSync(STATE, JSON.stringify({ sessionId: s.sessionId, driverPid: drv.pid, app, port, startedAt, driverLog: logFile }, null, 2))
  // the page: the relay serves it, the scoretable mounts
  let ready = false
  for (let i = 0; i < 120 && !ready; i++) {
    await sleep(500)
    try { ready = await exec('return document.readyState === "complete" && !!document.querySelector("#root")?.children.length') } catch { /* page still loading */ }
  }
  const info = await exec('return { url: location.href, title: document.title, diag: String(window.__OV_DIAGNOSTICS__ ?? null), w: innerWidth, h: innerHeight, dpr: devicePixelRatio }')
  console.log(JSON.stringify({ started: ready, app, ...info, logs: logDir(), driverLog: logFile }))
}

async function stop() {
  const s = readState()
  if (!s) return console.log('no session')
  try { await wd('DELETE', `/session/${s.sessionId}`, undefined, 20000) } catch (e) { console.error(String(e.message || e)) }
  try { process.kill(-s.driverPid, 'SIGTERM') } catch { try { process.kill(s.driverPid, 'SIGTERM') } catch { /* gone */ } }
  fs.rmSync(STATE, { force: true })
  console.log('stopped')
}

// The visible, enabled element a person would hit: by caption (buttons, links,
// role=button), testid=, or css=. The last match wins (an open dialog is on top).
const FIND = `
  const [q] = arguments
  const shown = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !e.disabled }
  const text = (e) => (e.innerText || e.getAttribute('aria-label') || e.title || '').replace(/\\s+/g, ' ').trim()
  let list
  if (q.startsWith('testid=')) list = [...document.querySelectorAll('[data-testid="' + q.slice(7) + '"]')]
  else if (q.startsWith('css=')) list = [...document.querySelectorAll(q.slice(4))]
  else {
    const all = [...document.querySelectorAll('button, a, [role=button], [role=menuitem], [role=tab], [role=switch], [role=option]')]
    list = all.filter((e) => text(e) === q)
    if (!list.length) list = all.filter((e) => text(e).toLowerCase().includes(q.toLowerCase()))
  }
  list = list.filter(shown)
  // what a person can hit: on top at its centre (a modal covers the page), or off screen (WebDriver scrolls to it)
  const onTop = (e) => { const r = e.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return true
    const hit = document.elementFromPoint(x, y); return !!hit && (e === hit || e.contains(hit)) }
  const top = list.filter(onTop)
  if (top.length) return { el: top[top.length - 1], cover: null }
  if (!list.length) return null
  const e = list[list.length - 1], r = e.getBoundingClientRect()
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  const name = (n) => n ? n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.getAttribute('role') ? '[role=' + n.getAttribute('role') + ']' : '') + ' ' + (n.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 50) : 'nothing'
  const dlg = hit && hit.closest('[role=dialog],[role=alertdialog]')
  return { el: e, cover: name(dlg || hit) }`

async function click(q, { dom = false } = {}) {
  const found = await exec(FIND, q)
  if (!found) die(`nothing visible matches ${JSON.stringify(q)} (try "ui")`)
  const { el, cover } = found
  if (dom) {
    await exec('arguments[0].click()', el)
    return console.log(`DOM-clicked ${JSON.stringify(q)}${cover ? ` (it was covered by ${cover})` : ''}`)
  }
  // a person could not press it either: say what is on top (a toast, a modal, its backdrop)
  if (cover) die(`${JSON.stringify(q)} is covered by ${cover}: close that first, wait, or use domclick`)
  const id = el[W3C_ELEMENT]
  try {
    await sx('POST', `/element/${id}/click`, {})
  } catch (e) {
    // WebKitWebDriver sometimes calls a visible button "intercepted": a real
    // mouse press at its centre, else a DOM click (still a ui.click line)
    try {
      const pointer = [{ type: 'pointerMove', duration: 0, origin: el, x: 0, y: 0 }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }]
      await sx('POST', '/actions', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: pointer }] })
      await sx('DELETE', '/actions')
      console.error(`webdriver click refused (${e.message.replace(/^.*: /, '')}), pressed the mouse at its centre instead`)
    } catch (e2) {
      console.error(`webdriver click failed (${e2.message}), using a DOM click`)
      await exec('arguments[0].click()', el)
    }
  }
  console.log(`clicked ${JSON.stringify(q)}`)
}

async function key(k) {
  const value = KEYS[k] ?? k
  // to the focused element (or the body): real key events through the webview
  const actions = [...value].flatMap((c) => [{ type: 'keyDown', value: c }, { type: 'keyUp', value: c }])
  await sx('POST', '/actions', { actions: [{ type: 'key', id: 'kbd', actions }] })
  await sx('DELETE', '/actions')
  console.log(`key ${k}`)
}

async function ui() {
  const r = await exec(`
    const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' }
    const covered = (e) => { const r = e.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false
      const hit = document.elementFromPoint(x, y); return !hit || !(e === hit || e.contains(hit)) }
    const t = (e) => (e.innerText || e.getAttribute('aria-label') || e.title || '').replace(/\\s+/g, ' ').trim().slice(0, 60)
    const dialogs = [...document.querySelectorAll('[role=dialog], [role=alertdialog]')].filter(shown).map((d) => ({ title: (d.querySelector('h1,h2,h3,[id$=title]') || d).innerText.split('\\n')[0].slice(0, 80), buttons: [...d.querySelectorAll('button')].filter(shown).map(t).filter(Boolean) }))
    // buttons a person can hit now (not under a modal or a toast)
    const buttons = [...document.querySelectorAll('button, [role=button], a[href]')].filter((e) => shown(e) && !covered(e)).map((e) => (e.dataset.testid ? '[' + e.dataset.testid + '] ' : '') + t(e)).filter((s) => s.trim())
    return { url: location.pathname + location.search, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, dialogs, buttons: buttons.slice(0, 120) }`)
  console.log(JSON.stringify(r, null, 1))
}

async function rect(r) {
  const v = r ? await sx('POST', '/window/rect', r) : await sx('GET', '/window/rect')
  console.log(JSON.stringify(v))
}

async function bounce(w, h, ms = 250) {
  const before = await sx('GET', '/window/rect')
  await sx('POST', '/window/rect', { width: w, height: h })
  await sleep(ms)
  await sx('POST', '/window/rect', { width: before.width, height: before.height })
  console.log(JSON.stringify({ from: [before.width, before.height], via: [w, h], ms }))
}

// The diagnostics lines since this session started: one copy per sid+seq
// (a reload can write a few twice), time order.
function lines(all) {
  const s = readState() || {}
  const dir = logDir()
  let files = []
  try { files = fs.readdirSync(dir).filter((f) => /^diagnostics-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort() } catch { die(`no log folder ${dir}`) }
  const seen = new Set()
  const out = []
  for (const f of files) {
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!l) continue
      let o
      try { o = JSON.parse(l) } catch { continue }
      if (s.startedAt && o.ts < s.startedAt) continue
      const k = o.sid ? `${o.sid}:${o.seq}` : `${o.ts}:${o.k}:${o.m}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push(o)
    }
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  if (all) return out
  const notable = (o) => o.k === 'geo.jump' || o.k === 'page.load' || o.k === 'page.reload_request' || o.k.startsWith('native.page_load') ||
    o.k === 'page.error' || o.k === 'page.rejection' || o.k === 'dialog.content' || (o.k === 'dialog.close' && o.d?.flash) ||
    o.k === 'sw.controllerchange' || o.k === 'lq.fallback' || o.k === 'action.fail' || o.k === 'action.drop' || o.k === 'diag.capped' || o.k === 'diag.dropped'
  return out.filter(notable)
}

function log(all) {
  const ls = lines(all)
  for (const o of ls) console.log(JSON.stringify(o))
  const count = {}
  for (const o of lines(true)) count[o.k] = (count[o.k] || 0) + 1
  console.error(`-- ${ls.length} lines shown; all kinds this session: ${JSON.stringify(count)} (folder ${logDir()})`)
}

async function smoke(o) {
  await start(o)
  try {
    await sleep(3000)
    await ui()
    // startup notices ("All services connected!" closes itself) out of the way
    for (let i = 0; i < 20; i++) {
      const open = await exec('return document.querySelectorAll("[role=dialog],[role=alertdialog]").length')
      if (!open) break
      if (i === 10) await key('Escape')
      await sleep(500)
    }
    console.log('-- window: a bounce like a KDE snap / maximise, then maximise and back')
    await bounce(1250, 760)
    await sleep(1500)
    const r = await sx('GET', '/window/rect')
    try { await sx('POST', '/window/maximize', {}); await sleep(1500) } catch (e) { console.error(`maximize: ${e.message}`) }
    await sx('POST', '/window/rect', { width: r.width, height: r.height })
    await sleep(1500)
    console.log('-- a dialog: Options open and closed')
    try { await click('Options'); await sleep(1200); await click('Close'); await sleep(1200) } catch (e) { console.error(String(e.message || e)) }
    await sleep(2500) // the page writes its lines about once a second
    log(false)
  } finally {
    await stop()
  }
}

const o = args(process.argv.slice(2))
const [cmd, a1, a2, a3] = o._
const cmds = {
  start: () => start(o),
  stop,
  smoke: () => smoke(o),
  ui,
  click: () => click(a1 ?? die('click what?')),
  domclick: () => click(a1 ?? die('click what?'), { dom: true }),
  key: () => key(a1 ?? die('which key?')),
  eval: async () => console.log(JSON.stringify(await exec(`return (${a1})`), null, 1)),
  size: () => rect({ width: Number(a1), height: Number(a2) }),
  bounce: () => bounce(Number(a1), Number(a2), a3 ? Number(a3) : 250),
  rect: () => rect(),
  max: async () => console.log(JSON.stringify(await sx('POST', '/window/maximize', {}))),
  fullscreen: async () => console.log(JSON.stringify(await sx('POST', '/window/fullscreen', {}))),
  shot: async () => { fs.writeFileSync(a1 || 'shot.png', Buffer.from(await sx('GET', '/screenshot'), 'base64')); console.log(a1 || 'shot.png') },
  log: async () => log(a1 === 'all'),
}
if (!cmds[cmd]) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(0, 40).map((l) => l.slice(3)).join('\n'))
  process.exit(cmd ? 1 : 0)
}
await cmds[cmd]().catch((e) => die(String(e?.message || e)))
