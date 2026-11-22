import { useTranslation } from 'react-i18next'
import { Gauge } from 'lucide-react'
import { cn, FOCUS_RING } from '../ui'
import { setLook, useLook } from '../utils/lookSettings'
import { answerDeviceCheck, cardChanges, changesFor, useDeviceCheck } from '../utils/deviceCheck'
import { logState } from '../utils/comprehensiveLogger'

/** "a, b and c" in the reader's language (Intl.ListFormat where there is one). */
export function joinList(items, lang) {
  try {
    if (typeof Intl.ListFormat === 'function') return new Intl.ListFormat(lang || undefined, { type: 'conjunction' }).format(items)
  } catch {
    // an unknown language tag: commas below
  }
  return items.join(', ')
}

/**
 * The device check's recommendation (utils/deviceCheck), one tap to apply:
 * "This device is on the slow side. For smoother scoring we recommend: no blur
 * behind dialogs, no animations, ..." with Apply and Keep as is.
 *
 * On Home (App.jsx, under the self-check notice): only while the last result
 * recommends a switch that differs from this device's and was not answered
 * yet; Apply sets exactly the listed switches, Keep as is keeps the look; both
 * answer the result and the card goes. Not over the first-start dialogs (App
 * does not pass it then).
 *
 * In Options (inOptions): shown whenever the result recommends a change, also
 * when it was answered on Home, with Apply only.
 */
export default function DeviceCheckCard({ inOptions = false, className = '' }) {
  const { t, i18n } = useTranslation()
  const result = useDeviceCheck()
  const look = useLook()
  const changes = inOptions ? changesFor(result, look) : cardChanges(result, look)
  if (!changes.length) return null
  // something turned off: smoother; only things turned on: the full look
  const lighter = changes.some((c) => !c.value)
  const list = joinList(changes.map((c) => t(`home.deviceCheck.item.${c.name}${c.value ? 'On' : 'Off'}`)), i18n?.language)
  const switches = Object.fromEntries(changes.map((c) => [c.name, c.value]))
  const apply = () => {
    setLook(switches)
    answerDeviceCheck('applied')
    logState('DeviceCheck', 'apply', { tier: result.tier, ...switches })
  }
  const keep = () => {
    answerDeviceCheck('kept')
    logState('DeviceCheck', 'keep', { tier: result.tier })
  }
  const miniButton = cn('inline-flex h-8 items-center rounded-lg border border-sky-300 bg-white px-3 text-xs font-semibold text-sky-800 hover:bg-sky-100', FOCUS_RING)
  return (
    <div className={cn('ov-kit', className)}>
      <div role="status" data-testid={inOptions ? 'device-check-options-card' : 'device-check-card'} data-tier={result.tier} className="flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
        <Gauge size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          {!inOptions && <p className="m-0 font-semibold">{t(`home.deviceCheck.title.${result.tier}`)}</p>}
          <p className={cn('m-0', !inOptions && 'mt-0.5')}>{t(lighter ? 'home.deviceCheck.smoother' : 'home.deviceCheck.fuller', { list })}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" data-testid="device-check-apply" onClick={apply} className={miniButton}>
              {t('home.deviceCheck.apply')}
            </button>
            {!inOptions && (
              <button type="button" data-testid="device-check-keep" onClick={keep} className={miniButton}>
                {t('home.deviceCheck.keep')}
              </button>
            )}
            {!inOptions && <span className="text-[11px] leading-snug text-sky-800">{t('home.deviceCheck.changeLater')}</span>}
          </div>
        </div>
      </div>
    </div>
  )
}
