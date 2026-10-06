import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Cloud, Copy, QrCode } from 'lucide-react'
import { Button, Switch, StatusPill } from '../../ui'
import { copyToClipboard } from '../../utils/networkInfo'
import { roleAccess } from '../../utils/tabletLinks'

export function useRoleLabels() {
  const { t } = useTranslation()
  return {
    main: t('connectTablets.role.main', 'Scoretable'),
    referee: t('connectTablets.role.referee', 'Referee'),
    bench_home: t('connectTablets.role.bench_home', 'Bench (home)'),
    bench_away: t('connectTablets.role.bench_away', 'Bench (away)'),
    livescore: t('connectTablets.role.livescore', 'Livescore')
  }
}

/**
 * One row per role: its link (QR + Copy) and, for the referee and the
 * benches, the PIN the tablet asks for and the switch that lets that role
 * in. The PIN is shown here only: it is never part of a link or a QR code.
 */
export function RoleRows({ rows, match, qrRole, onPickQr, onToggleRole, noUrlText, teamNames }) {
  const { t } = useTranslation()
  const labels = useRoleLabels()
  const [copied, setCopied] = useState(null)

  const copy = async (row) => {
    const res = await copyToClipboard(row.url)
    if (res?.success) {
      setCopied(row.role)
      setTimeout(() => setCopied(c => (c === row.role ? null : c)), 2000)
    }
  }

  return (
    <div className="divide-y divide-stone-100" data-testid="tablet-role-rows">
      {rows.map(row => {
        const access = roleAccess(match, row.role)
        const off = access.enabled === false
        const team = row.role === 'bench_home' ? teamNames?.home : row.role === 'bench_away' ? teamNames?.away : null
        return (
          <div key={row.role} className="flex min-h-14 items-center gap-2 py-2" data-testid={`role-row-${row.role}`}>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-semibold text-stone-900">{labels[row.role]}</span>
                {team && <span className="truncate text-xs text-stone-500">{team}</span>}
                {access.pin && !off && (
                  <span
                    className="rounded border border-stone-200 bg-stone-50 px-1.5 py-0.5 font-mono text-xs font-semibold tracking-[0.3em] text-stone-900 tabular-nums"
                    data-testid={`pin-${row.role}`}
                    title={t('connectTablets.pinTitle', 'The tablet asks for this PIN. Read it out; it is never in the link.')}
                  >
                    <span className="sr-only">PIN </span>{access.pin}
                  </span>
                )}
                {off && <StatusPill tone="neutral">{t('connectTablets.roleOff', 'Off')}</StatusPill>}
              </div>
              {row.url ? (
                <div className="truncate font-mono text-xs text-stone-500" title={row.url}>{row.url}</div>
              ) : row.note ? (
                <div className="flex items-center gap-1 text-xs text-stone-500" data-testid={`role-note-${row.role}`}>
                  <Cloud size={12} className="shrink-0 text-stone-400" aria-hidden="true" />
                  {row.note}
                </div>
              ) : (
                <div className="text-xs text-stone-400">{noUrlText}</div>
              )}
            </div>
            {access.field && match && onToggleRole && (
              <Switch
                checked={!off}
                onCheckedChange={(next) => onToggleRole(row.role, next)}
                aria-label={t('connectTablets.allowRole', 'Let {{role}} in', { role: labels[row.role] })}
                title={t('connectTablets.allowRole', 'Let {{role}} in', { role: labels[row.role] })}
              />
            )}
            <Button
              variant={qrRole === row.role ? 'dark' : 'ghost'}
              size="sm"
              icon={QrCode}
              aria-pressed={qrRole === row.role}
              disabled={!row.url}
              onClick={() => onPickQr(row.role)}
            >
              {t('connectTablets.qr', 'QR')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={copied === row.role ? Check : Copy}
              disabled={!row.url}
              onClick={() => copy(row)}
            >
              {copied === row.role ? t('connectTablets.copied', 'Copied') : t('connectTablets.copy', 'Copy')}
            </Button>
          </div>
        )
      })}
    </div>
  )
}

/**
 * The large QR codes: first the Wi-Fi to join (when the laptop makes one),
 * then the chosen role's link.
 */
export function QrPanel({ row, wifi }) {
  const { t } = useTranslation()
  const labels = useRoleLabels()
  return (
    <aside className="flex flex-col gap-3 self-start" data-testid="qr-panel">
      {wifi?.qr && (
        <figure className="flex flex-col items-center gap-2 rounded-xl border border-stone-200/70 bg-stone-50/60 p-3" data-testid="wifi-qr">
          <QRCodeSVG value={wifi.qr} size={148} level="M" marginSize={1} />
          <figcaption className="text-center text-xs text-stone-600">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">{t('connectTablets.step1', 'Step 1')}</span>
            <span className="font-semibold text-stone-800">{t('connectTablets.joinWifi', 'Join the Wi-Fi')}</span>
            <span className="block font-mono">{wifi.ssid}</span>
          </figcaption>
        </figure>
      )}
      <figure className="flex flex-col items-center gap-2 rounded-xl border border-stone-200/70 bg-stone-50/60 p-3" data-testid="role-qr">
        {row?.url ? (
          <QRCodeSVG value={row.url} size={wifi?.qr ? 148 : 200} level="M" marginSize={1} />
        ) : (
          <div className="flex h-[200px] w-[200px] items-center justify-center rounded-lg border border-dashed border-stone-300 px-4 text-center text-xs text-stone-400">
            {t('connectTablets.noLinkYet', 'No link yet')}
          </div>
        )}
        <figcaption className="text-center text-xs text-stone-600">
          {wifi?.qr && <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">{t('connectTablets.step2', 'Step 2')}</span>}
          <span className="font-semibold text-stone-800">{row ? labels[row.role] : ''}</span>
        </figcaption>
      </figure>
    </aside>
  )
}
