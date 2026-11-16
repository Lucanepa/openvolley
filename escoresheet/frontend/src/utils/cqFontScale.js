// WebKitGTK (the desktop app on Linux) applies the webview's page zoom twice to a font-size given in
// container units (cqw, cqh, cqi, ...): container units resolve against the zoomed size there, and
// only font-size takes that as is. Widths, heights, line heights and letter spacing in the same units
// come out right. On the Point Hub board, which runs the scoretable at the screen's own resolution
// with a page zoom of 1.5 (OPENVOLLEY_ZOOM, src-tauri/src/main.rs), every such text was 1.5x too big:
// the SERVE number stood out of its box (measured on the bench, WebKitGTK 2.54, 16.11.2026).
//
// So every font-size in container units is written calc(<n>cq? * var(--cqf, 1)) (the test
// cqFontScale.test.js keeps it that way), and this measures the engine and sets --cqf on the root to
// undo it: 1 everywhere it is not needed (browsers, tablets, the app without a zoom). It measures
// again after a resize, which is what a zoom change looks like from the page.

const PROBE_CQH = 50

/** How much bigger than asked a font-size of 50cqh comes out in a 100px-tall container (1 = right). */
export function measureCqFontScale(doc = globalThis.document) {
  if (!doc?.createElement || !globalThis.getComputedStyle) return 1
  const host = doc.body || doc.documentElement
  if (!host) return 1
  const box = doc.createElement('div')
  box.style.cssText = 'position:absolute;left:0;top:0;width:100px;height:100px;visibility:hidden;pointer-events:none;container-type:size'
  const probe = doc.createElement('div')
  probe.style.cssText = `font-size:${PROBE_CQH}cqh;line-height:1`
  probe.textContent = '0'
  box.appendChild(probe)
  host.appendChild(box)
  const px = parseFloat(globalThis.getComputedStyle(probe).fontSize)
  box.remove()
  return px > 0 && Number.isFinite(px) ? px / PROBE_CQH : 1
}

/** The factor --cqf gets for a measured scale: its inverse, or exactly 1 when within 1 %. */
export function cqFontFactor(scale) {
  if (!(scale > 0) || Math.abs(scale - 1) < 0.01) return 1
  return Math.round((1 / scale) * 10000) / 10000
}

export function applyCqFontScale(doc = globalThis.document) {
  const f = cqFontFactor(measureCqFontScale(doc))
  doc?.documentElement?.style.setProperty('--cqf', String(f))
  return f
}

export function installCqFontScale(win = globalThis.window) {
  if (!win?.document) return
  const run = () => applyCqFontScale(win.document)
  if (win.document.body) run()
  else win.document.addEventListener('DOMContentLoaded', run, { once: true })
  let timer = 0
  win.addEventListener('resize', () => { win.clearTimeout(timer); timer = win.setTimeout(run, 100) })
}

installCqFontScale()
