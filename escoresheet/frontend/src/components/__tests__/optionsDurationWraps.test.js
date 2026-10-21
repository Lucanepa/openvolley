// @vitest-environment node
/**
 * Options at 360 px with 130 % text: the set 2-3 interval's seconds field ran
 * half out of the dialog (two w-14 fields beside the label, no wrap). The row
 * wraps now and the fields keep to the right. jsdom lays nothing out:
 * measured in Chromium (Home > Options) at 360x800 130 %, 390x844 and 1280x800.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe.each(['HomeOptionsModal.jsx', 'ScoreboardOptionsModal.jsx'])('%s: the interval duration row', (file) => {
  const src = readFileSync(resolve(__dirname, '../options', file), 'utf8')
  it('wraps, the two fields to the right', () => {
    const at = src.indexOf('<DurationInput')
    const row = src.slice(src.lastIndexOf('<Row', at), at)
    expect(row).toMatch(/flexWrap: 'wrap'/)
    expect(src).toMatch(/<div className="ml-auto flex shrink-0 items-center gap-1 pl-4">/)
    expect(src).not.toMatch(/<div className="ml-4 flex items-center gap-1">/)
  })
})
