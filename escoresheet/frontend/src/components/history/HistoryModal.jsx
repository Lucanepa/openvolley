// History (scoreboard Match menu): the match log as the scorer reads it, in
// two views like DataProject's eScoresheet History window. Read-only; a
// wrong entry is one tap away with "Corrections" (the Manual changes panel).
//
//   History          Time | A | B | What | A line-up | B line-up: every entry
//                    the scorer wrote, the score of Team A and Team B, and on
//                    each rally both courts after it (positions I-VI, the
//                    libero marked). Set rows light blue, sanctions amber,
//                    captain and libero rows muted. The rows the app writes
//                    itself (rotations, rally starts) on request.
//   Set information  substitutions per team (score in / out), sanctions in
//                    the paper's W P E D columns, injuries and exceptional
//                    substitutions, time-outs: per set or the whole match.
//
// The rows come from domain/history (pure). The order chosen is remembered
// on the device, as the corrections' event log does.
import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Wrench } from 'lucide-react'
import Modal from '../Modal'
import { cn } from '../../ui/cn.js'
import { Button } from '../../ui/Button.jsx'
import { SegmentedControl } from '../../ui/SegmentedControl.jsx'
import { Switch } from '../../ui/Switch.jsx'
import { Select } from '../../ui/Select.jsx'
import { SearchInput } from '../../ui/Input.jsx'
import { SectionHeader } from '../../ui/SectionHeader.jsx'
import { EmptyLine } from '../../ui/EmptyState.jsx'
import { tr, teamLabel, teamAKeyOf, otherTeam, sanctionLabel } from '../../domain/describe'
import { historyRows, orderRows, searchRows, setInformation, playedSets, SANCTION_COLUMNS } from '../../domain/history'
import { teamBoxStyle } from '../../utils/teamColours'
import { TeamDot } from '../corrections/shared.jsx'

/** Where the scorer's order of the history is kept (this device). */
export const HISTORY_ORDER_KEY = 'ov.history.order'

/** 'newest' (the default, as the corrections' event log) or 'oldest'. */
export function readHistoryOrder() {
  try { return localStorage.getItem(HISTORY_ORDER_KEY) === 'oldest' ? 'oldest' : 'newest' } catch { return 'newest' }
}

function saveHistoryOrder(order) {
  try { localStorage.setItem(HISTORY_ORDER_KEY, order) } catch { /* private mode: not remembered */ }
}

// The kit table head ('caps'), sticky inside the scrolling box
const TH = 'sticky top-0 z-10 bg-stone-50 border-b border-stone-200 px-2 py-2 text-[11px] font-bold uppercase tracking-wide text-stone-500 whitespace-nowrap'
const TD = 'px-2 py-1.5 align-top'
// The scrolling box of a tab: the toolbar and the footer stay in view
// a fixed height: the dialog keeps its size when the tab or the filter changes
const SCROLL_BOX = 'h-[calc(85vh-27rem)] sm:h-[calc(85vh-19rem)] min-h-40 overflow-auto rounded-xl border border-stone-200 bg-white'

const ROW_TONE = {
  set: 'bg-sky-50',
  sanction: 'bg-amber-50'
}
const WHAT_TONE = {
  set: 'font-semibold text-sky-900',
  sanction: 'text-amber-900',
  muted: 'text-stone-500',
  auto: 'text-stone-400',
  plain: 'text-stone-800'
}

/** A team's letter on its colour ("A"), named for screen readers. */
function TeamChip({ team, className }) {
  if (!team) return null
  return (
    <span
      className={cn('inline-flex min-w-6 items-center justify-center rounded px-1.5 py-px text-xs font-bold leading-tight', className)}
      style={teamBoxStyle(team.color)}
      title={team.name}
    >
      {team.letter}
    </span>
  )
}

/** One court: positions I-VI joined by commas, the libero "L12", underlined. */
function Court({ line, liberoLabel }) {
  if (!line) return null
  return (
    <span className="whitespace-nowrap tabular-nums" data-court={line.text}>
      {line.positions.map((p, i) => (
        <Fragment key={p.pos}>
          {i > 0 && <span className="text-stone-400">,</span>}
          {p.libero
            ? <span className="font-semibold text-stone-900 underline decoration-stone-400 underline-offset-2" title={liberoLabel}>L{p.number}</span>
            : <span>{p.number || '?'}</span>}
        </Fragment>
      ))}
    </span>
  )
}

function setOptions(t, sets, allLabel) {
  return [
    { value: 'all', label: allLabel },
    ...sets.map(s => ({ value: String(s.index), label: tr(t, 'corrections.term.set', 'Set {{n}}', { n: s.number }) }))
  ]
}

