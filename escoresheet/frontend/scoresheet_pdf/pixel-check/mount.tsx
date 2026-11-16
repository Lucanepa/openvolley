/**
 * Draws the pixel-check match and saves its PDF through the real capture path
 * (App_Scoresheet getBlob), then hands the PDF and the sheet's geometry to
 * scripts/sheet-pixels.mjs on window.__sheetPixels. Synthetic data only.
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/i18n'
import App from '../App_Scoresheet'
import { pixelCheckMatch } from './fixture'

declare global {
  interface Window { __sheetPixels?: { pdfBase64?: string; error?: string; geometry?: unknown } }
}

const BAR_PX = 56

/** Boxes and rows of the sheet relative to the sheet, in CSS px at zoom 1. */
function geometry() {
  const sheet = document.querySelector('.scoresheet-container') as HTMLElement
  const sr = sheet.getBoundingClientRect()
  const s = sr.width / sheet.offsetWidth
  const R = (el: Element) => {
    const r = el.getBoundingClientRect()
    return { x: (r.left - sr.left) / s, y: (r.top - sr.top) / s, w: r.width / s, h: r.height / s }
  }
  const items: any[] = []
  const add = (kind: string, el: Element, extra: Record<string, unknown> = {}) =>
    items.push({ kind, ...R(el), cols: [...el.children].slice(0, 3).map(R), ...extra })
  for (const side of ['home', 'away']) {
    const roster = sheet.querySelector(`[data-testid="roster-${side}"]`)
    if (!roster) continue
    add('box', roster, { name: `roster-${side}` })
    roster.querySelectorAll('[data-testid="roster-row"]').forEach((r, i) => add('row', r, { name: `roster-${side} row ${i + 1}` }))
    roster.querySelectorAll('[data-testid="roster-libero-row"]').forEach((r, i) => add('row', r, { name: `libero-${side} row ${i + 1}` }))
    roster.querySelectorAll('[data-testid="roster-official-row"]').forEach((r, i) => add('row', r, { name: `officials-${side} row ${i + 1}` }))
  }
  for (const h of sheet.querySelectorAll('div.bg-gray-200')) {
    const name = (h.textContent || '').trim()
    if (/^(REMARKS|RESULT|APPROVAL|SANCTIONS)$/.test(name) && h.parentElement) add('box', h.parentElement, { name })
  }
  const set5 = sheet.querySelector('[data-testid="set5-box"]')
  const sets = [...sheet.querySelectorAll('[data-testid="set-box"]')]
  const descender: any[] = []
  sheet.querySelectorAll('[data-testid^="approval-name-"]').forEach((el) => {
    const text = (el.textContent || '').trim()
    if (!/[gjpqy]/.test(text)) return
    const fit = (el.firstElementChild || el) as HTMLElement
    descender.push({ name: text, ...R(el), fontPx: parseFloat(getComputedStyle(fit).fontSize) })
  })
  return {
    cssW: sheet.offsetWidth,
    cssH: sheet.offsetHeight,
    dpr: devicePixelRatio,
    items,
    set5: set5 ? R(set5) : null,
    sets: sets.map(R),
    descender
  }
}

export function mount({ embedded }: { embedded: boolean }) {
  window.__sheetPixels = {}
  const onBlob = async (out: { blob: Blob } | null) => {
    try {
      if (!out?.blob) throw new Error('no PDF')
      const bytes = new Uint8Array(await out.blob.arrayBuffer())
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      // the geometry after the save (the zoom it had is back; scaled out above)
      window.__sheetPixels = { pdfBase64: btoa(bin), geometry: geometry() }
    } catch (err) {
      window.__sheetPixels = { error: String((err as Error)?.message || err) }
    }
  }
  const app = (
    <App
      matchData={pixelCheckMatch() as any}
      extraRemarks={['Rebuilt after the match: 16.11.2026, 10:12 - Pixel check']}
      autoAction="getBlob"
      dataReady
      readOnly
      onBlob={onBlob}
      {...(embedded ? { embedded: true, reservedTop: BAR_PX } : {})}
    />
  )
  createRoot(document.getElementById('root')!).render(embedded
    ? <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}><div style={{ height: BAR_PX }} /><div style={{ flex: 1, minHeight: 0 }}>{app}</div></div>
    : app)
}
