import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { SectionHeader } from '../../ui/SectionHeader.jsx'
import { VolleyballIcon } from '../icons'
import {
  positionsByNumber,
  hasLineup,
  teamSanctionSummary,
  playerPlayStatus,
  gameCaptainOnCourt
} from '../../domain/rosterLive'

// Body of the scorer's "Rosters" dialog: players, liberos, bench officials and
// match officials of both teams. During play it also shows, per person, the
// court position (I-VI, the server with the ball), the sanctions of the match
// as cards, and who cannot play (expelled / disqualified / injured).
// Everything is derived from the events and the current lineups the
// Scoreboard already holds; nothing is written.

const BENCH_ORDER = { Coach: 0, 'Assistant Coach 1': 1, 'Assistant Coach 2': 2, Physiotherapist: 3, Medic: 4 }
const sortBench = bench => [...bench].sort((a, b) => (BENCH_ORDER[a.role] ?? 999) - (BENCH_ORDER[b.role] ?? 999))
const byNumber = (a, b) => (Number(a.number) || 0) - (Number(b.number) || 0)
const pad = (list, n) => [...list, ...Array(Math.max(0, n - list.length)).fill(null)]

const SANCTION_LABEL_KEYS = {
  warning: 'scoreboard.sanctions.warning',
  penalty: 'scoreboard.sanctions.penalty',
  expulsion: 'scoreboard.sanctions.expulsion',
  disqualification: 'scoreboard.sanctions.disqualification',
  delay_warning: 'scoreboard.sanctions.delayWarning',
  delay_penalty: 'scoreboard.sanctions.delayPenalty',
  improper_request: 'scoreboard.sanctions.improperRequest'
}

const CARD = { width: 10, height: 14, borderRadius: 2, flex: 'none', boxShadow: '0 0 0 1px rgba(0,0,0,0.12)' }
const Card = ({ colour, style }) => <span className={`sanction-card ${colour}`} style={{ ...CARD, display: 'inline-block', ...style }} />
const MARK = { fontWeight: 700, lineHeight: 1, fontSize: 13, color: '#dc2626' }
const CELL = { whiteSpace: 'nowrap', verticalAlign: 'middle', paddingLeft: 6, paddingRight: 6 }
// The name column takes the room the others leave and ends in an ellipsis
// (auto table layout: width 100% + max-width 0), so a long name never wraps.
// Header cells take the same side padding, so labels sit over their values.
const TH = { paddingLeft: 6, paddingRight: 6, whiteSpace: 'nowrap' }
const NAME_CELL = { ...CELL, width: '100%', maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }
// One row height for every row of both teams' tables, so they stay aligned
// side by side whatever a row holds (position pill, cards, badges).
const ROW_H = 42

/** One sanction as the cards the referee shows (FIVB 21.3). */
export function SanctionChip({ entry }) {
  const { t } = useTranslation()
  const label = t(SANCTION_LABEL_KEYS[entry.type] || entry.type, entry.type)
  const title = `${label} · ${t('rosterLive.setScore', { set: entry.setIndex, score: `${entry.own}:${entry.opp}` })}`
  let body
  switch (entry.type) {
    case 'warning':
      body = <Card colour="yellow" />
      break
    case 'penalty':
      body = <Card colour="red" />
      break
    case 'expulsion':
      // yellow + red together, in one hand
      body = (
        <span style={{ position: 'relative', display: 'inline-block', width: 15, height: 15 }}>
          <Card colour="yellow" style={{ position: 'absolute', left: 0, top: 1, transform: 'rotate(-10deg)' }} />
          <Card colour="red" style={{ position: 'absolute', right: 0, top: 0, transform: 'rotate(10deg)' }} />
        </span>
      )
      break
    case 'disqualification':
      // yellow + red apart, one in each hand
      body = <span style={{ display: 'inline-flex', gap: 3 }}><Card colour="yellow" /><Card colour="red" /></span>
      break
    case 'delay_warning':
    case 'delay_penalty':
      body = (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ov-text-muted, #78716c)' }}>{t('rosterLive.delayShort')}</span>
          <Card colour={entry.type === 'delay_warning' ? 'yellow' : 'red'} />
        </span>
      )
      break
    default:
      body = (
        <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 4px', borderRadius: 3, border: '1px solid var(--ov-hairline, #e7e5e4)', color: 'var(--ov-text-muted, #78716c)' }}>
          {entry.type === 'improper_request' ? t('rosterLive.improperRequestShort') : label}
        </span>
      )
  }
  return (
    <span title={title} aria-label={title} role="img" data-sanction={entry.type} style={{ display: 'inline-flex', alignItems: 'center' }}>
      {body}
    </span>
  )
}

function SanctionList({ entries }) {
  if (!entries?.length) return null
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap' }}>
      {entries.map(e => <SanctionChip key={e.id} entry={e} />)}
    </span>
  )
}

