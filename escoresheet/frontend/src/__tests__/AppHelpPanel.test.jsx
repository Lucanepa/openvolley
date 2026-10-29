// The scoretable's help: the header's ? opens the page's sections, a dialog's
// help button the dialog's own (components/help, helpEvents.js).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { waitFor, fireEvent, cleanup } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
import { db } from '../db/db'
import en from '../i18n/locales/en.json'
import { HELP_SCREENS } from '../components/help/helpSections'
import { offline, online, mountApp, button } from './appMount'

beforeAll(offline)
afterAll(online)
beforeEach(async () => {
  cleanup()
  await Promise.all(db.tables.map(table => table.clear()))
})

const helpPanel = () => document.querySelector('[data-testid="help-panel"]')
const panelOpen = () => helpPanel()?.getAttribute('aria-modal') === 'true'
const panelSections = () => [...helpPanel().querySelectorAll('[data-testid^="help-section-"]')].map(n => n.dataset.testid.replace('help-section-', ''))
const helpButton = () => [...document.querySelectorAll('button')].find(b => b.getAttribute('title') === en.contextHelp.helpButton && b.textContent.trim() === '?')

describe('App: the help panel', () => {
  it('the header\'s ? shows Home\'s sections; the Restore match dialog\'s help shows its own', async () => {
    mountApp()
    await waitFor(() => expect(button('Restore match')).toBeTruthy())
    expect(panelOpen()).toBe(false)

    fireEvent.click(helpButton())
    await waitFor(() => expect(panelOpen()).toBe(true))
    expect(panelSections()).toEqual(HELP_SCREENS.home.sections)
    expect(helpPanel().textContent).toContain(en.contextHelp.sections.home)
    expect(helpPanel().textContent).toContain(en.contextHelp.home.q_backgroundHome)
    // the page's questions point at the page ("Show me")
    fireEvent.click([...helpPanel().querySelectorAll('button')].find(b => b.textContent.includes(en.contextHelp.home.q_createMatch)))
    expect(helpPanel().textContent).toContain(en.contextHelp.showMe)
    fireEvent.click(helpPanel().querySelector('[data-modal-close]'))
    await waitFor(() => expect(panelOpen()).toBe(false))

    fireEvent.click(button('Restore match'))
    await waitFor(() => expect(document.querySelector('[data-testid="dialog-help"]')).toBeTruthy())
    fireEvent.click(document.querySelector('[data-testid="dialog-help"]'))
    await waitFor(() => expect(panelOpen()).toBe(true))
    expect(panelSections()).toEqual(HELP_SCREENS.restore.sections)
    expect(helpPanel().textContent).toContain(en.contextHelp.pageNames.restore)
    expect(helpPanel().textContent).toContain(en.contextHelp.handover.q_continueOther)

    // closed, the header's ? is the page's again
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(panelOpen()).toBe(false))
    fireEvent.click(helpButton())
    await waitFor(() => expect(panelOpen()).toBe(true))
    expect(panelSections()).toEqual(HELP_SCREENS.home.sections)
  })
})
