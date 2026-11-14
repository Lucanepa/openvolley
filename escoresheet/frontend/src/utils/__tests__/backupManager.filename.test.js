// UI tour 14.11 (o19): "Download game data" saved
// backup_g921357_set2_scoreleft2_scoreright3 while the screen showed 3 on the
// left and 2 on the right: the numbers are the home and away points. The
// name says so now.
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db/db', () => ({ db: {} }))

import { generateBackupFilename } from '../backupManager'

describe('backup file name', () => {
  it('names the latest set\'s points home and away', () => {
    const name = generateBackupFilename({ match: { gameN: 921357 }, sets: [{ index: 1, homePoints: 25, awayPoints: 20 }, { index: 2, homePoints: 2, awayPoints: 3 }] })
    expect(name).toMatch(/^backup_g921357_set2_home2_away3_\d{8}_\d{4}\.json$/)
    expect(name).not.toMatch(/left|right/)
  })
})