function PositionCell({ position, isServer }) {
  const { t } = useTranslation()
  if (!position) return <td style={CELL} />
  return (
    <td style={{ ...CELL, textAlign: 'center' }}>
      <span
        title={isServer ? `${t('rosterLive.posTitle')} ${position} · ${t('rosterLive.server')}` : `${t('rosterLive.posTitle')} ${position}`}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, verticalAlign: 'middle' }}
      >
        <span
          data-position={position}
          style={{
            display: 'inline-block', minWidth: 30, padding: '1px 6px', borderRadius: 999,
            fontSize: 12, fontWeight: 700, lineHeight: '16px', textAlign: 'center',
            background: 'rgba(16, 185, 129, 0.14)', color: '#047857', border: '1px solid rgba(16, 185, 129, 0.35)'
          }}
        >
          {position}
        </span>
        {isServer && <VolleyballIcon size={16} data-server="" style={{ color: 'var(--text, #1c1917)' }} />}
      </span>
    </td>
  )
}

// Minimum widths: the two teams' tables line up column by column unless a
// cell needs more room (then that column grows instead of clipping).
function Colgroup({ showPos }) {
  return (
    <colgroup>
      <col style={{ width: 84 }} />
      <col />
      <col style={{ width: 96 }} />
      {showPos && <col style={{ width: 64 }} />}
      <col style={{ width: 96 }} />
    </colgroup>
  )
}

