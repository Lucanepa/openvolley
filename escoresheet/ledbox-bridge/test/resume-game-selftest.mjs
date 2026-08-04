// The per-sport "last game" slot behind the New / Continue / Delete / Clock menu.
//
// The slot holds ONE in-progress match per sport so a power cut, a restart or a sport switch
// (which restarts the appliance) doesn't lose the score. It is emptied the moment a match is
// decided — that match is already in the history, and offering to continue a finished match is
// worse than offering nothing.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ResumeStore } from '../src/resumeStore.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-resume-'))
const file = path.join(tmp, 'data', 'resume.json')
const game = (over = {}) => ({
  team_a_name: 'KSCW', team_b_name: 'GAST',
  points_a: 12, points_b: 9, sets_won_a: 1, sets_won_b: 0,
  set_results: [{ a: 25, b: 21 }], ...over,
})

console.log('worthKeeping:')
ok(ResumeStore.worthKeeping(null) === false, 'null is not a game')
ok(ResumeStore.worthKeeping({ points_a: 0, points_b: 0 }) === false, 'an untouched 0-0 board is not a game')
ok(ResumeStore.worthKeeping({ points_a: 0, points_b: 1 }) === true, 'a single point makes it worth keeping')
ok(ResumeStore.worthKeeping({ sets_won_a: 1 }) === true, 'a won set makes it worth keeping')
ok(ResumeStore.worthKeeping({ team_a_name: 'KSCW' }) === true, 'named teams count — that setup is worth not retyping')
ok(ResumeStore.worthKeeping({ team_a_name: '   ' }) === false, 'whitespace-only names do not')
// The neutral board every `reset` emits. team_a_short defaults to a PLACEHOLDER, so counting
// shorts as "named" made this look like a game — and a reset then overwrote the real saved match
// with an empty board, which is exactly the match the operator reset in order to come back to.
const NEUTRAL = {
  team_a_name: '', team_a_short: 'HOME', team_b_name: '', team_b_short: 'AWAY',
  points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0, set_results: [],
}
ok(ResumeStore.worthKeeping(NEUTRAL) === false, 'a reset board is NOT a game, despite its HOME/AWAY placeholders')
ok(ResumeStore.worthKeeping({ ...NEUTRAL, team_a_short: 'A/A', team_b_short: 'B/B' }) === false, 'same for the beach placeholders')

console.log('\nsave / get / clear:')
const r = new ResumeStore({ file })
ok(r.has('volleyball') === false, 'nothing to continue on a fresh board')
r.save('volleyball', game(), '2026-08-04 11:40')
ok(r.has('volleyball') === true, 'saved')
ok(r.get('volleyball').points_a === 12, 'state round-trips')
ok(r.save('beach', { points_a: 0, points_b: 0 }, 'x') === false, 'an empty board is not saved')
ok(r.has('beach') === false, 'so beach still has nothing to continue')

console.log('\nper-sport isolation:')
r.save('beach', game({ team_a_name: 'DUO A', points_a: 4 }), '2026-08-04 11:41')
ok(r.get('volleyball').team_a_name === 'KSCW', 'volleyball keeps its own game')
ok(r.get('beach').team_a_name === 'DUO A', 'beach keeps its own game')
r.clear('volleyball')
ok(r.has('volleyball') === false, 'clearing one sport empties that slot')
ok(r.has('beach') === true, 'and leaves the other alone')

console.log('\npersistence across a restart:')
ok(fs.existsSync(file), 'written to disk')
const reopened = new ResumeStore({ file })
ok(reopened.get('beach').points_a === 4, 'a new process finds the game still there')

console.log('\nsavedAt vs updatedAt:')
const r2 = new ResumeStore({ file: path.join(tmp, 'data', 'r2.json') })
r2.save('volleyball', game({ points_a: 1 }), 'FIRST')
r2.save('volleyball', game({ points_a: 2 }), 'LATER')
ok(r2.games.volleyball.savedAt === 'FIRST', 'savedAt keeps when the match started')
ok(r2.games.volleyball.updatedAt === 'LATER', 'updatedAt tracks the latest point')

console.log('\na reset never clobbers a saved match:')
const r3 = new ResumeStore({ file: path.join(tmp, 'data', 'r3.json') })
r3.save('volleyball', game(), 'DURING')
ok(r3.save('volleyball', NEUTRAL, 'AFTER-RESET') === false, 'the neutral board is refused')
ok(r3.get('volleyball').points_a === 12, 'so the real match is still there to continue')

console.log('\nsummary (what the menu shows):')
const r2b = new ResumeStore({ file: path.join(tmp, 'data', 'r2b.json') })
// Typed full name + the default placeholder short — the shape the board is actually in.
r2b.save('volleyball', game({ team_a_name: 'KSCW', team_a_short: 'HOME', team_b_name: 'GAST', team_b_short: 'AWAY' }), 'now')
const sb = r2b.summary('volleyball')
ok(sb.teams.a === 'KSCW' && sb.teams.b === 'GAST', `prefers the typed name over the HOME/AWAY placeholder (${sb.teams.a} v ${sb.teams.b})`)
// Only the short was edited: still the best label available.
r2b.save('beach', game({ team_a_name: '', team_a_short: 'DUO', team_b_name: '', team_b_short: 'OPP' }), 'now')
ok(r2b.summary('beach').teams.a === 'DUO', 'falls back to the short when no full name was typed')

const s = r2.summary('volleyball')
ok(s.teams.a === 'KSCW' && s.teams.b === 'GAST', `names the teams (${s.teams.a} v ${s.teams.b})`)
ok(s.points.a === 2 && s.points.b === 9, 'carries the live points')
ok(s.sets.a === 1 && s.sets.b === 0, 'carries the set score')
ok(s.setsPlayed === 1, 'and how many sets are already in the book')
ok(r2.summary('basketball') === null, 'null when that sport has nothing saved')

console.log('\nunreadable file never throws:')
const bad = path.join(tmp, 'data', 'bad.json')
fs.writeFileSync(bad, 'not json{{')
let threw = false
try { new ResumeStore({ file: bad }) } catch { threw = true }
ok(threw === false, 'a corrupt slot degrades to "nothing to continue" instead of crashing scoring')

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
