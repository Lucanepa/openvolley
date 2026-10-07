import { useTranslation } from 'react-i18next'
import Modal from './Modal'
import { Button } from '../ui/Button.jsx'
import { SanctionChip, oneLine } from './rosters/RostersPanel.jsx'
import { compareEvents, scoreAtEvent } from '../domain/rosterLive'
import { isMatchOverStatus, getMatchWinner } from '../domain/matchEnd'
import { teamBoxStyle } from '../utils/teamColours'

// The scorer's "Sanctions and results" dialog (Match menu): every sanction of
// the match as the referee's cards, the set results seen from the current
// court sides (or the match totals once it is over) and the remarks.
//
// It uses the room it gets: up to 95vw x 90vh, type scaled with the window
// (15-19 px, about 1.5x the old 9-11 px), sanctions and results side by side
// when the dialog is wide enough and one under the other when it is not.
// Nothing is written here; signing opens the Scoreboard's own signature pad.

const SANCTION_LABEL_KEYS = {
  warning: 'scoreboard.sanctions.warning',
  penalty: 'scoreboard.sanctions.penalty',
  expulsion: 'scoreboard.sanctions.expulsion',
  disqualification: 'scoreboard.sanctions.disqualification',
  delay_warning: 'scoreboard.sanctions.delayWarning',
  delay_penalty: 'scoreboard.sanctions.delayPenalty'
}

const ROLE_SHORT = {
  Coach: 'C',
  'Assistant Coach 1': 'AC1',
  'Assistant Coach 2': 'AC2',
  Physiotherapist: 'P',
  Medic: 'M'
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V']
const toRoman = (n) => ROMAN[n - 1] || String(n)
// Local wall-clock time, as the match end page (formatTimeLocal) shows the
// same start / end (it was UTC here: 2 h early in summer in Switzerland)
const hhmmss = (d) => d
  ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  : '—'

// The kit SectionHeader face (a name on the dark 1.5px rule), sized with the dialog
const HEAD = 'm-0 mb-[0.6em] flex items-center justify-between gap-2 border-b-[1.5px] border-stone-800 pb-[0.35em] text-[0.78em] font-bold uppercase tracking-wider text-stone-800'
const TABLE = { width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' }
// The results table keeps its two halves the same width whatever the team
// names: fixed layout, the names wrap (a long club name used to push the
// table out of the dialog)
const RESULTS_TABLE = { ...TABLE, tableLayout: 'fixed' }
// Set | T S W P | Dur | P W S T  (live), T S W P | Dur | P W S T (totals)
const LIVE_COLS = ['12%', '8%', '8%', '8%', '14%', '12%', '14%', '8%', '8%', '8%']
const TOTAL_COLS = ['9%', '9%', '9%', '13%', '20%', '13%', '9%', '9%', '9%']
const colgroup = (widths) => <colgroup>{widths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
const TH = { padding: '0.35em 0.3em', textAlign: 'center', fontWeight: 600, fontSize: '0.78em', color: 'var(--ov-text-muted, #57534e)', whiteSpace: 'nowrap' }
const TD = { padding: '0.45em 0.3em', textAlign: 'center' }
const TEAM_TH = { ...TH, fontSize: '0.95em', whiteSpace: 'normal', verticalAlign: 'bottom', color: 'var(--text, #1c1917)', borderBottom: '1px solid var(--ov-hairline, #e7e5e4)' }
const ROW = { borderBottom: '1px solid var(--ov-hairline, #e7e5e4)' }

function TeamChip({ label, colour }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: '1.6em', padding: '0.1em 0.4em', borderRadius: 4,
      fontSize: '0.85em', fontWeight: 700, lineHeight: 1.2,
      ...teamBoxStyle(colour)
    }}>{label}</span>
  )
}

function TeamHead({ name, label, colour }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.4em', flexWrap: 'wrap' }}>
      <span style={{ fontWeight: 700, overflowWrap: 'anywhere', minWidth: 0 }}>{name}</span>
      <TeamChip label={label} colour={colour} />
    </span>
  )
}

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {Function} props.onClose
 * @param {object} props.data      the Scoreboard's live data (match, teams, sets, events)
 * @param {'home'|'away'} props.teamAKey
 * @param {boolean} props.leftIsHome
 * @param {(who: 'home-captain'|'away-captain') => void} props.onSign
 */
