// Perf pass 22.11.2026: every place that opened the scoresheet stringified
// the whole match (every event with its snapshot, ~1 MB at match end) into
// sessionStorage, and the page parsed it, although ?matchId= in the URL made
// the page read this device's database and never look at the copy. On the
// Android app that ran on the scorer's own thread at every open and at the
// approval. The openers now put only ?matchId= in the URL.
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8')
const OPENERS = ['components/Scoreboard.jsx', 'components/MatchEnd.jsx', 'components/MatchSetup.jsx', 'components/CoinToss.jsx', 'App.jsx']

describe('the scoresheet openers', () => {
  it.each(OPENERS)('%s writes no copy of the match into sessionStorage', (file) => {
    expect(read(file)).not.toMatch(/scoresheetData/)
  })

  it.each(OPENERS)('%s names the match in every scoresheet URL it opens', (file) => {
    const urls = read(file).match(/openAppWindow\(\s*`\/scoresheet\/[^`]*`/g) || []
    for (const url of urls) expect(url).toMatch(/^openAppWindow\(\s*`\/scoresheet\/\?matchId=\$\{/)
  })

  it('the page reads a sessionStorage copy only when the URL names no source', () => {
    const page = fs.readFileSync(path.resolve(__dirname, '../../../scoresheet_pdf/index_scoresheet.tsx'), 'utf8')
    expect(page).toMatch(/const initialMatchData = urlMatchId \|\| storageParams \|\| showList \? null : loadMatchData\(\);/)
    // and nowhere else
    expect(page.match(/loadMatchData\(\)/g)).toHaveLength(1)
  })
})
