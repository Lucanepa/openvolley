import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Undo2, Menu } from 'lucide-react'
import { ActionSheet } from '../../ui/Modal.jsx'
import { COURT_SURFACE, HEADER_SURFACE, normaliseColour, teamBoxStyle, teamTextPaint } from '../../utils/teamColours'
import { COURT_CELLS, PHONE_COUNTER_HEIGHT_PX, PHONE_COURT_MIN_PX, PHONE_RECENT_MIN_PX, PHONE_SQUARE_MIN_PX, PHONE_SQUARE_RESERVE_PX, POSITIONS, officialRoleShort, recentLinesFor, tintOf } from './phoneLayout'

/**
 * The scoring screen on a phone held upright (owner-approved mockup, 390x844).
 * A VIEW only: the Scoreboard feeds it the match state it already computes and
 * its own handlers, so every button opens the same dialog / runs the same
 * action as the desktop layout (point, start rally, undo, time-out,
 * substitution, libero, sanctions, replay, decision change, rosters,
 * scoresheet, remarks, the match menu). No scoring rule is decided here.
 *
 * Top to bottom: header (set, teams, undo, menu), the two score cards, a
 * stylised 2:1 court with the shirt numbers in their rotation positions and
 * the ball next to the server, the last three actions, the team actions
 * (time-outs and substitutions, each above its team's point button), the two
 * square point buttons (or Start rally / the time-out and interval countdowns
 * / the deciding-set setup, as the desktop centre column shows them), and a
 * grid of the other actions.
 *
 * Teams come as `left` / `right`: their court sides, so the cards, the court,
 * the team actions and the point buttons all line up with the court.
 *
 * @param {object} props
 * @param {number|string} props.setNumber the set as shown (bo3 decider "3")
 * @param {{ left: object, right: object }} props.teams see TeamVM below
 * @param {'left'|'right'|null} props.serving
 * @param {{ status: 'idle'|'in_play', isFirstRally: boolean, startDisabled: boolean, canReplayRally: boolean, isRallyReplayed: boolean }} props.rally
 * @param {null|{ kind: 'timeout', teamName: string, countdown: number, total: number }
 *   |{ kind: 'interval', countdown: number, total: number }
 *   |{ kind: 'set5', countdown?: number, total?: number, confirmLabel: string }} props.centre
 *   (each countdown also comes as `countdownText`, formatted as the desktop shows it)
 * @param {Array<{ id: any, text: string, time?: string|null }>} props.recent newest first
 * @param {boolean} props.canUndo
 * @param {string} [props.scoreFont] CSS font family of scores and countdowns
 * @param {{ timeouts: number, subs: number }} [props.limits] time-outs and substitutions per set
 * @param {object} props.actions the Scoreboard's handlers (see Scoreboard.jsx)
 *
 * TeamVM: { side, teamKey, label ('A'|'B'), name, shortName, color, setsWon,
 *   points, timeouts, subs, lineupSet, lineupOptional (easy match),
 *   liberoPaint ({ background, color, textShadow?, ring } | null),
 *   court: [{ position, number, isLibero, isCaptain, replaced }] (isCaptain:
 *   the team captain or the acting game captain; replaced: the player a
 *   substitute or the libero came in for),
 *   liberos: [{ number, libero, unable, onCourt, position }], benchPlayers:
 *   [{ number }], officials: [{ role }], improperRequestDone, delayWarned,
 *   easy, formalWarned, needsRedesignation }
 */
