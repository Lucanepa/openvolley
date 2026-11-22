import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Mail, Send } from 'lucide-react'
import { Button, Field, Input, Modal, Notice, SectionHeader } from '../ui'
import { getCloudApiUrl } from '../utils/backendConfig'
import { authorizationHeader } from '../lib/apiClient'
import { sendMatchPinMail } from '../utils/matchInfoMail'
import { openAppWindow } from '../utils/openAppWindow'
import { useBrowserOnline } from '../hooks/useBrowserOnline'
import { dayTimeLabel } from '../ui/format'
import { gameNumberOf, gamePinOf, isMailAddress, pinMailContent, pinMailtoHref, teamsLine } from '../utils/pinNotice'

// The server's answer to send-pin, as the line under the button. Each one
// points to the mail app below, which needs no server.
function accountErrorKey (r) {
  if (r?.network || r?.status === 0) return 'pinNotice.errOffline'
  if (r?.code === 'OV_EMAIL_UNCONFIRMED') return 'pinNotice.errUnconfirmed'
  if (r?.code === 'OV_PIN_MISMATCH') return 'pinNotice.errMismatch'
  if (r?.status === 404) return 'pinNotice.errNotOnServer'
  if (r?.status === 429) return 'pinNotice.errBusy'
  // 503 (no mailer, or a backend without the route yet: 404 is taken above,
  // an older backend answers an unknown POST like that), 401, 403, 500
  return 'pinNotice.errFailed'
}

const ERROR_FALLBACK = {
  'pinNotice.errOffline': 'No connection to the server – use your mail app below.',
  'pinNotice.errUnconfirmed': 'Confirm your email address first, or use your mail app below.',
  'pinNotice.errMismatch': 'The server has another PIN for this match. Use your mail app below.',
  'pinNotice.errNotOnServer': 'The match is not on the server yet. Use your mail app below.',
  'pinNotice.errBusy': 'Too many emails in a short time. Try again in a minute, or use your mail app below.',
  'pinNotice.errFailed': 'The email could not be sent. Use your mail app below.'
}

/**
 * The game PIN notice: once a new official match is set up, before its coin
 * toss (MatchSetup's Coin toss button, utils/pinNotice needsPinNotice). The
 * PIN large, the owner's sentence, and two ways to email it:
 *
 * - `accountEmail` (signed in, confirmed): "Send to my email (address)" asks
 *   the server to mail the PIN to that account address (POST
 *   /api/match/send-pin, which checks the PIN against the stored one).
 * - an address field, prefilled with `prefillEmail` (the scorer official's
 *   address, else the account's), editable: "Open in mail app" opens the
 *   device's mail app (mailto:, utils/openAppWindow: the Android app hands it
 *   to the system) with match, teams, date and PIN. Nothing goes through the
 *   server for a typed address.
 *
 * `homeName` / `awayName`: the team names Match setup shows (the match row
 * of a match made before Create match saved them has none). OK and × close it
 * (onClose); the backdrop does not, so a stray tap never skips it. `sendPin`
 * and `openMail` are for tests.
 */
