import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Eye, EyeOff, KeyRound } from 'lucide-react'
import { admin } from '../../lib/accountApi'
import { useErrorText } from './common'
import { Button, Notice, confirmDialog, toast } from '../../ui'

/**
 * A match's game PIN on its page (admins; owner 2026-11-15: "can i get the
 * match pin here? ... otherwise how can i reopen the game from thin air?").
 * Hidden until "Show PIN": each read is its own audited request (GET
 * /api/admin/matches/:id/pin), never part of the match list. The PIN is the
 * one the scorer app's Restore match asks for with the game number. The
 * server keeps a PIN only as its HMAC (production), so it usually cannot
 * show it: "Set new PIN" then gives the match a new one (audited, confirmed
 * first: a device with the old PIN needs the new one).
 */
export default function MatchPinBox({ match: m, online }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  // null: hidden; else { pin, stored }
  const [shown, setShown] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const game = m.game_n ?? '–'

  const show = async () => {
    setBusy(true)
    setError('')
    const res = await admin.readMatchPin(m.id)
    setBusy(false)
    if (res.error) return setError(errorText(res.error))
    setShown({ pin: res.data?.pin || null, stored: res.data?.stored || 'none' })
  }

  const reset = async () => {
    const ok = await confirmDialog({
      title: t('manage.matches.pin.resetTitle', { game }),
      message: t('manage.matches.pin.resetBody'),
      confirmLabel: t('manage.matches.pin.reset'),
      cancelLabel: t('common.cancel', 'Cancel'),
      tone: 'danger'
    })
    if (!ok) return
    setBusy(true)
    setError('')
    const res = await admin.resetMatchPin(m.id)
    setBusy(false)
    if (res.error) return setError(errorText(res.error))
    setShown({ pin: res.data?.pin || null, stored: res.data?.stored || 'hashed' })
    toast.success(t('manage.matches.pin.resetDone'))
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shown?.pin || '')
      toast.success(t('manage.matches.pin.copied'))
    } catch { /* no clipboard: the PIN stays selectable */ }
  }

  return (
    <div className="mt-4 border-t border-stone-100 pt-4" data-testid="match-pin">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-stone-700">{t('manage.matches.pin.title')}</span>
        {shown?.pin ? (
          <>
            <output data-testid="match-pin-value" className="select-all rounded-lg border border-stone-200 bg-stone-50 px-3 py-1.5 font-mono text-lg font-bold tracking-[0.3em] tabular-nums text-stone-900">{shown.pin}</output>
            <Button variant="secondary" size="sm" icon={Copy} onClick={copy} data-testid="match-pin-copy">{t('manage.matches.pin.copy')}</Button>
            <Button variant="ghost" size="sm" icon={EyeOff} onClick={() => setShown(null)} data-testid="match-pin-hide">{t('manage.matches.pin.hide')}</Button>
          </>
        ) : shown ? (
          <Button variant="secondary" size="sm" icon={KeyRound} disabled={!online || busy} onClick={reset} data-testid="match-pin-reset">{t('manage.matches.pin.reset')}</Button>
        ) : (
          <Button variant="secondary" size="sm" icon={Eye} disabled={!online || busy} onClick={show} data-testid="match-pin-show">{t('manage.matches.pin.show')}</Button>
        )}
      </div>
      {shown && !shown.pin && (
        <Notice tone="warning" className="mt-2">{t(shown.stored === 'hashed' ? 'manage.matches.pin.hashed' : 'manage.matches.pin.none')}</Notice>
      )}
      <p className="mt-2 text-xs text-stone-500">
        {shown?.pin ? t('manage.matches.pin.howTo', { game }) : t('manage.matches.pin.audited')}
      </p>
      {error && <Notice className="mt-2">{error}</Notice>}
    </div>
  )
}
