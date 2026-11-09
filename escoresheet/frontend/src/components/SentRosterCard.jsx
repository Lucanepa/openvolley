import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardCheck } from 'lucide-react'
import { Button, cn } from '../ui'
import { dayTimeLabel } from '../ui/format'

/**
 * "Roster sent by the team" (db/023, docs/team-managers-spec.md section 4):
 * a team manager sent this side's roster ahead; the tablet downloaded it
 * while it was online, so this shows without a connection. Accept fills the
 * roster and the signatures made ahead (after the usual replace question),
 * Not now hides this version. Nothing is filled without the tap.
 * @param {{ row: object, side: 'home'|'away', onUse: () => void, onDismiss: () => void, className?: string }} props
 */
export default function SentRosterCard({ row, side, onUse, onDismiss, className }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  if (!row) return null
  const players = row.players || []
  const staff = row.staff || []
  const sent = row.updatedAt ? dayTimeLabel(row.updatedAt) : ''
  const signed = row.coachSignature && row.captainSignature ? 'both' : row.coachSignature ? 'coach' : row.captainSignature ? 'captain' : null
  return (
    <div className={cn('rounded-xl border border-emerald-200 bg-emerald-50/70 p-3', className)} data-testid={`sent-roster-${side}`}>
      <div className="flex items-start gap-2">
        <ClipboardCheck size={18} aria-hidden className="mt-0.5 shrink-0 text-emerald-700" />
        <div className="min-w-0 flex-1">
          <p className="m-0 text-sm font-semibold text-emerald-900">{t('sentRoster.title', { team: row.teamName || '' })}</p>
          <p className="m-0 mt-0.5 text-xs text-emerald-800">
            {t('sentRoster.meta', {
              players: t('sentRoster.players', { count: players.length }),
              officials: t('sentRoster.officials', { count: staff.length }),
              when: sent,
              name: row.updatedByName || '–'
            })}
          </p>
          {signed && <p className="m-0 mt-0.5 text-xs font-medium text-emerald-900" data-testid={`sent-roster-signed-${side}`}>{t(`sentRoster.signed.${signed}`)}</p>}
        </div>
      </div>
      {open && (
        <ul className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-emerald-200 bg-white text-xs text-stone-700">
          {[...players].sort((a, b) => (a.number ?? 999) - (b.number ?? 999)).map((p, i) => (
            <li key={`p${i}`} className="flex gap-2 border-b border-stone-100 px-2 py-1 last:border-0">
              <span className="w-6 text-right font-semibold tabular-nums">{p.number ?? ''}</span>
              <span className="min-w-0 flex-1 truncate">{p.last_name} {p.first_name}</span>
              {p.is_captain && <span className="font-semibold">C</span>}
              {p.is_libero && <span className="font-semibold">L</span>}
            </li>
          ))}
          {staff.map((s, i) => (
            <li key={`s${i}`} className="flex gap-2 border-b border-stone-100 px-2 py-1 text-stone-500 last:border-0">
              <span className="w-6" />
              <span className="min-w-0 flex-1 truncate">{s.last_name} {s.first_name} · {s.role}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="positive" size="lg" onClick={onUse} data-testid={`sent-roster-use-${side}`}>{t('sentRoster.use')}</Button>
        <Button variant="secondary" size="lg" onClick={() => setOpen((v) => !v)}>{open ? t('sentRoster.hidePreview') : t('sentRoster.preview')}</Button>
        <Button variant="ghost" size="lg" onClick={onDismiss} data-testid={`sent-roster-dismiss-${side}`}>{t('sentRoster.notNow')}</Button>
      </div>
      <p className="m-0 mt-2 text-xs text-emerald-800">{t(signed === 'both' ? 'sentRoster.hintSigned' : 'sentRoster.hint')}</p>
    </div>
  )
}
