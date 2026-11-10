import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { admin } from '../../lib/accountApi'
import { usePanelData, usePanelRoute, useOnline, OfflineBanner, PageMissing, PanelHead, MatchStatusPill, ReasonModal, InputModal, useErrorText, useKitLang } from './common'
import { usePageItem } from './usePageItem'
import { Button, DateField, Field, Input, KeyValue, SearchInput, RowList, Row, RowTool, DateRail, StatusPill, EmptyInset, SkeletonRows, Notice, weekdayLabel, dayLabel, timeLabel, dayTimeLabel, shiftDayKey, todayKey, toast } from '../../ui'
import { ApprovalChips } from './ApprovalBits'

// The server reads at most 120 days of games at a time
const LOOKUP_DAYS = 120

/**
 * The read behind a game's page that is not in the list (opened from a link,
 * the list showing other days): the game number searched in the 120 days
 * before and after today; the same number in two seasons, the one nearer
 * today.
 */
export async function findOfficialGame(number) {
  const today = todayKey()
  const windows = [[shiftDayKey(today, -LOOKUP_DAYS), today], [shiftDayKey(today, 1), shiftDayKey(today, LOOKUP_DAYS)]]
  const reads = await Promise.all(windows.map(([from, to]) => admin.listOfficialGames({ from, to, q: String(number) })))
  if (reads.every(r => r.error)) return reads[0]
  const now = Date.now()
  const away = (g) => Math.abs((Date.parse(g.datetime || g.date) || now) - now)
  const games = reads.flatMap(r => r.data?.games || []).filter(g => String(g.game_number) === String(number)).sort((a, b) => away(a) - away(b))
  return { data: games[0] || null, error: null }
}

/**
 * Official games (svrz_games) and which cloud match scores each (admins).
 * A game is a page of its own (owner 2026-11-10: "make sure every page there
 * gets their own page (team, club, game, player etc)"): #games/<game number>,
 * with what its row says, Add editor and Release game (dialogs, as on the
 * row), and its cloud match's page in Closed matches (usePanelRoute).
 */
export default function OfficialGamesPanel({ route = '', onRoute = null, navigate = null, canOpen = null }) {
  const { t } = useTranslation()
  const lang = useKitLang()
  const online = useOnline()
  const errorText = useErrorText()
  const today = todayKey()
  const [from, setFrom] = useState(shiftDayKey(today, -1))
  const [to, setTo] = useState(shiftDayKey(today, 14))
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [editorFor, setEditorFor] = useState(null)
  const [releaseFor, setReleaseFor] = useState(null)

  const { data, error, loading, reload } = usePanelData(
    () => admin.listOfficialGames({ from, to, q: query || undefined }),
    [from, to, query],
    { enabled: online }
  )
  const games = data?.games || []
  const [[pageNumber = null], go] = usePanelRoute(route, onRoute)
  const page = usePageItem(pageNumber, {
    found: pageNumber ? games.find(g => String(g.game_number) === pageNumber) || null : null,
    ready: !!data && !loading,
    lookup: findOfficialGame,
    enabled: online
  })
  // the cloud match's page (#matches/<match id>), for an account with that tab
  const openMatch = navigate && (!canOpen || canOpen('matches')) ? (matchId) => navigate(`matches/${encodeURIComponent(matchId)}`) : null

  const dialogs = <>
    <InputModal
      open={!!editorFor}
      title={t('manage.games.addEditorTitle', { game: editorFor?.game ?? '' })}
      label={t('manage.games.editorEmail')}
      type="email"
      confirmLabel={t('manage.games.add')}
      onClose={() => setEditorFor(null)}
      onSubmit={async (email) => {
        const res = await admin.addMatchEditor(editorFor.matchId, { email })
        if (res.error) return errorText(res.error)
        setEditorFor(null)
        toast.success(t('manage.games.editorAdded'))
        reload()
        return null
      }}
    />
    <ReasonModal
      open={!!releaseFor}
      title={t('manage.games.releaseConfirmTitle', { game: releaseFor?.game ?? '' })}
      body={t('manage.games.releaseConfirmBody')}
      label={t('manage.games.reason')}
      confirmLabel={t('manage.games.releaseGame')}
      onClose={() => setReleaseFor(null)}
      onSubmit={async (reason) => {
        const res = await admin.releaseGame(releaseFor.matchId, { reason })
        if (res.error) return errorText(res.error)
        setReleaseFor(null)
        reload()
        return null
      }}
    />
  </>

  // the game's page
  if (pageNumber) {
    return (
      <>
        {page.item ? (
          <OfficialGamePage
            key={pageNumber}
            game={page.item}
            online={online}
            onBack={() => go([])}
            onAddEditor={(g) => setEditorFor({ game: g.game_number, matchId: g.claim.match_id })}
            onRelease={(g) => setReleaseFor({ game: g.game_number, matchId: g.claim.match_id })}
            onOpenMatch={openMatch}
          />
        ) : (
          <PageMissing loading={page.loading} error={page.error || error} onBack={() => go([])} backLabel={t('manage.tabs.games')} />
        )}
        {dialogs}
      </>
    )
  }

  return (
    <section>
      <PanelHead title={t('manage.tabs.games')} />
      <OfflineBanner online={online} />
      <form className="mb-3 grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 sm:grid-cols-[10rem_10rem_1fr_auto] sm:items-end" onSubmit={e => { e.preventDefault(); setQuery(q.trim()) }}>
        <Field tone="compact" label={t('manage.games.from')}>
          <DateField value={from} onChange={v => v && setFrom(v)} />
        </Field>
        <Field tone="compact" label={t('manage.games.to')}>
          <DateField value={to} onChange={v => v && setTo(v)} />
        </Field>
        <SearchInput size="md" value={q} onChange={e => { setQ(e.target.value); if (!e.target.value) setQuery('') }} placeholder={t('manage.games.search')} aria-label={t('manage.games.search')} className="min-[420px]:col-span-2 sm:col-span-1" />
        <Button type="submit" variant="secondary" className="hidden sm:inline-flex">{t('manage.games.searchButton')}</Button>
      </form>
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}
      {loading && !data ? (
        <SkeletonRows rows={6} />
      ) : games.length === 0 ? (
        <EmptyInset>{t('manage.games.empty')}</EmptyInset>
      ) : (
        <RowList>
          {games.map(g => {
            const claim = g.claim
            const when = g.datetime || g.date
            const title = `${g.team_home || '–'} vs ${g.team_away || '–'}`
            return (
              <Row
                key={g.game_number}
                data-testid={`game-${g.game_number}`}
                tone={claim ? (claim.closed_at ? 'emerald' : 'red') : 'stone'}
                leading={<DateRail weekday={weekdayLabel(when, lang)} date={dayLabel(when)} time={timeLabel(when) || g.time} tone={claim ? (claim.closed_at ? 'emerald' : 'red') : 'stone'} />}
                title={title}
                label={title}
                onOpen={() => go([g.game_number])}
                meta={<>
                  <span className="tabular-nums">#{g.game_number}</span>
                  {g.league && <span>{g.league}</span>}
                  {g.hall && <span>{g.hall}{g.city ? `, ${g.city}` : ''}</span>}
                </>}
                status={claim ? <MatchStatusPill status={claim.status} /> : <StatusPill tone="neutral">{t('manage.games.notClaimed')}</StatusPill>}
                chips={claim ? <>
                  <span className="text-xs text-stone-600">{t('manage.games.scoredBy', { name: claim.scorer_name || claim.scorer_email || claim.sheet_scorer_name || t('manage.games.unknownScorer') })}</span>
                  {claim.editors > 0 && <span className="text-xs text-stone-500">{t('manage.games.editors', { count: claim.editors })}</span>}
                  <ApprovalChips approvals={claim.approvals ?? g.approvals} />
                </> : null}
                tools={claim ? <>
                  <RowTool disabled={!online} onClick={() => setEditorFor({ game: g.game_number, matchId: claim.match_id })}>{t('manage.games.addEditor')}</RowTool>
                  <RowTool disabled={!online} onClick={() => setReleaseFor({ game: g.game_number, matchId: claim.match_id })}>{t('manage.games.releaseGame')}</RowTool>
                </> : null}
              />
            )
          })}
        </RowList>
      )}
      {dialogs}
    </section>
  )
}

