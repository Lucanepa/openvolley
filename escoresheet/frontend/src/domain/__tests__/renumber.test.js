// A shirt number changed during the match is changed for the whole match
// (owner 2026-10-29): every past and future reference of that player.
import { describe, it, expect } from 'vitest'
import { planRenumberPlayer, applyPlanToEvents, errorText } from '../manualCorrections'
import { referencedPlayerNumbers, renumberRemarkText, renumberSnapshot, recordNumbersMissingFrom } from '../roster'
import { describeEvent } from '../describe'
import { getStartingLineup } from '../../../scoresheet_pdf/utils/scoresheetModel'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM, pointsFor } from './fixtures/correctionsMatch'

const HOME_PLAYERS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ id: n, teamId: 10, number: n, name: `Home ${n}`, libero: n === 9 ? 'libero1' : '' }))
const AWAY_PLAYERS = [11, 12, 13, 14, 15, 16, 17, 20].map(n => ({ id: 100 + n, teamId: 20, number: n, name: `Away ${n}`, libero: n === 20 ? 'libero1' : '' }))
const LIVE = { ...MATCH, status: 'live', homeCourtCaptain: 5, homeRememberedCourtCaptain: 5, awayCourtCaptain: 5 }
const ctx = { match: LIVE, homeTeam: HOME_TEAM, awayTeam: AWAY_TEAM, matchId: 1, mode: 'live', liveSetIndex: 2, players: { home: HOME_PLAYERS, away: AWAY_PLAYERS } }
const REMARK = 'Team A, Set 1, Result 14:10: player no. 5 is exceptionally substituted by player no. 7 due to injury.'

// Home #5 everywhere: starting line-ups, replaced by the libero, sanctioned,
// substituted (with its remark), game captain, an injury on the bench
function matchWithFive() {
  const built = buildMatch({
    sets: [
      {
        points: pointsFor(25, 20),
        finished: true,
        extras: [
          { at: 0, type: 'libero_entry', payload: { team: 'home', playerOut: 5, liberoIn: 9 } },
          { at: 4, type: 'sanction', payload: { team: 'home', type: 'warning', playerType: 'player', playerNumber: 5 } },
          { at: 6, type: 'sanction', payload: { team: 'home', type: 'penalty', playerType: 'bench', playerNumber: 8 } },
          { at: 24, type: 'substitution', payload: { team: 'home', playerOut: 5, playerIn: 7, isExceptional: true, autoRemark: REMARK } },
          { at: 30, type: 'bench_injury', payload: { team: 'home', playerNumber: 5 } }
        ]
      },
      {
        points: pointsFor(12, 10),
        finished: false,
        extras: [
          { at: 0, type: 'court_captain_designation', payload: { team: 'home', playerNumber: 5, previousCourtCaptain: 4 } },
          { at: 2, type: 'sanction', payload: { team: 'away', type: 'warning', playerType: 'player', playerNumber: 15 } }
        ]
      }
    ]
  })
  // the away team has a #5 too? No: away #15 must not change when home #5 becomes #15
  const events = built.events.map(e => (e.type === 'point' ? { ...e, stateSnapshot: snapshotOf(e) } : e))
  return { ...built, events }
}

function snapshotOf(point) {
  return {
    teamAKey: 'home',
    servingTeam: point.payload.team,
    serverNumber: 5,
    lineupA: { I: { number: 5, isCaptain: false }, V: { number: 9, isLibero: true, replacedNumber: 5 } },
    lineupB: { I: { number: 5 } },
    subsA: [{ playerIn: 7, playerOut: 5 }],
    sanctionsA: [{ player: 5, type: 'warning' }],
    sanctionsB: [{ player: 5, type: 'warning' }]
  }
}

