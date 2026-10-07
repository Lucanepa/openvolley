import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { admin } from '../../lib/accountApi'
import { usePanelData, useOnline, OfflineBanner, PanelHead, MatchStatusPill, ReasonModal, useErrorText } from './common'
import { SegmentedControl, SearchInput, RowList, Row, RowTool, Chip, EmptyInset, SkeletonRows, Notice, dayTimeLabel, toast } from '../../ui'
import { ApprovalChips, ApprovalLookup } from './ApprovalBits'

/** Non-test matches by closed state; reopen a closed one (admins, audit-logged). */
export default function ClosedMatchesPanel() {
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
          {matches.map(m => (
            <Row
              key={m.id}
              stripe={false}
              toolsIndent="sm:pl-2"
              actionIndent="pl-1.5"
              title={`${m.home_name || '–'} vs ${m.away_name || '–'}`}
              status={<MatchStatusPill status={m.status} />}
              meta={<>
                {m.game_n ? <span className="tabular-nums">#{m.game_n}</span> : null}
                {m.scheduled_at && <span className="tabular-nums">{dayTimeLabel(m.scheduled_at)}</span>}
                {m.league && <span>{m.league}</span>}
                {(m.scorer_name || m.scorer_email) && <span>{t('manage.games.scoredBy', { name: m.scorer_name || m.scorer_email })}</span>}
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
              tools={m.closed_at ? <RowTool disabled={!online} onClick={() => setReopenFor(m)}>{t('manage.matches.reopen')}</RowTool> : null}
            />
          ))}
        </RowList>
      )}
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
    </section>
  )
}
