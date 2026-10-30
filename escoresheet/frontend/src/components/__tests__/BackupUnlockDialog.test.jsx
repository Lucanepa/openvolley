// The PIN dialog of an encrypted backup file (BackupUnlockDialog): Cancel
// works while a PIN is tried, and the readable header, which nothing has
// authenticated before the file opens, never breaks the dialog.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (opts?.n != null ? `${key} ${opts.n}` : key) })
}))
vi.mock('../../utils/backupCrypto/envelope', async (importOriginal) => ({
  ...(await importOriginal()),
  openEnvelope: vi.fn()
}))

import BackupUnlockDialog from '../BackupUnlockDialog'
import { BACKUP_WRONG_PIN, openEnvelope } from '../../utils/backupCrypto/envelope'

// No mockReset/mockClear between the tests: after one, vitest 5 reports the
// later rejection of a returned promise as unhandled although the dialog
// catches it. Every test that submits sets its own result.
const envelope = (readable) => ({ format: 'openvolley-encrypted-backup', formatVersion: 1, readable, slots: [], ciphertext: '' })

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const button = (name) => screen.getByRole('button', { name })

function typePin(pin) {
  fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: pin } })
  fireEvent.click(button('settings.backup.unlock.open'))
}

afterEach(cleanup)

describe('BackupUnlockDialog', () => {
  it('Cancel works while a PIN is being tried: the attempt is abandoned, its late result ignored', async () => {
    const trying = deferred()
    openEnvelope.mockReturnValue(trying.promise)
    const onOpened = vi.fn()
    const onCancel = vi.fn()
    render(<BackupUnlockDialog envelope={envelope({ gameN: 1042 })} onOpened={onOpened} onCancel={onCancel} />)
    typePin('123456')
    expect(screen.getByText('settings.backup.unlock.opening')).toBeInTheDocument()
    const { signal } = openEnvelope.mock.lastCall[2]
    expect(signal.aborted).toBe(false)

    const cancel = button('common.cancel')
    expect(cancel).not.toBeDisabled()
    fireEvent.click(cancel)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(signal.aborted).toBe(true) // no further slot is tried

    await act(async () => trying.resolve({ data: { version: 1 }, unlockedWith: { pin: 'game' } }))
    expect(onOpened).not.toHaveBeenCalled()
  })

  it('a wrong PIN after Cancel says nothing; the × closes the dialog while a PIN is tried too', async () => {
    const trying = deferred()
    openEnvelope.mockReturnValue(trying.promise)
    const onCancel = vi.fn()
    render(<BackupUnlockDialog envelope={envelope({})} onOpened={vi.fn()} onCancel={onCancel} />)
    typePin('111111')
    fireEvent.click(screen.getByRole('button', { name: 'modal.close' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    await act(async () => trying.reject(Object.assign(new Error('wrong'), { code: BACKUP_WRONG_PIN })))
    expect(screen.queryByText('settings.backup.unlock.wrongPin')).toBeNull()
  })

  it('a wrong PIN, not cancelled, says so and asks again', async () => {
    openEnvelope.mockRejectedValueOnce(Object.assign(new Error('wrong'), { code: BACKUP_WRONG_PIN }))
    render(<BackupUnlockDialog envelope={envelope({})} onOpened={vi.fn()} onCancel={vi.fn()} />)
    typePin('111111')
    expect(await screen.findByText('settings.backup.unlock.wrongPin')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('000000')).not.toBeDisabled()
  })

  it('shows the header of a file as the app writes it', () => {
    render(<BackupUnlockDialog
      envelope={envelope({ gameN: 1042, homeTeam: 'Volley Home', awayTeam: 'Volley Away', scheduledAt: '2026-10-29T18:00:00.000Z', sets: [{ index: 1, home: 25, away: 20 }, { index: 2, home: 3, away: 1 }], lastUpdated: '2026-10-29T18:42:00.000Z' })}
      onOpened={vi.fn()}
      onCancel={vi.fn()}
    />)
    const dialog = screen.getByTestId('backup-unlock-dialog')
    expect(dialog).toHaveTextContent('Volley Home – Volley Away')
    expect(dialog).toHaveTextContent('settings.backup.unlock.game 1042')
    expect(dialog).toHaveTextContent('29.10.2026 19:00')
    expect(dialog).toHaveTextContent('25:20 3:1')
  })

  it.each([
    ['sets with null and garbage entries', { sets: [null, 'x', 7, [], { home: {}, away: 2 }, { home: 25, away: 20 }], homeTeam: 'Home' }],
    ['names that are not text', { homeTeam: { name: 'x' }, awayTeam: ['y'], gameN: { n: 1 }, scheduledAt: {}, lastUpdated: [], sets: 'all' }],
    ['a header that is not an object', 'readable'],
    ['a header that is an array', [1, 2]],
    ['no header', null]
  ])('renders a crafted or damaged header without breaking: %s', (_, readable) => {
    render(<BackupUnlockDialog envelope={envelope(readable)} onOpened={vi.fn()} onCancel={vi.fn()} />)
    const dialog = screen.getByTestId('backup-unlock-dialog')
    expect(dialog).toBeInTheDocument()
    expect(dialog.textContent).not.toContain('[object Object]')
    expect(screen.getByPlaceholderText('000000')).toBeInTheDocument()
  })

  it('shows only the valid sets, at most five, and cuts a very long name', () => {
    const sets = [null, { home: 25, away: 20 }, { home: '18', away: '25' }, { home: -1, away: 3 }, { home: 2.5, away: 1 },
      ...Array.from({ length: 10 }, () => ({ home: 1, away: 0 }))]
    render(<BackupUnlockDialog envelope={envelope({ sets, homeTeam: 'H'.repeat(5000), awayTeam: 42 })} onOpened={vi.fn()} onCancel={vi.fn()} />)
    const dialog = screen.getByTestId('backup-unlock-dialog')
    expect(dialog).toHaveTextContent('25:20 18:25 1:0 1:0 1:0')
    expect(dialog.textContent).not.toContain('1:0  1:0  1:0  1:0')
    expect(dialog.textContent).not.toContain('-1:3')
    expect(dialog.textContent).toContain(`${'H'.repeat(80)} – 42`)
    expect(dialog.textContent).not.toContain('H'.repeat(81))
  })
})
