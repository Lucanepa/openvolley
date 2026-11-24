// Renders the fixture match to a vector PDF with real Chromium (field-spec
// 17.20) and checks it: a PDF, one A3 landscape page, the sheet's words as
// TEXT (pdftotext), no full-page picture (pdfimages), the same words the page
// shows. Needs a Chromium (CHROMIUM_PATH, or Playwright's cache) and the
// built page (frontend: npx vite build --config vite.render.config.js, or
// OV_RENDER_DIST); skipped without them. pdftotext/pdfimages (poppler-utils)
// for the text checks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir, homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createRenderer, LAUNCH_ARGS } from '../lib/renderPdf.mjs'
import { fixtureRecord } from './fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DIST = resolve(process.env.OV_RENDER_DIST || join(here, '../../frontend/dist-render'))

function chromiumPath () {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache/ms-playwright')
  if (!existsSync(cache)) return null
  for (const d of readdirSync(cache).sort().reverse()) {
    for (const rel of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = join(cache, d, rel)
      if (d.startsWith('chromium') && existsSync(p)) return p
    }
  }
  return null
}
const has = (bin) => { try { execFileSync('sh', ['-c', `command -v ${bin}`]); return true } catch { return false } }

const exe = chromiumPath()
const skip = !exe ? 'no Chromium' : !existsSync(join(DIST, 'render/index.html')) ? `no built page in ${DIST}` : false

test('the fixture match prints as a vector PDF with the sheet as text', { skip, timeout: 120_000 }, async () => {
  const renderer = createRenderer({ distDir: DIST, launch: () => chromium.launch({ executablePath: exe, args: LAUNCH_ARGS }) })
  try {
    const out = await renderer.render({ record: fixtureRecord(), rebuildReason: 'Set start times corrected', rebuiltAt: '2026-11-16T13:03:00Z', withText: true })
    assert.equal(out.pdf.subarray(0, 5).toString('latin1'), '%PDF-')
    assert.equal(out.info.filename, 'game424849_SM-Quali-U23_2026-11-15.pdf')
    assert.deepEqual(out.info.missingPictures, [])
    const dir = mkdtempSync(join(tmpdir(), 'ov-vector-'))
    const file = join(dir, 'sheet.pdf')
    writeFileSync(file, out.pdf)
    console.log(`vector PDF: ${out.pdf.length} bytes in ${out.ms} ms -> ${file}`)
    if (has('pdfinfo')) {
      const info = execFileSync('pdfinfo', [file]).toString()
      assert.match(info, /Pages:\s+1\b/)
      assert.match(info, /Page size:.*\(A3\)/)
    }
    if (has('pdftotext')) {
      const text = execFileSync('pdftotext', ['-layout', file, '-']).toString()
      // every word the sheet shows is text in the PDF (the client's sheet and the server's print agree)
      const norm = (x) => x.toLowerCase().replace(/\s+/g, '')
      const pdfText = norm(execFileSync('pdftotext', ['-raw', file, '-']).toString())
      const words = [...new Set((out.info.sheetText || '').split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3))]
      assert.ok(words.length > 80, `${words.length} words on the sheet`)
      const missing = words.filter(w => !pdfText.includes(norm(w)))
      assert.deepEqual(missing, [], 'words on the sheet that are not text in the PDF')
      for (const w of ['HOME VOLLEY CLUB', 'Home1', 'Away22', 'Gruyen', 'SM-Quali-U23', 'APPROVAL', 'RESULT', 'Rebuilt after the match', 'Set start times corrected', 'Late start: the hall was busy']) {
        assert.ok(text.toLowerCase().includes(w.toLowerCase()), `"${w}" as text in the PDF`)
      }
    }
    if (has('pdfimages')) {
      // the logo / ball pictures are small; a picture of the whole sheet would be ~1500 px wide
      const list = execFileSync('pdfimages', ['-list', file]).toString().split('\n').slice(2).filter(Boolean)
      const big = list.map(l => l.trim().split(/\s+/)).filter(c => Number(c[3]) > 1200)
      assert.equal(big.length, 0, `no full-page picture: ${list.join(' | ')}`)
    }
  } finally {
    await renderer.close()
  }
})

test('REMARKS that do not fit go on further pages as text', { skip, timeout: 120_000 }, async () => {
  const renderer = createRenderer({ distDir: DIST, launch: () => chromium.launch({ executablePath: exe, args: LAUNCH_ARGS }) })
  try {
    const out = await renderer.render({ record: fixtureRecord({ longRemarks: true }) })
    assert.equal(out.info.remarksClipped, true)
    assert.equal(out.info.remarksPages, true)
    if (has('pdfinfo') && has('pdftotext')) {
      const dir = mkdtempSync(join(tmpdir(), 'ov-vector-'))
      const file = join(dir, 'sheet.pdf')
      writeFileSync(file, out.pdf)
      const pages = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file]).toString())[1])
      assert.ok(pages >= 2, `${pages} pages`)
      const text = execFileSync('pdftotext', [file, '-']).toString()
      assert.ok(text.includes('Remark line 120'), 'the last remark line printed')
      assert.ok(text.includes('REMARKS (continued from the scoresheet)'))
    }
  } finally {
    await renderer.close()
  }
})

// owner 2026-11-22: a match with technical remarks (match_info.remarks_model 2)
// prints neither its changes after the match nor the rebuilt line; the
// scorer's remarks stay. The fixture's older match (above) prints both.
test('technical remarks are not printed (remarks model 2)', { skip, timeout: 120_000 }, async () => {
  const renderer = createRenderer({ distDir: DIST, launch: () => chromium.launch({ executablePath: exe, args: LAUNCH_ARGS }) })
  try {
    const out = await renderer.render({ record: fixtureRecord({ remarksModel: 2 }), rebuildReason: 'Set start times corrected', rebuiltAt: '2026-11-16T13:03:00Z', withText: true })
    assert.equal(out.pdf.subarray(0, 5).toString('latin1'), '%PDF-')
    const sheet = (out.info.sheetText || '').toLowerCase()
    assert.ok(sheet.includes('late start: the hall was busy'), 'the scorer\'s remark is on the sheet')
    for (const w of ['rebuilt after the match', 'corrected after the match', 'set 2 times corrected']) assert.equal(sheet.includes(w), false, `"${w}" not on the sheet`)
    if (has('pdftotext')) {
      const dir = mkdtempSync(join(tmpdir(), 'ov-vector-'))
      const file = join(dir, 'sheet.pdf')
      writeFileSync(file, out.pdf)
      const text = execFileSync('pdftotext', ['-layout', file, '-']).toString().toLowerCase()
      assert.ok(text.includes('late start: the hall was busy'))
      assert.equal(text.includes('rebuilt after the match'), false)
      assert.equal(text.includes('corrected after the match'), false)
    }
  } finally {
    await renderer.close()
  }
})

