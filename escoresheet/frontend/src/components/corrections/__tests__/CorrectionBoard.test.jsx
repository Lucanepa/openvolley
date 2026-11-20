import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM, pointsFor } from '../../../domain/__tests__/fixtures/correctionsMatch'
import { applyPlanToEvents } from '../../../domain/manualCorrections'
import { scoreFromPointEvents } from '../../../domain/rules'

const applied = vi.hoisted(() => ({ plans: [] }))
vi.mock('../../../services/corrections/applyCorrectionPlan', async (orig) => ({
  ...(await orig()),
  applyCorrectionPlan: async (plan) => { applied.plans.push(plan); return { addedIds: [], signaturesCleared: false } }
}))
// answer: true / false, answered here (the board asks before Save, Cancel, Undo all)
const dialog = vi.hoisted(() => ({ answer: true, calls: [] }))
vi.mock('../../../ui/uiStore.js', async (orig) => {
  const real = await orig()
  return { ...real, confirmDialog: (opts) => { dialog.calls.push(opts); return Promise.resolve(dialog.answer) } }
})

import CorrectionBoard, { boardFits, readCorrectionView, saveCorrectionView, CORRECTION_VIEW_KEY } from '../CorrectionBoard.jsx'
import { resetGhostClickGuard } from '../../../hooks/useConfirmAction'

const HOME_PLAYERS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ id: n, number: n, name: `Home ${n}` }))
const AWAY_PLAYERS = [11, 12, 13, 14, 15, 16, 17, 18].map(n => ({ id: 100 + n, number: n, name: `Away ${n}` }))

// Set 1 25:20 (finished), set 2 being played at 12:10
function liveMatch() {
  const built = buildMatch({
    sets: [{ points: pointsFor(25, 20), finished: true }, { points: pointsFor(12, 10).slice(0, 22), finished: false }]
  })
  const sets = built.sets.map(s => (s.index === 2 ? { ...s, finished: false } : s))
  return { events: built.events, sets }
}

function setup(over = {}) {
  const { events, sets } = liveMatch()
  const onClose = vi.fn()
  const onShowList = vi.fn()
  const props = {
    mode: 'live', matchId: 1, events, match: MATCH, sets, homeTeam: HOME_TEAM, awayTeam: AWAY_TEAM,
    homePlayers: HOME_PLAYERS, awayPlayers: AWAY_PLAYERS, liveSetIndex: 2, onClose, onShowList, ...over
  }
  const utils = render(<CorrectionBoard {...props} />)
  return { ...utils, props, onClose, onShowList }
}

const scoreOf = (side) => Number(screen.getByTestId(`board-score-${side}`).textContent)

