import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { admin } from '../../lib/accountApi'
import { useErrorText } from './common'
import { Modal, SkeletonRows, EmptyInset, Notice, StatusPill, dayTimeLabel } from '../../ui'

const OP_TONE = { void: 'brand', edit: 'todo', restore: 'planned' }

/** "point · home" style summary of a revision's before / after row. */
function rowSummary(r) {
  if (!r || typeof r !== 'object') return '–'
  const p = r.payload && typeof r.payload === 'object' ? r.payload : {}
  const bits = [r.type, p.team, p.playerNumber != null ? `#${p.playerNumber}` : null, p.playerOut != null ? `${p.playerOut}→${p.playerIn}` : null,
    r.score_a != null && r.score_b != null ? `${r.score_a}:${r.score_b}` : null].filter(Boolean)
  return bits.join(' · ') || '–'
}

/**
 * The corrections of a match (db/015 event_revisions): undone, deleted,
 * edited and restored events, with reason, who, device, time, before / after.
 */
export default function RevisionsModal({ match, onClose }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!match) return undefined
    let alive = true
    setRows(null)
    setError(null)
    admin.listRevisions(match.id).then((res) => {
      if (!alive) return
      if (res.error) setError(errorText(res.error))
      setRows(res.data || [])
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match?.id])

  return (
    <Modal
      open={!!match}
      onClose={onClose}
      layout="sections"
      size="xl"
      title={t('manage.revisions.title', { game: match?.game_n ?? '' })}
      description={t('manage.revisions.description')}
      closeLabel={t('common.close', 'Close')}
    >
      {error && <Notice>{error}</Notice>}
      {rows === null ? (
        <SkeletonRows rows={4} pill={false} />
      ) : rows.length === 0 ? (
        <EmptyInset>{t('manage.revisions.empty')}</EmptyInset>
      ) : (
        <ul className="divide-y divide-stone-100" data-testid="revisions-list">
          {rows.map(r => (
            <li key={r.id} className="py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill tone={OP_TONE[r.op] || 'neutral'}>{t(`manage.revisions.ops.${r.op}`, r.op)}</StatusPill>
                <span className="text-sm font-semibold text-stone-900">{t(`manage.revisions.reasons.${r.reason}`, r.reason)}</span>
                <span className="text-xs tabular-nums text-stone-500">{r.event_type || ''}{r.event_seq != null ? ` · seq ${r.event_seq}` : ''}{r.set_index != null ? ` · ${t('activity.set', { n: r.set_index })}` : ''}</span>
                {!r.applied && <span className="text-xs text-stone-500">{t('manage.revisions.notOnServer')}</span>}
              </div>
              <div className="mt-1 text-xs text-stone-600">
                <span className="tabular-nums">{dayTimeLabel(r.client_ts)}</span>
                {r.actor_email && <span> · {r.actor_email}</span>}
                {r.device_id && <span title={r.device_id}> · {t('manage.activity.device', { id: String(r.device_id).slice(0, 8) })}</span>}
                {r.app_version && <span className="tabular-nums"> · v{r.app_version}</span>}
              </div>
              <div className="mt-1 grid gap-1 text-xs text-stone-700 sm:grid-cols-2">
                <div><span className="text-stone-500">{t('manage.revisions.before')}: </span>{rowSummary(r.before)}</div>
                {r.after && <div><span className="text-stone-500">{t('manage.revisions.after')}: </span>{rowSummary(r.after)}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