export default function PhoneScoreboard({ setNumber, teams, serving, rally, centre, recent, canUndo, scoreFont = 'inherit', limits = DEFAULT_LIMITS, actions }) {
  const { t } = useTranslation()
  // The phone's own pickers: { kind: 'sub', side, out?: { position, number } } | { kind: 'sanction' } | { kind: 'libero' }
  const [sheet, setSheet] = useState(null)
  const { left, right } = teams
  const idle = rally.status === 'idle' && !rally.isRallyReplayed
  // The last actions fill the height left over: as many whole lines as fit
  // (three at the lowest), never a line cut in half
  const recentRef = useRef(null)
  const [recentLines, setRecentLines] = useState(3)
  useLayoutEffect(() => {
    const box = recentRef.current
    if (!box || typeof ResizeObserver === 'undefined') return
    const measure = () => setRecentLines(recentLinesFor(box.getBoundingClientRect().height))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    return () => observer.disconnect()
  }, [])
  const inPlay = rally.status === 'in_play'

  const paintOf = (team) => {
    const colour = normaliseColour(team.color)
    const ink = teamTextPaint(colour, HEADER_SURFACE)?.color || 'var(--ov-text)'
    const courtInk = teamTextPaint(colour, COURT_SURFACE)?.color || ink
    return {
      ink,
      courtInk,
      tint: tintOf(colour, 0.1) || 'var(--ov-card)',
      soft: tintOf(colour, 0.06) || 'var(--ov-sunken)',
      fill: teamBoxStyle(colour, { fallback: team.side === 'left' ? '#ef4444' : '#3b82f6' })
    }
  }
  const paint = { left: paintOf(left), right: paintOf(right) }
  const teamTitle = (team) => `${team.label} · ${team.shortName || team.name}`

  // ---- header -------------------------------------------------------------
  const header = (
    <header style={{ flex: 'none', height: 52, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px 0 14px', borderBottom: '1px solid var(--ov-hairline)', background: 'var(--ov-card)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ov-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {t('scoreboard.phone.setInfo', { set: setNumber, left: left.setsWon, right: right.setsWon })}
        </span>
        <span style={{ fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {left.name} – {right.name}
        </span>
      </div>
      <IconSquare label={t('scoreboard.buttons.undo')} onClick={() => actions.undo()} disabled={!canUndo}>
        <Undo2 size={20} aria-hidden="true" />
      </IconSquare>
      <IconSquare label={t('scoreboard.menu.menu')} onClick={() => actions.menu()}>
        <Menu size={20} aria-hidden="true" />
      </IconSquare>
    </header>
  )

  // ---- score cards --------------------------------------------------------
  const scoreCard = (team) => {
    const isServing = serving === team.side
    const p = paint[team.side]
    // Beside a two-digit score a 360px card leaves about 79px: the score is a
    // touch smaller on a narrow phone, the pill tight, and what still does not
    // fit is clipped rather than running into the score
    const line = { maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
    // The server's number on the serve pill: the player in position I of the
    // serving team, as the court shows it (a libero never serves there: the
    // screen keeps it out of I while its team serves). The word may be cut
    // short on a narrow card, the number never is.
    const serverNumber = isServing ? (team.court || []).find(pl => pl.position === 'I')?.number : null
    const server = serverNumber !== null && serverNumber !== undefined && serverNumber !== '' ? String(serverNumber) : null
    const info = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, overflow: 'hidden', alignItems: team.side === 'left' ? 'flex-start' : 'flex-end' }}>
        <span style={{ ...line, fontSize: 12, fontWeight: 700, color: p.ink }}>{teamTitle(team)}</span>
        <span
          aria-hidden={!isServing}
          data-testid={isServing ? 'phone-serve-pill' : undefined}
          aria-label={isServing && server ? t('scoreboard.phone.serveNumber', { number: server, defaultValue: 'Serve #{{number}}' }) : undefined}
          style={{ display: 'inline-flex', gap: 3, maxWidth: '100%', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', visibility: isServing ? 'visible' : 'hidden', boxSizing: 'border-box', padding: '2px 5px', borderRadius: 999, background: 'var(--ov-text)', color: 'var(--ov-card)', fontSize: 10, fontWeight: 800, letterSpacing: '0.02em', lineHeight: 1.3 }}
        >
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t('scoreboard.labels.serveLabel')}</span>
          {server && <span data-testid="phone-server-number" style={{ flex: 'none', fontVariantNumeric: 'tabular-nums' }}>#{server}</span>}
        </span>
        <span style={{ ...line, fontSize: 11, fontWeight: 600, color: 'var(--ov-text-muted)' }}>
          {t('scoreboard.phone.setsWon', { count: team.setsWon })}
        </span>
      </div>
    )
    const score = (
      <span data-testid={`phone-score-${team.side}`} style={{ flex: 'none', fontSize: 'clamp(40px, 12cqw, 52px)', lineHeight: 1, letterSpacing: '-0.02em', fontWeight: 800, fontVariantNumeric: 'tabular-nums', fontFamily: scoreFont }}>
        {team.points}
      </span>
    )
    return (
      <div key={team.side} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, padding: '6px 10px', minWidth: 0, borderRadius: 14, background: isServing ? p.tint : 'var(--ov-card)', border: '1px solid var(--ov-hairline)' }}>
        {team.side === 'left' ? <>{info}{score}</> : <>{score}{info}</>}
      </div>
    )
  }

  // ---- court --------------------------------------------------------------
  const courtHalf = (team) => {
    const bySide = Object.fromEntries((team.court || []).map(pl => [pl.position, pl]))
    const servesHere = serving === team.side
    const p = paint[team.side]
    const needsLineup = rally.status === 'idle' && rally.isFirstRally && !team.lineupSet
    // The libero's number in its own shirt colour, shaded where that colour
    // does not read on the court floor (a white or yellow libero shirt)
    const liberoInk = team.liberoPaint ? (teamTextPaint(team.liberoPaint.background, COURT_SURFACE)?.color || p.courtInk) : p.courtInk
    return (
      <div
        key={team.side}
        data-testid={`phone-court-${team.side}`}
        style={{
          position: 'relative',
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gridTemplateRows: 'repeat(3, minmax(0, 1fr))',
          gap: 2,
          padding: team.side === 'left' ? '6px 12px 6px 8px' : '6px 8px 6px 12px',
          borderRight: team.side === 'left' ? '4px solid var(--ov-text)' : undefined
        }}
      >
        {COURT_CELLS[team.side].map(position => {
          const pl = bySide[position]
          const number = pl && pl.number !== '' && pl.number !== undefined && pl.number !== null ? pl.number : null
          const hasBall = servesHere && position === 'I'
          // Marks as on the paper sheet: the captain's number circled (team
          // captain, or the acting game captain: a thin ring in the number's
          // colour, sized to it); small beside the number, the libero's L at
          // its top left and, at its foot bottom right, the number of the
          // player a substitute or the libero came in for. The ball hangs
          // halfway up on the outer side, level with the top of the number
          // when a mark sits under it there; the marks and the ball stand off
          // further round a ring.
          const isLibero = number !== null && !!pl?.isLibero
          const captain = number !== null && !!pl?.isCaptain
          const replaced = number !== null && hasValue(pl?.replaced) ? String(pl.replaced) : null
          const marks = [
            captain && t('scoreboard.phone.markCaptain', 'captain'),
            isLibero && t('scoreboard.phone.markLibero', 'libero'),
            replaced && t('scoreboard.phone.markReplaced', { number: replaced, defaultValue: 'in for {{number}}' })
          ].filter(Boolean)
          const markUnderBall = team.side === 'right' && !!replaced
          // room for the ring between the number and what hangs beside it:
          // CAPTAIN_RING_PAD round two digits, more round one (the ring stays
          // a circle, wider than the digit; a digit is about 0.6em)
          const beside = captain ? Math.max(CAPTAIN_RING_PAD, Math.ceil((CAPTAIN_RING_SIZE - 0.6 * 28 * String(number).length) / 2)) + 1 : 1
          const label = number !== null ? [t('scoreboard.phone.courtPlayer', { number, team: team.label }), ...marks].join(', ') : undefined
          return (
            <button
              key={position}
              type="button"
              data-court-cell={position}
              aria-label={label}
              disabled={number === null}
              onClick={(e) => number !== null && actions.playerClick(team.teamKey, position, number, e)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 0, minHeight: 0, background: 'transparent', borderRadius: 8, cursor: number !== null ? 'pointer' : 'default' }}
            >
              {/* The ball and the marks hang outside the number, so every number keeps its place */}
              <span data-testid={isLibero ? `phone-libero-${team.side}` : undefined} style={{ position: 'relative', fontSize: 28, lineHeight: 1, fontWeight: 800, color: isLibero ? liberoInk : p.courtInk, fontVariantNumeric: 'tabular-nums' }}>
                {number ?? '–'}
                {captain && <span aria-hidden="true" data-testid="phone-mark-captain" style={{ ...captainRing, borderColor: isLibero ? liberoInk : p.courtInk }} />}
                {isLibero && <span aria-hidden="true" data-testid="phone-mark-libero" style={{ ...courtMark, bottom: undefined, top: -3, right: '100%', marginRight: beside, color: liberoInk }}>L</span>}
                {replaced && <span aria-hidden="true" data-testid="phone-mark-replaced" style={{ ...courtMark, left: '100%', marginLeft: beside, color: 'var(--ov-text-secondary)' }}>{replaced}</span>}
                {hasBall && (
                  <span data-testid="phone-serve-ball" aria-label={t('scoreboard.labels.serveLabel')} style={{ position: 'absolute', ...(markUnderBall ? { top: 0 } : { top: '50%', transform: 'translateY(-50%)' }), ...(team.side === 'left' ? { right: '100%', marginRight: beside + 4 } : { left: '100%', marginLeft: beside + 4 }), width: 12, height: 12, borderRadius: '50%', background: '#facc15', border: '2px solid #1c1917' }} />
                )}
              </span>
            </button>
          )
        })}
        {needsLineup && (
          <button
            type="button"
            onClick={() => actions.openLineup(team.side)}
            style={{ position: 'absolute', inset: 6, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, borderRadius: 12, background: 'var(--ov-success)', color: '#ffffff', fontSize: 18, fontWeight: 800 }}
          >
            <span>{t('scoreboard.lineup', 'Line-up')}</span>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{team.lineupOptional ? t('scoreboard.phone.lineupOptional', { team: teamTitle(team) }) : teamTitle(team)}</span>
          </button>
        )}
      </div>
    )
  }

  // ---- team actions -------------------------------------------------------
  // As the desktop counters: open between rallies, also while a time-out or
  // the interval runs (a consecutive time-out, a substitution right after a
  // time-out), and also with all used (the count reads red): a further
  // request is an improper request (FIVB 15.11.1.4, 16.1.3), which the
  // scoreboard's handlers record
  const toDisabled = () => !idle
  const subDisabled = (team) => !idle || !team.lineupSet
  // Only the count taken, as the desktop counters: red once the last one is
  // taken, amber at the substitution before the last (the 5th of 6)
  const countState = (taken, max, { warnBefore = false } = {}) => {
    if (taken >= max) return 'max'
    if (warnBefore && max > 1 && taken === max - 1) return 'warn'
    return null
  }
  const COUNT_INK = { max: 'var(--ov-danger-text)', warn: 'var(--ov-warning-ink)' }
  const counter = (team, { label, value, state = null, disabled, onClick, testId }) => {
    const p = paint[team.side]
    return (
      <button
        type="button"
        data-testid={testId}
        onClick={onClick}
        disabled={disabled}
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, minHeight: PHONE_COUNTER_HEIGHT_PX, minWidth: 0,
          // 6px above and below: at Android's larger text (1.3) the label
          // touched the top border with none; at 1.0 the content (37px)
          // still fits the 56px, so the tiles only grow at large text
          padding: '6px 4px',
          borderRadius: 14,
          border: `2px solid ${disabled ? 'var(--ov-hairline-strong)' : p.ink}`,
          background: disabled ? 'var(--ov-sunken-strong)' : p.soft,
          color: disabled ? 'var(--ov-text-faint)' : 'var(--ov-text)',
          cursor: disabled ? 'default' : 'pointer'
        }}
      >
        {/* One line, small beside the count (it was 11px: the owner,
            2026-10-21); a label longer than the button ("TEMPS MORT") goes
            on two lines rather than out of it */}
        <span style={{ maxWidth: '100%', fontSize: 9, lineHeight: 1.15, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', textAlign: 'center', textWrap: 'balance', overflowWrap: 'anywhere', color: disabled ? 'var(--ov-text-faint)' : p.ink }}>{label}</span>
        <span data-count-state={state || undefined} style={{ fontSize: 22, lineHeight: 1, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: state ? COUNT_INK[state] : undefined }}>{value}</span>
      </button>
    )
  }
  const teamActions = (team) => (
    <div key={team.side} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 }}>
      {counter(team, { label: t('scoreboard.phone.timeOut'), value: team.timeouts, state: countState(team.timeouts, limits.timeouts), disabled: toDisabled(team), onClick: () => actions.timeout(team.side), testId: `phone-timeout-${team.side}` })}
      {counter(team, { label: t('scoreboard.labels.sub'), value: team.subs, state: countState(team.subs, limits.subs, { warnBefore: true }), disabled: subDisabled(team), onClick: () => setSheet({ kind: 'sub', side: team.side }), testId: `phone-sub-${team.side}` })}
    </div>
  )

  // ---- centre: point buttons, start rally, countdowns, set-5 setup ---------
  const bigButton = { width: '100%', minHeight: 52, borderRadius: 14, fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }
  const darkButton = { ...bigButton, background: 'var(--ov-selected)', color: 'var(--ov-on-dark)' }
  const outlineButton = { ...bigButton, background: 'var(--ov-card)', color: 'var(--ov-text)', border: '1px solid var(--ov-hairline-strong)' }
  const countdown = ({ countdown: value, countdownText, total }, warnAt, size = 48) => (
    <>
      <div data-testid="phone-countdown" style={{ flex: 'none', fontSize: size, lineHeight: 1, fontWeight: 800, fontFamily: scoreFont, fontVariantNumeric: 'tabular-nums', color: value <= warnAt ? 'var(--danger)' : 'var(--ov-text)' }}>{countdownText ?? value}</div>
      <div style={{ flex: 'none', width: '70%', height: 6, borderRadius: 3, overflow: 'hidden', background: 'var(--ov-hairline)' }}>
        <div style={{ width: `${total > 0 ? Math.max(0, Math.min(1, value / total)) * 100 : 0}%`, height: '100%', marginLeft: 'auto', borderRadius: 3, background: value <= warnAt ? 'var(--danger)' : 'var(--accent)', transition: 'width 1s linear' }} />
      </div>
    </>
  )
  let overlay = null
  // The time-out, the interval and the deciding set's setup are each about
  // 131px high, under the point buttons of a 375x740 view (158px), so they
  // never make the view scroll where the point buttons are square; on a
  // shorter screen their row grows to them (the view scrolls) rather than
  // them running over the rest. At 154px, and 172px when "Time-out: <long
  // team name>" took two lines, they scrolled on a 375x740 phone (2026-10-20).
  const countdownCard = { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, flex: 1, padding: 8, boxSizing: 'border-box', borderRadius: 16, background: 'var(--ov-card)', border: '1px solid var(--ov-hairline)' }
  const cardButton = { ...outlineButton, minHeight: 40, width: 'auto', padding: '0 24px' }
  // One line, cut short: a second line pushed the card past the point buttons
  const cardTitle = { maxWidth: '100%', fontSize: 14, lineHeight: 1.2, fontWeight: 700, color: 'var(--ov-text-secondary)', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
  if (centre?.kind === 'timeout') {
    overlay = (
      <div style={countdownCard}>
        <div style={cardTitle} title={t('scoreboard.phone.timeoutRunning', { team: centre.teamName })}>{t('scoreboard.phone.timeoutRunning', { team: centre.teamName })}</div>
        {countdown(centre, 10, 38)}
        <button type="button" style={cardButton} onClick={() => actions.stopTimeout()}>{t('scoreboard.buttons.stopTimeout')}</button>
      </div>
    )
  } else if (centre?.kind === 'set5') {
    // The two switches side by side, as the two point buttons they stand for
    const switchButton = { ...darkButton, minHeight: 44, padding: '2px 6px', fontSize: 14, lineHeight: 1.15, textAlign: 'center', gap: 6 }
    overlay = (
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8, flex: 1 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
          <button type="button" style={switchButton} onClick={() => actions.set5SwitchSides()}><span aria-hidden="true">⇄</span>{t('scoreboard.buttons.switchSides')}</button>
          <button type="button" style={switchButton} onClick={() => actions.set5SwitchServe()}>{t('scoreboard.buttons.switchServe')}</button>
        </div>
        <button type="button" style={{ ...bigButton, background: 'var(--ov-success)', color: '#ffffff' }} onClick={() => actions.set5Confirm()}>{centre.confirmLabel}</button>
        {typeof centre.countdown === 'number' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>{countdown(centre, 30, 32)}</div>
        )}
      </div>
    )
  } else if (centre?.kind === 'interval') {
    overlay = (
      <div style={countdownCard}>
        <div style={cardTitle}>{t('scoreboard.phone.interval')}</div>
        {countdown(centre, 30, 38)}
        <button type="button" style={cardButton} onClick={() => actions.endInterval()}>{t('scoreboard.buttons.endSetInterval')}</button>
      </div>
    )
  } else if (!inPlay) {
    overlay = (
      <button
        type="button"
        data-help-id="scoreboard-start-rally"
        disabled={rally.startDisabled}
        // No click event in: the screen's handler asks first when a point was
        // just awarded (accidental rally start check), as the desktop does
        onClick={() => actions.startRally()}
        style={{ ...bigButton, flex: 1, fontSize: 24, fontWeight: 800, borderRadius: 16, background: rally.startDisabled ? 'var(--ov-sunken-strong)' : 'var(--ov-selected)', color: rally.startDisabled ? 'var(--ov-text-faint)' : 'var(--ov-on-dark)' }}
      >
        {rally.isFirstRally ? t('scoreboard.buttons.startSet') : t('scoreboard.buttons.startRally')}
      </button>
    )
  }
  // The point buttons: squares as wide as their column (.phone-square in
  // styles.css). On a screen too short for the whole layout (a browser's
  // address and tool bars, the Android app's system bars) they get lower,
  // not narrower, then the court gets lower, so they and the action grid stay
  // on screen without scrolling; the root is the size container that
  // measures what is left (phoneLayout.js has the heights).
  const squareClass = 'phone-square'
  const pointButton = (team) => (
    <button
      key={team.side}
      type="button"
      data-help-id={`scoreboard-point-${team.side}`}
      aria-label={t('scoreboard.buttons.pointTeam', { team: team.label })}
      onClick={() => actions.point(team.side)}
      className={squareClass}
      style={{ minWidth: 0, borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', ...paint[team.side].fill }}
    >
      {/* "Point A", no "+1": a point is always one */}
      <span aria-hidden="true" style={{ fontSize: 24, fontWeight: 800, lineHeight: 1.1 }}>{t('scoreboard.buttons.pointTeam', { team: team.label })}</span>
    </button>
  )

  // ---- the other actions --------------------------------------------------
  const gridButton = (key, label, onClick, { disabled = false, span = 1, muted = false, small = false } = {}) => (
    <button
      key={key}
      type="button"
      data-testid={`phone-action-${key}`}
      onClick={onClick}
      disabled={disabled}
      style={{
        height: 44, minWidth: 0, padding: '0 4px', gridColumn: span > 1 ? `span ${span}` : undefined,
        borderRadius: 12, border: '1px solid var(--ov-hairline-strong)',
        background: disabled ? 'var(--ov-sunken-strong)' : muted ? 'var(--ov-sunken)' : 'var(--ov-card)',
        color: disabled ? 'var(--ov-text-faint)' : 'var(--ov-text)',
        // Long words break only at their soft hyphens (Score-sheet, Wieder-holen),
        // not anywhere mid-word; overflowWrap is the last resort
        fontSize: small ? 10.5 : 12, lineHeight: 1.15, fontWeight: 600, overflow: 'hidden', overflowWrap: 'anywhere', hyphens: 'manual'
      }}
    >
      {label}
    </button>
  )

  return (
    <div
      className="ov-kit phone-scoreboard"
      data-testid="phone-scoreboard"
      style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, height: '100%', width: '100%', maxWidth: 600, margin: '0 auto', containerType: 'size', '--phone-square-reserve': `${PHONE_SQUARE_RESERVE_PX}px`, '--phone-square-min': `${PHONE_SQUARE_MIN_PX}px`, '--phone-court-min': `${PHONE_COURT_MIN_PX}px`, overflowY: 'auto', overflowX: 'hidden', background: 'var(--ov-page-top)', color: 'var(--ov-text)', fontFamily: 'var(--font-sans)' }}
    >
      {header}

      <section aria-label={t('scoreboard.phone.score')} style={{ flex: 'none', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, padding: '10px 12px 6px' }}>
        {scoreCard(left)}
        {scoreCard(right)}
      </section>

      <section aria-label={t('scoreboard.phone.court')} style={{ flex: 'none', padding: '6px 12px 4px' }}>
        {/* 2:1, lower on a short screen (.phone-court in styles.css) */}
        <div className="phone-court" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', borderRadius: 16, background: COURT_SURFACE, border: '2px solid var(--ov-hairline-strong)', overflow: 'hidden' }}>
          {courtHalf(left)}
          {courtHalf(right)}
        </div>
      </section>

      {/* Grows into the height left over (from nothing: what it shows never
          sizes it): the screen is filled, no gap */}
      <section ref={recentRef} aria-label={t('scoreboard.phone.recentActions')} data-testid="phone-recent" style={{ flex: '1 1 0px', margin: '4px 14px 8px', padding: '6px 10px', minHeight: PHONE_RECENT_MIN_PX, boxSizing: 'border-box', overflow: 'hidden', borderRadius: 10, background: 'var(--ov-sunken-strong)', display: 'flex', flexDirection: 'column', gap: 3 }}>
        {recent.length === 0 ? (
          <span style={{ fontSize: 12, color: 'var(--ov-text-muted)' }}>{t('scoreboard.phone.noActions')}</span>
        ) : recent.slice(0, recentLines).map((r, i) => (
          // the time first, small and muted, so the action's text keeps the line
          <span key={r.id} title={r.time ? `${r.time} ${r.text}` : r.text} style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0, fontSize: 12, lineHeight: '15px', color: i === 0 ? 'var(--ov-text)' : 'var(--ov-text-muted)', fontWeight: i === 0 ? 700 : 500 }}>
            {r.time && <span data-testid="phone-recent-time" style={{ flex: 'none', fontSize: 10, fontWeight: 600, color: 'var(--ov-text-muted)', fontVariantNumeric: 'tabular-nums' }}>{r.time}</span>}
            <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.text}</span>
          </span>
        ))}
      </section>

      <section aria-label={t('scoreboard.phone.teamActions')} style={{ flex: 'none', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, padding: '0 12px 8px' }}>
        {teamActions(left)}
        {teamActions(right)}
      </section>

      <section aria-label={t('scoreboard.phone.pointButtons')} style={{ flex: 'none', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, padding: '0 12px 8px' }}>
        {inPlay && !centre ? (
          <>{pointButton(left)}{pointButton(right)}</>
        ) : (
          <>
            {/* Two square slots keep the height of the point buttons; the
                centre shares their row, in the flow: on a short screen, where
                the point buttons are low, the row grows to the centre's
                height (the view scrolls) rather than a countdown or the
                deciding set's setup running over the actions */}
            <div aria-hidden="true" className={squareClass} style={{ gridRow: 1, gridColumn: 1 }} />
            <div aria-hidden="true" className={squareClass} style={{ gridRow: 1, gridColumn: 2 }} />
            <div data-testid="phone-centre" style={{ gridRow: 1, gridColumn: '1 / -1', minWidth: 0, display: 'flex', flexDirection: 'column' }}>{overlay}</div>
          </>
        )}
      </section>

      <section aria-label={t('scoreboard.phone.moreActions')} style={{ flex: 'none', display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6, padding: '0 12px 14px' }}>
        {gridButton('libero', t('scoreboard.phone.libero'), () => setSheet({ kind: 'libero' }), { disabled: !idle })}
        {gridButton('sanction', t('scoreboard.sanction'), () => setSheet({ kind: 'sanction' }), { disabled: rally.status !== 'idle' })}
        {gridButton('replay', t('scoreboard.phone.replay'), () => actions.replay(), { disabled: !inPlay })}
        {gridButton('decision', t('scoreboard.phone.decision'), () => actions.replay(), { disabled: !(rally.status === 'idle' && rally.canReplayRally), small: true })}
        {gridButton('rosters', t('scoreboard.rosters'), () => actions.rosters(), { muted: true })}
        {gridButton('scoresheet', t('scoreboard.phone.scoresheet'), () => actions.scoresheet(), { muted: true })}
        {gridButton('remarks', t('scoreboard.phone.remarks'), () => actions.remarks(), { muted: true, span: 2 })}
      </section>

      {sheet?.kind === 'sub' && (
        <SubstitutionSheet
          team={teams[sheet.side]}
          ink={paint[sheet.side].ink}
          out={sheet.out}
          onPickOut={(out) => setSheet({ ...sheet, out })}
          onBack={() => setSheet({ kind: 'sub', side: sheet.side })}
          onClose={() => setSheet(null)}
          actions={actions}
          title={t('scoreboard.phone.subTitle', { team: teamTitle(teams[sheet.side]) })}
        />
      )}
      {sheet?.kind === 'sanction' && (
        <ActionSheet open onClose={() => setSheet(null)} title={t('scoreboard.sanction')} closeLabel={t('common.close')} railOffset={false}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, padding: '4px 8px 8px' }}>
            {[left, right].map(team => (
              <SanctionColumn key={team.side} team={team} ink={paint[team.side].ink} title={teamTitle(team)} actions={actions} onDone={() => setSheet(null)} />
            ))}
          </div>
        </ActionSheet>
      )}
      {sheet?.kind === 'libero' && (
        <ActionSheet open onClose={() => setSheet(null)} title={t('scoreboard.phone.libero')} closeLabel={t('common.close')} railOffset={false}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, padding: '4px 8px 8px' }}>
            {[left, right].map(team => (
              <LiberoColumn key={team.side} team={team} ink={paint[team.side].ink} title={teamTitle(team)} actions={actions} onDone={() => setSheet(null)} />
            ))}
          </div>
        </ActionSheet>
      )}
    </div>
  )
}

