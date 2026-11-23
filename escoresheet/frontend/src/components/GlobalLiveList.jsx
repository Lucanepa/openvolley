import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getCloudApiUrl } from '../utils/backendConfig'
import { formatLiveCode, setNumberOf } from '../utils/globalLive'
import { Card } from '../ui/Card.jsx'

export const LIST_POLL_MS = 10000

/**
 * The Global matches on the cloud livescore (owner 2026-11-17): the live
 * screens whose scorers opted in to "Show on livescore" (Options › Live
 * screen), from the TVs' in-memory court summaries (backend
 * GET /api/global/live, lib/globalLive.js list). A Global match has no
 * database row, so the livescore's game list cannot have it. Score summary
 * only; each event opens its own live page (?t=<code>). Nothing shows while
 * no event is listed.
 */
export default function GlobalLiveList({ fetchImpl = (...a) => fetch(...a), pollMs = LIST_POLL_MS }) {
  const { t } = useTranslation()
  const [events, setEvents] = useState([])

  useEffect(() => {
    let alive = true
    let timer = null
    const url = getCloudApiUrl('/api/global/live')
    const load = async () => {
      try {
        if (!url) return
        const res = await fetchImpl(url, { cache: 'no-store', credentials: 'omit' })
        const body = await res.json()
        if (alive && res.ok && Array.isArray(body?.data?.events)) setEvents(body.data.events)
      } catch { /* offline: the last list stays */ } finally {
        if (alive && url) timer = setTimeout(load, pollMs)
      }
    }
    load()
    return () => { alive = false; clearTimeout(timer) }
  }, [fetchImpl, pollMs])

  if (events.length === 0) return null
  return (
    <section className="mx-auto mt-6 max-w-3xl" data-testid="global-live-list" aria-label={t('globalLive.list.title')}>
      <h2 className="mb-2 px-1 text-sm font-semibold text-stone-700">{t('globalLive.list.title')}</h2>
      <div className="flex flex-col gap-3">
        {events.map((ev) => (
          <Card key={ev.code} pad="list" data-testid="global-live-event">
            <a href={`?t=${ev.code}`} className="flex items-center justify-between gap-2 px-4 pt-3 text-xs text-stone-500 hover:text-stone-800">
              <span className="font-mono tracking-wider">{formatLiveCode(ev.code)}</span>
              <span className="underline">{t('globalLive.list.open')}</span>
            </a>
            <ul className="divide-y divide-stone-100">
              {ev.courts.map((c) => <CourtRow key={c.id} court={c} t={t} />)}
            </ul>
          </Card>
        ))}
      </div>
    </section>
  )
}

function CourtRow({ court: c, t }) {
  const status = c.ended
    ? t('globalLive.page.final')
    : c.timeout ? t('globalLive.page.timeout')
      : c.interval ? t('globalLive.page.interval')
        : c.currentSet ? t('globalLive.page.set', { n: setNumberOf(c) }) : ''
  const team = (side) => (
    <div className="flex items-center gap-2">
      <span className="h-4 w-1.5 shrink-0 rounded-full" style={{ background: c[side]?.color || '#a8a29e' }} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-medium text-stone-900">{c[side]?.name || c[side]?.short || '–'}</span>
      {c.serving === side && !c.ended && <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" aria-label={t('globalLive.page.serving')} />}
      <span className="w-6 text-center font-mono text-sm text-stone-500">{c.setsWon?.[side] ?? 0}</span>
      <span className="w-8 text-right font-mono text-lg font-semibold tabular-nums">{c.ended ? '' : (c.points?.[side] ?? 0)}</span>
    </div>
  )
  return (
    <li className="px-4 py-3" data-testid="global-live-court-row">
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-stone-500">
        <span className="truncate">{c.hall || ''}</span>
        <span className={c.ended ? 'font-semibold text-stone-700' : 'font-semibold text-emerald-700'}>{status}</span>
      </div>
      {team('home')}
      {team('away')}
    </li>
  )
}