function PlayerTable({ team, rows, showPos, kind }) {
  const { t } = useTranslation()
  const cols = showPos ? 5 : 4
  return (
    <table className="roster-table">
      <Colgroup showPos={showPos} />
      <thead>
        <tr>
          <th style={TH}>{t('roster.number')}</th>
          <th style={TH}>{t('roster.name')}</th>
          <th style={TH}>{t('roster.dob')}</th>
          {showPos && <th style={{ ...TH, textAlign: 'center' }} title={t('rosterLive.posTitle')}>{t('rosterLive.pos')}</th>}
          <th style={TH}>{t('rosterLive.sanctions')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((player, idx) => {
          if (!player) {
            return <tr key={`empty-${kind}-${idx}`} style={{ height: ROW_H }}><td colSpan={cols} /></tr>
          }
          const num = String(player.number ?? '')
          const status = team.status(player)
          const position = team.positions[num]
          const fullName = `${player.lastName || player.name || ''} ${player.firstName || ''}`.trim()
          const outTitle = status.out ? t(`rosterLive.out.${status.out}`) : null
          return (
            <tr key={player.id || `${kind}-${num}`} data-player={num} style={{ height: ROW_H, color: status.out ? 'var(--ov-text-muted, #78716c)' : undefined }}>
              <td style={CELL}>
                <div className="roster-number" style={{ gap: 6 }}>
                  <span style={{ minWidth: 22 }}>{player.number ?? '—'}</span>
                  <span className="roster-role">
                    {player.libero === 'libero1' && <span className="roster-badge libero">L1</span>}
                    {player.libero === 'libero2' && <span className="roster-badge libero">L2</span>}
                    {player.libero === 'redesignated' && <span className="roster-badge libero">LR</span>}
                    {player.isCaptain && <span className="roster-badge captain">C</span>}
                    {team.gameCaptain === num && (
                      <span className="roster-badge captain" title={t('rosterLive.gameCaptain')} style={{ background: 'transparent' }}>
                        {t('rosterLive.gameCaptainShort')}
                      </span>
                    )}
                    {status.out && <span style={MARK} title={outTitle} aria-label={outTitle} data-out={status.out}>✕</span>}
                    {status.injured && <span style={MARK} title={t('rosterLive.injured')} aria-label={t('rosterLive.injured')}>✚</span>}
                  </span>
                </div>
              </td>
              <td className="roster-name" style={{ ...NAME_CELL, textDecoration: status.out ? 'line-through' : undefined }} title={fullName}>
                {fullName}
              </td>
              <td className="roster-dob" style={CELL}>{player.dob || '—'}</td>
              {showPos && <PositionCell position={position} isServer={team.serving && position === 'I'} />}
              <td style={CELL}><SanctionList entries={team.sanctions.players[num]} /></td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function BenchTable({ team, rows, emptyAll }) {
  const { t } = useTranslation()
  return (
    <table className="roster-table">
      <colgroup>
        <col style={{ width: 140 }} />
        <col />
        <col style={{ width: 96 }} />
        <col style={{ width: 96 }} />
      </colgroup>
      <thead>
        <tr>
          <th style={TH}>{t('roster.role')}</th>
          <th style={TH}>{t('roster.name')}</th>
          <th style={TH}>{t('roster.dob')}</th>
          <th style={TH}>{t('rosterLive.sanctions')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((official, idx) => (
          <tr key={official ? `${team.key}-bench-${idx}` : `empty-bench-${idx}`} style={{ height: ROW_H }}>
            {official ? (
              <>
                <td style={{ ...CELL, textTransform: 'capitalize', fontWeight: 500 }}>{official.role || '—'}</td>
                <td style={NAME_CELL} title={`${official.lastName || ''} ${official.firstName || ''}`.trim()}>
                  {official.lastName || ''} {official.firstName || ''}
                </td>
                <td style={CELL}>{official.dob || '—'}</td>
                <td style={CELL}><SanctionList entries={team.sanctions.officials[official.role]} /></td>
              </>
            ) : (
              <td colSpan={4} />
            )}
          </tr>
        ))}
        {emptyAll && (
          <tr>
            <td colSpan={4} style={{ textAlign: 'center', color: 'var(--muted)', fontStyle: 'italic' }}>{t('scoreboard.roster.noBenchOfficials')}</td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

function Section({ title, action }) {
  return (
    <div className="ov-kit">
      <SectionHeader title={title} action={action} className="mb-2" />
    </div>
  )
}

function TeamSanctionsLine({ entries }) {
  const { t } = useTranslation()
  if (!entries?.length) return null
  return (
    <span className="flex items-center gap-1.5 text-[11px] font-semibold text-stone-500" data-team-sanctions="">
      <span>{t('rosterLive.teamSanctions')}</span>
      <SanctionList entries={entries} />
    </span>
  )
}

/**
 * @param {object} props
 * @param {object} props.data       the Scoreboard's live match data
 * @param {{home: object|null, away: object|null}} props.lineups current lineup per team
 * @param {'home'|'away'|null} props.servingTeam team serving now
 */
export default function RostersPanel({ data, lineups, servingTeam }) {
  const { t } = useTranslation()
  const events = data?.events
  const setIndex = data?.set?.index
  const showPos = hasLineup(lineups?.home) || hasLineup(lineups?.away)

  const teams = useMemo(() => {
    const build = key => {
      const all = (key === 'home' ? data?.homePlayers : data?.awayPlayers) || []
      const lineup = lineups?.[key] || null
      return {
        key,
        name: (key === 'home' ? data?.homeTeam?.name : data?.awayTeam?.name) || t(key === 'home' ? 'common.home' : 'common.away'),
        players: all.filter(p => !p.libero).sort(byNumber),
        liberos: all.filter(p => p.libero).sort(byNumber),
        bench: sortBench(((key === 'home' ? data?.match?.bench_home : data?.match?.bench_away) || []).filter(b => b.firstName || b.lastName || b.dob)),
        positions: positionsByNumber(lineup),
        serving: hasLineup(lineup) && servingTeam === key,
        sanctions: teamSanctionSummary(events, key),
        gameCaptain: gameCaptainOnCourt(all, lineup, key === 'home' ? data?.match?.homeCourtCaptain : data?.match?.awayCourtCaptain),
        status: player => playerPlayStatus(events, key, player, setIndex)
      }
    }
    return { home: build('home'), away: build('away') }
  }, [data, events, setIndex, lineups, servingTeam, t])

  const { home, away } = teams
  const maxPlayers = Math.max(home.players.length, away.players.length)
  const maxLiberos = Math.max(home.liberos.length, away.liberos.length)
  const maxBench = Math.max(home.bench.length, away.bench.length)
  const officials = data?.match?.officials || []

  return (
    <div className="roster-panel">
      <div className="roster-tables">
        {[home, away].map(team => (
          <div className="roster-table-wrapper" key={`players-${team.key}`} data-team={team.key}>
            <Section title={<>{team.name} {t('scoreboard.players')}</>} action={<TeamSanctionsLine entries={team.sanctions.team} />} />
            <PlayerTable team={team} rows={pad(team.players, maxPlayers)} showPos={showPos} kind="player" />
          </div>
        ))}
      </div>

      {maxLiberos > 0 && (
        <div className="roster-tables" style={{ marginTop: 24 }}>
          {[home, away].map(team => (
            <div className="roster-table-wrapper" key={`liberos-${team.key}`}>
              <Section title={<>{team.name} {t('scoreboard.liberos')}</>} />
              <PlayerTable team={team} rows={pad(team.liberos, maxLiberos)} showPos={showPos} kind="libero" />
            </div>
          ))}
        </div>
      )}

      <div className="bench-officials-section" style={{ marginTop: 32, paddingTop: 24, borderTop: '1px solid var(--border)' }}>
        <div className="roster-tables">
          {[home, away].map(team => (
            <div className="roster-table-wrapper" key={`bench-${team.key}`}>
              <Section title={<>{team.name} {t('scoreboard.benchOfficials')}</>} />
              <BenchTable team={team} rows={pad(team.bench, maxBench)} emptyAll={maxBench === 0} />
            </div>
          ))}
        </div>
      </div>

      {officials.length > 0 && (
        <div className="officials-section" style={{ marginTop: 32, paddingTop: 24, borderTop: '1px solid var(--border)' }}>
          <Section title="Match officials" />
          <table className="roster-table">
            <thead>
              <tr>
                <th>Role</th>
                <th>Name</th>
                <th>Country</th>
                <th>DOB</th>
              </tr>
            </thead>
            <tbody>
              {officials.map((official, idx) => (
                <tr key={idx}>
                  <td style={{ textTransform: 'capitalize', fontWeight: 500 }}>{official.role || '—'}</td>
                  <td>{official.lastName || ''} {official.firstName || ''}</td>
                  <td>{official.country || '—'}</td>
                  <td>{official.dob || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
