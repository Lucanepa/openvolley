import { describe, it, expect } from 'vitest'
import {
  autoPlaysAs, officialPlaysAs, playerOfficialLinks, playsAsOf, rolesOfPlayer,
  officialChipState, benchNumberState, sanctionMember, sanctionPlays,
  withPlays, playsChoice, renumberPlays, playsValue
} from '../playerOfficials'
import { samePersonInMatch } from '../teamRosters'
import {
  memberSanctionOptions, validateMemberSanction, heaviestMemberSanction,
  sanctionedPlayerNumber, memberSentOff
} from '../sanctions'
import { isSentOff, substitutionIllegalReason } from '../interruptionRequests'
import { playerPlayStatus } from '../rosterLive'
import { lineupEntryErrors } from '../lineupEntry'
import { playersAvailableForNextSet } from '../matchEnd'
import { sanctionTarget } from '../describe'

// A playing coach (owner 2026-11-22): #7 Erik Fischer is also the coach
const players = [
  { number: 1, firstName: 'Luca', lastName: 'Keller', dob: '100211' },
  { number: 7, firstName: 'Erik', lastName: 'Fischer', dob: '100544' },
  { number: 8, firstName: 'Ben', lastName: 'Wenger', dob: '' },
  { number: 9, firstName: 'Hans', lastName: 'Muster', dob: '' },
  { number: 10, firstName: 'Hans', lastName: 'Muster', dob: '' }
]
const coach = { role: 'Coach', firstName: 'Erik', lastName: 'Fischer', dob: '100544' }

describe('samePersonInMatch (teamRosters samePerson for match rows)', () => {
  it('the same licence is the same person, a different licence is not', () => {
    expect(samePersonInMatch(coach, players[1])).toBe(true)
    expect(samePersonInMatch({ ...coach, dob: '999999' }, players[1])).toBe(false)
  })
  it('without a licence on one side: the same name, also swapped, accents and case aside', () => {
    expect(samePersonInMatch({ role: 'Coach', firstName: 'ben', lastName: 'WENGER' }, players[2])).toBe(true)
    expect(samePersonInMatch({ role: 'Coach', firstName: 'Wenger', lastName: 'Ben' }, players[2])).toBe(true)
    expect(samePersonInMatch({ role: 'Coach', firstName: 'Erik', lastName: 'Fischer', dob: '' }, players[1])).toBe(true)
    expect(samePersonInMatch({ role: 'Coach', firstName: 'Bén', lastName: 'Wénger' }, players[2])).toBe(true)
  })
  it('two different dates of birth are two people; an empty row is nobody', () => {
    expect(samePersonInMatch({ firstName: 'Ben', lastName: 'Wenger', dob: '01.02.1990' }, { firstName: 'Ben', lastName: 'Wenger', dob: '01.02.1991' })).toBe(false)
    expect(samePersonInMatch({ firstName: 'Ben', lastName: 'Wenger', dob: '01.02.1990' }, { firstName: 'Ben', lastName: 'Wenger', dob: '1990-02-01' })).toBe(true)
    expect(samePersonInMatch({ role: 'Coach', firstName: '', lastName: '' }, { number: 3, firstName: '', lastName: '' })).toBe(false)
    expect(samePersonInMatch({ role: 'Coach', firstName: 'X' }, { number: 3, firstName: 'X' })).toBe(false)
  })
})

