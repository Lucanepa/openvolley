import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Route, X } from 'lucide-react'
import { Button } from '../../ui/Button.jsx'
import { IconButton } from '../../ui/IconButton.jsx'

// Remembered on this device (a convenience: when the storage is blocked the
// card shows again next time, nothing else depends on it)
export const HOME_TOUR_CARD_KEY = 'ov.walkthrough.homeCard'

export function homeTourCardDone() {
  try {
    return !!localStorage.getItem(HOME_TOUR_CARD_KEY)
  } catch {
    return false
  }
}

function rememberDone(how) {
  try {
    localStorage.setItem(HOME_TOUR_CARD_KEY, how)
  } catch { /* private mode: shown again next time */ }
}

/**
 * Home's card for a first start (owner plan 24.11.2026): "New here? Take
 * the tour" (no length: it depends on the scorer, owner follow-up
 * 26.11.2026). Once started or put aside it does not come back on this
 * device; the tour stays in the help ("?" > Your first match).
 */
export default function HomeTourCard({ onStart, className }) {
  const { t } = useTranslation()
  const [done, setDone] = useState(homeTourCardDone)
  if (done) return null
  const close = (how) => {
    rememberDone(how)
    setDone(true)
  }
  return (
    <div data-testid="home-tour-card" className={`rounded-2xl border border-stone-200/70 bg-white p-4 shadow-card ${className || ''}`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-stone-100 text-stone-500" aria-hidden="true">
          <Route size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-stone-900">{t('walkthrough.homeCard.title')}</div>
          <p className="mt-1 text-xs leading-relaxed text-stone-600">{t('walkthrough.homeCard.text')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="dark" size="md" onClick={() => { close('started'); onStart?.() }} data-testid="home-tour-start">
              {t('walkthrough.homeCard.start')}
            </Button>
            <Button variant="ghost" size="md" className="bg-white" onClick={() => close('dismissed')} data-testid="home-tour-dismiss">
              {t('walkthrough.homeCard.notNow')}
            </Button>
          </div>
        </div>
        <IconButton variant="close" icon={X} label={t('walkthrough.homeCard.notNow')} onClick={() => close('dismissed')} className="-mr-2 -mt-2" />
      </div>
    </div>
  )
}
