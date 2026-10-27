import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, MonitorSmartphone } from 'lucide-react'
import Modal from './Modal'
import { Button, FormError } from '../ui'

// The platforms the server records (utils/identity platformName) -> a label key
const PLATFORM_KEYS = {
  android: 'android',
  ios: 'ios',
  'tauri-linux': 'linux',
  'tauri-windows': 'windows',
  'tauri-macos': 'macos',
  electron: 'desktop',
  web: 'web'
}

/**
 * "This match is now scored on another device (Android phone or tablet,
 * 19:54)": the device a scorer left, when another one took the match over
 * (server db/019, utils/matchHandover). It covers the scoring screens and
 * cannot be dismissed: this device must not go on scoring a match the other
 * device writes. Take back loads the other device's score from the cloud and
 * makes this device the scorer again (the other one is told the same); it
 * needs a connection. A match closed meanwhile (closed) only loads its final
 * result. Close goes back to the home screen.
 *
 * The copy opens read-only (the owner, 2026-10-27): the scoring screens stay
 * inert under this dialog (App), and Scoresheet (onScoresheet) opens this
 * copy's scoresheet to view, print or save. With onPreview, Take back first
 * shows the server's score now and asks again, so the scorer compares it with
 * the scoreboard before this device takes the match back; Cancel leaves
 * everything as it was. It needs a connection, as the take-back does.
 * @param {{ scorer: {platform?: string|null, at?: string|null}|null, closed?: boolean,
 *   onTakeBack: () => Promise<{ok?: boolean, error?: string}|void>|void, onClose: () => void,
 *   onPreview?: () => Promise<{score?: object, error?: string}>, onScoresheet?: () => void }} props
 */
export default function ScorerMovedModal({ scorer, closed = false, onTakeBack, onClose, onPreview = null, onScoresheet = null }) {
  const { t, i18n } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // the server's score, shown before the take-back (onPreview)
  const [preview, setPreview] = useState(null)
  const platformKey = PLATFORM_KEYS[scorer?.platform] || null
  const platform = platformKey ? t(`scorerMoved.platforms.${platformKey}`) : null
  const time = formatTakeOver(scorer?.at, i18n.language)
  const body = closed
    ? t('scorerMoved.bodyClosed')
    : platform && time
      ? t('scorerMoved.body', { platform, time })
      : t('scorerMoved.bodyUnknown')

  const run = async (action, onDone) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await action()
      if (r?.error) setError(TAKE_BACK_ERRORS.includes(r.error) ? r.error : 'failed')
      else onDone?.(r)
    } catch {
      setError('failed')
    } finally {
      setBusy(false)
    }
  }
  // the final result of a closed match needs no comparison
  const takeBack = () => (onPreview && !closed && !preview
    ? run(onPreview, (r) => setPreview(r?.score || {}))
    : run(onTakeBack))

  return (
    <Modal title={t('scorerMoved.title')} open={true} hideCloseButton={true} width={460} zIndex={3000}>
      <div className="ov-kit" data-testid="scorer-moved-modal">
        <div role="alert" className="flex items-start gap-3 text-sm text-stone-700">
          <MonitorSmartphone size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-amber-700" />
          <p className="m-0">{body}</p>
        </div>
        {!closed && !preview && <p className="mt-2 text-xs text-stone-500">{t('scorerMoved.takeBackHint')}</p>}
        {preview && (
          <div data-testid="scorer-moved-preview" className="mt-3 rounded-xl border border-stone-200/70 bg-stone-50/60 px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">{t('scorerMoved.serverScore')}</div>
            <div className="mt-0.5 text-lg font-bold tabular-nums text-stone-900">{scoreText(t, preview)}</div>
            <p className="mt-1 mb-0 text-xs text-stone-600">{t('scorerMoved.compareHint')}</p>
          </div>
        )}
        {error && (
          <div className="mt-3" data-testid="scorer-moved-error">
            <FormError size="md">{t(`scorerMoved.errors.${error}`)}</FormError>
          </div>
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {preview ? (
            <Button variant="secondary" size="lg" onClick={() => setPreview(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
          ) : (
            <>
              <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>
                {t('scorerMoved.close')}
              </Button>
              {onScoresheet && (
                <Button variant="secondary" size="lg" icon={FileText} onClick={onScoresheet} disabled={busy}>
                  {t('header.scoresheet')}
                </Button>
              )}
            </>
          )}
          <Button variant="dark" size="lg" onClick={takeBack} disabled={busy} aria-busy={busy || undefined}>
            {t(closed ? 'scorerMoved.showResult' : preview ? 'scorerMoved.confirmTakeBack' : 'scorerMoved.takeBack')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// takeBackScoring's reasons (utils/matchHandover) with a message
const TAKE_BACK_ERRORS = ['offline', 'noPin', 'notFound', 'otherMatch', 'failed']

/** "19:54" today, "20.10. 19:54" another day (the device's language), null without a valid time. */
export function formatTakeOver(at, lang, now = new Date()) {
  const d = at ? new Date(at) : null
  if (!d || Number.isNaN(d.getTime())) return null
  const time = d.toLocaleTimeString(lang || undefined, { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return time
  return `${d.toLocaleDateString(lang || undefined, { day: '2-digit', month: '2-digit' })} ${time}`
}

/** "Set 3 · 14:12 · sets 1:1" (deviceMatches setScore), or "Not started". */
export function scoreText(t, score) {
  if (!score || score.set == null) return t('home.continueCard.notStarted')
  return t('home.continueCard.score', { set: score.set, home: score.home, away: score.away, setsHome: score.setsHome, setsAway: score.setsAway })
}