function IconSquare({ label, onClick, disabled = false, children }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      style={{ flex: 'none', width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 12, border: '1px solid var(--ov-hairline-strong)', background: 'var(--ov-card)', color: disabled ? 'var(--ov-text-faint)' : 'var(--ov-text)', cursor: disabled ? 'default' : 'pointer' }}
    >
      {children}
    </button>
  )
}

// A 44px number chip of the pickers
function Chip({ children, onClick, disabled = false, tone = 'plain', label, testId }) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      style={{
        minHeight: 44, minWidth: 0, padding: '0 6px', borderRadius: 10,
        border: '1px solid var(--ov-hairline-strong)',
        background: disabled ? 'var(--ov-sunken-strong)' : tone === 'soft' ? 'var(--ov-sunken)' : 'var(--ov-card)',
        color: disabled ? 'var(--ov-text-faint)' : 'var(--ov-text)',
        fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
      }}
    >
      {children}
    </button>
  )
}

const chipGrid = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 }

/** Time-outs and substitutions per set (FIVB 15.1, 15.6) unless the Scoreboard says otherwise. */
const DEFAULT_LIMITS = { timeouts: 2, subs: 6 }

const hasValue = (v) => v !== undefined && v !== null && v !== ''

// The captain's ring round the number on the court: a thin circle in the
// number's colour (borderColor, set where it is drawn), as wide as the number plus CAPTAIN_RING_PAD
// each side and never narrower than it is high, so a 1-digit number gets a
// circle and a 2-digit one a short oval
const CAPTAIN_RING_PAD = 9
const CAPTAIN_RING_SIZE = 44
const captainRing = {
  position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
  width: `calc(100% + ${2 * CAPTAIN_RING_PAD}px)`, minWidth: CAPTAIN_RING_SIZE, height: CAPTAIN_RING_SIZE,
  boxSizing: 'border-box', borderWidth: 2, borderStyle: 'solid', borderRadius: 999, pointerEvents: 'none'
}