function HistoryTab({ t, events, ctx, sets, teams }) {
  const [setFilter, setSetFilter] = useState('all')
  const [order, setOrder] = useState(readHistoryOrder)
  const [showAuto, setShowAuto] = useState(false)
  const [query, setQuery] = useState('')
  const chooseOrder = (value) => { setOrder(value); saveHistoryOrder(value) }

  const allRows = useMemo(
    () => historyRows(events, ctx, { showAutomatic: showAuto, setFilter }),
    [events, ctx, showAuto, setFilter]
  )
  const rows = useMemo(() => orderRows(searchRows(allRows, query), order), [allRows, query, order])
  const liberoLabel = tr(t, 'history.libero', 'Libero')
  const lineupHead = (team) => tr(t, 'history.col.lineupOf', 'Line-up {{letter}}', { letter: team?.letter || '' })
  let zebra = 0

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex items-center gap-2 text-sm text-stone-600">
          <span>{tr(t, 'history.filter.set', 'Set')}</span>
          <Select
            value={setFilter}
            onChange={(e) => setSetFilter(e.target.value)}
            options={setOptions(t, sets, tr(t, 'history.filter.allSets', 'All sets'))}
            data-testid="history-set-filter"
          />
        </label>
        <SegmentedControl
          variant="joined"
          ariaLabel={tr(t, 'corrections.field.order', 'Order')}
          options={[
            { value: 'newest', label: tr(t, 'corrections.action.newestFirst', 'Newest first') },
            { value: 'oldest', label: tr(t, 'corrections.action.oldestFirst', 'Oldest first') }
          ]}
          value={order}
          onChange={chooseOrder}
        />
        <span className="flex items-center gap-2">
          <Switch checked={showAuto} onCheckedChange={setShowAuto} aria-labelledby="ov-history-auto" />
          <span id="ov-history-auto" className="text-sm text-stone-700">{tr(t, 'corrections.action.showAutomatic', 'Show automatic entries')}</span>
        </span>
        <SearchInput
          size="md"
          className="w-full sm:ml-auto sm:w-56"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tr(t, 'history.searchPlaceholder', 'Search the history')}
          aria-label={tr(t, 'history.search', 'Search')}
        />
      </div>

      <div className={SCROLL_BOX}>
        {allRows.length === 0 ? (
          <EmptyLine className="px-4">{tr(t, 'history.empty.events', 'Nothing recorded yet.')}</EmptyLine>
        ) : rows.length === 0 ? (
          <EmptyLine className="px-4">{tr(t, 'history.empty.search', 'No entry matches your search.')}</EmptyLine>
        ) : (
          <table className="w-full border-collapse text-sm select-text" data-testid="history-table">
            <thead>
              <tr>
                <th className={cn(TH, 'w-20 text-left')}>{tr(t, 'history.col.time', 'Time')}</th>
                <th className={cn(TH, 'w-10 text-center')} title={teams.A?.name}><TeamChip team={teams.A} /></th>
                <th className={cn(TH, 'w-10 text-center')} title={teams.B?.name}><TeamChip team={teams.B} /></th>
                <th className={cn(TH, 'text-left')}>{tr(t, 'history.col.what', 'What')}</th>
                <th className={cn(TH, 'hidden w-40 text-left sm:table-cell')}>{lineupHead(teams.A)}</th>
                <th className={cn(TH, 'hidden w-40 text-left sm:table-cell')}>{lineupHead(teams.B)}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const striped = r.tone === 'plain' && (zebra++ % 2 === 1)
                return (
                  <tr
                    key={r.id}
                    data-history-row={r.kind}
                    data-tone={r.tone}
                    className={cn('border-b border-stone-100 last:border-0', ROW_TONE[r.tone], striped && 'bg-stone-50/70')}
                  >
                    <td className={cn(TD, 'whitespace-nowrap text-xs tabular-nums', r.tone === 'auto' ? 'text-stone-400' : 'text-stone-500')}>{r.time}</td>
                    <td className={cn(TD, 'text-center font-semibold tabular-nums text-stone-900')}>{r.scoreA}</td>
                    <td className={cn(TD, 'text-center font-semibold tabular-nums text-stone-900')}>{r.scoreB}</td>
                    <td className={cn(TD, WHAT_TONE[r.tone] || WHAT_TONE.plain)}>
                      <span className="flex items-start gap-2">
                        {r.team && <TeamDot color={r.team.color} size={10} className="mt-1.5" />}
                        <span className="min-w-0" data-what="">{r.what}</span>
                      </span>
                      {/* phones: both courts under the sentence */}
                      {(r.lineupA || r.lineupB) && (
                        <span className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-stone-600 sm:hidden">
                          {r.lineupA && <span><span className="font-semibold text-stone-500">{teams.A?.letter}</span> <Court line={r.lineupA} liberoLabel={liberoLabel} /></span>}
                          {r.lineupB && <span><span className="font-semibold text-stone-500">{teams.B?.letter}</span> <Court line={r.lineupB} liberoLabel={liberoLabel} /></span>}
                        </span>
                      )}
                    </td>
                    <td className={cn(TD, 'hidden text-sm text-stone-700 sm:table-cell')} data-lineup="A"><Court line={r.lineupA} liberoLabel={liberoLabel} /></td>
                    <td className={cn(TD, 'hidden text-sm text-stone-700 sm:table-cell')} data-lineup="B"><Court line={r.lineupB} liberoLabel={liberoLabel} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      <p className="m-0 text-xs text-stone-500">{tr(t, 'history.lineupHint', 'Line-ups after each point, positions I to VI; L = libero.')}</p>
    </div>
  )
}

/** A small table of the Set information tab (kit 'caps' head, centred cells). */
function InfoTable({ columns, rows, empty, testId }) {
  if (!rows.length) return <EmptyLine>{empty}</EmptyLine>
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm" data-testid={testId}>
        <thead>
          <tr className="border-b border-stone-200 text-[11px] font-bold uppercase tracking-wide text-stone-500">
            {columns.map(c => (
              <th key={c.key} title={c.title} className={cn('px-2 py-2 whitespace-nowrap', c.left ? 'text-left' : 'text-center')}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? i} className="border-b border-stone-100 last:border-0">
              {columns.map(c => (
                <td key={c.key} className={cn('px-2 py-1.5 tabular-nums', c.left ? 'text-left text-stone-700' : 'text-center text-stone-800')}>{c.cell(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SetInfoTab({ t, events, ctx, sets, teams }) {
  const [setFilter, setSetFilter] = useState('all')
  const info = useMemo(() => setInformation(events, ctx, { setFilter }), [events, ctx, setFilter])
  const teamOf = (letter) => (letter === teams.A?.letter ? teams.A : letter === teams.B?.letter ? teams.B : null)
  const chip = (r) => <TeamChip team={teamOf(r.team)} />
  const setCol = { key: 'set', label: tr(t, 'history.col.set', 'Set'), cell: r => r.set }
  const scoreCol = { key: 'score', label: tr(t, 'history.col.score', 'Score'), title: tr(t, 'history.col.scoreTitle', 'The team concerned first, as on the scoresheet'), cell: r => r.score }
  const teamCol = { key: 'team', label: tr(t, 'history.col.teamAB', 'A/B'), cell: chip }

  const subColumns = [
    setCol,
    { key: 'in', label: tr(t, 'history.col.in', 'No. in'), cell: r => r.in },
    { key: 'out', label: tr(t, 'history.col.out', 'No. out'), cell: r => r.out },
    { key: 'scoreIn', label: tr(t, 'history.col.scoreIn', 'Score in'), cell: r => r.scoreIn },
    { key: 'scoreOut', label: tr(t, 'history.col.scoreOut', 'Score out'), cell: r => r.scoreOut || <span className="text-stone-300">–</span> }
  ]
  const sanctionColumns = [
    setCol,
    scoreCol,
    teamCol,
    ...Object.entries(SANCTION_COLUMNS).map(([type, letter]) => ({
      key: letter,
      label: tr(t, `history.sanctionColumn.${letter}`, letter),
      title: sanctionLabel(type, t),
      cell: r => (r.column === letter
        ? <span className="font-semibold text-stone-900" title={sanctionLabel(r.type, t)} data-sanction-cell={r.type}>{r.code}</span>
        : '')
    }))
  ]
  const injuryColumns = [
    setCol,
    scoreCol,
    teamCol,
    { key: 'number', label: tr(t, 'history.col.number', 'No.'), cell: r => r.number },
    { key: 'what', label: tr(t, 'history.col.what', 'What'), left: true, cell: r => r.what }
  ]
  const timeoutColumns = [setCol, { ...teamCol, label: tr(t, 'history.col.team', 'Team') }, scoreCol]

  return (
    <div className="space-y-3">
      <label className="flex flex-wrap items-center gap-2 text-sm text-stone-600">
        <span>{tr(t, 'history.filter.infoFor', 'Information related to')}</span>
        <Select
          value={setFilter}
          onChange={(e) => setSetFilter(e.target.value)}
          options={setOptions(t, sets, tr(t, 'history.filter.wholeMatch', 'Whole match'))}
          data-testid="history-info-filter"
        />
      </label>
      <div className={cn(SCROLL_BOX, 'space-y-6 p-3 sm:p-4')} data-testid="history-set-info">
        <section>
          <SectionHeader title={tr(t, 'corrections.section.substitutions', 'Substitutions')} />
          <div className="mt-2 grid gap-4 sm:grid-cols-2">
            {['A', 'B'].map(letter => (
              <div key={letter} data-subs-team={letter}>
                <p className="m-0 mb-1 flex items-center gap-2 text-sm font-semibold text-stone-700">
                  <TeamChip team={teams[letter]} />
                  <span className="min-w-0 truncate">{teams[letter]?.name}</span>
                </p>
                <InfoTable
                  columns={subColumns}
                  rows={info.substitutions[letter] || []}
                  empty={tr(t, 'history.empty.substitutions', 'No substitutions.')}
                  testId={`history-subs-${letter}`}
                />
              </div>
            ))}
          </div>
        </section>
        <div className="grid gap-6 lg:grid-cols-2">
          <section>
            <SectionHeader title={tr(t, 'corrections.section.sanctions', 'Sanctions')} />
            <div className="mt-2">
              <InfoTable columns={sanctionColumns} rows={info.sanctions} empty={tr(t, 'history.empty.sanctions', 'No sanctions.')} testId="history-sanctions" />
              {info.improperRequests.map(r => (
                <p key={r.id} className="m-0 mt-2 text-xs text-stone-600" data-improper-request={r.team}>
                  {tr(t, 'history.improperRequest', 'Improper request: Team {{team}}, set {{set}}, {{score}}', { team: r.team, set: r.set, score: r.score })}
                </p>
              ))}
            </div>
          </section>
          <section>
            <SectionHeader title={tr(t, 'history.section.injuries', 'Injuries and exceptional substitutions')} />
            <div className="mt-2">
              <InfoTable columns={injuryColumns} rows={info.injuries} empty={tr(t, 'history.empty.injuries', 'None.')} testId="history-injuries" />
            </div>
          </section>
          <section>
            <SectionHeader title={tr(t, 'corrections.section.timeouts', 'Time-outs')} />
            <div className="mt-2">
              <InfoTable columns={timeoutColumns} rows={info.timeouts} empty={tr(t, 'history.empty.timeouts', 'No time-outs.')} testId="history-timeouts" />
            </div>
          </section>
        </div>
      </div>
      <p className="m-0 text-xs text-stone-500">{tr(t, 'history.scoreHint', 'Scores are written with the team concerned first, as on the scoresheet.')}</p>
    </div>
  )
}

function HistoryBody({ events, match, sets, homeTeam, awayTeam, onClose, onCorrections }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState('history')
  const ctx = useMemo(() => ({ t, match, homeTeam, awayTeam }), [t, match, homeTeam, awayTeam])
  const played = useMemo(() => playedSets(events, sets, match), [events, sets, match])
  const teams = useMemo(() => {
    const aKey = teamAKeyOf(match)
    return { A: teamLabel(aKey, ctx), B: teamLabel(otherTeam(aKey), ctx) }
  }, [match, ctx])

  return (
    <div className="ov-kit space-y-3" data-testid="history">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          ariaLabel={tr(t, 'history.title', 'History')}
          options={[
            { value: 'history', label: tr(t, 'history.tab.history', 'History') },
            { value: 'info', label: tr(t, 'history.tab.setInfo', 'Set information') }
          ]}
          value={tab}
          onChange={setTab}
          className="w-full sm:w-80"
        />
        <p className="m-0 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-stone-700" data-testid="history-teams">
          {[teams.A, teams.B].map(team => team && (
            <span key={team.letter} className="flex min-w-0 items-center gap-1.5">
              <TeamChip team={team} />
              <span className="min-w-0 truncate">{team.name}</span>
            </span>
          ))}
        </p>
      </div>

      {tab === 'history'
        ? <HistoryTab t={t} events={events} ctx={ctx} sets={played} teams={teams} />
        : <SetInfoTab t={t} events={events} ctx={ctx} sets={played} teams={teams} />}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 pt-3" data-testid="history-footer">
        {onCorrections
          ? <Button variant="secondary" size="xl" icon={Wrench} onClick={onCorrections}>{tr(t, 'corrections.title', 'Corrections')}</Button>
          : <span />}
        <Button variant="dark" size="xl" onClick={onClose}>{tr(t, 'common.close', 'Close')}</Button>
      </div>
    </div>
  )
}

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {Array} props.events the match log
 * @param {object} props.match
 * @param {Array} [props.sets]
 * @param {object} [props.homeTeam]
 * @param {object} [props.awayTeam]
 * @param {() => void} [props.onCorrections] closes History and opens the Manual changes panel
 */
export default function HistoryModal({ open, onClose, events, match, sets, homeTeam, awayTeam, onCorrections }) {
  const { t } = useTranslation()
  if (!open) return null
  return (
    <Modal title={tr(t, 'history.title', 'History')} open onClose={onClose} width={1200}>
      <HistoryBody
        events={events || []}
        match={match}
        sets={sets || []}
        homeTeam={homeTeam}
        awayTeam={awayTeam}
        onClose={onClose}
        onCorrections={onCorrections}
      />
    </Modal>
  )
}
