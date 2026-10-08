import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render } from '@testing-library/react'
import ScoreServeRow, { SCORE_ROW, SERVE_BLOCK, serveLabelCqi } from '../referee/ScoreServeRow.jsx'

// vmin as useScaledLayout gives it: a 1280 x 800 tablet at display scale 1
const vmin = (v) => 800 * v / 100

const renderRow = (servingSide, extra = {}) => render(
  <ScoreServeRow
    leftScore={12}
    rightScore={10}
    servingSide={servingSide}
    serverNumber={servingSide ? 7 : null}
    servingColour="#ef4444"
    serveLabel="SERVE"
    vmin={vmin}
    {...extra}
  />
).container

const slotStyle = (c, side) => {
  const s = c.querySelector(`[data-serve-slot="${side}"]`).style
  return { display: s.display, minWidth: s.minWidth, height: s.height }
}

describe('referee score row: the SERVE block', () => {
  it('shows the block on the serving side only, with the label and the server\'s number', () => {
    for (const side of ['left', 'right']) {
      const c = renderRow(side)
      const other = side === 'left' ? 'right' : 'left'
      const block = c.querySelector(`[data-serve-slot="${side}"] [data-serve-block="${side}"]`)
      expect(block, side).not.toBeNull()
      expect(c.querySelector(`[data-serve-slot="${other}"] [data-serve-block]`), side).toBeNull()
      expect(block.querySelector('[data-serve-label]').textContent).toBe('SERVE')
      expect(block.querySelector('[data-serve-number]').textContent).toBe('7')
      expect(c.querySelectorAll('[data-serve-block]')).toHaveLength(1)
    }
    expect(renderRow(null).querySelector('[data-serve-block]')).toBeNull()
  })

  it('sits next to the score, on the serving team\'s side of it (mirrors with the view)', () => {
    const c = renderRow('left')
    const row = c.querySelector('[data-score-row]')
    const kids = [...row.children]
    expect(kids.map(k => k.getAttribute('data-serve-slot') ?? (k.hasAttribute('data-score') ? 'score' : '?'))).toEqual(['left', 'score', 'right'])
    expect(c.querySelector('[data-serve-slot="left"]').style.justifyContent).toBe('flex-end')
    expect(c.querySelector('[data-serve-slot="right"]').style.justifyContent).toBe('flex-start')
  })

  it('reserves the same room on both sides, served or not, so the score never moves', () => {
    const row = renderRow('left').querySelector('[data-score-row]')
    // two equal slots that never grow to their content
    expect(row.style.gridTemplateColumns).toBe('minmax(0, 1fr) auto minmax(0, 1fr)')
    const base = renderRow(null)
    for (const side of ['left', 'right', null]) {
      const c = renderRow(side)
      expect(slotStyle(c, 'left'), String(side)).toEqual(slotStyle(base, 'left'))
      expect(slotStyle(c, 'right'), String(side)).toEqual(slotStyle(base, 'right'))
    }
    expect(slotStyle(base, 'left')).toEqual(slotStyle(base, 'right'))
  })

  it('is big (as tall as the score digits) but never taller, so the court is not pushed down', () => {
    const c = renderRow('right')
    const digits = c.querySelector('[data-score] span')
    const block = c.querySelector('[data-serve-block]')
    expect(digits.style.fontSize).toBe(`${vmin(SCORE_ROW.scoreVmin)}px`)
    expect(digits.style.lineHeight).toBe('1')
    expect(block.style.height).toBe(`${vmin(SERVE_BLOCK.heightVmin)}px`)
    expect(c.querySelector('[data-serve-slot="right"]').style.height).toBe(`${vmin(SCORE_ROW.scoreVmin)}px`)
    expect(SERVE_BLOCK.heightVmin).toBe(SCORE_ROW.scoreVmin)
    // label + number + padding fit in that height
    expect(SERVE_BLOCK.labelVmin * 1.1 + SERVE_BLOCK.numberVmin + 2 * 0.8).toBeLessThanOrEqual(SERVE_BLOCK.heightVmin)
    // much larger than the old corner box (3 vmin label, 7-8 vmin number, 6 vmin box)
    expect(SERVE_BLOCK.numberVmin).toBeGreaterThan(8)
    expect(SERVE_BLOCK.widthVmin).toBeGreaterThanOrEqual(3 * 6)
  })

  it('a narrow slot (portrait tablet, 150 % display scale) keeps the label and number at least as big as the old corner box', () => {
    // Measured in Chromium at 768 x 1024, scale 1.5 (vmin 11.52): the slot is
    // 128 px wide. The old corner box used a 3 vmin label and a 7-8 vmin number.
    const v = 11.52
    const slot = 128
    const inner = slot - 2 * Math.min(v, 0.03 * slot)
    const number = Math.min(SERVE_BLOCK.numberVmin * v, SERVE_BLOCK.numberCqi / 100 * inner)
    expect(number).toBeGreaterThanOrEqual(8 * v)
    // the label's share depends on its length: SERVE is not sized for AUFSCHLAG
    expect(serveLabelCqi('SERVE')).toBeGreaterThan(serveLabelCqi('AUFSCHLAG') * 1.5)
  })

  it('every translated label and a two-digit number fit the block width', () => {
    const dir = resolve(__dirname, '../../i18n/locales')
    for (const lng of ['en', 'de', 'de-CH', 'fr', 'it']) {
      const label = JSON.parse(readFileSync(resolve(dir, `${lng}.json`), 'utf8')).scoreboard.labels.serveLabel
      // a bold upper-case letter with the 0.06 em spacing is at most ~0.76 em wide
      expect(serveLabelCqi(label) * label.length * 0.76, `${lng} ${label}`).toBeLessThanOrEqual(100)
    }
    // two tabular digits are ~1.11 em
    expect(SERVE_BLOCK.numberCqi * 1.112).toBeLessThanOrEqual(100)
    // (jsdom drops min(... cqi) font sizes: the component's use of
    // serveLabelCqi is checked in the source)
    const src = readFileSync(resolve(__dirname, '../referee/ScoreServeRow.jsx'), 'utf8')
    expect(src).toMatch(/\$\{serveLabelCqi\(label\)\}cqi/)
  })

  it('wears the serving team\'s colour', () => {
    const block = renderRow('left', { servingColour: '#3b82f6' }).querySelector('[data-serve-block]')
    expect(block.style.background).toMatch(/59, 130, 246|#3b82f6/i)
  })

  it('the referee view feeds it the serving side, the position I player and the translated label', () => {
    const src = readFileSync(resolve(__dirname, '../Referee.jsx'), 'utf8')
    expect(src).toMatch(/<ScoreServeRow\b/)
    expect(src).toMatch(/servingSide=\{leftServing \? 'left' : rightServing \? 'right' : null\}/)
    expect(src).toMatch(/lineupNumber\(leftLineup\?\.I\)/)
    expect(src).toMatch(/lineupNumber\(rightLineup\?\.I\)/)
    expect(src).toMatch(/t\('scoreboard\.labels\.serveLabel', 'SERVE'\)/)
    // the old corner indicator is gone
    expect(src).not.toMatch(/>SERVE<\/span>/)
  })
})
