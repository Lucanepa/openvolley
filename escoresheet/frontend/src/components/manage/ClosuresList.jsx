import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { admin } from '../../lib/accountApi'
import { useErrorText } from './common'
import { SkeletonRows, EmptyInset, Notice, dayTimeLabel } from '../../ui'

// The fields of a closed record (db/039 match_closures), in this order
export const CLOSURE_FIELDS = ['status', 'final_score', 'winner', 'sets', 'set_results', 'results', 'sanctions', 'remarks',
  'approval', 'signatures', 'manual_changes', 'officials', 'coin_toss']

const MAX_TEXT = 240

/** One field of a closed record as short text ('–' for none). */
export function fieldText(key, value) {
  if (value == null || value === '') return '–'
  if (key === 'sets' && Array.isArray(value)) {
    if (!value.length) return '–'
    return value.map(s => {
      const a = s.home_points ?? s.team1_points
      const b = s.away_points ?? s.team2_points
      return a != null && b != null ? `${a}:${b}` : '–'
    }).join(' · ')
  }
  if (key === 'approval' && typeof value === 'object' && !Array.isArray(value)) {
    const at = value.approvedAt || value.approved_at
    if (at) return dayTimeLabel(at)
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text
}

/** The fields whose value differs between the two records (all of them when there is no second one). */
export function changedFields(before, after) {
  const b = before || {}
  if (!after) return CLOSURE_FIELDS.filter(k => b[k] != null && b[k] !== '')
  return CLOSURE_FIELDS.filter(k => JSON.stringify(b[k] ?? null) !== JSON.stringify(after[k] ?? null))
}

/**
 * The earlier closes of a match: each admin reopen with its reason, and for
 * every field that changed the record as it was closed and as it closed
 * again (db/039 match_closures). On the match's page in Closed matches.
 */
export default function ClosuresList({ matchId }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!matchId) return undefined
    let alive = true
    setRows(null)
    setError(null)
    admin.listMatchClosures(matchId).then((res) => {
      if (!alive) return
      if (res.error) setError(errorText(res.error))
      setRows(res.data?.closures || [])
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId])

  return (
    <>
      {error && <Notice>{error}</Notice>}
      {rows === null ? (
        <SkeletonRows rows={2} pill={false} />
      ) : rows.length === 0 ? (
        <EmptyInset>{t('manage.matches.closures.empty')}</EmptyInset>
      ) : (
        <ul className="divide-y divide-stone-100" data-testid="closures-list">
          {rows.map(c => {
            const fields = changedFields(c.closed_record, c.reclosed_record)
            return (
              <li key={c.id} className="py-2.5" data-testid={`closure-${c.id}`}>
                <div className="text-sm font-semibold text-stone-900">
                  {t('manage.matches.closures.reopened', { date: dayTimeLabel(c.reopened_at) })}
                  {c.reopened_by_name ? ` ${t('manage.matches.closures.by', { name: c.reopened_by_name })}` : ''}
                </div>
                {c.reason && <div className="mt-0.5 text-sm text-stone-700">{c.reason}</div>}
                {!c.reclosed_at && <div className="mt-0.5 text-xs text-stone-500">{t('manage.matches.closures.notClosedAgain')}</div>}
                {fields.length === 0 ? (
                  <div className="mt-1 text-xs text-stone-500">{t('manage.matches.closures.unchanged')}</div>
                ) : (
                  <table className="mt-2 w-full table-fixed text-xs">
                    <thead>
                      <tr className="text-left text-stone-500">
                        <th className="w-1/4 py-1 pr-2 font-medium" />
                        <th className="py-1 pr-2 font-medium">{t('manage.matches.closures.asClosed')}</th>
                        {c.reclosed_record && <th className="py-1 font-medium">{t('manage.matches.closures.closedAgain')}</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {fields.map(k => (
                        <tr key={k} className="align-top text-stone-700">
                          <td className="py-1 pr-2 text-stone-500">{t(`manage.matches.closures.fields.${k}`)}</td>
                          <td className="break-words py-1 pr-2 tabular-nums">{fieldText(k, c.closed_record?.[k])}</td>
                          {c.reclosed_record && <td className="break-words py-1 tabular-nums">{fieldText(k, c.reclosed_record[k])}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