// A court mark (the replaced player's number at the number's foot, the
// libero's L at its top, set where it is drawn): small
const courtMark = { position: 'absolute', bottom: -3, fontSize: 10, lineHeight: 1, fontWeight: 800, letterSpacing: 0, whiteSpace: 'nowrap', pointerEvents: 'none' }

/**
 * Easy match: a shirt number typed for the player coming in. A number that is
 * no player yet comes in as a new player; one already in the team only when
 * the list offers it (the substitution rules decided there).
 */
function NewNumberField({ candidates, check, onPick }) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const submit = () => {
    const code = check(value)
    if (code === null) { onPick(Number(value), true); return }
    if (code === 'existing') {
      const listed = (candidates || []).find(c => String(c.number) === String(Number(value)))
      if (listed) { onPick(listed.number, false); return }
    }
    setError(({
      invalid: t('scoreboard.easySub.invalid', '1 to 99'),
      onCourt: t('scoreboard.easySub.onCourt', 'On court'),
      libero: t('scoreboard.easySub.libero', 'A libero')
    })[code] || t('scoreboard.easySub.notAllowed', 'Cannot come in'))
  }
  return (
    <form
      data-testid="phone-sub-new"
      style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}
      onSubmit={(e) => { e.preventDefault(); submit() }}
    >
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        aria-label={t('scoreboard.easySub.label', 'New number')}
        placeholder={t('scoreboard.easySub.label', 'New number')}
        value={value}
        onChange={(e) => { setValue(e.target.value.replace(/[^0-9]/g, '').slice(0, 2)); setError('') }}
        style={{
          minHeight: 44, flex: 1, minWidth: 0, padding: '0 10px', borderRadius: 10,
          border: `1px solid ${error ? 'var(--ov-danger-text)' : 'var(--ov-hairline-strong)'}`,
          background: 'var(--ov-card)', color: 'var(--ov-text)', fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums'
        }}
      />
      <button
        type="submit"
        disabled={!value}
        style={{ ...wideButton, width: 'auto', minWidth: 88, fontWeight: 700, background: value ? 'var(--ov-success-soft)' : 'var(--ov-sunken-strong)' }}
      >
        {t('scoreboard.easySub.ok', 'In')}
      </button>
      {error && <p role="alert" style={{ margin: 0, alignSelf: 'center', fontSize: 12, fontWeight: 600, color: 'var(--ov-danger-text)' }}>{error}</p>}
    </form>
  )
}
const sheetNote = { margin: 0, fontSize: 13, color: 'var(--ov-text-secondary)' }
const sheetHead = (ink) => ({ margin: 0, fontSize: 13, fontWeight: 800, color: ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' })
const wideButton = { minHeight: 44, width: '100%', padding: '0 8px', borderRadius: 10, border: '1px solid var(--ov-hairline-strong)', background: 'var(--ov-card)', color: 'var(--ov-text)', fontSize: 13, fontWeight: 600, textAlign: 'center' }

/**
 * Substitution, as the mockup draws it: the player going out (on court),
 * then the player coming in. The candidates are the Scoreboard's
 * getAvailableSubstitutes, and the choice opens the Scoreboard's own
 * substitution confirmation (the court action menu does the same).
 */
function SubstitutionSheet({ team, ink, out, onPickOut, onBack, onClose, actions, title }) {
  const { t } = useTranslation()
  const court = POSITIONS.map(position => (team.court || []).find(pl => pl.position === position)).filter(pl => pl && pl.number !== '' && pl.number !== null && pl.number !== undefined)
  const candidates = out ? actions.substituteCandidates(team.teamKey, out.number) : []
  // Easy match (domain/easyMatch.js): a number that is no player yet can come in
  const easyNew = !!out && !!actions.newSubstituteAllowed?.(team.teamKey, out.number)
  return (
    <ActionSheet open onClose={onClose} title={title} closeLabel={t('common.close')} railOffset={false}>
      <div data-testid="phone-sub-sheet" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 8px 8px' }}>
        {!out ? (
          <>
            <p style={sheetHead(ink)}>{t('scoreboard.phone.subOut')}</p>
            <div style={chipGrid}>
              {court.map(pl => (
                <Chip
                  key={pl.position}
                  testId={`phone-sub-out-${pl.number}`}
                  disabled={pl.isLibero || !actions.canSubstituteOut(team.teamKey, pl.number)}
                  onClick={() => onPickOut({ position: pl.position, number: pl.number })}
                >
                  {pl.number}
                </Chip>
              ))}
            </div>
            <p style={sheetNote}>{t('scoreboard.phone.subHint')}</p>
          </>
        ) : (
          <>
            <p style={sheetHead(ink)}>{t('scoreboard.phone.subIn', { number: out.number })}</p>
            {candidates.length === 0 && !easyNew ? (
              <p style={sheetNote}>{t('scoreboard.phone.noSubstitutes')}</p>
            ) : candidates.length === 0 ? null : (
              <div style={chipGrid}>
                {candidates.map(c => (
                  <Chip
                    key={c.number}
                    tone="soft"
                    testId={`phone-sub-in-${c.number}`}
                    onClick={() => {
                      onClose()
                      actions.substitute({ teamKey: team.teamKey, position: out.position, playerOut: out.number, playerIn: c.number })
                    }}
                  >
                    {c.number}
                  </Chip>
                ))}
              </div>
            )}
            {easyNew && (
              <NewNumberField
                candidates={candidates}
                check={(value) => actions.checkNewSubstitute(team.teamKey, value)}
                onPick={(number, newPlayer) => {
                  onClose()
                  actions.substitute({ teamKey: team.teamKey, position: out.position, playerOut: out.number, playerIn: number, newPlayer })
                }}
              />
            )}
            <button type="button" style={wideButton} onClick={onBack}>{t('common.back')}</button>
          </>
        )}
      </div>
    </ActionSheet>
  )
}

/**
 * One team's sanctions: the team ones of the side column (improper request,
 * delay warning, then delay penalty), and every player and official, each
 * opening the Scoreboard's own sanction menu.
 */
function SanctionColumn({ team, ink, title, actions, onDone }) {
  const { t } = useTranslation()
  const person = (spec) => (e) => { onDone(); actions.sanctionPerson({ team: team.teamKey, side: team.side, ...spec }, e) }
  const court = (team.court || []).filter(pl => pl.number !== '' && pl.number !== null && pl.number !== undefined && !pl.isLibero)
  const liberos = team.liberos || []
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <p style={sheetHead(ink)}>{title}</p>
      {!team.improperRequestDone && (
        <button type="button" style={wideButton} onClick={() => { onDone(); actions.improperRequest(team.side) }}>{t('scoreboard.sanctions.improperRequest')}</button>
      )}
      {!team.delayWarned ? (
        <button type="button" style={{ ...wideButton, background: '#fef9c3' }} onClick={() => { onDone(); actions.delayWarning(team.side) }}>{t('scoreboard.sanctions.delayWarning')}</button>
      ) : (
        <button type="button" style={{ ...wideButton, background: '#fee2e2' }} onClick={() => { onDone(); actions.delayPenalty(team.side) }}>{t('scoreboard.sanctions.delayPenalty')}</button>
      )}
      {team.easy && (
        <>
          {/* Easy match: no bench or officials, the sanction goes to the team */}
          <button type="button" data-testid={`phone-team-warning-${team.side}`} disabled={team.formalWarned} style={{ ...wideButton, background: team.formalWarned ? 'var(--ov-sunken-strong)' : '#fef9c3', color: team.formalWarned ? 'var(--ov-text-faint)' : undefined }} onClick={() => { onDone(); actions.sanctionTeam(team.teamKey, 'warning') }}>{t('scoreboard.sanctions.warning')}</button>
          <button type="button" data-testid={`phone-team-penalty-${team.side}`} style={{ ...wideButton, background: '#fee2e2' }} onClick={() => { onDone(); actions.sanctionTeam(team.teamKey, 'penalty') }}>{t('scoreboard.sanctions.penalty')}</button>
        </>
      )}
      <p style={{ ...sheetNote, fontSize: 12, marginTop: 4 }}>{team.easy ? t('scoreboard.phone.sanctionOnePlayer') : t('scoreboard.phone.sanctionPeople')}</p>
      <div style={chipGrid}>
        {court.map(pl => (
          <Chip key={`c-${pl.number}`} onClick={person({ type: 'player', playerNumber: pl.number, position: pl.position })}>{pl.number}</Chip>
        ))}
        {liberos.map(l => (
          <Chip key={`l-${l.number}`} tone="soft" onClick={person(l.onCourt ? { type: 'player', playerNumber: l.number, position: l.position } : { type: 'libero', playerNumber: l.number })}>{l.number}</Chip>
        ))}
        {(team.benchPlayers || []).map(pl => (
          <Chip key={`b-${pl.number}`} tone="soft" onClick={person({ type: 'bench', playerNumber: pl.number })}>{pl.number}</Chip>
        ))}
        {(team.officials || []).map(o => (
          <Chip key={`o-${o.role}`} tone="soft" label={o.role} onClick={person({ type: 'official', role: o.role })}>{officialRoleShort(o.role)}</Chip>
        ))}
      </div>
    </div>
  )
}

/**
 * One team's liberos: one on court opens the court action menu (libero out,
 * exchange, unable to play), one on the bench the bench libero menu (libero
 * in), as tapping them on the desktop court and bench does.
 */
function LiberoColumn({ team, ink, title, actions, onDone }) {
  const { t } = useTranslation()
  const liberos = team.liberos || []
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <p style={sheetHead(ink)}>{title}</p>
      {liberos.length === 0 && <p style={sheetNote}>{t('scoreboard.phone.noLibero')}</p>}
      {liberos.map(l => (
        <button
          key={l.number}
          type="button"
          data-testid={`phone-libero-${team.side}-${l.number}`}
          disabled={l.unable}
          style={{ ...wideButton, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, ...(l.unable ? { background: 'var(--ov-sunken-strong)', color: 'var(--ov-text-faint)' } : null) }}
          onClick={(e) => { onDone(); actions.liberoClick(team.teamKey, l, e) }}
        >
          <span style={{ fontSize: 15, fontWeight: 800 }}>{l.number}</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ov-text-muted)' }}>
            {/* a libero declared unable keeps libero 'unable' (re-designation) */}
            {l.libero === 'libero1' ? 'L1' : l.libero === 'libero2' ? 'L2' : l.libero === 'redesignated' ? 'LR' : l.libero === 'unable' ? t('scoreboard.reopenRoster.liberoUnable') : 'L'}
            {l.onCourt ? ` · ${t('scoreboard.phone.onCourt')}` : ''}
          </span>
        </button>
      ))}
      {team.needsRedesignation && (
        <button type="button" style={{ ...wideButton, background: '#fee2e2', color: '#991b1b' }} onClick={() => { onDone(); actions.redesignateLibero(team.teamKey) }}>
          {t('scoreboard.phone.redesignate')}
        </button>
      )}
    </div>
  )
}
