/**
 * The team colour picker: the twelve presets plus a Custom tile with the
 * browser colour input, a hex field (#rrggbb, #rgb) and a live preview; a
 * saved colour that is none of the presets selects the Custom tile; colours
 * close to the other team's get a gentle note, never a refusal.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => String(typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en', changeLanguage: () => Promise.resolve() }
  })
}))

import TeamColourPicker, { recallCustomColour, rememberCustomColour } from '../TeamColourPicker'
import TeamShirt from '../TeamShirt'
import { TEAM_COLOUR_PRESETS, readableTextOn } from '../../utils/teamColours'

const rgb = (hex) => {
  const n = (i) => parseInt(hex.slice(i, i + 2), 16)
  return `rgb(${n(1)}, ${n(3)}, ${n(5)})`
}
const customTile = () => document.querySelector('[data-custom-tile]')
const hexField = () => screen.getByLabelText('matchSetup.customColourHex')
const applyButton = () => screen.getByRole('button', { name: 'matchSetup.applyColour' })

beforeEach(() => { try { localStorage.clear() } catch { /* none */ } })
afterEach(cleanup)

describe('TeamColourPicker', () => {
  it('shows the twelve presets and a 13th Custom tile with the spectrum shirt and a "+"', () => {
    render(<TeamColourPicker value="#dc2626" onPick={() => {}} />)
    const tiles = screen.getAllByRole('button')
    expect(tiles).toHaveLength(13)
    TEAM_COLOUR_PRESETS.forEach((c, i) => expect(tiles[i].getAttribute('aria-label')).toBe(`Select colour ${c}`))
    const custom = customTile()
    expect(custom.getAttribute('aria-label')).toBe('matchSetup.customColour')
    expect(custom.getAttribute('aria-pressed')).toBe('false')
    expect(custom.querySelector('.shirt').dataset.color).toBe('rainbow')
    expect(custom.querySelector('.number').textContent).toBe('+')
    // the red preset is the selected one
    expect(screen.getByRole('button', { name: 'Select colour #dc2626' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('a preset click picks it at once', () => {
    const onPick = vi.fn()
    render(<TeamColourPicker value="#dc2626" onPick={onPick} />)
    fireEvent.click(screen.getByRole('button', { name: 'Select colour #22c55e' }))
    expect(onPick).toHaveBeenCalledWith('#22c55e')
  })

  it('a saved colour that is none of the presets selects the Custom tile, which shows it', () => {
    render(<TeamColourPicker value="#7B1E2B" onPick={() => {}} />)
    const custom = customTile()
    expect(custom.getAttribute('aria-pressed')).toBe('true')
    expect(custom.getAttribute('aria-label')).toBe('matchSetup.customColour #7b1e2b')
    expect(custom.querySelector('.shirt').dataset.color).toBe('#7b1e2b')
    expect(custom.querySelector('.number').style.color).toBe(rgb(readableTextOn('#7b1e2b')))
    for (const c of TEAM_COLOUR_PRESETS) {
      expect(screen.getByRole('button', { name: `Select colour ${c}` }).getAttribute('aria-pressed')).toBe('false')
    }
  })

  it('a preset in another case or as #rgb still selects the preset, not Custom', () => {
    render(<TeamColourPicker value="#fff" onPick={() => {}} />)
    expect(screen.getByRole('button', { name: 'Select colour #FFFFFF' }).getAttribute('aria-pressed')).toBe('true')
    expect(customTile().getAttribute('aria-pressed')).toBe('false')
  })

  it('the Custom tile shows the last custom colour while the team wears a preset', () => {
    render(<TeamColourPicker value="#000000" lastCustom="#0e7490" onPick={() => {}} />)
    const custom = customTile()
    expect(custom.getAttribute('aria-pressed')).toBe('false')
    expect(custom.querySelector('.shirt').dataset.color).toBe('#0e7490')
    expect(custom.getAttribute('aria-label')).toBe('matchSetup.customColour #0e7490')
  })

  it('opens the custom section: colour input, hex field and a preview that follow each other', () => {
    const onPick = vi.fn()
    render(<TeamColourPicker value="#dc2626" onPick={onPick} />)
    expect(document.querySelector('[data-custom-section]')).toBeNull()
    fireEvent.click(customTile())
    expect(customTile().getAttribute('aria-expanded')).toBe('true')
    const section = document.querySelector('[data-custom-section]')
    const colourInput = within(section).getByLabelText('matchSetup.customColour')
    expect(colourInput.getAttribute('type')).toBe('color')
    // starts from the team's colour
    expect(hexField().value).toBe('#dc2626')

    fireEvent.change(hexField(), { target: { value: '#1A7F5A' } })
    expect(colourInput.value).toBe('#1a7f5a')
    const preview = section.querySelector('[data-preview]')
    expect(preview.dataset.color).toBe('#1a7f5a')
    expect(preview.querySelector('.number').style.color).toBe(rgb(readableTextOn('#1a7f5a')))

    fireEvent.change(colourInput, { target: { value: '#ffd700' } })
    expect(hexField().value).toBe('#ffd700')
    expect(section.querySelector('[data-preview]').dataset.color).toBe('#ffd700')
    // gold takes dark text
    expect(section.querySelector('[data-preview] .number').style.color).toBe(rgb(readableTextOn('#ffd700')))
    expect(readableTextOn('#ffd700')).toBe('#1c1917')

    fireEvent.click(applyButton())
    expect(onPick).toHaveBeenCalledWith('#ffd700')
  })

  it('accepts #rgb and rgb, refuses anything else with Apply disabled', () => {
    const onPick = vi.fn()
    render(<TeamColourPicker value="#dc2626" onPick={onPick} />)
    fireEvent.click(customTile())
    fireEvent.change(hexField(), { target: { value: '#0aF' } })
    expect(applyButton().disabled).toBe(false)
    fireEvent.click(applyButton())
    expect(onPick).toHaveBeenLastCalledWith('#00aaff')

    fireEvent.change(hexField(), { target: { value: 'c0ffee' } })
    fireEvent.keyDown(hexField(), { key: 'Enter' })
    expect(onPick).toHaveBeenLastCalledWith('#c0ffee')

    for (const bad of ['', '#12', '#12345', 'blue', '#ggg000', '#1234567']) {
      fireEvent.change(hexField(), { target: { value: bad } })
      expect(applyButton().disabled, bad).toBe(true)
      expect(hexField().getAttribute('aria-invalid'), bad).toBe('true')
      expect(screen.getByText('matchSetup.customColourInvalid')).toBeTruthy()
    }
    expect(onPick).toHaveBeenCalledTimes(2)
  })

  it('a half-typed or wrong code keeps the preview on the last valid colour, not red', () => {
    render(<TeamColourPicker value="#3b82f6" onPick={() => {}} />)
    fireEvent.click(customTile())
    const section = document.querySelector('[data-custom-section]')
    const colourInput = within(section).getByLabelText('matchSetup.customColour')
    const preview = () => section.querySelector('[data-preview]').dataset.color
    // typing #1a7f5a key by key: '#', '#1', '#1a' are no code yet
    for (const partial of ['#', '#1', '#1a']) {
      fireEvent.change(hexField(), { target: { value: partial } })
      expect(preview(), partial).toBe('#3b82f6')
      expect(colourInput.value, partial).toBe('#3b82f6')
    }
    fireEvent.change(hexField(), { target: { value: '#1a7' } })
    expect(preview()).toBe('#11aa77')
    fireEvent.change(hexField(), { target: { value: '#1a7f' } })
    expect(preview()).toBe('#11aa77')
    expect(applyButton().disabled).toBe(true)
    fireEvent.change(hexField(), { target: { value: '#1a7f5a' } })
    expect(preview()).toBe('#1a7f5a')
    fireEvent.change(hexField(), { target: { value: 'nonsense' } })
    expect(preview()).toBe('#1a7f5a')
    expect(colourInput.value).toBe('#1a7f5a')
  })

  it('a pasted code with spaces around it still reads', () => {
    const onPick = vi.fn()
    render(<TeamColourPicker value="#3b82f6" onPick={onPick} />)
    fireEvent.click(customTile())
    expect(Number(hexField().getAttribute('maxLength'))).toBeGreaterThanOrEqual(9)
    fireEvent.change(hexField(), { target: { value: ' #C0FFEE ' } })
    expect(hexField().value).toBe('#C0FFEE')
    expect(applyButton().disabled).toBe(false)
    fireEvent.click(applyButton())
    expect(onPick).toHaveBeenCalledWith('#c0ffee')
  })

  it('Cancel closes the custom section without picking', () => {
    const onPick = vi.fn()
    render(<TeamColourPicker value="#dc2626" onPick={onPick} />)
    fireEvent.click(customTile())
    fireEvent.change(hexField(), { target: { value: '#123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(document.querySelector('[data-custom-section]')).toBeNull()
    expect(onPick).not.toHaveBeenCalled()
  })

  it('a custom colour close to the other team gets a gentle note, and can still be applied', () => {
    const onPick = vi.fn()
    render(<TeamColourPicker value="#22c55e" otherColour="#dc2626" onPick={onPick} />)
    expect(screen.queryByText('matchSetup.closeToOtherTeamColour')).toBeNull()
    fireEvent.click(customTile())
    fireEvent.change(hexField(), { target: { value: '#ef4444' } })
    expect(screen.getByRole('status').textContent).toBe('matchSetup.closeToOtherTeamColour')
    expect(applyButton().disabled).toBe(false)
    fireEvent.click(applyButton())
    expect(onPick).toHaveBeenCalledWith('#ef4444')
  })

  it('marks the presets close to the other team and notes a current colour that is', () => {
    const onPick = vi.fn()
    render(<TeamColourPicker value="#dc2626" otherColour="#e2001a" onPick={onPick} />)
    expect(screen.getByRole('status').textContent).toBe('matchSetup.closeToOtherTeamColour')
    const red = screen.getByRole('button', { name: 'Select colour #dc2626' })
    expect(red.querySelector('[data-close-mark]')).not.toBeNull()
    expect(red.getAttribute('title')).toBe('matchSetup.closeToOtherTeamColour')
    expect(screen.getByRole('button', { name: 'Select colour #3b82f6' }).querySelector('[data-close-mark]')).toBeNull()
    // never refused
    fireEvent.click(red)
    expect(onPick).toHaveBeenCalledWith('#dc2626')
  })

  it('picking a custom colour re-paints the team shirt with it, the number readable on it', () => {
    function Harness() {
      const [colour, setColour] = useState('#dc2626')
      return (
        <>
          <TeamShirt color={colour} data-testid="card-shirt" />
          <TeamColourPicker value={colour} onPick={setColour} />
        </>
      )
    }
    render(<Harness />)
    fireEvent.click(customTile())
    fireEvent.change(hexField(), { target: { value: '#5b21b6' } })
    fireEvent.click(applyButton())
    const shirt = screen.getByTestId('card-shirt')
    expect(shirt.dataset.color).toBe('#5b21b6')
    expect(shirt.querySelector('[data-part="body"]').getAttribute('fill')).toBe('#5b21b6')
    expect(shirt.querySelector('.number').style.color).toBe(rgb(readableTextOn('#5b21b6')))
    // the custom tile is the selected one now
    expect(customTile().getAttribute('aria-pressed')).toBe('true')
  })
})

describe('last custom colour per team', () => {
  it('remembers one colour per team key, normalised', () => {
    expect(recallCustomColour('team:vbc')).toBeNull()
    rememberCustomColour('team:vbc', '#ABC')
    rememberCustomColour('team:other', '#123456')
    expect(recallCustomColour('team:vbc')).toBe('#aabbcc')
    expect(recallCustomColour('team:other')).toBe('#123456')
    rememberCustomColour('team:vbc', 'not a colour')
    expect(recallCustomColour('team:vbc')).toBe('#aabbcc')
    expect(recallCustomColour(null)).toBeNull()
  })

  it('forgets quietly when storage throws', () => {
    const blocked = () => { throw new Error('blocked') }
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, clear: () => {} })
    try {
      expect(() => rememberCustomColour('team:x', '#123456')).not.toThrow()
      expect(recallCustomColour('team:x')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
