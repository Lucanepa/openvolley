import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import en from '../../i18n/locales/en.json'

// The English strings, with {{x}} filled in
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, params = {}) => {
      const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), en)
      return typeof v === 'string' ? v.replace(/\{\{(\w+)\}\}/g, (_, p) => String(params[p] ?? '')) : key
    },
    i18n: { language: 'en-GB' }
  })
}))

import ClosedOnServerModal from '../ClosedOnServerModal'

const texts = en.cloudBlock.closedCopy
const props = (over = {}) => ({
  onLoadOfficial: vi.fn(async () => ({ ok: true })),
  onRemove: vi.fn(),
  onUsePin: vi.fn(),
  onClose: vi.fn(),
  ...over
})

// 2026-10-23: a phone kept scoring a copy of a match the server had closed.
// The dialog takes the scoring screen's place and cannot be dismissed.
describe('ClosedOnServerModal', () => {
  it('says the match is closed on the server and offers Close, Remove and Load', async () => {
    const p = props()
    render(<ClosedOnServerModal {...p} />)
    expect(screen.getByTestId('closed-copy-modal')).toBeTruthy()
    expect(screen.getByText(texts.title)).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe(texts.body)
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual([en.common.close, texts.remove, texts.loadOfficial])

    fireEvent.click(screen.getByRole('button', { name: texts.loadOfficial }))
    await waitFor(() => expect(p.onLoadOfficial).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: texts.remove }))
    expect(p.onRemove).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: en.common.close }))
    expect(p.onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('closed-copy-error')).toBeNull()
  })

  it('offline: says a connection is needed, no PIN button', async () => {
    render(<ClosedOnServerModal {...props({ onLoadOfficial: vi.fn(async () => ({ error: 'offline' })) })} />)
    fireEvent.click(screen.getByRole('button', { name: texts.loadOfficial }))
    expect((await screen.findByTestId('closed-copy-error')).textContent).toBe(texts.errors.offline)
    expect(screen.queryByRole('button', { name: texts.usePin })).toBeNull()
  })

  it('the PIN on this device does not load it: offers the game number and PIN', async () => {
    for (const reason of ['noPin', 'notFound', 'otherMatch']) {
      const p = props({ onLoadOfficial: vi.fn(async () => ({ error: reason })) })
      const { unmount } = render(<ClosedOnServerModal {...p} />)
      fireEvent.click(screen.getByRole('button', { name: texts.loadOfficial }))
      expect((await screen.findByTestId('closed-copy-error')).textContent).toBe(texts.errors.needsPin)
      fireEvent.click(screen.getByRole('button', { name: texts.usePin }))
      expect(p.onUsePin).toHaveBeenCalledTimes(1)
      unmount()
    }
  })

  it('a failed load (or a throw, or an unknown reason) says so and offers the PIN too', async () => {
    const p = props({ onLoadOfficial: vi.fn(async () => ({ error: 'failed' })) })
    render(<ClosedOnServerModal {...p} />)
    fireEvent.click(screen.getByRole('button', { name: texts.loadOfficial }))
    expect((await screen.findByTestId('closed-copy-error')).textContent).toBe(texts.errors.failed)
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual([en.common.close, texts.remove, texts.usePin, texts.loadOfficial])
    fireEvent.click(screen.getByRole('button', { name: texts.usePin }))
    expect(p.onUsePin).toHaveBeenCalledTimes(1)

    p.onLoadOfficial.mockImplementationOnce(async () => { throw new Error('x') })
    fireEvent.click(screen.getByRole('button', { name: texts.loadOfficial }))
    await waitFor(() => expect(p.onLoadOfficial).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('closed-copy-error').textContent).toBe(texts.errors.failed)
    p.onLoadOfficial.mockImplementationOnce(async () => ({ error: 'something' }))
    fireEvent.click(screen.getByRole('button', { name: texts.loadOfficial }))
    await waitFor(() => expect(p.onLoadOfficial).toHaveBeenCalledTimes(3))
    expect(screen.getByTestId('closed-copy-error').textContent).toBe(texts.errors.failed)
  })

  it('every button waits while the official version loads', async () => {
    let finish
    const p = props({ onLoadOfficial: vi.fn(() => new Promise(r => { finish = r })) })
    render(<ClosedOnServerModal {...p} />)
    fireEvent.click(screen.getByRole('button', { name: texts.loadOfficial }))
    await waitFor(() => expect(screen.getAllByRole('button').every(b => b.disabled)).toBe(true))
    expect(screen.getByRole('button', { name: texts.loadOfficial }).getAttribute('aria-busy')).toBe('true')
    finish({ ok: true })
    await waitFor(() => expect(screen.getAllByRole('button').every(b => !b.disabled)).toBe(true))
  })

  it('the buttons wrap on a phone', () => {
    render(<ClosedOnServerModal {...props()} />)
    expect(screen.getByRole('button', { name: texts.loadOfficial }).parentElement.className).toContain('flex-wrap')
  })
})
