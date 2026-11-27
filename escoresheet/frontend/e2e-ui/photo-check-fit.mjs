#!/usr/bin/env node
// The photo import's check screen (components/rosterPhoto/RosterConfirmStep.jsx in
// its dialog, as RosterPhotoImport shows it) fits a Galaxy Tab A7 Lite and a phone
// without scrolling sideways, with the default text and with Android's large system
// font (owner, 2026-11-27: the table scrolled sideways and long names were cut off in
// their boxes). Made-up names only. Needs a running dev server:
//
//   WS_PORT=18741 npx vite --host 127.0.0.1 --port 5641 --strictPort
//   OV_URL=http://127.0.0.1:5641/ node e2e-ui/photo-check-fit.mjs [--shots DIR]
//
// Per size (A7 Lite at density 1.333 and 1.5, landscape and upright, a phone) and per
// text size (1x, 1.5x: Android grows the text, not px or rem lengths, so every element
// with a font size of its own gets 1.5x its computed size here):
//   - nothing in the dialog is wider than its box (no sideways scrolling);
//   - every name is whole in its box (it wraps onto a second line, never cut off);
//   - every control of a player row is at least 44 x 44 px.
// Exits 1 on a problem. Environment: PLAYWRIGHT_CORE, CHROME_PATH (as small-screens.mjs).
import fs from 'node:fs'
import path from 'node:path'
import { BASE_URL, launch } from './lib.mjs'

const shots = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null })()
if (shots) fs.mkdirSync(shots, { recursive: true })

// made-up people, long names on purpose
const roster = {
  source: 'ocr',
  players: [
    { number: 12, licence: '100001', firstName: 'Maximiliano Alessandro', lastName: 'Beispielmann-Exemplarisch', dob: '', isCaptain: true, isLibero: false, confidence: { number: 0.6 } },
    { number: null, licence: '100002', firstName: 'Anna', lastName: 'von Beispielhausen', dob: '', isCaptain: false, isLibero: true, confidence: { isLibero: 0.6 } },
    { number: 7, licence: '10003', firstName: 'Jean-Baptiste', lastName: 'Exemplaire-Dupontel', dob: '', isCaptain: false, isLibero: false },
    { number: 99, licence: '100004', firstName: 'Lea', lastName: 'Muster', dob: '', isCaptain: false, isLibero: false, confidence: { lastName: 0.5 } },
    { number: 3, licence: '', firstName: 'Giovanni Battista', lastName: 'Esempio Della Valle', dob: '', isCaptain: false, isLibero: false }
  ],
  coach: { firstName: 'Hans-Peter', lastName: 'Musterbeispielmann', licence: '100005' },
  ac1: { firstName: 'Marie', lastName: 'Exemple', licence: '100006', confidence: { firstName: 0.5 } },
  ac2: null,
  struck: [{ firstName: 'Paul', lastName: 'Gestrichen', licence: '100007' }]
}

const SIZES = [
  { name: 'a7-1005x600', width: 1005, height: 600 },
  { name: 'a7-893x533', width: 893, height: 533 },
  { name: 'a7-600x1005', width: 600, height: 1005 },
  { name: 'a7-1340x800', width: 1340, height: 800 },
  { name: 'a7-800x1340', width: 800, height: 1340 },
  { name: 'phone-393x852', width: 393, height: 852 }
]