describe('the link (plays)', () => {
  it('automatic: the one player who is the same person', () => {
    expect(autoPlaysAs(coach, players)).toBe(7)
    expect(officialPlaysAs(coach, players)).toBe(7)
    // two players of that name: no automatic link
    expect(autoPlaysAs({ role: 'Coach', firstName: 'Hans', lastName: 'Muster' }, players)).toBe(null)
    expect(autoPlaysAs({ role: 'Coach', firstName: 'Anna', lastName: 'Frei' }, players)).toBe(null)
  })
  it('the scorer\'s choice: a number of the team, or not the same person', () => {
    expect(officialPlaysAs({ ...coach, plays: false }, players)).toBe(null)
    expect(officialPlaysAs({ role: 'Coach', firstName: 'Hans', lastName: 'Muster', plays: 10 }, players)).toBe(10)
    expect(officialPlaysAs({ role: 'Coach', firstName: 'Anna', lastName: 'Frei', plays: '8' }, players)).toBe(8)
    // a number no player wears links nobody
    expect(officialPlaysAs({ role: 'Coach', firstName: 'Anna', lastName: 'Frei', plays: 99 }, players)).toBe(null)
    expect(playsValue({ plays: '' })).toBe(undefined)
    expect(playsValue({ plays: null })).toBe(undefined)
  })
  it('every linked official of a bench; two roles of one person name the same number', () => {
    const bench = [
      coach,
      { role: 'Assistant Coach 1', firstName: 'Jan', lastName: 'Widmer', dob: '100174' },
      { role: 'Assistant Coach 2', firstName: 'Luca', lastName: 'Keller', dob: '100211' },
      { role: 'Medic', firstName: 'Luca', lastName: 'Keller', dob: '100211' }
    ]
    const links = playerOfficialLinks(bench, players)
    expect(links).toEqual([{ role: 'Coach', number: 7 }, { role: 'Assistant Coach 2', number: 1 }, { role: 'Medic', number: 1 }])
    expect(playsAsOf(links, 'Coach')).toBe(7)
    expect(playsAsOf(links, 'Assistant Coach 1')).toBe(null)
    expect(rolesOfPlayer(links, '1')).toEqual(['Assistant Coach 2', 'Medic'])
    expect(rolesOfPlayer(links, 8)).toEqual([])
  })
  it('the editor: its value, the choice written back, a renumbered player', () => {
    expect(playsChoice(coach, players)).toEqual({ value: '7', auto: true })
    expect(playsChoice({ ...coach, plays: false }, players)).toEqual({ value: 'none', auto: false })
    expect(playsChoice({ role: 'Coach', firstName: 'Anna', lastName: 'Frei' }, players)).toEqual({ value: '', auto: false })
    expect(playsChoice({ role: 'Coach', firstName: 'Anna', lastName: 'Frei', plays: 8 }, players)).toEqual({ value: '8', auto: false })
    expect(withPlays(coach, 'none')).toEqual({ ...coach, plays: false })
    expect(withPlays(coach, '9')).toEqual({ ...coach, plays: 9 })
    expect(withPlays({ ...coach, plays: 9 }, '')).toEqual(coach)
    const bench = [{ role: 'Coach', plays: 7 }, { role: 'Medic', plays: false }, { role: 'Assistant Coach 1' }]
    expect(renumberPlays(bench, [{ from: 7, to: 17 }])).toEqual([{ role: 'Coach', plays: 17 }, { role: 'Medic', plays: false }, { role: 'Assistant Coach 1' }])
  })
})

describe('where he is decides the role (greyed chips)', () => {
  const links = [{ role: 'Coach', number: 7 }]
  it('on court: the official\'s chip is greyed', () => {
    expect(officialChipState(links, 'Coach', { onCourt: ['1', '2', '3', '4', '5', '7'] })).toEqual({ playsAs: 7, onCourt: true })
    expect(officialChipState(links, 'Coach', { onCourt: [1, 2, 3, 4, 5, 6] })).toEqual({ playsAs: 7, onCourt: false })
    // an official who does not play is never greyed
    expect(officialChipState(links, 'Medic', { onCourt: [7] })).toEqual({ playsAs: null, onCourt: false })
  })
  it('replaced by the libero he is still the player', () => {
    expect(officialChipState(links, 'Coach', { onCourt: [1, 2, 3, 4, 5, 12], replacedByLibero: ['7'] }).onCourt).toBe(true)
    expect(benchNumberState(links, 7, { onCourt: [1, 2, 3, 4, 5, 12], replacedByLibero: [7] })).toEqual({ roles: ['Coach'], asOfficial: null })
  })
  it('on the bench (or before the line-up): his number is greyed, the official acts', () => {
    expect(benchNumberState(links, 7, { onCourt: [1, 2, 3, 4, 5, 6] })).toEqual({ roles: ['Coach'], asOfficial: 'Coach' })
    expect(benchNumberState(links, 7, {})).toEqual({ roles: ['Coach'], asOfficial: 'Coach' })
    expect(benchNumberState(links, 8, { onCourt: [1, 2, 3, 4, 5, 6] })).toEqual({ roles: [], asOfficial: null })
  })
})

