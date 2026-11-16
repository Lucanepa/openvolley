import { describe, it, expect } from 'vitest'
import { REBUILT_AFTER_MATCH, rebuildRemark } from '../sheetRemarks'

describe('rebuildRemark (an admin\'s "Rebuild PDF", owner 2026-11-16)', () => {
  it('says the sheet was drawn again, when (Zurich) and why', () => {
    const at = new Date('2026-11-16T09:05:00Z') // 10:05 in Zurich
    expect(rebuildRemark('  Set start\ntimes corrected ', at)).toBe(`${REBUILT_AFTER_MATCH}: 16.11.2026, 10:05 - Set start times corrected`)
    expect(rebuildRemark('', at)).toBe('Rebuilt after the match: 16.11.2026, 10:05')
  })
})
