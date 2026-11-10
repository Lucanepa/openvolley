import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { admin } from '../../lib/accountApi'
import { usePanelData, usePanelRoute, useOnline, OfflineBanner, PageMissing, PanelHead, MatchStatusPill, ReasonModal, useErrorText } from './common'
import { usePageItem } from './usePageItem'
import { Button, SegmentedControl, SearchInput, RowList, Row, RowTool, Chip, EmptyInset, KeyValue, SectionHeader, SectionNote, SkeletonRows, Notice, dayTimeLabel, toast } from '../../ui'
import { ApprovalChips, ApprovalLookup } from './ApprovalBits'
import RevisionsList from './RevisionsList'

/**
 * The read behind a match's page that is not in the list (opened from a link,
 * or reopened while the list shows the closed ones): there is no read of one
 * match, so the 500 latest matches, open or closed, and the one with this id.
 */
export async function findMatch(id) {
  const res = await admin.listMatches({ state: 'all', limit: 500 })
  if (res.error) return res
  return { data: (res.data?.matches || []).find(m => m.id === id) || null, error: null }
}

/**
 * Non-test matches by closed state; reopen a closed one (admins, audit-logged).
 * A match is a page of its own (owner 2026-11-10: "make sure every page there
 * gets their own page"): #matches/<match id>, with what its row says, Reopen,
 * Activity and its corrections (usePanelRoute).
 */
export default function ClosedMatchesPanel({ onShowActivity = null, route = '', onRoute = null }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const [state, setState] = useState('closed')
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [reopenFor, setReopenFor] = useState(null)
  const { data, error, loading, reload } = usePanelData(
    () => admin.listMatches({ state, q: query || undefined }),
    [state, query],
    { enabled: online }
  )
  const matches = data?.matches || []
  const [[pageId = null], go] = usePanelRoute(route, onRoute)
  const page = usePageItem(pageId, {
    found: pageId ? matches.find(m => m.id === pageId) || null : null,
    ready: !!data && !loading,
    lookup: findMatch,
    enabled: online
  })

  const reopenModal = (
    <ReasonModal
      open={!!reopenFor}
      title={t('manage.matches.reopenTitle', { game: reopenFor?.game_n ?? '' })}
      body={t('manage.matches.reopenBody')}
      label={t('manage.matches.reopenReason')}
      confirmLabel={t('manage.matches.reopen')}
      onClose={() => setReopenFor(null)}
      onSubmit={async (reason) => {
        const res = await admin.reopenMatch(reopenFor.id, { reason })
        if (res.error && res.error.code !== 'OV_NOT_CLOSED') return errorText(res.error)
        setReopenFor(null)
        toast.success(t('manage.matches.reopened'))
        reload()
        return null
      }}
    />
  )

  // the match's page
  if (pageId) {
    return (
      <>
        {page.item ? (
          <MatchPage
            key={pageId}
            match={page.item}
            online={online}
            onBack={() => go([])}
            onReopen={() => setReopenFor(page.item)}
            onShowActivity={onShowActivity}
          />
        ) : (
          <PageMissing loading={page.loading} error={page.error || error} onBack={() => go([])} backLabel={t('manage.tabs.matches')} />
        )}
        {reopenModal}
      </>
    )
  }

  return (
    <section>
      <PanelHead title={t('manage.tabs.matches')} />
      <OfflineBanner online={online} />
      {/* The "ID" on a PDF approval stamp, or a game number */}
      <ApprovalLookup online={online} />
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <SegmentedControl
          ariaLabel={t('manage.tabs.matches')}
          value={state}
          onChange={setState}
          options={[
            { value: 'closed', label: t('manage.matches.filterClosed') },
            { value: 'open', label: t('manage.matches.filterOpen') },
            { value: 'all', label: t('manage.matches.filterAll') }
          ]}
        />
        <form className="sm:ml-auto sm:w-80" onSubmit={e => { e.preventDefault(); setQuery(q.trim()) }}>
          <SearchInput size="md" value={q} onChange={e => { setQ(e.target.value); if (!e.target.value) setQuery('') }} placeholder={t('manage.matches.search')} aria-label={t('manage.matches.search')} />
        </form>
      </div>
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}
      {loading && !data ? (
        <SkeletonRows rows={5} pill={false} />
      ) : matches.length === 0 ? (
        <EmptyInset>{t('manage.matches.empty')}</EmptyInset>
      ) : (
        <RowList>
          {matches.map(m => {
            const title = `${m.home_name || '–'} vs ${m.away_name || '–'}`
            return (
              <Row
                key={m.id}
                data-testid={`match-${m.id}`}
                stripe={false}
                toolsIndent="sm:pl-2"
                actionIndent="pl-1.5"
                title={title}
                label={title}
                onOpen={() => go([m.id])}
                status={<MatchStatusPill status={m.status} />}
                meta={<>
                  {m.game_n ? <span className="tabular-nums">#{m.game_n}</span> : null}
                  {m.scheduled_at && <span className="tabular-nums">{dayTimeLabel(m.scheduled_at)}</span>}
                  {m.league && <span>{m.league}</span>}
                  {/* the account, else (account deleted, or none) the scorer named on the scoresheet */}
                  {(m.scorer_name || m.scorer_email || m.sheet_scorer_name) && <span>{t('manage.games.scoredBy', { name: m.scorer_name || m.scorer_email || m.sheet_scorer_name })}</span>}
                </>}
                chips={<>
                  {m.closed_at && (
                    <span className="text-xs text-stone-600">
                      {t('manage.matches.closedAt', { date: dayTimeLabel(m.closed_at) })}{m.closed_by_name ? ` ${t('manage.matches.closedBy', { name: m.closed_by_name })}` : ''}
                    </span>
                  )}
                  {m.official_game_exempt && <Chip>{t('manage.games.releaseGame')}</Chip>}
                  <ApprovalChips approvals={m.approvals} />
                </>}
                // the corrections are on the match's page (the row opens it)
                tools={<>
                  {m.closed_at && <RowTool disabled={!online} onClick={() => setReopenFor(m)}>{t('manage.matches.reopen')}</RowTool>}
                  {onShowActivity && m.external_id && <RowTool disabled={!online} onClick={() => onShowActivity(m.external_id)}>{t('manage.matches.activity')}</RowTool>}
                </>}
              />
            )
          })}
        </RowList>
      )}
      {reopenModal}
    </section>
  )
}

