import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Switch, cn } from '../../ui'
import { StatusLine, radioKeyDown, useRoleLabels } from './parts'
import { sinceLabel } from './connectView'

/** A role card's one line of live state (step 2). */
export function useCardStatusText() {
  const { t } = useTranslation()
  return (s) => ({
    off: t('connectTablets.card.off', 'Off · turn on to show its PIN'),
    nopin: t('connectTablets.card.nopin', 'On · no PIN yet'),
    waiting: t('connectTablets.card.waiting', 'Waiting for the tablet…'),
    connected: sinceLabel(s.since)
      ? t('connectTablets.card.connectedSince', 'Connected · since {{time}}', { time: sinceLabel(s.since) })
      : t('connectTablets.card.connected', 'Connected'),
    many: t('connectTablets.card.many', '{{count}} tablets use this PIN', { count: s.count }),
    unknown: t('connectTablets.card.unknown', 'Live status not available'),
    remote: t('connectTablets.card.remote', 'On · status not visible over the internet'),
    public: t('connectTablets.card.public', 'Public · no PIN')
  }[s.status] || '')
}

/**
 * Step 2: one card per tablet. The card picks the tablet whose code step 3
 * shows; the switch beside it lets that role in (or keeps it out). Flipping
 * the switch picks the card too.
 *
 * @param {{ role: string, team?: string|null, access: object, status: object }[]} props.cards
 */
export function RoleCards({ cards, selected, onSelect, onToggleRole, labelledBy }) {
  const { t } = useTranslation()
  const labels = useRoleLabels()
  const statusText = useCardStatusText()
  const base = useId()
  const ids = cards.map(c => c.role)

  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="space-y-1.5" data-testid="tablet-role-rows">
      {cards.map(card => {
        const { role, team, access, status } = card
        const checked = role === selected
        const off = status.status === 'off'
        const switchable = !!access?.field && !!onToggleRole
        return (
          <div
            key={role}
            data-testid={`role-row-${role}`}
            className={cn(
              'flex items-center gap-2 rounded-xl border transition-colors',
              checked ? 'border-slate-900 bg-white ring-1 ring-slate-900' : off ? 'border-stone-200 bg-stone-50' : 'border-stone-200 bg-white hover:bg-stone-50'
            )}
          >
            <button
              type="button"
              role="radio"
              aria-checked={checked}
              aria-labelledby={`${base}-${role}`}
              aria-describedby={`${base}-${role}-s`}
              tabIndex={checked ? 0 : -1}
              data-radio-id={role}
              onClick={() => onSelect(role)}
              onKeyDown={(e) => radioKeyDown(e, ids, selected, onSelect)}
              className="min-w-0 flex-1 rounded-xl px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
            >
              <span id={`${base}-${role}`} className="flex min-w-0 items-baseline gap-2">
                <span className={cn('shrink-0 text-sm font-semibold', off ? 'text-stone-500' : 'text-stone-900')}>{labels[role]}</span>
                {team && <span className="min-w-0 truncate text-xs text-stone-500">{team}</span>}
              </span>
              <StatusLine
                status={status.status}
                className={cn('mt-0.5', off ? 'text-stone-400' : status.status === 'connected' ? 'text-emerald-800' : 'text-stone-500')}
                testId={`role-status-${role}`}
              >
                <span id={`${base}-${role}-s`}>{statusText(status)}</span>
              </StatusLine>
            </button>
            {switchable && (
              <Switch
                className="mr-3"
                checked={!off}
                onCheckedChange={(next) => { onSelect(role); onToggleRole(role, next) }}
                aria-label={t('connectTablets.allowRole', 'Let {{role}} in', { role: labels[role] })}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
