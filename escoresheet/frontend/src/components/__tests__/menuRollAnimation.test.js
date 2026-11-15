// Owner, 15.11: tapping a player opened its menu, then "reopened it a little
// bigger": the roll-in animated `transform`, which replaced the menus' own
// inline scale(1.5) while it ran. It animates `translate` now.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '../../styles.css'), 'utf8')
const block = (name) => { const i = css.indexOf(`@keyframes ${name} {`); return css.slice(i, css.indexOf('\n}', i)) }

describe('menu roll-in keeps the menu\'s own scale', () => {
  for (const name of ['rollDown', 'rollUp']) {
    it(`${name} animates translate, never transform`, () => {
      const k = block(name)
      expect(k).toMatch(/translate: 0 -?6px/)
      expect(k).not.toMatch(/transform:/)
    })
  }
})
