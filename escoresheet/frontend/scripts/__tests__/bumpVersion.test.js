import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { nextCalendarVersion, androidVersionCode, isHigher, writeVersionFiles } from '../bump-version.js'

const at = (iso) => new Date(iso)

describe('calendar versions YY.M.N', () => {
  it('the first calendar version after 3.x is the month .0', () => {
    expect(nextCalendarVersion('3.5.1', at('2026-11-20T10:00:00Z'))).toBe('26.11.0')
  })
  it('the same month counts up, a new month starts again at 0, January has no leading zero', () => {
    expect(nextCalendarVersion('26.11.0', at('2026-11-28T10:00:00Z'))).toBe('26.11.1')
    expect(nextCalendarVersion('26.11.4', at('2026-12-01T10:00:00Z'))).toBe('26.12.0')
    expect(nextCalendarVersion('26.12.2', at('2027-01-03T10:00:00Z'))).toBe('27.1.0')
  })
  it('the month is the Zurich calendar’s (23:30 UTC on 30 November is already December there)', () => {
    expect(nextCalendarVersion('26.11.3', at('2026-11-30T23:30:00Z'))).toBe('26.12.0')
  })
  it('never goes down', () => {
    expect(() => nextCalendarVersion('27.1.0', at('2026-12-15T10:00:00Z'))).toThrow(/not higher/)
  })
  it('Android codes keep growing and stay below Play’s limit', () => {
    expect(androidVersionCode('3.5.1')).toBe(30050010)
    expect(androidVersionCode('26.11.0')).toBe(260110000)
    expect(androidVersionCode('26.11.0')).toBeGreaterThan(androidVersionCode('3.5.1'))
    expect(androidVersionCode('27.1.0')).toBeGreaterThan(androidVersionCode('26.12.9'))
    expect(androidVersionCode('99.12.999')).toBeLessThan(2100000000)
    expect(isHigher('26.11.0', '3.5.1')).toBe(true)
    expect(isHigher('26.1.0', '26.11.0')).toBe(false)
  })
  it('writes every version file a release changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-bump-'))
    mkdirSync(join(dir, 'public')); mkdirSync(join(dir, 'android', 'app'), { recursive: true }); mkdirSync(join(dir, 'src-tauri'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '3.5.1' }))
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: 'x', version: '3.5.1', packages: { '': { name: 'x', version: '3.5.1' } } }))
    writeFileSync(join(dir, 'public', 'version.json'), '{"version":"3.5.1"}\n')
    writeFileSync(join(dir, 'android', 'app', 'build.gradle'), '//   1.48.20, androidBuild 0 -> 10480200; 3.5.1 -> 30050010\ndef androidBuild = 0\n        versionCode 30050010\n        versionName "3.5.1"\n')
    writeFileSync(join(dir, 'src-tauri', 'Cargo.toml'), '[package]\nname = "app-x"\nversion = "3.5.1"\n\n[dependencies]\nserde = { version = "1" }\n')
    writeFileSync(join(dir, 'src-tauri', 'Cargo.lock'), '[[package]]\nname = "app-x"\nversion = "3.5.1"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\n')
    writeVersionFiles(dir, '26.11.0')
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version).toBe('26.11.0')
    const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'))
    expect([lock.version, lock.packages[''].version]).toEqual(['26.11.0', '26.11.0'])
    expect(readFileSync(join(dir, 'public', 'version.json'), 'utf8')).toBe('{"version":"26.11.0"}\n')
    const gradle = readFileSync(join(dir, 'android', 'app', 'build.gradle'), 'utf8')
    expect(gradle).toContain('versionCode 260110000')
    expect(gradle).toContain('versionName "26.11.0"')
    expect(gradle).toContain('3.5.1 -> 30050010; 26.11.0 -> 260110000')
    expect(readFileSync(join(dir, 'src-tauri', 'Cargo.toml'), 'utf8')).toContain('version = "26.11.0"\n\n[dependencies]\nserde = { version = "1" }')
    const cargoLock = readFileSync(join(dir, 'src-tauri', 'Cargo.lock'), 'utf8')
    expect(cargoLock).toContain('name = "app-x"\nversion = "26.11.0"')
    expect(cargoLock).toContain('name = "serde"\nversion = "1.0.0"')
  })
})