/**
 * An official game's page: when, where, league, game number, and the cloud
 * match that scores it (status, scorer, editors, approvals), with Add editor,
 * Release game and its page in Closed matches.
 */
function OfficialGamePage({ game: g, online, onBack, onAddEditor, onRelease, onOpenMatch }) {
  const { t } = useTranslation()
  const claim = g.claim
  const when = g.datetime || g.date
  const hall = [g.hall, g.city].filter(Boolean).join(', ')
  const scorer = claim ? (claim.scorer_name || claim.scorer_email || claim.sheet_scorer_name || t('manage.games.unknownScorer')) : null
  const items = [
    { label: t('manage.matches.facts.when'), value: when ? <span className="tabular-nums">{g.datetime ? dayTimeLabel(g.datetime) : dayLabel(when, { year: true })}</span> : '–' },
    { label: t('manage.matches.facts.game'), value: <span className="tabular-nums">#{g.game_number}</span> },
    { label: t('manage.matches.facts.league'), value: g.league || '–' },
    { label: t('manage.matches.facts.hall'), value: hall || '–' },
    ...(claim ? [
      { label: t('manage.matches.facts.scorer'), value: scorer },
      { label: t('manage.matches.facts.editors'), value: <span className="tabular-nums">{claim.editors ?? 0}</span> }
    ] : [])
  ]
  const approvals = claim ? (claim.approvals ?? g.approvals) : null
  return (
    <section data-testid="official-game-page">
      <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack} className="mb-3" data-testid="official-game-back">{t('manage.tabs.games')}</Button>
      <PanelHead title={`${g.team_home || '–'} vs ${g.team_away || '–'}`}>
        {claim ? <MatchStatusPill status={claim.status} /> : <StatusPill tone="neutral">{t('manage.games.notClaimed')}</StatusPill>}
      </PanelHead>
      <OfflineBanner online={online} />
      {Array.isArray(approvals) && approvals.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5"><ApprovalChips approvals={approvals} /></div>
      )}
      <div className="rounded-2xl border border-stone-200/70 bg-white p-4 shadow-card sm:p-5" data-testid="official-game-facts">
        <KeyValue items={items} variant="stats" className="gap-y-3 text-sm" />
        {claim && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-stone-100 pt-4">
            {onOpenMatch && <Button variant="dark" onClick={() => onOpenMatch(claim.match_id)} data-testid="official-game-match">{t('manage.games.openMatch')}</Button>}
            <Button variant="secondary" disabled={!online} onClick={() => onAddEditor(g)} data-testid="official-game-add-editor">{t('manage.games.addEditor')}</Button>
            <Button variant="danger-outline" disabled={!online} onClick={() => onRelease(g)} data-testid="official-game-release">{t('manage.games.releaseGame')}</Button>
          </div>
        )}
      </div>
    </section>
  )
}
