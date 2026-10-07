import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { admin } from '../../lib/accountApi'
import { usePanelData, useOnline, OfflineBanner, PanelHead, MatchStatusPill, ReasonModal, InputModal, useErrorText, useKitLang } from './common'
import { Field, Input, SearchInput, RowList, Row, RowTool, DateRail, StatusPill, EmptyInset, SkeletonRows, Notice, Button, weekdayLabel, dayLabel, timeLabel, shiftDayKey, todayKey, toast } from '../../ui'

/** Official games (svrz_games) and which cloud match scores each (admins). */
export default function OfficialGamesPanel() {
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

  return (
    <section>
      <PanelHead title={t('manage.tabs.games')} />
      <OfflineBanner online={online} />
      <form className="mb-3 grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 sm:grid-cols-[10rem_10rem_1fr_auto] sm:items-end" onSubmit={e => { e.preventDefault(); setQuery(q.trim()) }}>
        <Field tone="compact" label={t('manage.games.from')}>
          <Input type="date" value={from} onChange={e => e.target.value && setFrom(e.target.value)} />
        </Field>
        <Field tone="compact" label={t('manage.games.to')}>
          <Input type="date" value={to} onChange={e => e.target.value && setTo(e.target.value)} />
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
            return (
              <Row
                key={g.game_number}
                tone={claim ? (claim.closed_at ? 'emerald' : 'red') : 'stone'}
                leading={<DateRail weekday={weekdayLabel(when, lang)} date={dayLabel(when)} time={timeLabel(when) || g.time} tone={claim ? (claim.closed_at ? 'emerald' : 'red') : 'stone'} />}
                title={`${g.team_home || '–'} vs ${g.team_away || '–'}`}
                meta={<>
                  <span className="tabular-nums">#{g.game_number}</span>
                  {g.league && <span>{g.league}</span>}
                  {g.hall && <span>{g.hall}{g.city ? `, ${g.city}` : ''}</span>}
                </>}
                status={claim ? <MatchStatusPill status={claim.status} /> : <StatusPill tone="neutral">{t('manage.games.notClaimed')}</StatusPill>}
                chips={claim ? <>
                  <span className="text-xs text-stone-600">{t('manage.games.scoredBy', { name: claim.scorer_name || claim.scorer_email || t('manage.games.unknownScorer') })}</span>
                  {claim.editors > 0 && <span className="text-xs text-stone-500">{t('manage.games.editors', { count: claim.editors })}</span>}
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
    </section>
  )
}