export default function MatchPinNotice ({ open, match, homeName = '', awayName = '', accountEmail = null, prefillEmail = '', onClose, sendPin = sendMatchPinMail, openMail = openAppWindow }) {
  const { t } = useTranslation()
  const online = useBrowserOnline()
  const [mailTo, setMailTo] = useState(prefillEmail || '')
  const [mailError, setMailError] = useState('')
  const [mailOpened, setMailOpened] = useState(false)
  const [account, setAccount] = useState({ state: 'idle', errorKey: null })

  // a new match (or a prefill that arrived late) starts clean
  useEffect(() => {
    if (!open) return
    setMailTo(prefillEmail || '')
    setMailError('')
    setMailOpened(false)
    setAccount({ state: 'idle', errorKey: null })
  }, [open, match?.id, prefillEmail])

  if (!open || !match) return null

  const pin = gamePinOf(match)
  const sendUrl = getCloudApiUrl('/api/match/send-pin')
  const externalId = match.seed_key || null
  const canSendToAccount = !!(accountEmail && sendUrl && externalId && authorizationHeader().Authorization)
  const game = gameNumberOf(match)
  const date = dayTimeLabel(match.scheduledAt)
  const names = { home: homeName, away: awayName }
  const meta = [teamsLine(t, match, names), date || null, game ? t('pinNotice.mailGame', 'Game {{number}}', { number: game }) : null].filter(Boolean).join(' · ')

  const sendToAccount = async () => {
    if (account.state === 'sending') return
    setAccount({ state: 'sending', errorKey: null })
    const r = await sendPin({ url: sendUrl, headers: authorizationHeader(), externalId, gamePin: pin })
    if (r?.success) setAccount({ state: 'sent', errorKey: null })
    else setAccount({ state: 'error', errorKey: accountErrorKey(r) })
  }

  const openMailApp = (e) => {
    e?.preventDefault?.()
    const to = mailTo.trim()
    if (to && !isMailAddress(to)) {
      setMailError(t('matchSetup.invalidEmail', 'Please enter a valid email address'))
      setMailOpened(false)
      return
    }
    setMailError('')
    const result = openMail(pinMailtoHref(to, pinMailContent(t, match, names)))
    if (result && result.ok === false) {
      setMailOpened(false)
      setMailError(t('pinNotice.mailAppFailed', 'The mail app could not be opened. Write the PIN down instead.'))
      return
    }
    setMailOpened(true)
  }

  return (
    // .ov-kit: the legacy button and focus rules (styles.css) stay out of the dialog
    <div className="ov-kit">
      <Modal
        open
        onClose={onClose}
        title={t('pinNotice.title', 'Write down the game PIN')}
        size="md"
        decision
        dismissible={false}
        closeLabel={t('common.close', 'Close')}
      >
        <div data-testid="pin-notice">
          <p className="text-xs text-stone-500 tabular-nums">{meta}</p>
          <div className="mt-3 rounded-xl border border-stone-200/70 bg-stone-50/60 px-4 py-5 text-center">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">{t('matchSetup.gamePin', 'Game PIN')}</div>
            {/* pl-[0.3em]: the tracking's trailing space, so the digits sit centred */}
            <div data-testid="pin-notice-pin" className="mt-1 select-text pl-[0.3em] font-mono text-4xl font-bold tracking-[0.3em] tabular-nums text-stone-900 sm:text-5xl">{pin}</div>
          </div>
          <p className="mt-3 text-sm font-medium leading-relaxed text-stone-800">
            {t('pinNotice.writeDown', 'Please write the PIN down somewhere: it is needed to recover the match and/or to reopen it.')}
          </p>

          <div className="mt-5 space-y-3">
            <SectionHeader as="h4" title={t('pinNotice.emailHeading', 'Send it by email')} />
            {canSendToAccount && (
              <div>
                <Button
                  variant="secondary"
                  size="xl"
                  block
                  icon={Send}
                  loading={account.state === 'sending'}
                  disabled={!online || account.state === 'sent'}
                  onClick={sendToAccount}
                  data-testid="pin-notice-send-account"
                  className="h-auto min-h-11 py-2 text-center leading-snug"
                >
                  {t('pinNotice.sendToAccount', 'Send to my email ({{email}})', { email: accountEmail })}
                </Button>
                {account.state === 'sent' && (
                  <Notice tone="success" className="mt-2">{t('pinNotice.sentToAccount', 'Sent to {{email}}.', { email: accountEmail })}</Notice>
                )}
                {account.state === 'error' && (
                  <Notice tone="error" className="mt-2">{t(account.errorKey, ERROR_FALLBACK[account.errorKey])}</Notice>
                )}
                {!online && account.state !== 'sent' && (
                  <p className="mt-2 text-xs text-stone-500">{t('pinNotice.errOffline', ERROR_FALLBACK['pinNotice.errOffline'])}</p>
                )}
              </div>
            )}
            <form className="flex items-end gap-2 stack:flex-col stack:items-stretch" onSubmit={openMailApp} noValidate>
              <Field
                tone="compact"
                className="min-w-0 flex-1"
                label={canSendToAccount ? t('pinNotice.otherAddress', 'Another address') : t('pinNotice.emailLabel', 'Email address')}
                error={mailError || undefined}
              >
                <Input
                  size="lg"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  maxLength={254}
                  value={mailTo}
                  onChange={(e) => { setMailTo(e.target.value); setMailError(''); setMailOpened(false) }}
                  data-testid="pin-notice-email"
                />
              </Field>
              <Button type="submit" variant="secondary" size="xl" icon={Mail} data-testid="pin-notice-mail-app">
                {t('pinNotice.openMailApp', 'Open in mail app')}
              </Button>
            </form>
            {mailOpened
              ? <Notice tone="success">{t('pinNotice.mailAppOpened', 'Your mail app opened with the PIN. Send it from there.')}</Notice>
              : <p className="text-xs text-stone-500">{t('pinNotice.mailAppHint', 'Opens your mail app with the PIN. Nothing goes through our server.')}</p>}
          </div>

          <div className="mt-5 flex justify-end">
            <Button variant="dark" size="xl" className="min-w-28" onClick={onClose} data-testid="pin-notice-ok">{t('common.ok', 'OK')}</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
