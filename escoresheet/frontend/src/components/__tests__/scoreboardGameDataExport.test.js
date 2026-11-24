/**
 * Match menu, "Download game data (JSON)": it wrote every table of the
 * device in plain JSON (every match's PINs, signatures, dates of birth) into
 * Downloads. Now this match only, through downloadMatchBackup: the app backup
 * file (utils/backupFile), which Restore match reads. Scoreboard.jsx is too
 * large to mount, so the source is checked for the wiring.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sb = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')

describe('the Match menu game data download', () => {
  const start = sb.indexOf('const downloadGameData = async () => {')
  const block = sb.slice(start, sb.indexOf('\n  }\n', start))

  it('is this match\'s backup file, never the whole database', () => {
    expect(start).toBeGreaterThan(-1)
    expect(block).toContain('await downloadMatchBackup(matchId)')
    expect(block).not.toMatch(/db\.\w+\.toArray\(\)/)
    expect(block).not.toContain('JSON.stringify')
    expect(sb).toMatch(/import \{[^}]*\bdownloadMatchBackup\b[^}]*\} from '\.\.\/utils\/backupManager'/)
  })
})
