// The live sanction blocks against the FIVB sanction scale (Official
// Volleyball Rules 2025-2028, 21.1-21.4, 16.2, 15.11), owner decision 12
// (23.11.2026): the blocks stay hard blocks and follow the scale exactly.
//  - 21.1: the formal warning (yellow card) is given once per team in the
//    match: the team has then reached the sanctioning level, and the next
//    minor misconduct of any of its members is a penalty;
//  - 21.3 / 21.4.2: misconduct sanctions are individual and remain for the
//    match; the same member's next offence gets a heavier sanction
//    (warning < penalty < expulsion < disqualification), so never the same
//    one twice and never a lighter one (a yellow after a red, an expulsion
//    or a disqualification);
//  - 21.4.3: an expulsion or a disqualification needs no earlier sanction;
//  - 16.2 / 15.11: delays and improper requests are team sanctions on their
//    own ladder, outside the member scale.
// Every case below was checked against domain/sanctions as it was: none of
// its blocks contradicts the scale, so sanctions.test.js pins nothing that
// had to change. What the menus offer (memberSanctionOptions) is what
// confirmPlayerSanction lets through (validateMemberSanction).
import { describe, it, expect } from 'vitest'
import { validateMemberSanction, memberSanctionOptions, resolveSanction, teamSanctionCounts } from '../sanctions'
import en from '../../i18n/locales/en.json'

const player = (seq, team, playerNumber, type, setIndex = 1) => ({ seq, setIndex, type: 'sanction', payload: { team, type, playerType: 'player', playerNumber } })
const official = (seq, team, role, type, extra = {}) => ({ seq, setIndex: 1, type: 'sanction', payload: { team, type, playerType: 'official', role, ...extra } })
const teamSanction = (seq, team, type) => ({ seq, setIndex: 1, type: 'sanction', payload: { team, type } })
const offered = (events, member) => Object.entries(memberSanctionOptions(events, member)).filter(([, v]) => v.legal).map(([k]) => k)

// [the case, the events before, the member, the sanction asked, legal?, the block]
const SCALE = [
  // the team warning, once per team per match (21.1)
  ['a second yellow to another member of a warned team', [player(1, 'home', 5, 'warning')], { team: 'home', playerNumber: 7 }, 'warning', false, 'teamAlreadyWarned'],
  ['a second yellow to the same member', [player(1, 'home', 5, 'warning')], { team: 'home', playerNumber: 5 }, 'warning', false, 'sameSanctionTwice'],
  ['a yellow to an official of a team whose player was warned', [player(1, 'home', 5, 'warning')], { team: 'home', role: 'Coach' }, 'warning', false, 'teamAlreadyWarned'],
  ['the warned team\'s next minor misconduct: a penalty', [player(1, 'home', 5, 'warning')], { team: 'home', playerNumber: 7 }, 'penalty', true],
  ['the other team may still be warned', [player(1, 'home', 5, 'warning')], { team: 'away', playerNumber: 7 }, 'warning', true],
  ['a warning in an earlier set counts for the match', [player(1, 'home', 5, 'warning', 1)], { team: 'home', playerNumber: 8 }, 'warning', false, 'teamAlreadyWarned'],
  // never lighter than the member's heaviest (21.4.2)
  ['a yellow after a red', [player(1, 'away', 6, 'penalty')], { team: 'away', playerNumber: 6 }, 'warning', false, 'lighterSanction'],
  ['a yellow after an expulsion', [player(1, 'away', 6, 'expulsion')], { team: 'away', playerNumber: 6 }, 'warning', false, 'lighterSanction'],
  ['a yellow after a disqualification', [player(1, 'away', 6, 'disqualification')], { team: 'away', playerNumber: 6 }, 'warning', false, 'lighterSanction'],
  ['a red after an expulsion (an earlier set)', [player(1, 'away', 6, 'expulsion', 1)], { team: 'away', playerNumber: 6 }, 'penalty', false, 'lighterSanction'],
  ['a red after a disqualification', [player(1, 'away', 6, 'disqualification')], { team: 'away', playerNumber: 6 }, 'penalty', false, 'lighterSanction'],
  ['an expulsion after a disqualification', [player(1, 'away', 6, 'disqualification')], { team: 'away', playerNumber: 6 }, 'expulsion', false, 'lighterSanction'],
  ['an official\'s yellow after his red', [official(1, 'away', 'Coach', 'penalty')], { team: 'away', role: 'Coach' }, 'warning', false, 'lighterSanction'],
  // never the same twice (21.4.2: heavier for each successive offence)
  ['a second red to the same member', [player(1, 'away', 6, 'penalty')], { team: 'away', playerNumber: 6 }, 'penalty', false, 'sameSanctionTwice'],
  ['a second expulsion (a later set)', [player(1, 'away', 6, 'expulsion', 1)], { team: 'away', playerNumber: 6 }, 'expulsion', false, 'sameSanctionTwice'],
  // legal escalations (21.3.2.3, 21.3.3.3, 21.3.3.4)
  ['warning, then a red', [player(1, 'home', 3, 'warning')], { team: 'home', playerNumber: 3 }, 'penalty', true],
  ['a red, then an expulsion (second rude conduct)', [player(1, 'home', 3, 'penalty')], { team: 'home', playerNumber: 3 }, 'expulsion', true],
  ['an expulsion, then a disqualification', [player(1, 'home', 3, 'penalty'), player(2, 'home', 3, 'expulsion', 2)], { team: 'home', playerNumber: 3 }, 'disqualification', true],
  ['a yellow, then straight to a disqualification', [player(1, 'home', 3, 'warning')], { team: 'home', playerNumber: 3 }, 'disqualification', true],
  // no earlier sanction needed (21.4.3)
  ['a first expulsion', [], { team: 'home', playerNumber: 9 }, 'expulsion', true],
  ['a first disqualification', [], { team: 'home', playerNumber: 9 }, 'disqualification', true],
  ['a first red', [], { team: 'home', playerNumber: 9 }, 'penalty', true],
  // a red to another member does not spend the team warning (the owner's
  // decision names the same member only; question open, see the notes)
  ['a yellow to a member of a team whose other member has a red', [player(1, 'home', 5, 'penalty')], { team: 'home', playerNumber: 7 }, 'warning', true],
  // delays and improper requests are team sanctions (16.2, 15.11)
  ['a yellow after the team\'s delay warning', [teamSanction(1, 'home', 'delay_warning')], { team: 'home', playerNumber: 4 }, 'warning', true],
  ['a yellow after the team\'s delay penalty and improper request', [teamSanction(1, 'home', 'delay_penalty'), teamSanction(2, 'home', 'improper_request')], { team: 'home', playerNumber: 4 }, 'warning', true],
  // one member in two roles: a playing coach (#7) is one member
  ['the playing coach\'s yellow as #7 after his red as the coach', [official(1, 'home', 'Coach', 'penalty', { plays: 7 })], { team: 'home', playerNumber: 7, alsoRoles: ['Coach'] }, 'warning', false, 'lighterSanction']
]

