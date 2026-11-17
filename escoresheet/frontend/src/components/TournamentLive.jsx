import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getCloudApiUrl } from '../utils/backendConfig'
import { formatLiveCode } from '../utils/globalLive'

export const POLL_MS = 5000

/**
 * The Global tool's live page for TVs: every court of a tournament code
 * (livescore site, ?t=<code>; backend GET /api/global/live/<code>). Made for
 * a TV or a beamer: big numbers, no controls, it keeps itself up to date and
 * waits quietly while nothing is live yet.
 */
export default function TournamentLive({ code, fetchImpl = (...a) => fetch(...a), pollMs = POLL_MS }) {
  const { t } = useTranslation()
  const [page, setPage] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    let timer = null
    const url = getCloudApiUrl(`/api/global/live/${code}`)
    const load = async () => {
      try {
        if (!url) throw new Error('no backend')
        const res = await fetchImpl(url, { cache: 'no-store', credentials: 'omit' })
        const body = await res.json()
        if (!res.ok || !body?.data) throw new Error(`HTTP ${res.status}`)
        if (alive) { setPage(body.data); setFailed(false) }
      } catch {
        if (alive) setFailed(true)
      } finally {
        if (alive) timer = setTimeout(load, pollMs)
      }
    }
    load()
    return () => { alive = false; clearTimeout(timer) }
  }, [code, fetchImpl, pollMs])

  const courts = page?.courts || []
  return (
    <div className="ov-kit min-h-screen bg-stone-100 p-4 text-stone-900 sm:p-6" data-testid="tournament-live">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t('globalLive.page.title')}</h1>
        <div className="flex items-center gap-3 text-sm text-stone-500">
          <span className="font-mono tracking-wider">{formatLiveCode(code)}</span>
          {failed && <span role="status" className="text-amber-700">{t('globalLive.page.offline')}</span>}
        </div>
      </header>
      {courts.length === 0 ? (
        <div className="mt-24 text-center text-lg text-stone-500" data-testid="tournament-live-empty">
          {page ? t('globalLive.page.empty') : t('globalLive.page.loading')}
        </div>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 520px), 1fr))' }}>
          {courts.map((c) => <CourtCard key={c.id} court={c} t={t} />)}
        </div>
      )}
    </div>
  )
}

function TeamRow({ team, setsWon, points, serving, sets, side, ended }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3">
      <span className="h-10 w-2 shrink-0 rounded-full" style={{ background: team?.color || '#a8a29e' }} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 truncate text-xl font-semibold sm:text-2xl">
          <span className="truncate">{team?.name || team?.short || '–'}</span>
          {serving && !ended && <span className="inline-block h-3 w-3 shrink-0 rounded-full bg-amber-400" aria-label={t('globalLive.page.serving')} />}
        </div>
        {sets.length > 0 && (
          <div className="mt-0.5 flex gap-2 font-mono text-sm text-stone-500">
            {sets.map((s, i) => <span key={i} className={s[side] > s[side === 'home' ? 'away' : 'home'] ? 'font-semibold text-stone-800' : ''}>{s[side]}</span>)}
          </div>
        )}
      </div>
      <div className="w-10 text-center font-mono text-3xl font-semibold text-stone-500">{setsWon}</div>
      <div className="w-20 text-right font-mono text-5xl font-bold tabular-nums">{ended ? '' : points}</div>
    </div>
  )
}

function CourtCard({ court: c, t }) {
  const status = c.ended
    ? t('globalLive.page.final')
    : c.timeout ? t('globalLive.page.timeout')
      : c.interval ? t('globalLive.page.interval')
        : c.currentSet ? t('globalLive.page.set', { n: c.currentSet }) : ''
  return (
    <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-stone-200" data-testid="tournament-live-court">
      <div className="mb-3 flex items-center justify-between gap-2 text-sm text-stone-500">
        <span className="truncate">{[c.hall, c.gameNumber ? `#${c.gameNumber}` : null].filter(Boolean).join(' · ')}</span>
        <span className={c.ended ? 'font-semibold text-stone-700' : 'font-semibold text-emerald-700'}>{status}</span>
      </div>
      <div className="flex flex-col gap-3">
        <TeamRow team={c.home} setsWon={c.setsWon?.home ?? 0} points={c.points?.home ?? 0} serving={c.serving === 'home'} sets={c.sets || []} side="home" ended={c.ended} />
        <TeamRow team={c.away} setsWon={c.setsWon?.away ?? 0} points={c.points?.away ?? 0} serving={c.serving === 'away'} sets={c.sets || []} side="away" ended={c.ended} />
      </div>
    </section>
  )
}
