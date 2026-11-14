// @vitest-environment node
/**
 * UI tour 14.11 (s04/s05): the setup summary listed the assistant scorer
 * "Baumann, L." while the Match info editor showed the Ass. scorer card
 * switched off (it started collapsed whatever it held, so the name was
 * hidden). The card starts on when it holds a name, as the 2nd referee's and
 * the line judges' do (the switch still turns it off), and the summary lists the assistant scorer only when
 * there is one (an optional official, as the line judges).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const setup = readFileSync(resolve(__dirname, '../MatchSetup.jsx'), 'utf8')

describe('assistant scorer: editor and summary agree', () => {
  it('the Ass. scorer card is on while it holds a name', () => {
    const card = setup.match(/<OfficialCard\s+title=\{t\('matchSetup\.assistantScorer'\)\}[\s\S]*?\/>/)[0]
    expect(card).toMatch(/filled=\{!!\(asstFirst \|\| asstLast\)\}/)
  })

  // Review 7a: a name held the card on and the switch did nothing. A name now
  // only sets where the card starts; the switch turns it off and on.
  it('the switch works while the card holds a name', () => {
    expect(setup).not.toMatch(/forceExpanded/)
    const cards = [...setup.matchAll(/const (OfficialCard|LineJudgesCard) = memo\(function[\s\S]*?\n\}\)\n/g)].map(m => m[0])
    expect(cards).toHaveLength(2)
    for (const card of cards) {
      expect(card).toMatch(/const \[collapsed, setCollapsed\] = useState\(null\)/)
      expect(card).toMatch(/collapsed \?\? \(defaultCollapsed && !filled\)/)
      expect(card).toMatch(/onToggle=\{\(\) => setCollapsed\(!isCollapsed\)\}/)
    }
  })

  it('the summary lists the assistant scorer only when named', () => {
    const row = setup.match(/\n(.*)\{ label: t\('matchSetup\.assistantScorer'\)/)[1]
    expect(row).toMatch(/\(asstFirst \|\| asstLast\) \? \[/)
  })
})
