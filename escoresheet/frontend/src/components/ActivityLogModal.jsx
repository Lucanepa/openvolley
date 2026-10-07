import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FileJson } from 'lucide-react'
import { db } from '../db/db'
import { Modal, FilterPill, Select, StatusPill, EmptyState, SkeletonRows, Button } from '../ui'
import { listActivity, countNotUploaded, SYNC } from '../utils/activity'
import { activityCategory, activityLine } from '../domain/activitySummary'
import { gameNumberOf } from '../utils/activity/activeMatch'

// The match activity log (utils/activity): what happened on this device,
// newest first. Opened from the scoreboard's options (this match) and from
// the home options (every match, with a match picker).

const FILTERS = ['all', 'scoring', 'corrections', 'sync', 'errors']

export function activityFilterOf(entry) {
  if (entry.level === 'error' || entry.level === 'warn') return 'errors'
  const cat = activityCategory(entry.kind, entry.level)
  if (cat === 'scoring') return 'scoring'
  if (cat === 'correction') return 'corrections'
  if (cat === 'sync') return 'sync'
  if (cat === 'error') return 'errors'
  return 'other'
}

const TIME_FMT = (() => {
  try {
    return new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  } catch {
    return null
  }
})()
function timeOf(ts) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '–'
  if (!TIME_FMT) return d.toISOString().slice(5, 19).replace('T', ' ')
  const parts = Object.fromEntries(TIME_FMT.formatToParts(d).map(p => [p.type, p.value]))
  return `${parts.day}.${parts.month}. ${parts.hour}:${parts.minute}:${parts.second}`
}

const kindKey = (kind) => String(kind || '').replace(/\./g, '_')

/** Rows as a file: JSON (array) or CSV. */
export function activityExport(rows, format) {
  const clean = rows.map(({ lid: _lid, ...r }) => r)
  if (format === 'json') return JSON.stringify(clean, null, 2)
  const cols = ['ts', 'kind', 'level', 'matchExt', 'setIndex', 'eventSeq', 'deviceId', 'appVersion', 'platform', 'accountId', 'synced', 'data']
  const cell = (v) => {
    if (v == null) return ''
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [cols.join(','), ...clean.map(r => cols.map(c => cell(r[c])).join(','))].join('\n')
}

function saveText(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function ActivityLogModal({ open, onClose, matchId = null }) {
  const { t } = useTranslation()
  const [rows, setRows] = useState(null)
  const [waiting, setWaiting] = useState(0)
  const [filter, setFilter] = useState('all')
  const [pick, setPick] = useState(matchId ?? '')
  const [matches, setMatches] = useState([])
  const fixedMatch = matchId != null

  useEffect(() => { setPick(matchId ?? '') }, [matchId])

  // The local matches (home options: pick one, or all)
  useEffect(() => {
    if (!open || fixedMatch) return undefined
    let alive = true
    db.matches.toArray()
      .then((list) => { if (alive) setMatches(list.sort((a, b) => (b.id || 0) - (a.id || 0))) })
      .catch(() => {})
    return () => { alive = false }
  }, [open, fixedMatch])

  useEffect(() => {
    if (!open) return undefined
    let alive = true
    setRows(null)
    const id = pick === '' ? null : Number(pick)
    Promise.all([listActivity(db, { matchId: id }), countNotUploaded(db, { matchId: id })])
      .then(([list, n]) => {
        if (!alive) return
        setRows(list)
        setWaiting(n)
      })
      .catch(() => { if (alive) setRows([]) })
    return () => { alive = false }
  }, [open, pick])

  const counts = useMemo(() => {
    const c = { all: rows?.length || 0, scoring: 0, corrections: 0, sync: 0, errors: 0 }
    for (const r of rows || []) {
      const f = activityFilterOf(r)
      if (f in c) c[f]++
    }
    return c
  }, [rows])
  const shown = useMemo(() => (rows || []).filter(r => filter === 'all' || activityFilterOf(r) === filter), [rows, filter])

  const exportAs = (format) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const name = `openvolley-activity-${pick === '' ? 'all' : `match${pick}`}-${stamp}.${format}`
    saveText(activityExport([...shown].reverse(), format), name, format === 'json' ? 'application/json' : 'text/csv')
  }

  const matchLabel = (m) => {
    const n = gameNumberOf(m)
    const home = m.homeTeamName || m.home_team?.name || ''
    const away = m.awayTeamName || m.away_team?.name || ''
    const teams = home || away ? ` · ${home}${home && away ? ' – ' : ''}${away}` : ''
    return `${n ? t('activity.game', { n }) : t('activity.localMatch', { id: m.id })}${m.test ? ` (${t('activity.test')})` : ''}${teams}`
  }

  const badge = (r) => {
    if (r.synced === SYNC.UPLOADED) return <StatusPill tone="done">{t('activity.status.uploaded')}</StatusPill>
    if (r.synced === SYNC.LOCAL) return <StatusPill tone="neutral">{t('activity.status.local')}</StatusPill>
    return <StatusPill tone="planned">{t('activity.status.waiting')}</StatusPill>
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('activity.title')}
      description={rows ? t('activity.notUploaded', { count: waiting }) : undefined}
      layout="sections"
      size="xl"
      closeLabel={t('common.close', 'Close')}
      footer={(
        <>
          <Button variant="ghost" size="sm" icon={FileJson} onClick={() => exportAs('json')} disabled={!shown.length}>{t('activity.exportJson')}</Button>
          <Button variant="ghost" size="sm" icon={Download} onClick={() => exportAs('csv')} disabled={!shown.length}>{t('activity.exportCsv')}</Button>
        </>
      )}
    >
      {!fixedMatch && (
        <Select
          block
          value={String(pick)}
          onChange={(e) => setPick(e.target.value)}
          aria-label={t('activity.match')}
        >
          <option value="">{t('activity.allMatches')}</option>
          {matches.map(m => <option key={m.id} value={String(m.id)}>{matchLabel(m)}</option>)}
        </Select>
      )}
      <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label={t('activity.filter')}>
        {FILTERS.map(f => (
          <FilterPill key={f} active={filter === f} count={counts[f]} onClick={() => setFilter(f)}>
            {t(`activity.filters.${f}`)}
          </FilterPill>
        ))}
      </div>
      {rows === null ? (
        <SkeletonRows rows={6} />
      ) : shown.length === 0 ? (
        <EmptyState title={t('activity.empty')} />
      ) : (
        <ul className="divide-y divide-stone-100" data-testid="activity-list">
          {shown.map(r => (
            <li key={r.uid} className="flex items-start gap-3 py-2.5">
              <span className="w-28 shrink-0 pt-0.5 text-xs tabular-nums text-stone-500">{timeOf(r.ts)}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={r.level === 'info' ? 'text-sm font-semibold text-stone-900' : 'text-sm font-semibold text-red-700'}>
                    {t(`activity.kinds.${kindKey(r.kind)}`, r.kind)}
                  </span>
                  {r.setIndex != null && <span className="text-xs tabular-nums text-stone-500">{t('activity.set', { n: r.setIndex })}</span>}
                </div>
                <div className="truncate text-xs tabular-nums text-stone-600" title={JSON.stringify(r.data)}>{activityLine(r) || '–'}</div>
              </div>
              <div className="shrink-0">{badge(r)}</div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
