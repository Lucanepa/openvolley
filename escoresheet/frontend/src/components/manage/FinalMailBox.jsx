import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Mail } from 'lucide-react'
import { admin } from '../../lib/accountApi'
import { useErrorText } from './common'
import { Button, Notice, confirmDialog, dayTimeLabel, toast } from '../../ui'

// What the server answers about a close's mail (lib/finalMail.js), as one key of manage.matches.finalMail.states
const STATES = ['sent', 'sent_no_pdf', 'pending', 'deferred', 'partial', 'failed', 'no_recipients', 'no_pdf']
// Why the server leaves a close out (OV_FINAL_MAIL_REFUSED details.reason)
const REASONS = ['test', 'beach', 'no_game_number', 'released', 'not_closed']
const reasonKey = (reason) => `manage.matches.finalMail.refused.${REASONS.includes(reason) ? reason : 'other'}`
// Answers of a send that reached everyone it was for
const DONE = ['sent', 'sent_no_pdf']

/**
 * "Send final mail" on a closed match's page (admins; owner 2026-11-15: the
 * switch mails only the matches closed after it was turned on, so the ones
 * closed before never get their mail). Shows the mail's state of the latest
 * close (match_final_mails: sent when, pending, none); the button asks first,
 * with how many addresses (a count, never one) and whether the PDF is
 * attached, then sends it now (GET / POST /api/admin/matches/:id/final-mail,
 * audited). Test, beach, numberless and released matches are refused by the
 * server as the automatic mail leaves them out; the box says why.
 */
export default function FinalMailBox({ match: m, online }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const [info, setInfo] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const game = m.game_n ?? '–'

  const load = useCallback(async () => {
    const res = await admin.finalMailStatus(m.id)
    if (res.error) {
      setLoadError(errorText(res.error))
      return null
    }
    setLoadError('')
    setInfo(res.data)
    return res.data
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id])

  useEffect(() => { if (online) load() }, [online, load])

  const sendError = (error) => {
    const code = error?.code
    if (code === 'OV_FINAL_MAIL_BUSY') return t('manage.matches.finalMail.busy')
    if (code === 'OV_MAIL_UNAVAILABLE') return t('manage.matches.finalMail.noMailServer')
    if (code === 'OV_FINAL_MAIL_REFUSED') return t(reasonKey(error?.details?.reason))
    if (code === 'OV_NOT_CLOSED') return t(reasonKey('not_closed'))
    return errorText(error)
  }

  const send = async () => {
    setBusy(true)
    // the count and the PDF as they are now, not as the page opened
    const now = await load()
    if (!now) return setBusy(false)
    if (!now.sendable || !now.mail) return setBusy(false)
    if (!now.recipients) {
      setBusy(false)
      toast.error(t('manage.matches.finalMail.noRecipients'))
      return
    }
    const ok = await confirmDialog({
      title: t(now.resend ? 'manage.matches.finalMail.confirmTitleAgain' : 'manage.matches.finalMail.confirmTitle', { game }),
      message: [
        t('manage.matches.finalMail.confirmRecipients', { count: now.recipients }),
        t(now.pdf ? 'manage.matches.finalMail.confirmPdf' : 'manage.matches.finalMail.confirmNoPdf'),
        now.resend ? t('manage.matches.finalMail.confirmResend') : null,
        t('manage.matches.finalMail.audited')
      ].filter(Boolean).join(' '),
      confirmLabel: t('manage.matches.finalMail.send'),
      cancelLabel: t('common.cancel', 'Cancel')
    })
    if (!ok) return setBusy(false)
    const res = await admin.sendFinalMail(m.id)
    setBusy(false)
    if (res.error) {
      toast.error(sendError(res.error))
      return
    }
    const r = res.data || {}
    if (DONE.includes(r.outcome)) toast.success(t(r.pdf ? 'manage.matches.finalMail.sent' : 'manage.matches.finalMail.sentNoPdf', { count: r.reached ?? 0 }))
    else if (r.outcome === 'no_recipients') toast.error(t('manage.matches.finalMail.noRecipients'))
    else toast.error(t('manage.matches.finalMail.notAll', { reached: r.reached ?? 0, count: r.recipients ?? 0 }))
    load()
  }

  const state = info?.state || null
  const outcome = STATES.includes(state?.outcome) ? state.outcome : null
  const stateText = !info
    ? null
    : outcome === 'sent' || outcome === 'sent_no_pdf'
      ? t(`manage.matches.finalMail.states.${outcome}`, { date: state.sent_at || state.updated_at ? dayTimeLabel(state.sent_at || state.updated_at) : '–', count: state.recipients ?? 0 })
      : t(`manage.matches.finalMail.states.${outcome || 'none'}`)
  const refusedText = info && !info.sendable && info.reason
    ? t(reasonKey(info.reason))
    : null

  return (
    <div className="mt-4 border-t border-stone-100 pt-4" data-testid="final-mail">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-stone-700">{t('manage.matches.finalMail.title')}</span>
        {stateText && <span className="text-sm text-stone-600" data-testid="final-mail-state">{stateText}</span>}
        {info?.sendable && (
          <Button
            variant="secondary"
            size="sm"
            icon={Mail}
            className="sm:ml-auto"
            disabled={!online || busy || !info.mail}
            onClick={send}
            data-testid="final-mail-send"
          >
            {t(info.resend ? 'manage.matches.finalMail.sendAgain' : 'manage.matches.finalMail.send')}
          </Button>
        )}
      </div>
      {refusedText && <p className="mt-2 text-xs text-stone-500">{refusedText}</p>}
      {info?.sendable && !info.mail && <Notice tone="warning" className="mt-2">{t('manage.matches.finalMail.noMailServer')}</Notice>}
      {info?.sendable && info.mail && (
        <p className="mt-2 text-xs text-stone-500">{t(info.switch_on ? 'manage.matches.finalMail.hint' : 'manage.matches.finalMail.hintOff')}</p>
      )}
      {loadError && <Notice className="mt-2">{loadError}</Notice>}
    </div>
  )
}
