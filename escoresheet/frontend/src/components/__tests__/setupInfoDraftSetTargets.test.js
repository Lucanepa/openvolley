// @vitest-environment node
/**
 * A Global match's points per set (pointsRegular, pointsDeciding) belong to the
 * Match info draft (#145): the merge into rollout/fixes dropped them from the
 * draft keys, the draft's values and its restore setters, so a reload of the
 * info page reset a chosen 21/15 to 25/15.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const setup = readFileSync(resolve(__dirname, '../MatchSetup.jsx'), 'utf8')

describe('Match info draft keeps a Global match\'s set targets', () => {
  it('INFO_DRAFT_KEYS lists both', () => {
    const keys = setup.match(/const INFO_DRAFT_KEYS = \[([\s\S]*?)\]/)[1]
    expect(keys).toContain("'pointsRegular'")
    expect(keys).toContain("'pointsDeciding'")
  })

  it('the draft values carry both', () => {
    const values = setup.match(/const draftDataOf = \(view\) => \{[\s\S]*?const values = \{([\s\S]*?)\}/)[1]
    expect(values).toMatch(/\bpointsRegular\b/)
    expect(values).toMatch(/\bpointsDeciding\b/)
  })

  it('the restore has a setter for both', () => {
    expect(setup).toMatch(/pointsRegular: setPointsRegular/)
    expect(setup).toMatch(/pointsDeciding: setPointsDeciding/)
  })
})
