import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeftRight, X } from 'lucide-react'
import { Button } from '../../ui/Button.jsx'
import { CardGlyph, cardOfSanctionType } from './SanctionCards.jsx'
import { SCORESHEET_BAR_PX } from './RefereeScoresheet.jsx'

/** The libero mark of a roster player: 'L1', 'L2', 'L' (one libero) or null. */
function liberoMark(player, liberoCount) {
  const l = player?.libero
  if (l !== 'libero1' && l !== 'libero2') return null
  return liberoCount === 1 ? 'L' : (l === 'libero1' ? 'L1' : 'L2')
}

const nameOf = (p) => [p?.lastName, p?.firstName].filter(Boolean).join(' ').trim() || p?.name || ''

/** Official roles as on the paper form: C, AC1, AC2, P, M. */
const ROLE_CODE = {
  coach: 'C',
  'assistant coach 1': 'AC1',
  'assistant coach 2': 'AC2',
  physiotherapist: 'P',
  medic: 'M',
  doctor: 'M'
}
const roleCode = (role) => ROLE_CODE[String(role || '').trim().toLowerCase()] || (role ? String(role).slice(0, 3) : '')

/**
 * One team's roster from the relay bundle (the referee tablet's 'full'
 * bundle): players by shirt number with captain, libero and the cards of the
 * match, then the team officials. Pure, for the view and its tests.
 * @param {object} bundle
 * @param {'home'|'away'} team
 */
export function rosterOfTeam(bundle, team) {
  const m = bundle?.match || {}
  const teamRow = (team === 'home' ? bundle?.homeTeam : bundle?.awayTeam) || {}
  const players = (team === 'home' ? bundle?.homePlayers : bundle?.awayPlayers) || []
  const bench = (team === 'home' ? m.bench_home : m.bench_away) || []
  const letter = m.coinTossTeamA ? (m.coinTossTeamA === team ? 'A' : 'B') : null
  const valid = players.filter((p) => p && typeof p === 'object' && p.number != null && p.number !== '')
  const liberoCount = valid.filter((p) => p.libero === 'libero1' || p.libero === 'libero2').length
  const sanctions = (Array.isArray(bundle?.events) ? bundle.events : [])
    .filter((e) => e?.type === 'sanction' && e.payload?.team === team && e.payload?.playerNumber != null)
  return {
    team,
    letter,
    name: (typeof teamRow === 'string' ? teamRow : teamRow.name) || '',
    shortName: teamRow.shortName || (team === 'home' ? m.homeShortName : m.awayShortName) || '',
    players: valid
      .map((p) => ({
        number: Number(p.number),
        name: nameOf(p),
        captain: p.isCaptain === true || p.captain === true,
        libero: liberoMark(p, liberoCount),
        cards: sanctions.filter((e) => String(e.payload.playerNumber) === String(p.number)).map((e) => e.payload.type)
      }))
      .sort((a, b) => a.number - b.number),
    officials: bench
      .filter((b) => b && (b.firstName || b.lastName))
      .map((b) => ({ role: roleCode(b.role), name: nameOf(b) }))
  }
}

/**
 * The referee tablet's rosters, one team at a time, to check them against the
 * players on court and the teams' licences: shirt numbers, names, captain,
 * liberos, the cards of the match and the officials. Read only, live from the
 * bundle. A button switches the team; Close (or Escape) goes back.
 *
 * @param {object} props
 * @param {object} props.bundle the last 'full' relay bundle
 * @param {() => void} props.onClose
 */
