import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Timer, ArrowLeftRight } from 'lucide-react'
import { addRelayMessageListener } from '../../utils/serverDataSync'
import { teamBoxStyle } from '../../utils/teamColours'

const OPEN = ['pending', 'seen']

/**
 * The open bench requests (relay bench-request-info { team, id, kind, pairs?,
 * status }) as one entry per request, oldest first; answered ones go.
 * Line-ups never come (FIVB 7.3): only time-outs and substitutions.
 */
export function benchInfoReducer(list, m) {
  if (!m || m.type !== 'bench-request-info' || !m.id) return list
  const rest = list.filter((e) => e.id !== m.id)
  if (!OPEN.includes(m.status) || (m.kind !== 'timeout' && m.kind !== 'substitution')) return rest
  // one open request per team and kind
  return [...rest.filter((e) => !(e.team === m.team && e.kind === m.kind)), { id: m.id, team: m.team, kind: m.kind, setIndex: m.setIndex, pairs: m.pairs || null }]
}

/**
 * For the 2nd referee: a small, non-blocking line at the bottom of the
 * referee tablet while a bench has asked for a time-out or prepared a
 * substitution on its tablet (the bench still asks the referee as always,
 * the scorer records). Gone once the scorer answered or the bench cancelled.
 */
export default function BenchRequestIndicator({ matchId, teams, setIndex = null }) {
  const { t } = useTranslation()
  const [list, setList] = useState([])
  useEffect(() => {
    setList([])
    if (!matchId) return undefined
    return addRelayMessageListener(matchId, (m) => setList((l) => benchInfoReducer(l, m)))
  }, [matchId])
  const shown = setIndex == null ? list : list.filter((e) => e.setIndex == null || e.setIndex >= setIndex)
  if (shown.length === 0) return null
  return (
    <div
      className="ov-kit no-print"
      data-referee-bench-requests=""
      role="status"
      style={{ position: 'fixed', left: 8, bottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)', zIndex: 40, display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 'min(420px, calc(100vw - 16px))', pointerEvents: 'none' }}
    >
      {shown.map((e) => {
        const team = teams?.[e.team] || {}
        const Icon = e.kind === 'timeout' ? Timer : ArrowLeftRight
        return (
          <div key={e.id} data-referee-bench-request={e.kind} data-team={e.team} className="flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900 shadow-lg">
            <span className="rounded-md px-2 py-0.5 text-xs font-bold truncate max-w-[40%]" style={teamBoxStyle(team.colour)}>{team.name || t(`common.${e.team}`)}</span>
            <Icon size={16} aria-hidden="true" className="shrink-0" />
            <span className="font-medium min-w-0">
              {e.kind === 'timeout'
                ? t('benchRequests.referee.timeout', 'Bench asks for a time-out')
                : t('benchRequests.referee.substitution', { pairs: (e.pairs || []).map((p) => `${p.out} → ${p.in}`).join(', '), defaultValue: 'Bench prepares a substitution: {{pairs}}' })}
            </span>
          </div>
        )
      })}
    </div>
  )
}
