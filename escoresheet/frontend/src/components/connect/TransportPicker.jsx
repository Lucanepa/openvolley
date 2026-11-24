import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Bluetooth, Globe, Laptop, Wifi } from 'lucide-react'
import { StatusPill, cn } from '../../ui'
import { radioKeyDown } from './parts'

const ICONS = { hall: Wifi, laptop: Laptop, server: Globe, bluetooth: Bluetooth }

export function useTransportTexts() {
  const { t } = useTranslation()
  return {
    label: {
      hall: t('connectTablets.transport.hall', 'Hall Wi-Fi'),
      laptop: t('connectTablets.transport.laptop', 'Wi-Fi from this computer'),
      server: t('connectTablets.transport.server', 'Internet'),
      bluetooth: t('connectTablets.transport.bluetooth', 'Bluetooth')
    },
    when: {
      hall: t('connectTablets.transport.hallWhen', 'The hall has Wi-Fi and this computer is on it.'),
      laptop: t('connectTablets.transport.laptopWhen', 'No hall Wi-Fi, or tablets cannot reach this computer on it. No internet needed.'),
      server: t('connectTablets.transport.serverWhen', 'Tablets have mobile data, or the hall Wi-Fi keeps devices apart. Sign-in needed.'),
      bluetooth: t('connectTablets.transport.bluetoothWhen', 'Last resort when no Wi-Fi works. Linux only.')
    },
    reason: {
      needsServer: t('connectTablets.reason.needsServer', 'Needs the desktop app or a venue box'),
      noNetwork: t('connectTablets.reason.noNetwork', 'This computer is on no network'),
      needsDesktop: t('connectTablets.reason.needsDesktop', 'Needs the desktop app (Windows, Linux)'),
      cannotCreateWifi: t('connectTablets.reason.cannotCreateWifi', 'This computer cannot create a Wi-Fi'),
      cloudBlocked: t('connectTablets.reason.cloudBlocked', 'Cloud is off in this app window'),
      windowsBluetooth: t('connectTablets.reason.windowsBluetooth', 'Windows cannot host a Bluetooth network'),
      needsLinuxDesktop: t('connectTablets.reason.needsLinuxDesktop', 'Needs the desktop app on Linux'),
      btNotHere: t('connectTablets.reason.btNotHere', 'Not available on this computer')
    }
  }
}

/**
 * Step 1: the four ways tablets reach this computer, each with when to use
 * it. One that cannot work here stays pickable (its panel explains what to
 * do) but is dimmed and says why. The radio dot keeps unselected cards
 * readable as choices.
 */
export function TransportPicker({ options, value, onChange, labelledBy }) {
  const { t } = useTranslation()
  const texts = useTransportTexts()
  const base = useId()
  const ids = options.map(o => o.id)
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="space-y-1.5" data-testid="transport-picker">
      {options.map(o => {
        const Icon = ICONS[o.id]
        const checked = o.id === value
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-labelledby={`${base}-${o.id}`}
            aria-describedby={`${base}-${o.id}-d`}
            tabIndex={checked ? 0 : -1}
            data-radio-id={o.id}
            data-available={o.available}
            data-testid={`transport-${o.id}`}
            onClick={() => onChange(o.id)}
            onKeyDown={(e) => radioKeyDown(e, ids, value, onChange)}
            className={cn(
              'flex w-full items-start gap-2.5 rounded-xl border bg-white px-3 py-1.5 text-left transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1',
              checked ? 'border-slate-900 ring-1 ring-slate-900' : 'border-stone-200 hover:bg-stone-50'
            )}
          >
            <span
              aria-hidden="true"
              className={cn('mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border', checked ? 'border-slate-900 bg-slate-900' : 'border-stone-300 bg-white')}
            >
              {checked && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <Icon size={14} aria-hidden="true" className={o.available ? 'text-stone-500' : 'text-stone-300'} />
                <span id={`${base}-${o.id}`} className={cn('text-sm font-semibold', o.available ? 'text-stone-900' : 'text-stone-500')}>
                  {texts.label[o.id]}
                </span>
                {o.recommended && o.available && <StatusPill tone="planned">{t('connectTablets.recommended', 'Recommended')}</StatusPill>}
                {o.experimental && <StatusPill tone="todo">{t('connectTablets.experimental', 'Experimental')}</StatusPill>}
              </span>
              <span
                id={`${base}-${o.id}-d`}
                className={cn(
                  'mt-0.5 block text-[11px] leading-snug',
                  o.available ? 'text-stone-500' : 'text-stone-400',
                  // Side by side (lg) the picked card says when to use it and
                  // an unusable one says why; the others stay one line, so
                  // step 1's set-up below fits without scrolling. Stacked
                  // (phone, tablet) every card says it.
                  checked || !o.available ? '' : 'lg:sr-only'
                )}
              >
                {o.available ? texts.when[o.id] : texts.reason[o.reasonKey]}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