let problems = 0
for (const size of SIZES) {
  for (const zoom of [1, 1.5]) {
    const { browser, page, errors } = await launch({ width: size.width, height: size.height, touch: true })
    try {
      await page.route('**/__photo-check-fit.html', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>fit</title><body><div id="root"></div></body>' }))
      await page.goto(new URL('__photo-check-fit.html', BASE_URL).href)
      await page.evaluate(async ({ roster, zoom }) => {
        // React from the dev server's own pre-bundled copies (the ones the app imports)
        const R = await import('/@react-refresh')
        R.injectIntoGlobalHook(window)
        window.$RefreshReg$ = () => {}
        window.$RefreshSig$ = () => (t) => t
        window.__vite_plugin_react_preamble_installed__ = true
        const main = await (await fetch('/src/main.jsx')).text()
        const dep = (re) => re.exec(main)[1]
        const React = (await import(dep(/"(\/node_modules\/\.vite\/deps\/react\.js\?v=[^"]+)"/))).default
        const client = await import(dep(/"(\/node_modules\/\.vite\/deps\/react-dom_client\.js\?v=[^"]+)"/))
        const createRoot = client.createRoot || client.default.createRoot
        await import('/src/tailwind.css')
        await import('/src/i18n/index.js')
        const { default: KitModal } = await import('/src/components/manage/KitModal.jsx')
        const { default: RosterConfirmStep } = await import('/src/components/rosterPhoto/RosterConfirmStep.jsx')
        const { fieldIssues } = await import('/src/domain/importedRoster.js')
        if (zoom !== 1) {
          // a text zoom: each element with a font size of its own grows, inherited ones follow
          const grow = (root) => {
            const plan = [root, ...root.querySelectorAll('*')].filter((e) => !e.dataset.zoomed).map((e) => {
              const own = parseFloat(getComputedStyle(e).fontSize)
              const up = e.parentElement
              const parent = up?.dataset.zoomed ? parseFloat(up.dataset.base) : (up ? parseFloat(getComputedStyle(up).fontSize) : 16)
              return { e, own, inherits: Math.abs(own - parent) < 0.01 && up !== document.body }
            })
            for (const { e, own, inherits } of plan) {
              e.dataset.zoomed = '1'
              e.dataset.base = String(own)
              if (!inherits) e.style.fontSize = `${own * zoom}px`
            }
          }
          new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) grow(n) }).observe(document.body, { childList: true, subtree: true })
        }
        function App () {
          const [r, setR] = React.useState(roster)
          return React.createElement(KitModal, { open: true, onClose: () => {}, decision: true, dismissible: false, layout: 'sections', size: 'xl', className: 'max-w-4xl', title: 'Einsatzliste from a photo', closeLabel: 'Close' },
            React.createElement(RosterConfirmStep, { roster: r, issues: fieldIssues(r), onChange: setR }))
        }
        createRoot(document.getElementById('root')).render(React.createElement(App))
      }, { roster, zoom })
      await page.waitForSelector('[data-testid="roster-photo-players"]')
      await page.waitForTimeout(300)
      const found = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        const wide = [dialog, ...dialog.querySelectorAll('*')]
          .filter((e) => !['TEXTAREA', 'INPUT'].includes(e.tagName) && !e.classList.contains('sr-only') && getComputedStyle(e).overflowX !== 'visible' && e.scrollWidth > e.clientWidth + 1)
          .map((e) => `${e.tagName} ${e.scrollWidth} > ${e.clientWidth}`)
        if (document.documentElement.scrollWidth > window.innerWidth) wide.push(`page ${document.documentElement.scrollWidth} > ${window.innerWidth}`)
        const cut = [...dialog.querySelectorAll('textarea, input[type=text]')]
          .filter((t) => t.scrollWidth > t.clientWidth + 2 || (t.tagName === 'TEXTAREA' && t.scrollHeight > t.clientHeight + 2))
          .map((t) => t.getAttribute('aria-label'))
        const small = [...dialog.querySelectorAll('[data-testid="roster-photo-row"] input, [data-testid="roster-photo-row"] textarea, [data-testid="roster-photo-row"] button')]
          .map((e) => (e.type === 'checkbox' ? e.parentElement : e))
          .filter((e) => { const r = e.getBoundingClientRect(); return r.height < 43.5 || r.width < 43.5 })
          .map((e) => e.getAttribute('aria-label') || e.title || e.tagName)
        return { wide, cut, small: [...new Set(small)] }
      })
      const bad = found.wide.length + found.cut.length + found.small.length + errors.length
      problems += bad ? 1 : 0
      console.log(`${bad ? 'FAIL' : 'ok  '} ${size.name} text ${zoom}x${bad ? ` ${JSON.stringify({ ...found, errors })}` : ''}`)
      if (shots) await page.screenshot({ path: path.join(shots, `${size.name}-text${zoom}.png`) })
    } finally {
      await browser.close()
    }
  }
}
console.log(problems ? `${problems} size(s) with problems` : 'the check screen fits every size')
process.exit(problems ? 1 : 0)