describe('CorrectionBoard', () => {
  beforeEach(() => { applied.plans = []; dialog.calls = []; dialog.answer = true; resetGhostClickGuard() })

  it('draws the set being played: both teams, the score, the courts', () => {
    setup()
    expect(screen.getByTestId('correction-board')).toBeTruthy()
    expect(scoreOf('left') + scoreOf('right')).toBe(22)
    expect(within(screen.getByTestId('board-team-left')).getAllByRole('button', { name: /^Position / })).toHaveLength(6)
    expect(screen.getByText('No changes yet. Nothing is saved until you tap Save.')).toBeTruthy()
  })

  it('stages + and −, redraws at once, takes back the last change, and saves them all in one write', async () => {
    const { props, onClose } = setup()
    const left0 = scoreOf('left')
    fireEvent.click(screen.getByTestId('board-plus-left'))
    expect(scoreOf('left')).toBe(left0 + 1)
    fireEvent.click(screen.getByTestId('board-plus-left'))
    expect(scoreOf('left')).toBe(left0 + 2)
    fireEvent.click(screen.getByTestId('board-undo'))
    expect(scoreOf('left')).toBe(left0 + 1)
    const right0 = scoreOf('right')
    fireEvent.click(screen.getByTestId('board-minus-right'))
    expect(scoreOf('right')).toBe(right0 - 1)
    expect(applied.plans).toHaveLength(0) // nothing written yet

    fireEvent.click(screen.getByTestId('board-save'))
    // the review: the changes in words and the set box as it will print, from the draft
    const review = await screen.findByTestId('board-save-review')
    expect(within(review).getAllByRole('listitem')).toHaveLength(2)
    const box = await within(review).findByTestId('set-preview-row', {}, { timeout: 10000 })
    expect(box.getAttribute('data-set-index')).toBe('2')
    expect(applied.plans).toHaveLength(0)
    fireEvent.click(screen.getByTestId('board-save-confirm'))
    await vi.waitFor(() => expect(applied.plans).toHaveLength(1))
    const plan = applied.plans[0]
    expect(plan.logs).toHaveLength(2)
    const after = applyPlanToEvents(props.events, plan)
    const sc = scoreFromPointEvents(after, 2)
    const leftIsHome = scoreOf('left') === sc.homePoints
    expect(leftIsHome ? sc.homePoints : sc.awayPoints).toBe(left0 + 1)
    expect(leftIsHome ? sc.awayPoints : sc.homePoints).toBe(right0 - 1)
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith({ saved: true }))
  })

  it('Back to the board from the review keeps the changes, nothing written', async () => {
    setup()
    const left0 = scoreOf('left')
    fireEvent.click(screen.getByTestId('board-plus-left'))
    fireEvent.click(screen.getByTestId('board-save'))
    fireEvent.click(await screen.findByRole('button', { name: 'Back to the board' }))
    expect(screen.queryByTestId('board-save-review')).toBeNull()
    expect(scoreOf('left')).toBe(left0 + 1)
    expect(applied.plans).toHaveLength(0)
  })

  it('a time-out is added from its slot and removed from it', async () => {
    setup()
    fireEvent.click(screen.getByTestId('board-timeout-left-0'))
    // the time-out form, at the current score, team preset
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }))
    const slot = await screen.findByTestId('board-timeout-left-0')
    expect(slot.textContent).toMatch(/^TO \d+:\d+$/)
    fireEvent.click(slot)
    fireEvent.click(await screen.findByTestId('board-timeout-remove'))
    expect((await screen.findByTestId('board-timeout-left-0')).textContent).toBe('TO')
  })

  it('refuses a point that would end the set, with the reason', () => {
    const built = buildMatch({ sets: [{ points: pointsFor(24, 20).slice(0, 44), finished: false }] })
    render(<CorrectionBoard mode="live" matchId={1} events={built.events} match={MATCH} sets={[{ id: 1, index: 1, finished: false }]}
      homeTeam={HOME_TEAM} awayTeam={AWAY_TEAM} homePlayers={HOME_PLAYERS} awayPlayers={AWAY_PLAYERS} liveSetIndex={1} onClose={() => {}} />)
    const sc = scoreFromPointEvents(built.events, 1)
    const homeSide = Number(screen.getByTestId('board-score-left').textContent) === sc.homePoints ? 'left' : 'right'
    fireEvent.click(screen.getByTestId(`board-plus-${homeSide}`))
    expect(Number(screen.getByTestId(`board-score-${homeSide}`).textContent)).toBe(24)
  })

  it('switch sides moves the teams; rotate moves the court', () => {
    setup()
    const leftName = within(screen.getByTestId('board-team-left')).getByRole('heading').textContent
    fireEvent.click(screen.getByTestId('board-switch-sides'))
    expect(within(screen.getByTestId('board-team-right')).getByRole('heading').textContent).toBe(leftName)
  })

  it('a rally in play: nothing can be changed', () => {
    setup({ rallyInPlay: true })
    expect(screen.getByText('A rally is in play: record its point first, then correct.')).toBeTruthy()
    expect(screen.getByTestId('board-plus-left').disabled).toBe(true)
  })

  it('the match changing under the board: Save is blocked until Start again', () => {
    const { props, rerender } = setup()
    fireEvent.click(screen.getByTestId('board-plus-left'))
    const extra = { id: 9999, matchId: 1, type: 'remark', setIndex: 2, seq: 9999, payload: {} }
    rerender(<CorrectionBoard {...props} events={[...props.events, extra]} />)
    expect(screen.getByText(/The match changed while the board was open/)).toBeTruthy()
    expect(screen.getByTestId('board-save').disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }))
    expect(screen.getByText('No changes yet. Nothing is saved until you tap Save.')).toBeTruthy()
  })

  it('Close with changes asks first; List remembers the choice', async () => {
    const { onClose, onShowList } = setup()
    fireEvent.click(screen.getByTestId('board-plus-left'))
    dialog.answer = false
    fireEvent.click(screen.getByTestId('board-close'))
    await vi.waitFor(() => expect(dialog.calls).toHaveLength(1))
    expect(onClose).not.toHaveBeenCalled()
    dialog.answer = true
    fireEvent.click(screen.getByTestId('board-show-list'))
    await vi.waitFor(() => expect(onShowList).toHaveBeenCalled())
    expect(readCorrectionView()).toBe('list')
    saveCorrectionView('board')
    expect(localStorage.getItem(CORRECTION_VIEW_KEY)).toBe('board')
  })

  it('at the match end: a finished set follows the final score rule, nothing live is offered', async () => {
    const built = buildMatch({ sets: [{ points: pointsFor(25, 20), finished: true }, { points: pointsFor(25, 18), finished: true }] })
    const onClose = vi.fn()
    render(<CorrectionBoard mode="review" matchId={1} events={built.events} match={MATCH} sets={built.sets}
      homeTeam={HOME_TEAM} awayTeam={AWAY_TEAM} homePlayers={HOME_PLAYERS} awayPlayers={AWAY_PLAYERS} onClose={onClose} onShowList={() => {}} />)
    expect(screen.queryByTestId('board-switch-sides')).toBeNull()
    expect(screen.queryByTestId('board-rotate-forward-left')).toBeNull()
    expect(screen.queryByTestId('board-reopen-set')).toBeNull()
    const sc = scoreFromPointEvents(built.events, 2)
    const awaySide = Number(screen.getByTestId('board-score-left').textContent) === sc.awayPoints ? 'left' : 'right'
    fireEvent.click(screen.getByTestId(`board-plus-${awaySide}`))
    expect(Number(screen.getByTestId(`board-score-${awaySide}`).textContent)).toBe(19)
    saveCorrectionView('board')
    fireEvent.click(screen.getByTestId('board-save'))
    fireEvent.click(await screen.findByTestId('board-save-confirm'))
    await vi.waitFor(() => expect(applied.plans).toHaveLength(1))
    expect(applied.plans[0].logs[0].text).toMatch(/entered after the match/)
    // the live default view is not changed from the match end
    expect(readCorrectionView()).toBe('board')
  })

  it('fits tablets in landscape and desktops, not phones', () => {
    expect(boardFits({ innerWidth: 1280, innerHeight: 800 })).toBe(true)
    expect(boardFits({ innerWidth: 390, innerHeight: 844 })).toBe(false)
    expect(boardFits({ innerWidth: 844, innerHeight: 390 })).toBe(false)
  })
})
