import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card } from '../ui/Card.jsx'
import { fetchOrganizerMatches, fetchSharedMatch, formatOrganizerCode, organizerPdfUrl, sharedPdfUrl } from '../utils/globalCloudDb'

export const PAGE_POLL_MS = 30000

/**
 * The livescore site's pages of the Global tool's opt-in cloud copy
 * (utils/globalCloudDb): one shared match (?s=<token>) and a tournament's
 * list for its organizer (?o=<code>). Read-only; they refresh while a match
 * is still being scored.
 */
function usePolled(load, deps, pollMs) {
  const [state, setState] = useState({ data: null, failed: false, missing: false })
  useEffect(() => {
    let alive = true
    let timer = null
    const run = async () => {
      const r = await load()
      if (!alive) return
      if (r.ok) setState({ data: r.data, failed: false, missing: false })
      else setState((s) => ({ ...s, failed: true, missing: r.status === 404 }))
      timer = setTimeout(run, pollMs)
    }
    run()
    return () => { alive = false; clearTimeout(timer) }
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}

const statusText = (t, s) => (s === 'final' ? t('globalCloud.page.final') : s === 'ended' ? t('globalCloud.page.ended') : s === 'live' ? t('globalCloud.page.live') : t('globalCloud.page.scheduled'))

function when(iso, lang) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  try { return d.toLocaleString(lang || undefined, { dateStyle: 'medium', timeStyle: 'short' }) } catch { return d.toISOString() }
}

function MatchResult({ summary: s, pdfHref, t, lang }) {
  const team = (side) => (
    <div className="flex items-center gap-2">
      <span className="h-5 w-1.5 shrink-0 rounded-full" style={{ background: s?.[side]?.color || '#a8a29e' }} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-base font-semibold text-stone-900">{s?.[side]?.name || s?.[side]?.short || '–'}</span>
      <span className="flex gap-2 font-mono text-sm text-stone-500">
        {(s?.sets || []).map((x, i) => <span key={i} className={x[side] > x[side === 'home' ? 'away' : 'home'] ? 'font-semibold text-stone-800' : ''}>{x[side]}</span>)}
      </span>
      <span className="w-8 text-right font-mono text-xl font-bold tabular-nums">{s?.setsWon?.[side] ?? 0}</span>
    </div>
  )
  const meta = [s?.league, s?.hall, when(s?.scheduledAt, lang), s?.gameNumber ? `#${s.gameNumber}` : null].filter(Boolean).join(' · ')
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2 text-xs text-stone-500">
        <span className="truncate">{meta}</span>
        <span className={s?.status === 'live' ? 'font-semibold text-emerald-700' : 'font-semibold text-stone-700'}>{statusText(t, s?.status)}</span>
      </div>
      <div className="flex flex-col gap-2">
        {team('home')}
        {team('away')}
      </div>
      {pdfHref && (
        <a href={pdfHref} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-sm font-medium text-stone-700 underline" data-testid="global-cloud-pdf">
          {t('globalCloud.page.pdf')}
        </a>
      )}
    </div>
  )
}

function Shell({ title, children, testId }) {
  return (
    <div className="ov-kit min-h-screen bg-stone-100 p-4 text-stone-900 sm:p-6" data-testid={testId}>
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
        {children}
      </div>
    </div>
  )
}

/** ?s=<token>: one shared Global match. */
export function SharedMatchPage({ token, fetchImpl, pollMs = PAGE_POLL_MS }) {
  const { t, i18n } = useTranslation()
  const { data, failed, missing } = usePolled(() => fetchSharedMatch(token, { fetchImpl }), [token], pollMs)
  return (
    <Shell title={t('globalCloud.page.sharedTitle')} testId="global-shared-page">
      {data ? (
        <Card className="p-4">
          <MatchResult summary={data.summary} pdfHref={data.hasPdf ? sharedPdfUrl(token) : null} t={t} lang={i18n?.language} />
        </Card>
      ) : (
        <p className="mt-16 text-center text-stone-500" role="status">
          {missing ? t('globalCloud.page.notShared') : failed ? t('globalCloud.page.offline') : t('globalCloud.page.loading')}
        </p>
      )}
    </Shell>
  )
}

/** ?o=<code>: every match a tournament saved with its code. */
export function OrganizerPage({ code, fetchImpl, pollMs = PAGE_POLL_MS }) {
  const { t, i18n } = useTranslation()
  const { data, failed } = usePolled(() => fetchOrganizerMatches(code, { fetchImpl }), [code], pollMs)
  const matches = Array.isArray(data?.matches) ? data.matches : []
  return (
    <Shell title={t('globalCloud.page.organizerTitle')} testId="global-organizer-page">
      <p className="-mt-2 mb-4 font-mono text-sm tracking-wider text-stone-500">{formatOrganizerCode(code)}</p>
      {data && matches.length === 0 && <p className="mt-16 text-center text-stone-500">{t('globalCloud.page.noMatches')}</p>}
      {!data && <p className="mt-16 text-center text-stone-500" role="status">{failed ? t('globalCloud.page.offline') : t('globalCloud.page.loading')}</p>}
      <div className="flex flex-col gap-3">
        {matches.map((m) => (
          <Card key={m.id} className="p-4" data-testid="global-organizer-match">
            <MatchResult summary={m.summary} pdfHref={m.hasPdf ? organizerPdfUrl(code, m.id) : null} t={t} lang={i18n?.language} />
          </Card>
        ))}
      </div>
    </Shell>
  )
}