describe('renumber a player for the whole match', () => {
  it('rewrites every reference of the team in the record, nothing of the other team', () => {
    const { events } = matchWithFive()
    expect(referencedPlayerNumbers(events, 'home').has('5')).toBe(true)
    const plan = planRenumberPlayer(events, { team: 'home', playerId: 5, to: 15 }, ctx)
    expect(plan.error).toBeUndefined()
    const after = applyPlanToEvents(events, plan)

    const home = referencedPlayerNumbers(after, 'home')
    expect(home.has('5')).toBe(false)
    expect(home.has('15')).toBe(true)
    // the other team's #15 and its records are untouched
    const awayBefore = events.filter(e => e.payload?.team === 'away').map(e => JSON.stringify(e.payload))
    const awayAfter = after.filter(e => e.payload?.team === 'away').map(e => JSON.stringify(e.payload))
    expect(awayAfter).toEqual(awayBefore)

    // each kind of reference
    const byType = (type, pred = () => true) => after.find(e => e.type === type && e.payload?.team === 'home' && pred(e))
    expect(byType('libero_entry').payload.playerOut).toBe(15)
    expect(byType('sanction', e => e.payload.type === 'warning').payload.playerNumber).toBe(15)
    expect(byType('sanction', e => e.payload.type === 'penalty').payload.playerNumber).toBe(8)
    expect(byType('substitution').payload.playerOut).toBe(15)
    expect(byType('bench_injury').payload.playerNumber).toBe(15)
    expect(byType('court_captain_designation').payload.playerNumber).toBe(15)
    const ls = after.filter(e => e.type === 'lineup' && e.payload.team === 'home' && e.payload.liberoSubstitution).map(e => e.payload.liberoSubstitution.playerNumber)
    expect(ls.length).toBeGreaterThan(0)
    expect(ls.every(n => String(n) === '15')).toBe(true)
    expect(getStartingLineup(after, 1, 'home')).toEqual(['1', '2', '3', '4', '15', '6'])
    expect(getStartingLineup(after, 2, 'home')).toEqual(['1', '2', '3', '4', '15', '6'])

    // the automatic remark, in the entry and where it stands in the remarks
    const remark = REMARK.replace('player no. 5', 'player no. 15')
    expect(byType('substitution').payload.autoRemark).toBe(remark)
    expect(plan.remarkReplace).toEqual([{ from: REMARK, to: remark }])

    // the snapshots the tablets were shown: home's side only
    const snap = after.find(e => e.type === 'point' && e.payload.team === 'home').stateSnapshot
    expect(snap.lineupA.I.number).toBe(15)
    expect(snap.lineupA.V.replacedNumber).toBe(15)
    expect(snap.serverNumber).toBe(15)
    expect(snap.subsA[0].playerOut).toBe(15)
    expect(snap.sanctionsA[0].player).toBe(15)
    expect(snap.lineupB.I.number).toBe(5)
    expect(snap.sanctionsB[0].player).toBe(5)

    // the roster row, the game captain in force and the remembered one
    expect(plan.playerUpdates).toEqual([{ id: 5, changes: { number: 15 } }])
    expect(plan.matchPatch).toEqual({ homeCourtCaptain: 15, homeRememberedCourtCaptain: 15 })

    // the correction log shown to the referee; nothing inconsistent after it
    expect(plan.log).toMatchObject({ action: 'renumberPlayer', team: 'home', before: '5', after: 'Player #5 of VC Smash renumbered to #15' })
    expect(plan.log.text).toBe('Player #5 of VC Smash renumbered to #15')
    expect(plan.newIssues).toEqual([])
    // the lists read the new number
    const sub = after.find(e => e.type === 'substitution')
    expect(describeEvent(sub, after, ctx).text).toMatch(/#7 in for #15/)
  })

  it('refuses a number of another player of the team, a number in the record and an invalid number', () => {
    const { events } = matchWithFive()
    const taken = planRenumberPlayer(events, { team: 'home', playerId: 5, to: 6 }, ctx)
    expect(taken.error).toBe('corrections.error.numberTaken')
    expect(errorText(taken)).toBe('#6 is already the number of Home 6 (VC Smash). Choose another number.')
    // #22 is not on the roster but a substitution of the record uses it
    const withStranger = events.map(e => (e.type === 'bench_injury' ? { ...e, payload: { ...e.payload, playerNumber: 22 } } : e))
    const inRecord = planRenumberPlayer(withStranger, { team: 'home', playerId: 5, to: 22 }, ctx)
    expect(inRecord.error).toBe('corrections.error.numberInRecord')
    expect(errorText(inRecord)).toBe('#22 already appears in the match record of VC Smash. Choose another number.')
    for (const bad of [0, 100, 'x', '', 1.5]) {
      expect(planRenumberPlayer(events, { team: 'home', playerId: 5, to: bad }, ctx).error).toBe('corrections.error.invalidNumber')
    }
    expect(planRenumberPlayer(events, { team: 'home', playerId: 5, to: 5 }, ctx).error).toBe('corrections.error.sameNumber')
    // the other team may have the number: only the team's own players count
    expect(planRenumberPlayer(events, { team: 'home', playerId: 5, to: 11 }, ctx).error).toBeUndefined()
  })
})

describe('renumber helpers', () => {
  it('remark lines: player numbers change, scores, sets and times stay', () => {
    const map = [{ from: '5', to: '15' }]
    expect(renumberRemarkText('Set 3, 14:28, B 15:5, #5 exceptionally substituted by #12', map)).toBe('Set 3, 14:28, B 15:5, #15 exceptionally substituted by #12')
    expect(renumberRemarkText('Team B, Set 1, Result 5:5: Libero no. 5 is declared unable to play.', map)).toBe('Team B, Set 1, Result 5:5: Libero no. 15 is declared unable to play.')
    expect(renumberRemarkText('Satz 1: Spieler/in Nr. 5 wird ersetzt', map)).toBe('Satz 1: Spieler/in Nr. 15 wird ersetzt')
    expect(renumberRemarkText('le libéro n° 5 est déclaré inapte', map)).toBe('le libéro n° 15 est déclaré inapte')
    expect(renumberRemarkText('il libero n. 5 è dichiarato', map)).toBe('il libero n. 15 è dichiarato')
    expect(renumberRemarkText('#55 and #5', map)).toBe('#55 and #15')
  })

  it('snapshots: only the renumbered team\'s side', () => {
    const snap = { teamAKey: 'away', servingTeam: 'home', serverNumber: 5, lineupA: { I: { number: 5 } }, lineupB: { I: { number: 5 } } }
    const out = renumberSnapshot(snap, 'home', new Map([['5', '15']]))
    expect(out.lineupB.I.number).toBe(15)
    expect(out.lineupA.I.number).toBe(5)
    expect(out.serverNumber).toBe(15)
    expect(renumberSnapshot(snap, 'home', new Map([['8', '18']]))).toBeNull()
  })

  it('a roster that drops a number the record uses is noticed (Match setup roster editor)', () => {
    const { events } = matchWithFive()
    const roster = HOME_PLAYERS.map(p => (p.number === 5 ? { ...p, number: 15 } : p))
    expect(recordNumbersMissingFrom(events, 'home', roster)).toEqual(['5'])
    expect(recordNumbersMissingFrom(events, 'home', HOME_PLAYERS)).toEqual([])
    expect(recordNumbersMissingFrom([], 'home', roster)).toEqual([])
  })
})
