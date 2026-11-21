import { useTranslation } from 'react-i18next'
import { WifiOff } from 'lucide-react'
import { timeLabel } from '../ui/format'

/**
 * The line under Match Setup's Remote panel hint (owner 2026-11-21): when the
 * panel last asked the server for this side's roster ("Last checked 14:32"),
 * "Not checked yet", "Offline" (the panel checks again once the device is
 * online) or "Server not reached" (with the last good check). Nothing here
 * waits for the network: it shows what the checks found.
 * @param {{ side: 'home'|'away', state?: { at: string|null, failed?: boolean }, online: boolean }} props
 */
export default function RosterCheckStatus({ side, state, online }) {
  const { t } = useTranslation()
  const time = state?.at ? timeLabel(state.at) : ''
  const last = time ? t('matchSetup.rosterCheck.lastChecked', { time }) : null
  let text
  if (!online) text = [t('matchSetup.rosterCheck.offline'), last].filter(Boolean).join(' · ')
  else if (state?.failed) text = [t('matchSetup.rosterCheck.failed'), last].filter(Boolean).join(' · ')
  else text = last || t('matchSetup.rosterCheck.notChecked')
  return (
    <p className="m-0 flex items-center gap-1.5 text-xs text-stone-500" data-testid={`roster-check-status-${side}`}>
      {!online && <WifiOff size={12} aria-hidden className="shrink-0" />}
      <span className="min-w-0">{text}</span>
    </p>
  )
}
