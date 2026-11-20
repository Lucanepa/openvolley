#!/usr/bin/env node

/**
 * The release version: calendar versions YY.M.N (owner 2026-11-20).
 *
 *   YY  the year's last two digits (26 = 2026)
 *   M   the month, 1 to 12, without a leading zero (semver, npm, Tauri and the
 *       Windows installer refuse "26.01.0")
 *   N   the release of that month, from 0: 26.11.0 is November 2026's first
 *       release, 26.11.1 its second; a new month starts again at 0
 *
 * Every calendar version is higher than the 3.x numbers before it (26 > 3), so
 * the App Store, Google Play, F-Droid, the desktop updater and the package
 * managers (winget, Homebrew, AUR, APT, Scoop, snap, Flatpak) all see it as an
 * update. Android: versionCode = (YY * 1000000 + M * 1000 + N) * 10, 26.11.0 =
 * 260110000, below Play's limit of 2100000000; a four-digit year would not fit,
 * hence YY. The month is the Zurich calendar's.
 *
 * Usage (from escoresheet/frontend):
 *   node scripts/bump-version.js                 the next version for today
 *   node scripts/bump-version.js --dry-run       print it, write nothing
 *   node scripts/bump-version.js --date 2026-12-03
 *   node scripts/bump-version.js --set 26.11.4   exactly this one (must be higher)
 *
 * Writes package.json, package-lock.json, public/version.json,
 * android/app/build.gradle (versionName, versionCode and the list in its
 * header) and src-tauri/Cargo.toml + Cargo.lock. Stages nothing: the release
 * commit does. The old commit-msg hook (scripts/hooks/commit-msg) still calls
 * this with the message file: it then does nothing, since versions no longer
 * move with every commit.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/

/** [major, minor, patch] of "a.b.c", else null. */
export function parseVersion (v) {
  const m = VERSION_RE.exec(String(v ?? '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** a > b, number by number. */
export function isHigher (a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

/** Android's versionCode for a version (android/app/build.gradle, androidBuild 0). */
export function androidVersionCode (v) {
  const p = parseVersion(v)
  if (!p) throw new Error(`not a version: ${v}`)
  return (p[0] * 1000000 + p[1] * 1000 + p[2]) * 10
}

/** { year: 2026, month: 11 } of `date` on the Zurich calendar. */
export function zurichYearMonth (date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: 'numeric' }).formatToParts(date)
  return { year: Number(parts.find((p) => p.type === 'year').value), month: Number(parts.find((p) => p.type === 'month').value) }
}

/**
 * The next calendar version after `current` for `date`: YY.M.0 in a new month,
 * else the same YY.M with N + 1. Never lower than `current`.
 */
export function nextCalendarVersion (current, date = new Date()) {
  const { year, month } = zurichYearMonth(date)
  const yy = year % 100
  const p = parseVersion(current)
  const next = p && p[0] === yy && p[1] === month ? `${yy}.${month}.${p[2] + 1}` : `${yy}.${month}.0`
  if (p && !isHigher(next, current)) throw new Error(`the next version ${next} is not higher than ${current}`)
  return next
}

/** Every version file a release changes, set to `version`; returns the paths written. */
export function writeVersionFiles (frontendDir, version) {
  const written = []
  const pkgPath = resolve(frontendDir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  pkg.version = version
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  written.push(pkgPath)

  const lockPath = resolve(frontendDir, 'package-lock.json')
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
    lock.version = version
    if (lock.packages?.['']) lock.packages[''].version = version
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')
    written.push(lockPath)
  }

  const versionJsonPath = resolve(frontendDir, 'public', 'version.json')
  writeFileSync(versionJsonPath, JSON.stringify({ version }) + '\n')
  written.push(versionJsonPath)

  // The Android literals (F-Droid's update checker reads them with a regex);
  // android/app/build.gradle fails the build if they drift from package.json.
  const gradlePath = resolve(frontendDir, 'android', 'app', 'build.gradle')
  if (existsSync(gradlePath)) {
    const code = androidVersionCode(version)
    let gradle = readFileSync(gradlePath, 'utf-8')
      .replace(/^def androidBuild = \d+$/m, 'def androidBuild = 0')
      .replace(/^(\s+)versionCode \d+$/m, `$1versionCode ${code}`)
      .replace(/^(\s+)versionName "[^"]*"$/m, `$1versionName "${version}"`)
    // the header's list of codes (the comment line with the "<version> -> <code>" pairs)
    gradle = gradle.replace(/^(\/\/ +1\.48\.20, androidBuild 0 -> 10480200;.*)$/m, (line) => line.includes(`; ${version} -> `) ? line : `${line}; ${version} -> ${code}`)
    writeFileSync(gradlePath, gradle)
    written.push(gradlePath)
  }

  // The desktop app's Rust package keeps the same version (Tauri reads package.json)
  const cargoPath = resolve(frontendDir, 'src-tauri', 'Cargo.toml')
  if (existsSync(cargoPath)) {
    const toml = readFileSync(cargoPath, 'utf-8')
    const name = /^\[package\][\s\S]*?^name = "([^"]+)"/m.exec(toml)?.[1]
    writeFileSync(cargoPath, toml.replace(/^(\[package\][\s\S]*?^version = )"[^"]*"/m, `$1"${version}"`))
    written.push(cargoPath)
    const cargoLockPath = resolve(frontendDir, 'src-tauri', 'Cargo.lock')
    if (name && existsSync(cargoLockPath)) {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const lock = readFileSync(cargoLockPath, 'utf-8')
      writeFileSync(cargoLockPath, lock.replace(new RegExp(`(\\[\\[package\\]\\]\\nname = "${esc}"\\nversion = )"[^"]*"`), `$1"${version}"`))
      written.push(cargoLockPath)
    }
  }
  return written
}

function main (argv) {
  const args = argv.slice(2)
  // the old commit-msg hook passes the message file: versions move at release time only
  if (args.length === 1 && !args[0].startsWith('--') && existsSync(args[0])) return 0
  const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
  const current = JSON.parse(readFileSync(resolve(frontendDir, 'package.json'), 'utf-8')).version
  let next
  if (opt('--set')) {
    next = opt('--set')
    if (!parseVersion(next)) { console.error(`--set: not a version: ${next}`); return 2 }
    if (!isHigher(next, current)) { console.error(`--set: ${next} is not higher than ${current}`); return 2 }
  } else {
    const dateArg = opt('--date')
    const date = dateArg ? new Date(`${dateArg}T12:00:00Z`) : new Date()
    if (Number.isNaN(date.getTime())) { console.error(`--date: not a date: ${dateArg}`); return 2 }
    next = nextCalendarVersion(current, date)
  }
  if (args.includes('--dry-run')) {
    console.log(`${current} -> ${next} (versionCode ${androidVersionCode(next)}; dry run)`)
    return 0
  }
  const files = writeVersionFiles(frontendDir, next)
  console.log(`${current} -> ${next} (versionCode ${androidVersionCode(next)})`)
  for (const f of files) console.log(`  wrote ${f}`)
  return 0
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) process.exitCode = main(process.argv)
