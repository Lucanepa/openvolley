import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from './Modal'
import { Button, dayTimeLabel, FormError, Input } from '../ui'
import { BACKUP_DAMAGED, BACKUP_NEWER, BACKUP_NO_CRYPTO, BACKUP_WRONG_PIN, openEnvelope } from '../utils/backupCrypto/envelope'

// Asks for the PIN of an encrypted backup file (utils/backupCrypto) before
// the restore preview: the game PIN or the referee PIN, either opens it. A
// wrong PIN says so and the scorer tries again; Cancel goes back. Opened by
// hooks/useBackupUnlock, above every other dialog (the scoreboard options
// are at 10000-10001). What the file shows in the clear (game number, teams,
// date, set scores) tells the scorer which match it is.

function unlockErrorText(err, t) {
  switch (err?.code) {
    case BACKUP_WRONG_PIN: return t('settings.backup.unlock.wrongPin')
    case BACKUP_DAMAGED: return t('settings.backup.restoreErrors.unreadable')
    case BACKUP_NEWER: return t('settings.backup.unlock.newer')
    case BACKUP_NO_CRYPTO: return t('settings.backup.unlock.unsupported')
    default: return t('settings.backup.restoreErrors.failed', { error: err?.message || String(err ?? '') })
  }
}

export default function BackupUnlockDialog({ envelope, onOpened, onCancel, zIndex = 10050 }) {
  const { t } = useTranslation()
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)
  const inputId = useId()
  useEffect(() => { inputRef.current?.focus() }, [])
  // After a wrong PIN, the field is ready for the next try
  useEffect(() => { if (error) inputRef.current?.select?.() }, [error])

  const r = envelope?.readable || {}
  const teams = [r.homeTeam, r.awayTeam].filter(Boolean).join(' – ')
  const when = r.scheduledAt ? dayTimeLabel(r.scheduledAt) : ''
  const gameLine = [r.gameN != null && r.gameN !== '' ? t('settings.backup.unlock.game', { n: r.gameN }) : '', when].filter(Boolean).join(' · ')
  const sets = (Array.isArray(r.sets) ? r.sets : []).map(s => `${s.home}:${s.away}`).join('  ')
  const saved = r.lastUpdated ? dayTimeLabel(r.lastUpdated) : ''

  const submit = async (e) => {
    e?.preventDefault()
    if (busy || !pin) return
    setBusy(true)
    setError('')
    try {
      // About half a second per PIN slot on a tablet (Argon2id, kdf.js)
      const { data, unlockedWith } = await openEnvelope(envelope, pin)
      onOpened({ ...data, unlockedWith })
    } catch (err) {
      setError(unlockErrorText(err, t))
      setBusy(false)
    }
  }

  return (
    <Modal title={t('settings.backup.unlock.title')} open={true} onClose={busy ? () => {} : onCancel} width={440} zIndex={zIndex} helpScreen="restore">
      <form className="ov-kit" onSubmit={submit} data-testid="backup-unlock-dialog">
        <p className="m-0 text-sm text-stone-600">{t('settings.backup.unlock.intro')}</p>
        {(teams || gameLine || sets) && (
          <div className="mt-3 rounded-xl border border-stone-200/70 bg-stone-50/60 px-3 py-2.5 text-center">
            {teams && <div className="break-words text-sm font-semibold text-stone-900">{teams}</div>}
            {gameLine && <div className="mt-0.5 text-xs tabular-nums text-stone-600">{gameLine}</div>}
            {sets && <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-stone-800">{sets}</div>}
            {saved && <div className="mt-1 text-[11px] tabular-nums text-stone-500">{t('settings.backup.unlock.saved', { when: saved })}</div>}
          </div>
        )}
        <label htmlFor={inputId} className="mb-1.5 mt-4 block text-sm font-medium text-stone-700">
          {t('settings.backup.unlock.pinLabel')}
        </label>
        <Input
          ref={inputRef}
          id={inputId}
          size="lg"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={12}
          value={pin}
          onChange={(e) => { setPin(e.target.value.replace(/\s/g, '')); setError('') }}
          placeholder="000000"
          invalid={!!error}
          disabled={busy}
          className="text-center font-mono text-lg font-semibold tracking-[0.3em]"
        />
        <FormError className="mt-3">{error}</FormError>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="xl" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="positive" size="xl" loading={busy} disabled={!pin}>
            {busy ? t('settings.backup.unlock.opening') : t('settings.backup.unlock.open')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
