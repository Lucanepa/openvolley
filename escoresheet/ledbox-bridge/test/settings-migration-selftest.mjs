// Verifies the per-sport settings refactor + the migration of an OLD FLAT settings.json (the shape
// the live board actually has) — nothing must be lost, and each sport keeps its own values.
import { Settings } from '../src/settings.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

// The board's real OLD FLAT settings.json (from its boot log).
const OLD_FLAT = {
  blinkPoint: true, blinkSub: true, blinkMs: 2000,
  timeoutSeconds: 30, setIntervalSeconds: 180, warmupSeconds: 600,
  countdownOnTimeout: true, countdownOnSetInterval: true, hornOnCountdownEnd: false,
  idleFullNames: true, idleFontMax: 24, brightness: 0,
  totalTimeouts: 2, totalSubs: 6, bestOf: 5,
  sport: 'volleyball', clubName: 'KSC WIEDIKON', scorerPin: '2026',
  branding: 'kscw', liveScoring: 'off',
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-settings-'))
const file = path.join(dir, 'settings.json')
fs.writeFileSync(file, JSON.stringify(OLD_FLAT, null, 2))

console.log("migrating the board's old flat settings.json:")
const s = new Settings(file)

// nothing lost
ok(s.values.brightness === 0, 'brightness 0 preserved')
ok(s.values.scorerPin === '2026', 'scorerPin 2026 preserved (board stays locked)')
ok(s.values.sport === 'volleyball', 'sport volleyball preserved')
ok(s.values.clubName === 'KSC WIEDIKON', 'clubName preserved')
ok(s.values.branding === 'kscw' && s.values.liveScoring === 'off', 'branding/liveScoring preserved')
ok(s.values.timeoutSeconds === 30, 'volleyball timeoutSeconds 30 preserved')
ok(s.values.setIntervalSeconds === 180, 'volleyball setInterval 180 preserved')
ok(s.values.totalTimeouts === 2 && s.values.totalSubs === 6, 'volleyball allowances preserved')
ok(s.values.bestOf === 5, 'volleyball bestOf 5 preserved')
ok(s.values.hornOnCountdownEnd === false, 'volleyball hornOnCountdownEnd=false preserved')
ok(s.values.ttoSeconds === 0, 'new ttoSeconds defaults to 0 for volleyball')

// on-disk shape migrated
const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
ok(disk.perSport && disk.perSport.volleyball && disk.perSport.beach && disk.perSport.basketball, 'disk now { global, perSport:{v,b,bb} }')
ok(disk.scorerPin === '2026' && disk.brightness === 0, 'global keys stay at top level on disk')
ok(disk.perSport.volleyball.timeoutSeconds === 30, 'volleyball per-sport keys under perSport.volleyball')
ok(!('timeoutSeconds' in disk), 'per-sport keys removed from top level')

// each sport keeps its own
const beach = s.forSport('beach')
ok(beach.timeoutSeconds === 60 && beach.ttoSeconds === 60 && beach.totalTimeouts === 1 && beach.totalSubs === 0 && beach.bestOf === 3, 'beach defaults (1′ TO+TTO, best-of-3, no subs)')
ok(beach.scorerPin === '2026' && beach.brightness === 0, 'forSport carries the global keys')
const bb = s.forSport('basketball')
ok(bb.totalTimeouts === 5 && bb.totalSubs === 5, 'basketball defaults (5 TO, bonus at 5 fouls)')

// editing the ACTIVE sport routes there only
s.update({ timeoutSeconds: 45 })
ok(s.values.timeoutSeconds === 45, 'edit active-sport timeout -> merged view')
ok(s.forSport('beach').timeoutSeconds === 60, 'beach timeout untouched by editing volleyball')
const disk2 = JSON.parse(fs.readFileSync(file, 'utf8'))
ok(disk2.perSport.volleyball.timeoutSeconds === 45 && disk2.perSport.beach.timeoutSeconds === 60, 'routed to perSport.volleyball on disk')

// a global edit is shared across sports
s.update({ brightness: 55 })
ok(s.forSport('beach').brightness === 55 && s.forSport('volleyball').brightness === 55, 'global brightness shared by all sports')

// reload the new-shape file is stable (idempotent)
const s2 = new Settings(file)
ok(s2.values.timeoutSeconds === 45 && s2.values.brightness === 55 && s2.values.scorerPin === '2026', 'reload of migrated file is stable')

// A patch that changes the sport AND carries per-sport values must NOT write those values into
// the INCOMING sport. A settings form is always rendered under the sport that was active when it
// loaded, so its numbers belong to THAT sport. Routing them by the post-patch sport let beach's
// 60s timeout/interval overwrite volleyball's 30/180 on disk — permanently, and invisibly.
console.log('\nsport change + per-sport values in one patch:')
s.update({ sport: 'beach' })
ok(s.values.sport === 'beach', 'switched active sport to beach')
const volleyBefore = s.forSport('volleyball').timeoutSeconds
s.update({ sport: 'volleyball', timeoutSeconds: 60, setIntervalSeconds: 60 })
ok(s.values.sport === 'volleyball', 'switched active sport back to volleyball')
ok(s.forSport('volleyball').timeoutSeconds === volleyBefore,
  `volleyball timeout NOT clobbered by the outgoing sport (${volleyBefore}s kept)`)
ok(s.forSport('volleyball').setIntervalSeconds === 180, 'volleyball set interval still 180s')
ok(s.forSport('beach').timeoutSeconds === 60, 'the values landed on beach, the sport the form was rendered under')

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
