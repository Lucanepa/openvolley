import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Undo2, Menu } from 'lucide-react'
import { ActionSheet } from '../../ui/Modal.jsx'
import { COURT_SURFACE, HEADER_SURFACE, normaliseColour, teamBoxStyle, teamTextPaint } from '../../utils/teamColours'
import { COURT_CELLS, POSITIONS, officialRoleShort, tintOf } from './phoneLayout'

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
 * @param {Array<{ id: any, text: string }>} props.recent newest first
 * @param {boolean} props.canUndo
 * @param {string} [props.scoreFont] CSS font family of scores and countdowns
 * @param {object} props.actions the Scoreboard's handlers (see Scoreboard.jsx)
 *
 * TeamVM: { side, teamKey, label ('A'|'B'), name, shortName, color, setsWon,
 *   points, timeouts, subs, lineupSet, court: [{ position, number, isLibero }],
 *   liberos: [{ number, libero, unable, onCourt, position }], benchPlayers:
 *   [{ number }], officials: [{ role }], improperRequestDone, delayWarned,
 *   needsRedesignation }
 */
export default function PhoneScoreboard({ setNumber, teams, serving, rally, centre, recent, canUndo, scoreFont = 'inherit', actions }) {
  const { t } = useTranslation()
  // The phone's own pickers: { kind: 'sub', side, out?: { position, number } } | { kind: 'sanction' } | { kind: 'libero' }
  const [sheet, setSheet] = useState(null)
  const { left, right } = teams
  const idle = rally.status === 'idle' && !rally.isRallyReplayed
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
    const info = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, alignItems: team.side === 'left' ? 'flex-start' : 'flex-end' }}>
        <span style={{ maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 12, fontWeight: 700, color: p.ink }}>{teamTitle(team)}</span>
        <span
          aria-hidden={!isServing}
          style={{ visibility: isServing ? 'visible' : 'hidden', padding: '2px 8px', borderRadius: 999, background: 'var(--ov-text)', color: 'var(--ov-card)', fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', lineHeight: 1.3, whiteSpace: 'nowrap' }}
        >
          {t('scoreboard.labels.serveLabel')}
        </span>
        <span style={{ whiteSpace: 'nowrap', fontSize: 11, fontWeight: 600, color: 'var(--ov-text-muted)' }}>
          {t('scoreboard.phone.setsWon', { count: team.setsWon })}
        </span>
      </div>
    )
    const score = (
      <span data-testid={`phone-score-${team.side}`} style={{ flex: 'none', fontSize: 52, lineHeight: 1, fontWeight: 800, fontVariantNumeric: 'tabular-nums', fontFamily: scoreFont }}>
        {team.points}
      </span>
    )
    return (
      <div key={team.side} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, padding: '6px 12px', minWidth: 0, borderRadius: 14, background: isServing ? p.tint : 'var(--ov-card)', border: '1px solid var(--ov-hairline)' }}>
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
          return (
            <button
              key={position}
              type="button"
              data-court-cell={position}
              aria-label={number !== null ? t('scoreboard.phone.courtPlayer', { number, team: team.label }) : undefined}
              disabled={number === null}
              onClick={(e) => number !== null && actions.playerClick(team.teamKey, position, number, e)}
              style={{ display: 'flex', flexDirection: team.side === 'left' ? 'row-reverse' : 'row', alignItems: 'center', justifyContent: 'center', gap: 4, minWidth: 0, minHeight: 0, background: 'transparent', borderRadius: 8, cursor: number !== null ? 'pointer' : 'default' }}
            >
              <span style={{ fontSize: 28, lineHeight: 1, fontWeight: 800, color: p.courtInk, fontVariantNumeric: 'tabular-nums' }}>{number ?? '–'}</span>
              {hasBall && (
                <span data-testid="phone-serve-ball" aria-label={t('scoreboard.labels.serveLabel')} style={{ flex: 'none', width: 12, height: 12, borderRadius: '50%', background: '#facc15', border: '2px solid #1c1917' }} />
              )}
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
            <span style={{ fontSize: 12, fontWeight: 600 }}>{teamTitle(team)}</span>
          </button>
        )}
      </div>
    )
  }

  // ---- team actions -------------------------------------------------------
  // As the desktop counters: open between rallies, also while a time-out or
  // the interval runs (a consecutive time-out, a substitution right after a
  // time-out); greyed once used up
  const toDisabled = (team) => !idle || team.timeouts >= 2
  const subDisabled = (team) => !idle || team.subs >= 6 || !team.lineupSet
  const counter = (team, { label, value, disabled, onClick, testId }) => {
    const p = paint[team.side]
    return (
      <button
        type="button"
        data-testid={testId}
        onClick={onClick}
        disabled={disabled}
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, minHeight: 56, minWidth: 0, padding: '0 4px',
          borderRadius: 14,
          border: `2px solid ${disabled ? 'var(--ov-hairline-strong)' : p.ink}`,
          background: disabled ? 'var(--ov-sunken-strong)' : p.soft,
          color: disabled ? 'var(--ov-text-faint)' : 'var(--ov-text)',
          cursor: disabled ? 'default' : 'pointer'
        }}
      >
        {/* One line as the mockup (a touch smaller on a 360px phone); a label
            longer than the button ("TEMPS MORT") goes on two lines rather than
            out of it */}
        <span style={{ maxWidth: '100%', fontSize: 'clamp(10px, 2.85vw, 11px)', lineHeight: 1.15, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', textAlign: 'center', textWrap: 'balance', overflowWrap: 'anywhere', color: disabled ? 'var(--ov-text-faint)' : p.ink }}>{label}</span>
        <span style={{ fontSize: 22, lineHeight: 1.1, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      </button>
    )
  }
  const teamActions = (team) => (
    <div key={team.side} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 }}>
      {counter(team, { label: t('scoreboard.phone.timeOut'), value: `${team.timeouts}/2`, disabled: toDisabled(team), onClick: () => actions.timeout(team.side), testId: `phone-timeout-${team.side}` })}
      {counter(team, { label: t('scoreboard.labels.sub'), value: `${team.subs}/6`, disabled: subDisabled(team), onClick: () => setSheet({ kind: 'sub', side: team.side }), testId: `phone-sub-${team.side}` })}
    </div>
  )

  // ---- centre: point buttons, start rally, countdowns, set-5 setup ---------
  const bigButton = { width: '100%', minHeight: 52, borderRadius: 14, fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }
  const darkButton = { ...bigButton, background: 'var(--ov-selected)', color: 'var(--ov-on-dark)' }
  const outlineButton = { ...bigButton, background: 'var(--ov-card)', color: 'var(--ov-text)', border: '1px solid var(--ov-hairline-strong)' }
  const countdown = ({ countdown: value, countdownText, total }, warnAt) => (
    <>
      <div data-testid="phone-countdown" style={{ flex: 'none', fontSize: 48, lineHeight: 1, fontWeight: 800, fontFamily: scoreFont, fontVariantNumeric: 'tabular-nums', color: value <= warnAt ? 'var(--danger)' : 'var(--ov-text)' }}>{countdownText ?? value}</div>
      <div style={{ flex: 'none', width: '70%', height: 8, borderRadius: 4, overflow: 'hidden', background: 'var(--ov-hairline)' }}>
        <div style={{ width: `${total > 0 ? Math.max(0, Math.min(1, value / total)) * 100 : 0}%`, height: '100%', marginLeft: 'auto', borderRadius: 4, background: value <= warnAt ? 'var(--danger)' : 'var(--accent)', transition: 'width 1s linear' }} />
      </div>
    </>
  )
  let overlay = null
  if (centre?.kind === 'timeout') {
    overlay = (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, height: '100%', padding: 10, borderRadius: 16, background: 'var(--ov-card)', border: '1px solid var(--ov-hairline)' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ov-text-secondary)', textAlign: 'center' }}>{t('scoreboard.phone.timeoutRunning', { team: centre.teamName })}</div>
        {countdown(centre, 10)}
        <button type="button" style={{ ...outlineButton, width: 'auto', padding: '0 24px' }} onClick={() => actions.stopTimeout()}>{t('scoreboard.buttons.stopTimeout')}</button>
      </div>
    )
  } else if (centre?.kind === 'set5') {
    overlay = (
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8, height: '100%' }}>
        <button type="button" style={darkButton} onClick={() => actions.set5SwitchSides()}><span aria-hidden="true">⇄</span>{t('scoreboard.buttons.switchSides')}</button>
        <button type="button" style={darkButton} onClick={() => actions.set5SwitchServe()}>{t('scoreboard.buttons.switchServe')}</button>
        <button type="button" style={{ ...bigButton, background: 'var(--ov-success)', color: '#ffffff' }} onClick={() => actions.set5Confirm()}>{centre.confirmLabel}</button>
        {typeof centre.countdown === 'number' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>{countdown(centre, 30)}</div>
        )}
      </div>
    )
  } else if (centre?.kind === 'interval') {
    overlay = (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, height: '100%', padding: 10, borderRadius: 16, background: 'var(--ov-card)', border: '1px solid var(--ov-hairline)' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ov-text-secondary)' }}>{t('scoreboard.phone.interval')}</div>
        {countdown(centre, 30)}
        <button type="button" style={{ ...outlineButton, width: 'auto', padding: '0 24px' }} onClick={() => actions.endInterval()}>{t('scoreboard.buttons.endSetInterval')}</button>
      </div>
    )
  } else if (!inPlay) {
    overlay = (
      <button
        type="button"
        data-help-id="scoreboard-start-rally"
        disabled={rally.startDisabled}
        // The desktop button hands its click event to handleStartRally too
        onClick={(e) => actions.startRally(e)}
        style={{ ...bigButton, height: '100%', fontSize: 24, fontWeight: 800, borderRadius: 16, background: rally.startDisabled ? 'var(--ov-sunken-strong)' : 'var(--ov-selected)', color: rally.startDisabled ? 'var(--ov-text-faint)' : 'var(--ov-on-dark)' }}
      >
        {rally.isFirstRally ? t('scoreboard.buttons.startSet') : t('scoreboard.buttons.startRally')}
      </button>
    )
  }
  const pointButton = (team) => (
    <button
      key={team.side}
      type="button"
      data-help-id={`scoreboard-point-${team.side}`}
      aria-label={t('scoreboard.buttons.pointTeam', { team: team.label })}
      onClick={() => actions.point(team.side)}
      style={{ aspectRatio: '1 / 1', minWidth: 0, borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, ...paint[team.side].fill }}
    >
      <span aria-hidden="true" style={{ fontSize: 40, fontWeight: 800, lineHeight: 1 }}>+1</span>
      <span aria-hidden="true" style={{ fontSize: 14, fontWeight: 600 }}>{t('scoreboard.buttons.pointTeam', { team: team.label })}</span>
    </button>
  )

  // ---- the other actions --------------------------------------------------
  const gridButton = (key, label, onClick, { disabled = false, span = 1, muted = false } = {}) => (
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
        fontSize: 12, lineHeight: 1.15, fontWeight: 600, overflow: 'hidden', overflowWrap: 'anywhere', hyphens: 'manual'
      }}
    >
      {label}
    </button>
  )

  return (
    <div
      className="ov-kit phone-scoreboard"
      data-testid="phone-scoreboard"
      style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, height: '100%', width: '100%', maxWidth: 600, margin: '0 auto', overflowY: 'auto', overflowX: 'hidden', background: 'var(--ov-page-top)', color: 'var(--ov-text)', fontFamily: 'var(--font-sans)' }}
    >
      {header}

      <section aria-label={t('scoreboard.phone.score')} style={{ flex: 'none', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, padding: '10px 12px 6px' }}>
        {scoreCard(left)}
        {scoreCard(right)}
      </section>

      <section aria-label={t('scoreboard.phone.court')} style={{ flex: 'none', padding: '6px 12px 4px' }}>
        <div style={{ width: '100%', aspectRatio: '2 / 1', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', borderRadius: 16, background: COURT_SURFACE, border: '2px solid var(--ov-hairline-strong)', overflow: 'hidden' }}>
          {courtHalf(left)}
          {courtHalf(right)}
        </div>
      </section>

      <section aria-label={t('scoreboard.phone.recentActions')} data-testid="phone-recent" style={{ flex: 'none', margin: '4px 14px 8px', padding: '6px 10px', minHeight: 58, boxSizing: 'border-box', borderRadius: 10, background: 'var(--ov-sunken-strong)', display: 'flex', flexDirection: 'column', gap: 3 }}>
        {recent.length === 0 ? (
          <span style={{ fontSize: 12, color: 'var(--ov-text-muted)' }}>{t('scoreboard.phone.noActions')}</span>
        ) : recent.map((r, i) => (
          <span key={r.id} title={r.text} style={{ fontSize: 12, lineHeight: '15px', color: i === 0 ? 'var(--ov-text)' : 'var(--ov-text-muted)', fontWeight: i === 0 ? 700 : 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.text}</span>
        ))}
      </section>

      {/* Grows into the height left over: the screen is filled, no gap */}
      <section aria-label={t('scoreboard.phone.teamActions')} style={{ flex: '1 0 auto', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, padding: '0 12px 8px' }}>
        {teamActions(left)}
        {teamActions(right)}
      </section>

      <section aria-label={t('scoreboard.phone.pointButtons')} style={{ flex: 'none', position: 'relative', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, padding: '0 12px 8px' }}>
        {inPlay && !centre ? (
          <>{pointButton(left)}{pointButton(right)}</>
        ) : (
          <>
            {/* Two square slots keep the height of the point buttons */}
            <div aria-hidden="true" style={{ aspectRatio: '1 / 1' }} />
            <div aria-hidden="true" style={{ aspectRatio: '1 / 1' }} />
            <div style={{ position: 'absolute', top: 0, left: 12, right: 12, bottom: 8 }}>{overlay}</div>
          </>
        )}
      </section>

      <section aria-label={t('scoreboard.phone.moreActions')} style={{ flex: 'none', display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6, padding: '0 12px 14px' }}>
        {gridButton('libero', t('scoreboard.phone.libero'), () => setSheet({ kind: 'libero' }), { disabled: !idle })}
        {gridButton('sanction', t('scoreboard.sanction'), () => setSheet({ kind: 'sanction' }), { disabled: rally.status !== 'idle' })}
        {gridButton('replay', t('scoreboard.phone.replay'), () => actions.replay(), { disabled: !inPlay })}
        {gridButton('decision', t('scoreboard.phone.decision'), () => actions.replay(), { disabled: !(rally.status === 'idle' && rally.canReplayRally) })}
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
            {candidates.length === 0 ? (
              <p style={sheetNote}>{t('scoreboard.phone.noSubstitutes')}</p>
            ) : (
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
      <p style={{ ...sheetNote, fontSize: 12, marginTop: 4 }}>{t('scoreboard.phone.sanctionPeople')}</p>
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
            {l.libero === 'libero1' ? 'L1' : l.libero === 'redesignated' ? 'LR' : 'L2'}
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