export default function RefereeRosters({ bundle, onClose }) {
  const { t } = useTranslation()
  // Team A first (the coin toss's left team), home before the coin toss
  const first = bundle?.match?.coinTossTeamA === 'away' ? 'away' : 'home'
  const [team, setTeam] = useState(first)
  const roster = useMemo(() => rosterOfTeam(bundle, team), [bundle, team])
  const other = useMemo(() => rosterOfTeam(bundle, team === 'home' ? 'away' : 'home'), [bundle, team])
  const closeRef = useRef(null)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    closeRef.current?.focus({ preventScroll: true })
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const teamLabel = (r) => [r.letter, r.shortName || r.name].filter(Boolean).join(' · ')

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="referee-rosters-title"
      data-testid="referee-rosters-view"
      className="no-print"
      style={{ position: 'fixed', inset: 0, zIndex: 990, display: 'flex', flexDirection: 'column', background: 'var(--bg, #f5f5f4)' }}
    >
      <div
        className="ov-kit flex shrink-0 items-center gap-3 border-b border-stone-200/70 bg-white"
        style={{ height: SCORESHEET_BAR_PX, padding: '0 max(12px, env(safe-area-inset-right, 0px)) 0 max(12px, env(safe-area-inset-left, 0px))' }}
      >
        <Button ref={closeRef} variant="dark" size="xl" icon={X} onClick={onClose} data-testid="referee-rosters-close" className="shrink-0">
          {t('refereeDashboard.rosters.close', 'Close')}
        </Button>
        <h2 id="referee-rosters-title" className="min-w-0 flex-1 truncate text-sm font-semibold text-stone-900">
          {t('refereeDashboard.rosters.title', 'Rosters')}
        </h2>
        <Button variant="secondary" size="xl" icon={ArrowLeftRight} onClick={() => setTeam(team === 'home' ? 'away' : 'home')} data-testid="referee-rosters-switch" className="shrink-0">
          {teamLabel(other) || t('refereeDashboard.rosters.otherTeam', 'Other team')}
        </Button>
      </div>

      <div className="ov-kit min-h-0 flex-1 overflow-y-auto" style={{ padding: '16px max(16px, env(safe-area-inset-right, 0px)) 24px max(16px, env(safe-area-inset-left, 0px))' }}>
        <div className="mx-auto grid max-w-2xl gap-4">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="min-w-0 truncate text-xl font-bold text-stone-900" data-testid="referee-rosters-team">
              {roster.letter && <span className="mr-2 text-stone-500">{roster.letter}</span>}
              {roster.name}
            </h3>
            <span className="shrink-0 text-sm tabular-nums text-stone-500">
              {t('refereeDashboard.rosters.count', '{{players}} players', { players: roster.players.length })}
            </span>
          </div>

          <ul className="divide-y divide-stone-200/70 overflow-hidden rounded-xl border border-stone-200/70 bg-white" data-testid="referee-rosters-players">
            {roster.players.length === 0 && (
              <li className="px-4 py-3 text-sm text-stone-500">{t('refereeDashboard.rosters.empty', 'No roster yet')}</li>
            )}
            {roster.players.map((p) => (
              <li key={p.number} className="flex min-h-14 items-center gap-3 px-4 py-2" data-testid="referee-rosters-player">
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg font-bold tabular-nums"
                  style={p.captain
                    ? { border: '2px solid var(--text, #1c1917)', color: 'var(--text, #1c1917)' }
                    : { background: 'var(--surface-sunken, #f5f5f4)', color: 'var(--text, #1c1917)' }}
                  title={p.captain ? t('refereeDashboard.rosters.captain', 'Captain') : undefined}
                >
                  {p.number}
                </span>
                <span className="min-w-0 flex-1 truncate text-base text-stone-900">{p.name}</span>
                {p.captain && <span className="shrink-0 rounded-md border border-emerald-400 px-1.5 text-xs font-bold text-emerald-700">C</span>}
                {p.libero && <span className="shrink-0 rounded-md bg-blue-100 px-1.5 text-xs font-bold text-blue-700">{p.libero}</span>}
                {p.cards.length > 0 && (
                  <span className="flex shrink-0 items-center gap-1" aria-label={p.cards.join(', ')}>
                    {p.cards.map((c, i) => { const kind = cardOfSanctionType(c)?.kind; return kind ? <CardGlyph key={i} kind={kind} height="20px" /> : null })}
                  </span>
                )}
              </li>
            ))}
          </ul>

          <div className="grid gap-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">{t('refereeDashboard.rosters.officials', 'Team officials')}</h4>
            <ul className="divide-y divide-stone-200/70 overflow-hidden rounded-xl border border-stone-200/70 bg-white">
              {roster.officials.length === 0 && (
                <li className="px-4 py-3 text-sm text-stone-500">{t('refereeDashboard.rosters.noOfficials', 'No officials entered')}</li>
              )}
              {roster.officials.map((o, i) => (
                <li key={i} className="flex min-h-12 items-center gap-3 px-4 py-2">
                  <span className="w-10 shrink-0 text-sm font-bold text-stone-600">{o.role}</span>
                  <span className="min-w-0 flex-1 truncate text-base text-stone-900">{o.name}</span>
                </li>
              ))}
            </ul>
          </div>

          <Button variant="secondary" size="xl" block icon={ArrowLeftRight} onClick={() => setTeam(team === 'home' ? 'away' : 'home')} data-testid="referee-rosters-switch-bottom">
            {t('refereeDashboard.rosters.show', 'Show {{team}}', { team: teamLabel(other) || t('refereeDashboard.rosters.otherTeam', 'Other team') })}
          </Button>
        </div>
      </div>
    </div>
  )
}