describe('sanctions count for the person (FIVB 21.4.2)', () => {
  const links = [{ role: 'Coach', number: 7 }]
  const ev = (seq, payload, setIndex = 1) => ({ type: 'sanction', seq, setIndex, payload: { team: 'home', ...payload } })
  const coachPenalty = ev(1, { type: 'penalty', playerType: 'official', role: 'Coach', ...sanctionPlays(links, { type: 'official', role: 'Coach' }) })

  it('an official\'s sanction records the number he plays with; a player\'s nothing more', () => {
    expect(sanctionPlays(links, { type: 'official', role: 'Coach' })).toEqual({ plays: 7 })
    expect(sanctionPlays(links, { type: 'official', role: 'Medic' })).toEqual({})
    expect(sanctionPlays(links, { type: 'player', playerNumber: 7 })).toEqual({})
    expect(sanctionMember(links, { team: 'home', playerNumber: 7 })).toEqual({ team: 'home', playerNumber: 7, alsoRoles: ['Coach'] })
    expect(sanctionMember(links, { team: 'home', role: 'Coach' })).toEqual({ team: 'home', role: 'Coach', plays: 7 })
    expect(sanctionMember(links, { team: 'home', playerNumber: 8 })).toEqual({ team: 'home', playerNumber: 8 })
  })

  it('a penalty on C, then #7: no second penalty, nothing lighter; expulsion is offered', () => {
    const member = sanctionMember(links, { team: 'home', playerNumber: 7 })
    expect(validateMemberSanction([coachPenalty], { ...member, type: 'penalty' })).toEqual({ legal: false, reason: 'sameSanctionTwice' })
    const options = memberSanctionOptions([coachPenalty], member)
    expect(options.penalty.legal).toBe(false)
    expect(options.expulsion.legal).toBe(true)
    expect(heaviestMemberSanction([coachPenalty], member)).toBe('penalty')
    // the event's own number counts without the roster's link too
    expect(validateMemberSanction([coachPenalty], { team: 'home', playerNumber: 7, type: 'penalty' }).reason).toBe('sameSanctionTwice')
    // another player is another member
    expect(memberSanctionOptions([coachPenalty], { team: 'home', playerNumber: 8 }).penalty.legal).toBe(true)
  })

  it('an expulsion of #7, then C: only the disqualification', () => {
    const events = [ev(1, { type: 'expulsion', playerType: 'player', playerNumber: 7, position: 'IV' })]
    const member = sanctionMember(links, { team: 'home', role: 'Coach' })
    const options = memberSanctionOptions(events, member)
    expect(options.penalty).toEqual({ legal: false, reason: 'lighterSanction', heaviest: 'expulsion' })
    expect(options.expulsion.legal).toBe(false)
    expect(options.disqualification.legal).toBe(true)
    // without the link the coach is someone else
    expect(memberSanctionOptions(events, { team: 'home', role: 'Coach' }).penalty.legal).toBe(true)
  })

  it('the team warning once and the delay ladder are unchanged', () => {
    const events = [ev(1, { type: 'warning', playerType: 'player', playerNumber: 3 }), ev(2, { type: 'delay_warning' })]
    expect(validateMemberSanction(events, { ...sanctionMember(links, { team: 'home', role: 'Coach' }), type: 'warning' }).reason).toBe('teamAlreadyWarned')
    expect(memberSanctionOptions(events, sanctionMember(links, { team: 'home', role: 'Coach' })).penalty.legal).toBe(true)
  })

  it('a disqualified coach is out as #7 for the match, an expelled one for the set', () => {
    const dq = ev(1, { type: 'disqualification', playerType: 'official', role: 'Coach', plays: 7 })
    expect(sanctionedPlayerNumber(dq.payload)).toBe(7)
    expect(sanctionedPlayerNumber({ playerType: 'official', role: 'Medic' })).toBe(null)
    expect(sanctionedPlayerNumber({ playerType: 'player', playerNumber: 3 })).toBe(3)
    expect(isSentOff([dq], 'home', 7, 3)).toBe(true)
    expect(playerPlayStatus([dq], 'home', { number: 7 }, 2).out).toBe('disqualified')
    expect(playersAvailableForNextSet(players, [dq], 'home').map(p => p.number)).not.toContain(7)
    expect(lineupEntryErrors({ lineup: ['7', '1', '8', '9', '10', '2'], players: [...players, { number: 2 }], events: [dq], team: 'home', setIndex: 2 })[0]).toBe('disqualified')

    const ex = ev(1, { type: 'expulsion', playerType: 'official', role: 'Coach', plays: 7 }, 2)
    expect(isSentOff([ex], 'home', 7, 2)).toBe(true)
    expect(isSentOff([ex], 'home', 7, 3)).toBe(false)
    expect(playerPlayStatus([ex], 'home', { number: 7 }, 2).out).toBe('expelled')
    // he cannot come in as a substitute in that set
    const lineup = { type: 'lineup', seq: 0, setIndex: 2, payload: { team: 'home', isInitial: true, lineup: { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' } } }
    expect(substitutionIllegalReason([lineup, ex], 2, 'home', { playerOut: 4, playerIn: 7 }, { players })).toBe('sent_off')
  })

  it('the person sent off in either role (memberSentOff)', () => {
    const ex = ev(1, { type: 'expulsion', playerType: 'player', playerNumber: 7 }, 2)
    expect(memberSentOff([ex], sanctionMember(links, { team: 'home', role: 'Coach' }), 2)).toBe('expelled')
    expect(memberSentOff([ex], sanctionMember(links, { team: 'home', role: 'Coach' }), 3)).toBe(null)
    expect(memberSentOff([ex], { team: 'home', role: 'Coach' }, 2)).toBe(null)
    const dq = ev(2, { type: 'disqualification', playerType: 'official', role: 'Coach', plays: 7 })
    expect(memberSentOff([dq], { team: 'home', playerNumber: 7 }, 4)).toBe('disqualified')
  })

  it('the remarks and lists name the role he had: "Coach (#7)"', () => {
    expect(sanctionTarget({ type: 'warning', playerType: 'official', role: 'Coach', plays: 7 }).label).toBe('Coach (#7)')
    expect(sanctionTarget({ type: 'warning', playerType: 'official', role: 'Coach', plays: 7 }).code).toBe('C')
    expect(sanctionTarget({ type: 'warning', playerType: 'official', role: 'Coach' }).label).toBe('Coach')
  })
})
