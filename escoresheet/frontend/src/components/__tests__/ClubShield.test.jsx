import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// A roster row's shield: green from an upload, gray typed by hand, gray with
// its own words when the club's lists keep the person by hand or from an
// official match's roster (db/048, owner 2026-11-20: "From a match", never
// "Added by hand"). Made-up people of VBC Musterdorf.

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key) => key, i18n: { language: 'en' } }) }))

import ClubShield from '../manage/ClubShield'

const ANNA = { sv_number: '100001', last_name: 'Beispiel', first_name: 'Anna', lists: ['players'], manual: false, from_match: false }
const HANS = { sv_number: '400001', last_name: 'Hand', first_name: 'Hans', lists: ['players'], manual: true, from_match: false }
const PIA = { sv_number: '100007', last_name: 'Spielmann', first_name: 'Pia', lists: ['players'], manual: true, from_match: true }

const shield = () => screen.getByTestId('club-shield')

describe('ClubShield', () => {
  it('a person from a match: the gray shield with "from a match", shown or linkable', () => {
    const { rerender } = render(<ClubShield person={PIA} />)
    expect(shield().dataset.shield).toBe('match')
    expect(shield().getAttribute('aria-label')).toBe('clubPlayers.shield.match')
    expect(shield().className).toContain('text-stone-400')
    rerender(<ClubShield person={PIA} onLink={() => {}} />)
    expect(shield().tagName).toBe('BUTTON')
    expect(shield().getAttribute('aria-label')).toBe('clubPlayers.shield.matchLink')
  })

  it('added by hand, typed by hand and uploaded keep their words', () => {
    const { rerender } = render(<ClubShield person={HANS} />)
    expect([shield().dataset.shield, shield().getAttribute('aria-label')]).toEqual(['manual', 'clubPlayers.shield.manual'])
    rerender(<ClubShield person={HANS} onLink={() => {}} />)
    expect(shield().getAttribute('aria-label')).toBe('clubPlayers.shield.manualLink')
    rerender(<ClubShield person={null} />)
    expect([shield().dataset.shield, shield().getAttribute('aria-label')]).toEqual(['hand', 'clubPlayers.shield.hand'])
    rerender(<ClubShield person={ANNA} />)
    expect([shield().dataset.shield, shield().getAttribute('aria-label')]).toEqual(['club', 'clubPlayers.shield.club'])
    // an uploaded person whose answer says from_match (it never does) stays green
    rerender(<ClubShield person={{ ...ANNA, from_match: true }} />)
    expect(shield().dataset.shield).toBe('club')
  })
})
