import { useTranslation } from 'react-i18next'
import { Gauge } from 'lucide-react'
import { cn, FOCUS_RING } from '../ui'
import { setLook, useLook } from '../utils/lookSettings'
import { RECOMMENDED, answerDeviceCheck, cardChanges, changesFor, useDeviceCheck } from '../utils/deviceCheck'
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
 * On Home (App.jsx, HomePage pins it to the foot of the screen, out of the
 * flow so nothing moves and always in view): only while the last result recommends a switch that
 * differs from this device's and was not answered yet; Apply sets exactly the
 * listed switches, Keep as is keeps the look; both answer the result and the
 * card goes. Not over the first-start dialogs or Home's match set-up dialogs
 * (App does not pass it then).
 *
 * In Options (inOptions, under the switches): shown whenever the result
 * recommends a change, also when it was answered on Home, with Apply only and
 * no gauge (the result line above has it).
 */
export default function DeviceCheckCard({ inOptions = false, className = '' }) {
  const { t, i18n } = useTranslation()
  const result = useDeviceCheck()
  const look = useLook()
  const changes = inOptions ? changesFor(result, look) : cardChanges(result, look)
  if (!changes.length) return null
  // No animations because the device asks for less motion (its own setting,
  // e.g. Android's "Remove animations"), not because of its speed: said on a
  // line of its own, so a fast device is not told it needs it to be smoother
  const motionByDevice = !!result.hints?.reducedMotion && RECOMMENDED[result.tier]?.motion === true &&
    changes.some((c) => c.name === 'motion' && c.value === false)
  const listed = motionByDevice ? changes.filter((c) => c.name !== 'motion') : changes
  // something turned off: smoother; only things turned on: the full look
  const lighter = listed.some((c) => !c.value)
  const list = joinList(listed.map((c) => t(`home.deviceCheck.item.${c.name}${c.value ? 'On' : 'Off'}`)), i18n?.language)
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
  // touch size (44 px): the card's one-tap decision, on tablets and phones
  const miniButton = cn('inline-flex h-11 items-center rounded-lg border border-sky-300 bg-white px-4 text-sm font-semibold text-sky-800 hover:bg-sky-100', FOCUS_RING)
  return (
    <div className={cn('ov-kit', className)}>
      <div role="status" data-testid={inOptions ? 'device-check-options-card' : 'device-check-card'} data-tier={result.tier} className="flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
        {/* in Options the result line above has the gauge already */}
        {!inOptions && <Gauge size={14} aria-hidden="true" className="mt-0.5 shrink-0" />}
        <div className="min-w-0 flex-1">
          {!inOptions && <p className="m-0 font-semibold">{t(`home.deviceCheck.title.${result.tier}`)}</p>}
          {listed.length > 0 && <p className={cn('m-0', !inOptions && 'mt-0.5')}>{t(lighter ? 'home.deviceCheck.smoother' : 'home.deviceCheck.fuller', { list })}</p>}
          {motionByDevice && <p data-testid="device-check-less-motion" className={cn('m-0', (!inOptions || listed.length > 0) && 'mt-0.5')}>{t('home.deviceCheck.lessMotion')}</p>}
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