describe('the member sanction blocks follow the FIVB scale (21.1, 21.3, 21.4)', () => {
  it.each(SCALE)('%s', (_name, prior, member, type, legal, reason) => {
    const v = validateMemberSanction(prior, { ...member, type })
    expect(v.legal).toBe(legal)
    if (!legal) expect(v.reason).toBe(reason)
    // the menus offer exactly what the confirmation lets through
    expect(memberSanctionOptions(prior, member)[type].legal).toBe(legal)
  })

  it('a warned team\'s member is offered a penalty, never the warning (the next minor misconduct)', () => {
    const events = [player(1, 'home', 5, 'warning')]
    expect(offered(events, { team: 'home', playerNumber: 7 })).toEqual(['penalty', 'expulsion', 'disqualification'])
    // and the scorer is told why, in every language (scoreboard.dialogs.teamAlreadyWarned)
    expect(en.scoreboard.dialogs.teamAlreadyWarned).toMatch(/next minor misconduct is a penalty/)
  })

  it('the member\'s menu after each step of the scale', () => {
    const steps = [player(1, 'away', 6, 'warning'), player(2, 'away', 6, 'penalty'), player(3, 'away', 6, 'expulsion'), player(4, 'away', 6, 'disqualification')]
    const member = { team: 'away', playerNumber: 6 }
    expect(offered([], member)).toEqual(['warning', 'penalty', 'expulsion', 'disqualification'])
    expect(offered(steps.slice(0, 1), member)).toEqual(['penalty', 'expulsion', 'disqualification'])
    expect(offered(steps.slice(0, 2), member)).toEqual(['expulsion', 'disqualification'])
    expect(offered(steps.slice(0, 3), member)).toEqual(['disqualification'])
    expect(offered(steps, member)).toEqual([])
  })
})

describe('the team ladders (16.2 delays, 15.11 improper requests)', () => {
  it.each([
    ['the first delay is a delay warning', [], 'delay_penalty', 'delay_warning'],
    ['every further delay is a delay penalty', [teamSanction(1, 'home', 'delay_warning')], 'delay_warning', 'delay_penalty'],
    ['and after a delay penalty too', [teamSanction(1, 'home', 'delay_warning'), teamSanction(2, 'home', 'delay_penalty')], 'delay_warning', 'delay_penalty'],
    ['the first improper request: recorded, no other consequence', [], 'improper_request', 'improper_request'],
    ['a further improper request is a delay (warning first)', [teamSanction(1, 'home', 'improper_request')], 'improper_request', 'delay_warning'],
    ['a further improper request after a delay warning: a delay penalty', [teamSanction(1, 'home', 'improper_request'), teamSanction(2, 'home', 'delay_warning')], 'improper_request', 'delay_penalty'],
    ['misconduct does not count on the delay ladder', [player(1, 'home', 5, 'penalty'), player(2, 'home', 6, 'warning')], 'delay_warning', 'delay_warning']
  ])('%s', (_name, prior, requested, expected) => {
    expect(resolveSanction(requested, teamSanctionCounts(prior, 'home'))).toBe(expected)
  })
})