export default function SanctionsResultsModal({ open, onClose, data, teamAKey, leftIsHome, onSign }) {
  const { t } = useTranslation()
  if (!open) return null

  const events = data?.events || []
  const teamBKey = teamAKey === 'home' ? 'away' : 'home'
  const letter = (key) => (key === teamAKey ? 'A' : 'B')
  const teamData = (key) => (key === 'home' ? data?.homeTeam : data?.awayTeam)
  const teamColour = (key) => teamData(key)?.color || (key === 'home' ? '#ef4444' : '#3b82f6')

  // ── Sanctions ────────────────────────────────────────────────────────────
  const sanctions = events
    .filter(e => e.type === 'sanction' && e.payload?.type !== 'improper_request')
    .sort((a, b) => ((a.setIndex || 1) - (b.setIndex || 1)) || compareEvents(a, b))
    .map((e, idx) => {
      const team = e.payload?.team
      const type = e.payload?.type || e.payload?.sanctionType
      const score = scoreAtEvent(events, e)
      const role = e.payload?.role
      const number = e.payload?.playerNumber
      let who = null
      if (role) who = { short: ROLE_SHORT[role] || role, title: role }
      else if (number !== undefined && number !== null && number !== '') who = { short: `#${number}`, title: null }
      return {
        id: e.id ?? `${e.setIndex}-${e.seq}-${idx}`,
        team,
        type,
        who,
        setIndex: e.setIndex || 1,
        own: team === 'home' ? score.home : score.away,
        opp: team === 'home' ? score.away : score.home
      }
    })

  const improper = (key) => !!data?.match?.sanctions?.[`improperRequest${key === 'home' ? 'Home' : 'Away'}`]

  const sanctionsBlock = (
    <section aria-labelledby="sr-sanctions" style={{ minWidth: 0 }}>
      <h4 id="sr-sanctions" className={HEAD}>{t('matchEnd.sanctions')}</h4>

      {/* Improper request: one box per team, crossed once the team has had it */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75em', marginBottom: '0.8em', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>{t('scoreboard.sanctions.improperRequest', 'Improper request')}</span>
        <span style={{ display: 'inline-flex', gap: '0.5em' }}>
          {[teamAKey, teamBKey].map(key => {
            const marked = improper(key)
            return (
              <span
                key={key}
                data-improper-request={marked ? 'yes' : 'no'}
                aria-label={`${letter(key)}: ${marked ? t('scoreboard.sanctions.sanctionedImproperRequest', 'Sanctioned with an improper request') : '—'}`}
                style={{
                  position: 'relative', width: '2em', height: '2em', borderRadius: '50%',
                  border: '2px solid var(--ov-hairline-strong, #d6d3d1)', display: 'inline-flex',
                  alignItems: 'center', justifyContent: 'center', fontWeight: 700
                }}
              >
                {letter(key)}
                {marked && (
                  <span aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.6em', lineHeight: 1, color: 'rgba(220, 38, 38, 0.6)', fontWeight: 400 }}>✕</span>
                )}
              </span>
            )
          })}
        </span>
      </div>

      <table style={TABLE}>
        <thead>
          <tr style={{ borderBottom: '2px solid var(--ov-hairline-strong, #d6d3d1)' }}>
            <th style={{ ...TH, width: '3.2em' }}><span className="sr-only">{t('scoreboard.sanctionsResults.card', 'Card')}</span></th>
            <th style={{ ...TH, textAlign: 'left' }}>{t('scoreboard.sanctionsResults.sanction', 'Sanction')}</th>
            <th style={TH}>{t('scoreboard.sanctionsResults.person', 'Person')}</th>
            <th style={TH}>{t('scoreboard.sanctionsResults.team', 'Team')}</th>
            <th style={TH}>{t('matchEnd.set', 'Set')}</th>
            <th style={TH}>{t('scoreboard.sanctionsResults.score', 'Score')}</th>
          </tr>
        </thead>
        <tbody>
          {sanctions.length === 0 ? (
            <tr>
              <td colSpan="6" style={{ ...TD, padding: '1em', color: 'var(--ov-text-muted, #78716c)' }}>
                {t('matchEnd.noSanctions', 'No sanctions')}
              </td>
            </tr>
          ) : sanctions.map(s => (
            <tr key={s.id} style={ROW} data-sanction-row={s.type}>
              <td style={TD}>
                {/* The referee's cards, 1.6x the Rosters size */}
                <span style={{ display: 'inline-flex', zoom: 1.6 }}>
                  <SanctionChip entry={s} />
                </span>
              </td>
              <td style={{ ...TD, textAlign: 'left' }}>{oneLine(t(SANCTION_LABEL_KEYS[s.type] || s.type, s.type || ''))}</td>
              <td style={{ ...TD, fontWeight: 700 }} title={s.who?.title || undefined}>
                {s.who ? s.who.short : <span style={{ fontWeight: 500, color: 'var(--ov-text-muted, #78716c)' }}>{t('scoreboard.sanctionsResults.wholeTeam', 'Team')}</span>}
              </td>
              <td style={TD}><TeamChip label={letter(s.team)} colour={teamColour(s.team)} /></td>
              <td style={TD}>{toRoman(s.setIndex)}</td>
              <td style={{ ...TD, whiteSpace: 'nowrap' }}>{s.own}:{s.opp}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )

  // ── Results (from the current court sides) ──────────────────────────────
  const leftKey = leftIsHome ? 'home' : 'away'
  const rightKey = leftIsHome ? 'away' : 'home'
  const leftName = teamData(leftKey)?.name || t('scoreboard.sanctionsResults.leftTeam', 'Left team')
  const rightName = teamData(rightKey)?.name || t('scoreboard.sanctionsResults.rightTeam', 'Right team')
  const pts = (set, key) => (key === 'home' ? set.homePoints : set.awayPoints)
  const count = (type, setIndex, key) => events.filter(e => e.type === type && e.setIndex === setIndex && e.payload?.team === key).length

  // Copy: never sort the live-query array in place
  const allSets = [...(data?.sets || [])].sort((a, b) => a.index - b.index)
  const finishedSets = allSets.filter(s => s.finished)
  const isMatchFinal = isMatchOverStatus(data?.match?.status)

  const teamHeads = (lead) => (
    <tr>
      {lead && <th style={TH} />}
      <th colSpan="4" style={TEAM_TH}>
        <TeamHead name={leftName} label={letter(leftKey)} colour={teamColour(leftKey)} />
      </th>
      <th style={TH} />
      <th colSpan="4" style={TEAM_TH}>
        <TeamHead name={rightName} label={letter(rightKey)} colour={teamColour(rightKey)} />
      </th>
    </tr>
  )
  const letterHeads = (lead) => (
    <tr style={{ borderBottom: '2px solid var(--ov-hairline-strong, #d6d3d1)' }}>
      {lead && <th style={TH}>{t('matchEnd.set', 'Set')}</th>}
      {['T', 'S', 'W', 'P'].map(l => <th key={`l${l}`} style={TH}>{l}</th>)}
      <th style={TH}>{t('scoreboard.sanctionsResults.durShort', 'Dur')}</th>
      {['P', 'W', 'S', 'T'].map(l => <th key={`r${l}`} style={TH}>{l}</th>)}
    </tr>
  )
  const legend = (
    <p style={{ margin: '0.6em 0 0', fontSize: '0.8em', color: 'var(--ov-text-muted, #78716c)' }}>
      {t('scoreboard.sanctionsResults.legend', 'T timeouts · S substitutions · W sets won · P points · Dur set duration')}
    </p>
  )

  let resultsBody
  if (isMatchFinal) {
    const total = (fn) => finishedSets.reduce((sum, set) => sum + fn(set), 0)
    const leftTO = total(set => count('timeout', set.index, leftKey))
    const rightTO = total(set => count('timeout', set.index, rightKey))
    const leftSubs = total(set => count('substitution', set.index, leftKey))
    const rightSubs = total(set => count('substitution', set.index, rightKey))
    const leftWins = finishedSets.filter(s => pts(s, leftKey) > pts(s, rightKey)).length
    const rightWins = finishedSets.filter(s => pts(s, rightKey) > pts(s, leftKey)).length
    const leftPoints = total(set => pts(set, leftKey))
    const rightPoints = total(set => pts(set, rightKey))

    let totalDurationMin = 0
    finishedSets.forEach(set => {
      if (set.startTime && set.endTime) totalDurationMin += Math.floor((new Date(set.endTime) - new Date(set.startTime)) / 60000)
    })
    const firstSetStart = events.find(e => e.type === 'set_start' && e.setIndex === 1)
    const matchStartTime = firstSetStart ? new Date(firstSetStart.ts) : (finishedSets[0]?.startTime ? new Date(finishedSets[0].startTime) : null)
    const lastSet = finishedSets[finishedSets.length - 1]
    const matchEndTime = lastSet?.endTime ? new Date(lastSet.endTime) : null
    const matchDurationMin = matchStartTime && matchEndTime ? Math.floor((matchEndTime - matchStartTime) / 60000) : 0

    // No winner for a match stopped with level sets
    const winnerKey = getMatchWinner(allSets, data?.match?.bestOf, { forfeitTeam: data?.match?.forfeitTeam })
    const winnerName = winnerKey
      ? (teamData(winnerKey)?.name || (winnerKey === 'home' ? 'Home' : 'Away'))
      : t('matchEnd.noWinner', 'No winner (match stopped)')

    const captains = [
      { key: 'home', who: 'home-captain', signature: data?.match?.homePostGameCaptainSignature || null, team: data?.homeTeam?.name || t('common.home') },
      { key: 'away', who: 'away-captain', signature: data?.match?.awayPostGameCaptainSignature || null, team: data?.awayTeam?.name || t('common.away') }
    ]

    resultsBody = (
      <>
        <table style={RESULTS_TABLE}>
          {colgroup(TOTAL_COLS)}
          <thead>{teamHeads(false)}{letterHeads(false)}</thead>
          <tbody>
            <tr style={ROW}>
              <td style={TD}>{leftTO}</td>
              <td style={TD}>{leftSubs}</td>
              <td style={{ ...TD, fontWeight: 700 }}>{leftWins}</td>
              <td style={TD}>{leftPoints}</td>
              <td style={{ ...TD, color: 'var(--ov-text-muted, #78716c)' }}>{totalDurationMin}'</td>
              <td style={TD}>{rightPoints}</td>
              <td style={{ ...TD, fontWeight: 700 }}>{rightWins}</td>
              <td style={TD}>{rightSubs}</td>
              <td style={TD}>{rightTO}</td>
            </tr>
          </tbody>
        </table>
        {legend}

        <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(9em, 1fr))', gap: '0.5em 1.25em', margin: '1em 0 0' }}>
          {[
            [t('matchEnd.start', 'Start'), hhmmss(matchStartTime)],
            [t('matchEnd.end', 'End'), hhmmss(matchEndTime)],
            [t('scoreboard.matchDuration'), matchDurationMin > 0 ? `${matchDurationMin} min` : '—'],
            [t('scoreboard.winnerLabel'), `${winnerName} (${leftWins}-${rightWins})`]
          ].map(([label, value], i) => (
            // The winner gets a whole line: a long club name stays on one or two lines
            <div key={label} style={{ minWidth: 0, gridColumn: i === 3 ? '1 / -1' : undefined }}>
              <dt style={{ fontSize: '0.78em', fontWeight: 600, color: 'var(--ov-text-muted, #57534e)' }}>{label}</dt>
              <dd style={{ margin: 0, fontWeight: 600, overflowWrap: 'anywhere' }}>{value}</dd>
            </div>
          ))}
        </dl>

        {/* Post-match captain signatures */}
        <div style={{ marginTop: '1em', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1em', alignItems: 'end' }}>
          {captains.map(c => (
            <div key={c.key} style={{ minWidth: 0 }}>
              <div style={{ fontSize: '0.85em', fontWeight: 600, marginBottom: '0.3em' }}>
                {t('scoreboard.captainLabel', { team: c.team })}
              </div>
              {c.signature ? (
                <div style={{ border: '1px solid var(--ov-hairline, #e7e5e4)', borderRadius: 6, padding: 4, minHeight: '3em', background: 'var(--panel-2)' }}>
                  <img src={c.signature} alt={t('common.signature')} style={{ maxWidth: '100%', maxHeight: '3em', objectFit: 'contain' }} />
                </div>
              ) : (
                <span className="ov-kit contents">
                  <Button variant="secondary" size="lg" className="h-11 w-full" onClick={() => onSign(c.who)}>
                    {t('scoreboard.sign')}
                  </Button>
                </span>
              )}
            </div>
          ))}
        </div>
      </>
    )
  } else {
    // Only the sets that have been played (started or with points)
    const playedSets = allSets.filter(s => s.homePoints > 0 || s.awayPoints > 0 || s.finished || s.startTime)
    resultsBody = (
      <>
        <table style={RESULTS_TABLE}>
          {colgroup(LIVE_COLS)}
          <thead>{teamHeads(true)}{letterHeads(true)}</thead>
          <tbody>
            {playedSets.map(set => {
              const lp = pts(set, leftKey)
              const rp = pts(set, rightKey)
              let duration = ''
              if (set.startTime && set.endTime) {
                duration = `${Math.floor((new Date(set.endTime) - new Date(set.startTime)) / 60000)}'`
              }
              // The set in play: its row on the sunken tint, nobody has won it yet
              // (W stays 0 for both, the leader's points are not bolded as a win)
              const live = !set.finished
              const leftWon = !live && lp > rp
              const rightWon = !live && rp > lp
              return (
                <tr key={set.id} style={{ ...ROW, background: live ? 'var(--ov-surface-sunken, #fafaf9)' : undefined }} data-set-row={set.index}>
                  <td style={{ ...TD, fontWeight: 700 }}>{toRoman(set.index)}</td>
                  <td style={TD}>{count('timeout', set.index, leftKey)}</td>
                  <td style={TD}>{count('substitution', set.index, leftKey)}</td>
                  <td style={TD}>{leftWon ? 1 : 0}</td>
                  <td style={{ ...TD, fontSize: '1.15em', fontWeight: leftWon ? 800 : 500 }}>{lp}</td>
                  <td style={{ ...TD, color: 'var(--ov-text-muted, #78716c)' }}>{duration}</td>
                  <td style={{ ...TD, fontSize: '1.15em', fontWeight: rightWon ? 800 : 500 }}>{rp}</td>
                  <td style={TD}>{rightWon ? 1 : 0}</td>
                  <td style={TD}>{count('substitution', set.index, rightKey)}</td>
                  <td style={TD}>{count('timeout', set.index, rightKey)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {legend}
      </>
    )
  }

  const resultsBlock = (
    <section aria-labelledby="sr-results" style={{ minWidth: 0 }}>
      <h4 id="sr-results" className={HEAD}>{t('matchEnd.results')}</h4>
      {resultsBody}
    </section>
  )

  return (
    <Modal
      title={t('scoreboard.modals.sanctionsAndResults')}
      open={true}
      onClose={onClose}
      width={1600}
      panelStyle={{ maxHeight: '90vh' }}
    >
      <div data-sanctions-results="" style={{ fontSize: 'clamp(15px, 1.2vw, 19px)', lineHeight: 1.35, color: 'var(--text, #1c1917)' }}>
        {/* Two columns while each keeps ~28em, one under the other below that */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 27em), 1fr))', gap: '1.5em 2.25em', alignItems: 'start' }}>
          {sanctionsBlock}
          {resultsBlock}
        </div>

        {data?.match?.remarks && (
          <section aria-labelledby="sr-remarks" style={{ marginTop: '1.5em' }}>
            <h4 id="sr-remarks" className={HEAD}>{t('matchEnd.remarks')}</h4>
            <div style={{
              background: 'var(--panel-2)', border: '1px solid var(--ov-hairline, #e7e5e4)', borderRadius: 8,
              padding: '0.7em 0.9em', fontSize: '0.9em', whiteSpace: 'pre-wrap', maxHeight: '12em', overflowY: 'auto'
            }}>
              {data.match.remarks}
            </div>
          </section>
        )}
      </div>
    </Modal>
  )
}