/**
 * A match's page: what its row says (game, when, league, scorer, editors,
 * closed when and by whom, its approvals), Reopen (a closed one) and
 * Activity, and its corrections (RevisionsList).
 */
function MatchPage({ match: m, online, onBack, onReopen, onShowActivity }) {
  const { t } = useTranslation()
  const scorer = m.scorer_name || m.scorer_email || m.sheet_scorer_name
  const closed = m.closed_at
    ? `${dayTimeLabel(m.closed_at)}${m.closed_by_name ? ` ${t('manage.matches.closedBy', { name: m.closed_by_name })}` : ''}`
    : '–'
  const items = [
    { label: t('manage.matches.facts.game'), value: m.game_n ? <span className="tabular-nums">#{m.game_n}</span> : '–' },
    { label: t('manage.matches.facts.when'), value: m.scheduled_at ? <span className="tabular-nums">{dayTimeLabel(m.scheduled_at)}</span> : '–' },
    { label: t('manage.matches.facts.league'), value: m.league || '–' },
    { label: t('manage.matches.facts.scorer'), value: scorer || t('manage.games.unknownScorer') },
    { label: t('manage.matches.facts.editors'), value: <span className="tabular-nums">{m.editors ?? 0}</span> },
    { label: t('manage.matches.facts.closed'), value: closed }
  ]
  const hasChips = m.official_game_exempt || (m.approvals || []).length > 0
  const activity = !!(onShowActivity && m.external_id)
  return (
    <section data-testid="match-page">
      <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack} className="mb-3" data-testid="match-page-back">{t('manage.tabs.matches')}</Button>
      <PanelHead title={`${m.home_name || '–'} vs ${m.away_name || '–'}`}>
        <MatchStatusPill status={m.status} />
      </PanelHead>
      <OfflineBanner online={online} />
      {hasChips && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {m.official_game_exempt && <Chip>{t('manage.games.releaseGame')}</Chip>}
          <ApprovalChips approvals={m.approvals} />
        </div>
      )}
      <div className="mb-6 rounded-2xl border border-stone-200/70 bg-white p-4 shadow-card sm:p-5" data-testid="match-facts">
        <KeyValue items={items} variant="stats" className="gap-y-3 text-sm" />
        {(m.closed_at || activity) && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-stone-100 pt-4">
            {m.closed_at && <Button variant="secondary" disabled={!online} onClick={onReopen} data-testid="match-reopen">{t('manage.matches.reopen')}</Button>}
            {activity && <Button variant="secondary" disabled={!online} onClick={() => onShowActivity(m.external_id)} data-testid="match-activity">{t('manage.matches.activity')}</Button>}
          </div>
        )}
      </div>
      <SectionHeader title={t('manage.matches.corrections')} />
      <SectionNote className="mb-2">{t('manage.revisions.description')}</SectionNote>
      <RevisionsList matchId={m.id} />
    </section>
  )
}
