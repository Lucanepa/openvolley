// Home's "New here? Take the tour" (HomeTourCard): once started or
// put aside, it does not come back on this device
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent, cleanup, screen } from '@testing-library/react'
import '../../../i18n'
import en from '../../../i18n/locales/en.json'
import de from '../../../i18n/locales/de.json'
import deCH from '../../../i18n/locales/de-CH.json'
import fr from '../../../i18n/locales/fr.json'
import it_ from '../../../i18n/locales/it.json'
import HomeTourCard, { HOME_TOUR_CARD_KEY, homeTourCardDone } from '../HomeTourCard'

beforeEach(() => {
  cleanup()
  localStorage.removeItem(HOME_TOUR_CARD_KEY)
})

describe('Home tour card', () => {
  it('shows once: put aside, it stays away', () => {
    render(<HomeTourCard onStart={() => {}} />)
    expect(screen.getByTestId('home-tour-card').textContent).toContain(en.walkthrough.homeCard.title)
    fireEvent.click(screen.getByTestId('home-tour-dismiss'))
    expect(screen.queryByTestId('home-tour-card')).toBeNull()
    expect(homeTourCardDone()).toBe(true)
    cleanup()
    render(<HomeTourCard onStart={() => {}} />)
    expect(screen.queryByTestId('home-tour-card')).toBeNull()
  })

  it('starts the tour, then stays away', () => {
    const onStart = vi.fn()
    render(<HomeTourCard onStart={onStart} />)
    fireEvent.click(screen.getByTestId('home-tour-start'))
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('home-tour-card')).toBeNull()
    cleanup()
    render(<HomeTourCard onStart={onStart} />)
    expect(screen.queryByTestId('home-tour-card')).toBeNull()
  })

  it('without storage it still shows and closes (nothing breaks)', () => {
    const get = vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const set = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    try {
      render(<HomeTourCard onStart={() => {}} />)
      fireEvent.click(screen.getByTestId('home-tour-dismiss'))
      expect(screen.queryByTestId('home-tour-card')).toBeNull()
    } finally {
      get.mockRestore()
      set.mockRestore()
    }
  })

  // Owner follow-up 26.11.2026: the tour takes as long as the scorer takes
  // (the video of it runs 7 to 8 minutes): no length on the card
  it('promises no length, in any language', () => {
    for (const [lang, d] of Object.entries({ en, de, 'de-CH': deCH, fr, it: it_ })) {
      expect(d.walkthrough.homeCard.title, lang).not.toMatch(/\d|minute|Minute|minuti/)
    }
  })
})
