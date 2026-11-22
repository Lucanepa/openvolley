import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Gauge, Loader2 } from 'lucide-react'
import { cn, dayLabel, FOCUS_RING } from '../../ui'
import { setLook, useLook } from '../../utils/lookSettings'
import { changesFor, checkDeviceNow, useDeviceCheck, useDeviceCheckRunning } from '../../utils/deviceCheck'
import { readOpenMatch } from '../../utils/deviceSelfCheck'
import { logState } from '../../utils/comprehensiveLogger'
import DeviceCheckCard from '../DeviceCheckCard'

const SWITCHES = ['blur', 'motion', 'clockSeconds', 'pdfSharp']

const BTN_OUTLINE = cn('inline-flex h-11 items-center justify-center gap-1.5 rounded-lg border border-stone-300 bg-white px-4 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50', FOCUS_RING)

/**
 * Options › Effects and speed: the device check's last result in plain words
 * ("Checked on 22.11.2026: this device is on the slow side."), its
 * recommendation with Apply when it differs from the switches, the "Check
 * this device" button, and the four look switches (utils/lookSettings), each
 * applied at once. In the Home options and the scoring screen's; the check
 * itself only where no match is open (canCheck): the scoring screen's
 * options say where to check again.
 * `kit`: the dialog's own Row, InfoDot and ToggleSwitch, so the rows look like
 * the dialog's others.
 */
export default function LookOptions({ kit, canCheck = false }) {
  const { Row, InfoDot, ToggleSwitch } = kit
  const { t } = useTranslation()
  const look = useLook()
  const result = useDeviceCheck()
  // "Checking...": any check of this page, also the automatic one (it stops
  // when Options opens, and the button comes back then)
  const checking = useDeviceCheckRunning()
  // The check started here stops at its next step, keeping nothing, as the
  // automatic one does: Options closed (this unmounts), the check no longer
  // offered (a match being opened), the page hidden, or a match screen noted
  // open (deviceSelfCheck noteOpenMatch: Match Setup, the scoring screen)
  const mounted = useRef(false)
  const offered = useRef(canCheck)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => { offered.current = canCheck }, [canCheck])
  const runCheck = async () => {
    if (checking) return
    const keepGoing = () => mounted.current && offered.current && !document.hidden && readOpenMatch() == null
    const r = await checkDeviceNow({ keepGoing })
    if (r) logState('DeviceCheck', 'result', { tier: r.tier, score: r.score, workMs: r.workMs, layoutMs: r.layoutMs, from: 'options' })
  }
  const resultText = result
    ? t('options.look.checkedOn', { date: dayLabel(result.at, { year: true }), verdict: t(`options.look.verdict.${result.tier}`) })
    : t('options.look.notChecked')
  const matches = result && changesFor(result, look).length === 0

  return (
    <>
      <Row style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px' }}>
        <div className="flex items-center gap-1.5">
          <div className="text-sm font-semibold text-stone-900">{t('options.look.check')}</div>
          <InfoDot title={t('options.look.checkInfo')} />
        </div>
        <p data-testid="device-check-result" className="m-0 flex items-start gap-1.5 text-xs leading-snug text-stone-600">
          <Gauge size={14} aria-hidden="true" className="mt-px shrink-0 text-stone-400" />
          <span>
            {resultText}
            {matches && ` ${t('options.look.matches')}`}
          </span>
        </p>
        <DeviceCheckCard inOptions />
        {canCheck ? (
          <div>
            <button type="button" data-testid="device-check-run" onClick={runCheck} disabled={checking} aria-busy={checking || undefined} className={BTN_OUTLINE}>
              {checking && <Loader2 size={16} aria-hidden="true" className="animate-spin" />}
              {checking ? t('options.look.checking') : t('options.look.checkNow')}
            </button>
          </div>
        ) : (
          <p className="m-0 text-[11px] leading-snug text-stone-500">{t('options.look.checkFromHome')}</p>
        )}
      </Row>
      {SWITCHES.map((name) => (
        <Row key={name}>
          <div className="flex items-center gap-1.5">
            <div className="text-sm font-semibold text-stone-900">{t(`options.look.${name}`)}</div>
            <InfoDot title={t(`options.look.${name}Info`)} />
          </div>
          <div data-testid={`look-${name}`} data-on={look[name] ? 'true' : 'false'}>
            <ToggleSwitch
              value={look[name]}
              onToggle={() => {
                const next = !look[name]
                setLook({ [name]: next })
                logState('LookOptions', 'switch', { [name]: next })
              }}
            />
          </div>
        </Row>
      ))}
    </>
  )
}
