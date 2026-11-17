// Tests for lib/tvPage.js (the live page any screen can open, smart TVs included).
//   cd escoresheet/backend && node --test tests/tvPage.test.js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { tvPageHtml, TV_JS } from '../lib/tvPage.js'

describe('tvPage', () => {
  it('the page names its code, loads only /tv/tv.js and has no inline script (CSP script-src self)', () => {
    const html = tvPageHtml('ABCD2345')
    assert.match(html, /data-code="ABCD2345"/)
    assert.match(html, /<script src="\/tv\/tv\.js"><\/script>/)
    assert.equal((html.match(/<script/g) || []).length, 1)
    assert.equal(/<script>[^<]/.test(html), false)
    assert.equal(tvPageHtml('AB"><x').includes('"><x'), false) // whatever is passed, nothing breaks out
  })

  it('the page CSS needs no grid and no custom properties (old TV engines)', () => {
    const html = tvPageHtml('ABCD2345')
    assert.equal(/display:\s*grid|var\(--/.test(html), false)
  })

  it('the script is ES5: no arrow functions, template literals, let/const, classes, spread, fetch or promises', () => {
    new vm.Script(TV_JS) // it parses
    const code = TV_JS.replace(/'(?:[^'\\]|\\.)*'/g, "''") // ignore string contents
    for (const [what, re] of [['arrow', /=>/], ['template literal', /`/], ['let', /\blet\s/], ['const', /\bconst\s/], ['class', /\bclass\s/], ['spread', /\.\.\./], ['fetch', /\bfetch\(/], ['Promise', /\bPromise\b/], ['async', /\basync\b/], ['for-of', /\bfor\s*\([^)]*\bof\b/]]) {
      assert.equal(re.test(code), false, what)
    }
  })

  it('the script reads its data from the same origin only', () => {
    assert.match(TV_JS, /x\.open\('GET', '\/api\/global\/live\/' \+ code/)
    assert.equal(/https?:\/\//.test(TV_JS), false)
  })
})
