import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowLeftRight, Maximize, Minimize, Pencil, RotateCcw, Undo2 } from 'lucide-react'
import { Volleyball } from '@phosphor-icons/react'
import Modal from './Modal'
import TeamShirt from './TeamShirt'
import TeamColourPicker from './TeamColourPicker'
import { Button, Field, Input, cn, FOCUS_RING, backdropDismiss, confirmDialog } from '../ui'
import { readableText } from '../utils/teamColours'
import {
  addPoint, removePoint, finishSet, canFinishSet, swapSides, undo, canUndo, setTeams, resetBoard,
  setsWon, currentSet, hasScore, sides, loadBoard, saveBoard, MAX_NAME
} from '../domain/simpleScoreboard'

/**
 * Scoreboard (Home): two teams, their points and the sets won, on the whole
 * screen (domain/simpleScoreboard.js). A tap on a team's half is a point for
 * it; −1, Undo, Next set, Swap sides, Teams and Reset do the rest. Nothing
 * leaves the device.
 *
 * Keys on a laptop: ← and → a point for the left or right team, Ctrl+Z or
 * Backspace undo.
 */
export default function SimpleScoreboard({ onExit, isFullscreen = false, toggleFullscreen = null }) {
  const { t } = useTranslation()
  const [board, setBoard] = useState(() => loadBoard())
  const [teamsOpen, setTeamsOpen] = useState(false)
  // Teams or the reset question is open: the keys stay off. Its own flag, not
  // a look for [role=dialog]: the help panel stays mounted (off screen) as one
  const busy = useRef(false)

  useEffect(() => { saveBoard(board) }, [board])
  useEffect(() => { busy.current = teamsOpen }, [teamsOpen])

  const { left, right } = sides(board)
  const won = setsWon(board)
  const nameOf = (team) => board.teams[team].name || (team === 'home' ? t('simpleBoard.home', 'Home') : t('simpleBoard.away', 'Away'))

  useEffect(() => {
    const onKey = (e) => {
      if (busy.current || e.defaultPrevented) return
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        setBoard(b => addPoint(b, e.key === 'ArrowLeft' ? sides(b).left : sides(b).right))
      } else if ((e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) || e.key === 'Backspace') {
        e.preventDefault()
        setBoard(b => undo(b))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const reset = async () => {
    if (!hasScore(board)) return
    busy.current = true
    const ok = await confirmDialog({
      title: t('simpleBoard.resetTitle', 'Start a new game?'),
      message: t('simpleBoard.resetMessage', 'The points and sets go back to 0. The team names and colours stay.'),
      confirmLabel: t('simpleBoard.resetConfirm', 'New game'),
      cancelLabel: t('common.cancel', 'Cancel'),
      tone: 'danger'
    })
    busy.current = teamsOpen
    if (ok) setBoard(b => resetBoard(b))
  }

  const tool = 'h-11 min-w-11 rounded-xl px-2.5 sm:px-3'
  const toolLabel = 'hidden md:inline'

  return (
    <div
      data-testid="simple-scoreboard"
      className="ov-kit fixed inset-0 z-40 flex flex-col bg-stone-100"
      style={{ paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)', paddingLeft: 'env(safe-area-inset-left, 0px)', paddingRight: 'env(safe-area-inset-right, 0px)' }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-stone-200/70 bg-white px-2 py-2 sm:px-3">
        <Button variant="secondary" size="xl" icon={ArrowLeft} onClick={onExit} className={tool} data-testid="simple-board-exit">
          {t('simpleBoard.back', 'Back')}
        </Button>
        <div className="min-w-0 flex-1 truncate text-center text-base font-semibold tabular-nums text-stone-900" data-testid="simple-board-set">
          {t('simpleBoard.set', { n: currentSet(board), defaultValue: 'Set {{n}}' })}
        </div>
        <Button
          variant="secondary"
          size="xl"
          icon={Undo2}
          onClick={() => setBoard(b => undo(b))}
          disabled={!canUndo(board)}
          aria-label={t('simpleBoard.undo', 'Undo')}
          title={t('simpleBoard.undo', 'Undo')}
          className={tool}
        >
          <span className={toolLabel}>{t('simpleBoard.undo', 'Undo')}</span>
        </Button>
        <Button
          variant="secondary"
          size="xl"
          icon={ArrowLeftRight}
          onClick={() => setBoard(b => swapSides(b))}
          aria-label={t('simpleBoard.swap', 'Swap sides')}
          title={t('simpleBoard.swap', 'Swap sides')}
          className={tool}
        >
          <span className={toolLabel}>{t('simpleBoard.swap', 'Swap sides')}</span>
        </Button>
        <Button
          variant="secondary"
          size="xl"
          icon={Pencil}
          onClick={() => setTeamsOpen(true)}
          aria-label={t('simpleBoard.teams', 'Teams')}
          title={t('simpleBoard.teams', 'Teams')}
          className={tool}
        >
          <span className={toolLabel}>{t('simpleBoard.teams', 'Teams')}</span>
        </Button>
        <Button
          variant="secondary"
          size="xl"
          icon={RotateCcw}
          onClick={reset}
          disabled={!hasScore(board)}
          aria-label={t('simpleBoard.reset', 'New game')}
          title={t('simpleBoard.reset', 'New game')}
          className={tool}
        >
          <span className={toolLabel}>{t('simpleBoard.reset', 'New game')}</span>
        </Button>
        {toggleFullscreen && (
          <Button
            variant="secondary"
            size="xl"
            icon={isFullscreen ? Minimize : Maximize}
            onClick={toggleFullscreen}
            aria-pressed={!!isFullscreen}
            aria-label={isFullscreen ? t('header.exitFullscreen') : t('header.fullscreen')}
            title={isFullscreen ? t('header.exitFullscreen') : t('header.fullscreen')}
            className={cn(tool, 'hidden sm:inline-flex')}
          />
        )}
      </div>

      {/* Side by side in every orientation, as the teams stand on the court
          (the owner, 2026-11-03: not one above the other in portrait) */}
      <div className="flex min-h-0 flex-1 gap-2 p-2">
        {[left, right].map(team => (
          <TeamHalf
            key={team}
            team={team}
            name={nameOf(team)}
            colour={board.teams[team].color}
            points={board.points[team]}
            sets={won[team]}
            serving={board.serving === team}
            onPoint={() => setBoard(b => addPoint(b, team))}
            onMinus={() => setBoard(b => removePoint(b, team))}
          />
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t border-stone-200/70 bg-white px-3 py-2">
        <div className="min-w-0 flex-1">
          {board.sets.length > 0 ? (
            <ol className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm font-semibold tabular-nums text-stone-700" aria-label={t('simpleBoard.sets', 'Sets')} data-testid="simple-board-sets">
              {board.sets.map((s, i) => (
                <li key={i}>
                  <span className="mr-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">{t('simpleBoard.setShort', { n: i + 1, defaultValue: 'S{{n}}' })}</span>
                  {`${s[left]}:${s[right]}`}
                </li>
              ))}
            </ol>
          ) : (
            <p className="truncate text-xs text-stone-500">{t('simpleBoard.hint', 'Tap a team to give it a point.')}</p>
          )}
        </div>
        <Button
          variant="dark"
          size="xl"
          onClick={() => setBoard(b => finishSet(b))}
          disabled={!canFinishSet(board)}
          title={canFinishSet(board) ? undefined : t('simpleBoard.nextSetTied', 'One team must lead to end the set.')}
          className="h-11 shrink-0 rounded-xl"
          data-testid="simple-board-next-set"
        >
          {t('simpleBoard.nextSet', 'Next set')}
        </Button>
      </div>

      {teamsOpen && (
        <TeamsModal
          teams={board.teams}
          onCancel={() => setTeamsOpen(false)}
          onSave={(teams) => {
            setBoard(b => setTeams(b, teams))
            setTeamsOpen(false)
          }}
        />
      )}
    </div>
  )
}

/**
 * One team's half: the whole half is its point button, in the team's colour
 * (volleyui §7: the colour stays, the text is black or white by contrast).
 * The digits scale with the half (container units), so the score reads from
 * the far side of the hall on a tablet and still fits a phone.
 */
function TeamHalf({ team, name, colour, points, sets, serving, onPoint, onMinus }) {
  const { t } = useTranslation()
  const ink = readableText(colour)
  const inkStyle = { color: ink.color, textShadow: ink.textShadow }
  return (
    <div className="relative min-w-0 flex-1 overflow-hidden rounded-2xl" style={{ backgroundColor: colour, containerType: 'size' }} data-testid={`simple-board-${team}`}>
      <button
        type="button"
        onClick={onPoint}
        aria-label={t('simpleBoard.pointFor', { team: name, points, defaultValue: 'Point for {{team}} ({{points}})' })}
        className={cn('absolute inset-0 flex touch-manipulation select-none flex-col items-center justify-center gap-1 px-3 pb-14 pt-3 transition-[filter] active:brightness-90', FOCUS_RING)}
        style={inkStyle}
      >
        <span className="flex max-w-full items-center gap-2">
          {serving && (
            <>
              <Volleyball size={22} weight="fill" aria-hidden="true" className="shrink-0" data-testid={`simple-board-serve-${team}`} />
              <span className="sr-only">{t('simpleBoard.serves', 'serves')}</span>
            </>
          )}
          <span className="truncate text-lg font-semibold sm:text-2xl">{name}</span>
        </span>
        <span className="text-sm font-semibold tabular-nums opacity-85 sm:text-base">
          {t('simpleBoard.setsWon', { n: sets, defaultValue: 'Sets {{n}}' })}
        </span>
        <span className="font-bold leading-none tabular-nums" style={{ fontSize: 'min(55cqh, 68cqw)' }} data-testid={`simple-board-points-${team}`}>
          {points}
        </span>
      </button>
      <button
        type="button"
        onClick={onMinus}
        disabled={points <= 0}
        aria-label={t('simpleBoard.pointOff', { team: name, defaultValue: 'One point off {{team}}' })}
        title={t('simpleBoard.pointOff', { team: name, defaultValue: 'One point off {{team}}' })}
        className={cn('absolute bottom-2 left-2 h-11 min-w-14 touch-manipulation rounded-xl bg-black/15 px-3 text-base font-bold tabular-nums disabled:opacity-40', FOCUS_RING)}
        style={inkStyle}
      >
        −1
      </button>
    </div>
  )
}

/** The teams' names and shirt colours */
function TeamsModal({ teams, onCancel, onSave }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(() => ({ home: { ...teams.home }, away: { ...teams.away } }))
  const [picking, setPicking] = useState(null) // 'home' | 'away' | null
  const set = (team, field, value) => setDraft(prev => ({ ...prev, [team]: { ...prev[team], [field]: value } }))
  const labelOf = (team) => (team === 'home' ? t('simpleBoard.homeTeam', 'Home team') : t('simpleBoard.awayTeam', 'Away team'))

  return (
    <Modal title={t('simpleBoard.teams', 'Teams')} open={true} onClose={onCancel} width={440}>
      <form
        className="ov-kit space-y-3 p-1 sm:p-2"
        onSubmit={(e) => { e.preventDefault(); onSave(draft) }}
      >
        {['home', 'away'].map(team => (
          <fieldset key={team} className="min-w-0 rounded-xl border border-stone-200/70 bg-stone-50/60 p-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{labelOf(team)}</legend>
            <div className="flex items-end gap-3">
              <button
                type="button"
                onClick={() => setPicking(team)}
                aria-label={t('simpleBoard.chooseColour', { team: labelOf(team), defaultValue: 'Shirt colour of {{team}}' })}
                className={cn('shrink-0 rounded-lg p-1 hover:bg-stone-100', FOCUS_RING)}
              >
                <TeamShirt color={draft[team].color} className="h-11 w-11" />
              </button>
              <div className="min-w-0 flex-1">
                <Field label={t('simpleBoard.teamName', 'Name')}>
                  <Input
                    id={`simple-board-${team}-name`}
                    value={draft[team].name}
                    placeholder={team === 'home' ? t('simpleBoard.home', 'Home') : t('simpleBoard.away', 'Away')}
                    onChange={e => set(team, 'name', e.target.value.slice(0, MAX_NAME))}
                    autoComplete="off"
                  />
                </Field>
              </div>
            </div>
          </fieldset>
        ))}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" size="xl" onClick={onCancel} className="rounded-lg font-medium">
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button type="submit" variant="positive" size="xl" className="rounded-lg" data-testid="simple-board-teams-save">
            {t('common.save', 'Save')}
          </Button>
        </div>
      </form>

      {picking && (
        <>
          <div className="fixed inset-0 z-[1999] bg-stone-900/50" {...backdropDismiss(() => setPicking(null))} />
          <div
            role="dialog"
            aria-label={t('simpleBoard.chooseColour', { team: labelOf(picking), defaultValue: 'Shirt colour of {{team}}' })}
            className="fixed left-1/2 top-1/2 z-[2000] min-w-[280px] max-w-[95vw] rounded-2xl border border-stone-200/70 bg-white p-4 shadow-2xl"
            style={{ transform: 'translate(-50%, -50%)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <TeamColourPicker
              value={draft[picking].color}
              otherColour={draft[picking === 'home' ? 'away' : 'home'].color}
              onPick={(color) => {
                set(picking, 'color', color)
                setPicking(null)
              }}
            />
          </div>
        </>
      )}
    </Modal>
  )
}
